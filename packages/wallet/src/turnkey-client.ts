/*
 * Real Turnkey gateway (Signer + TurnkeyDirectory).
 *
 * Request/response shapes are taken from @turnkey/sdk-server 8.6.0 (`TurnkeyApiTypes`).
 * We do not use the SDK's HTTP client at runtime: it imports `cross-fetch` (whose browser
 * build relies on XMLHttpRequest, absent on Workers) and has no request timeout. Instead
 * we use the global `fetch` with an AbortSignal timeout and stamp parent-org / delegated
 * requests with @turnkey/api-key-stamper (pure-JS runtime: identical on Workers and Node).
 *
 * Every unexpected response fails closed with a TurnkeyError.
 */
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import type { TurnkeyApiTypes } from "@turnkey/sdk-server";
import type {
  RawPayloadSignature,
  SignedTransaction,
  StampedTurnkeyRequest,
  UnsignedTransaction,
} from "@zyropay/shared";
import {
  chainFamilyOf,
  IMPORTED_KEY_DERIVATION_PATH,
  isCardanoTurnkeyAccount,
} from "@zyropay/shared";
import { z } from "zod";
import { bytesToHex, decodeTransaction } from "./encoding";
import {
  TURNKEY_PATHS,
  isTurnkeyUrl,
  turnkeyTransactionType,
  WEBAUTHN_STAMP_HEADER,
} from "./stamped";
import type {
  DelegatedKeyResolver,
  RootQuorum,
  TurnkeyDirectory,
  TurnkeyIdentity,
  TurnkeyPolicySummary,
  TurnkeyUserSummary,
  TurnkeyWalletAccount,
} from "./types";
import type { Signer } from "@zyropay/shared";

export class TurnkeyError extends Error {
  constructor(
    readonly kind: "http" | "timeout" | "activity" | "response" | "config" | "refused",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TurnkeyError";
  }
}

export interface TurnkeyClientConfig {
  readonly apiBaseUrl: string;
  readonly parentOrganizationId: string;
  readonly parentApiPublicKey: string;
  readonly parentApiPrivateKey: string;
  readonly resolveDelegatedKey: DelegatedKeyResolver;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const ActivitySchema = z.object({
  activity: z.object({
    id: z.string(),
    organizationId: z.string(),
    status: z.string(),
    type: z.string(),
    result: z
      .object({
        signTransactionResult: z.object({ signedTransaction: z.string().min(1) }).optional(),
        signRawPayloadResult: z
          .object({
            r: z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),
            s: z.string().regex(/^(0x)?[0-9a-fA-F]{1,64}$/),
            // Ed25519 (Cardano) has no recovery id: Turnkey may return an empty `v`.
            v: z.string().regex(/^(0x)?[0-9a-fA-F]{0,2}$/),
          })
          .optional(),
        createPoliciesResult: z.object({ policyIds: z.array(z.string()) }).optional(),
      })
      .loose()
      .optional(),
  }),
});

const WhoamiSchema = z.object({
  organizationId: z.string().min(1),
  organizationName: z.string(),
  userId: z.string().min(1),
  username: z.string(),
});

const OrgConfigsSchema = z.object({
  configs: z.object({
    quorum: z.object({ threshold: z.number().int(), userIds: z.array(z.string()) }).optional(),
  }),
});

const WalletsSchema = z.object({
  wallets: z.array(z.object({ walletId: z.string(), walletName: z.string() })),
});
const AccountsSchema = z.object({
  accounts: z.array(
    z.object({
      walletId: z.string(),
      address: z.string(),
      addressFormat: z.string(),
      path: z.string(),
      curve: z.string().optional(),
      publicKey: z.string().optional(),
    }),
  ),
});
const PrivateKeysSchema = z.object({
  privateKeys: z.array(
    z.object({
      privateKeyId: z.string(),
      privateKeyName: z.string(),
      addresses: z.array(
        z.object({ format: z.string().optional(), address: z.string().optional() }),
      ),
    }),
  ),
});
const UsersSchema = z.object({
  users: z.array(
    z.object({
      userId: z.string(),
      userName: z.string(),
      apiKeys: z.array(z.object({ credential: z.object({ publicKey: z.string() }) })),
      authenticators: z.array(z.unknown()),
    }),
  ),
});
const PoliciesSchema = z.object({
  policies: z.array(
    z.object({
      policyId: z.string(),
      effect: z.enum(["EFFECT_ALLOW", "EFFECT_DENY"]),
      consensus: z.string(),
    }),
  ),
});

export class TurnkeyClient implements Signer, TurnkeyDirectory {
  readonly simulated = false;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly parentStamper: ApiKeyStamper;
  private readonly now: () => Date;

  constructor(private readonly config: TurnkeyClientConfig) {
    for (const [name, value] of Object.entries({
      apiBaseUrl: config.apiBaseUrl,
      parentOrganizationId: config.parentOrganizationId,
      parentApiPublicKey: config.parentApiPublicKey,
      parentApiPrivateKey: config.parentApiPrivateKey,
    })) {
      if (!value) throw new TurnkeyError("config", `Turnkey ${name} is not configured`);
    }
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.now = config.now ?? (() => new Date());
    this.parentStamper = new ApiKeyStamper({
      apiPublicKey: config.parentApiPublicKey,
      apiPrivateKey: config.parentApiPrivateKey,
      runtimeOverride: "purejs",
    });
  }

  // --- Signer port -----------------------------------------------------------

  async forwardStampedQuery<T>(request: StampedTurnkeyRequest): Promise<T> {
    if (!isTurnkeyUrl(request.url, this.config.apiBaseUrl, TURNKEY_PATHS.whoami)) {
      throw new TurnkeyError("refused", "only stamped whoami queries may be forwarded");
    }
    return (await this.post(request.url, request.body, request.stamp)) as T;
  }

  async forwardStampedSignRequest(request: StampedTurnkeyRequest): Promise<SignedTransaction> {
    // The caller ran verifySignTransactionRequest; re-check the invariants that make
    // forwarding safe so this method can never be used to forward anything else.
    if (!isTurnkeyUrl(request.url, this.config.apiBaseUrl, TURNKEY_PATHS.signTransaction)) {
      throw new TurnkeyError("refused", "not a sign_transaction URL");
    }
    if (request.stamp.stampHeaderName !== WEBAUTHN_STAMP_HEADER) {
      throw new TurnkeyError("refused", "user signing requires a passkey stamp");
    }
    const json = await this.post(request.url, request.body, request.stamp);
    return this.signedFromActivity(json);
  }

  async forwardStampedSignRawPayload(request: StampedTurnkeyRequest): Promise<RawPayloadSignature> {
    // The caller ran verifySignRawPayloadRequest; re-check the forwarding invariants.
    if (!isTurnkeyUrl(request.url, this.config.apiBaseUrl, TURNKEY_PATHS.signRawPayload)) {
      throw new TurnkeyError("refused", "not a sign_raw_payload URL");
    }
    if (request.stamp.stampHeaderName !== WEBAUTHN_STAMP_HEADER) {
      throw new TurnkeyError("refused", "user signing requires a passkey stamp");
    }
    const json = await this.post(request.url, request.body, request.stamp);
    const parsed = ActivitySchema.safeParse(json);
    if (!parsed.success) throw new TurnkeyError("response", "unexpected activity response");
    const { activity } = parsed.data;
    if (activity.type !== "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2") {
      throw new TurnkeyError("response", "unexpected activity type");
    }
    const result = activity.result?.signRawPayloadResult;
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED" || result === undefined) {
      throw new TurnkeyError("activity", `sign activity is ${activity.status}`);
    }
    const strip = (v: string) => v.replace(/^0x/, "").toLowerCase();
    return {
      r: strip(result.r).padStart(64, "0"),
      s: strip(result.s).padStart(64, "0"),
      v: strip(result.v),
      activityId: activity.id,
      simulated: false,
    };
  }

  async signWithDelegatedKey(input: {
    subOrganizationId: string;
    signWith: string;
    unsigned: UnsignedTransaction;
  }): Promise<SignedTransaction> {
    if (chainFamilyOf(input.unsigned.network) === "cardano") {
      // ADR-002: no Turnkey policy can bound a raw Ed25519 signature; never delegated.
      throw new TurnkeyError("refused", "Cardano is never signed with the delegated key");
    }
    const key = await this.config.resolveDelegatedKey(input.subOrganizationId);
    if (key === null) throw new TurnkeyError("refused", "no active delegated signer");
    const body: TurnkeyApiTypes["v1SignTransactionRequest"] = {
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      timestampMs: String(this.now().getTime()),
      organizationId: input.subOrganizationId,
      parameters: {
        signWith: input.signWith,
        unsignedTransaction: bytesToHex(
          decodeTransaction(input.unsigned.serialized, input.unsigned.encoding),
        ),
        type: turnkeyTransactionType(chainFamilyOf(input.unsigned.network)),
      },
    };
    const stamper = new ApiKeyStamper({
      apiPublicKey: key.publicKey,
      apiPrivateKey: key.privateKey,
      runtimeOverride: "purejs",
    });
    const raw = JSON.stringify(body);
    const stamp = await stamper.stamp(raw);
    const json = await this.post(this.url(TURNKEY_PATHS.signTransaction), raw, stamp);
    return this.signedFromActivity(json);
  }

  // --- Directory ---------------------------------------------------------------

  async whoami(request: StampedTurnkeyRequest): Promise<TurnkeyIdentity> {
    const parsed = WhoamiSchema.safeParse(await this.forwardStampedQuery<unknown>(request));
    if (!parsed.success) throw new TurnkeyError("response", "unexpected whoami response");
    return parsed.data;
  }

  async getRootQuorum(subOrganizationId: string): Promise<RootQuorum> {
    const body: TurnkeyApiTypes["v1GetOrganizationConfigsRequest"] = {
      organizationId: subOrganizationId,
    };
    const parsed = OrgConfigsSchema.safeParse(
      await this.parentQuery(TURNKEY_PATHS.getOrganizationConfigs, body),
    );
    const quorum = parsed.success ? parsed.data.configs.quorum : undefined;
    if (quorum === undefined)
      throw new TurnkeyError("response", "sub-organization has no readable root quorum");
    return quorum;
  }

  async listWalletAccounts(subOrganizationId: string): Promise<TurnkeyWalletAccount[]> {
    const walletsBody: TurnkeyApiTypes["v1GetWalletsRequest"] = {
      organizationId: subOrganizationId,
    };
    const wallets = WalletsSchema.safeParse(
      await this.parentQuery(TURNKEY_PATHS.listWallets, walletsBody),
    );
    if (!wallets.success) throw new TurnkeyError("response", "unexpected list_wallets response");
    const out: TurnkeyWalletAccount[] = [];
    for (const wallet of wallets.data.wallets) {
      const accountsBody: TurnkeyApiTypes["v1GetWalletAccountsRequest"] = {
        organizationId: subOrganizationId,
        walletId: wallet.walletId,
        paginationOptions: { limit: "100" },
      };
      const accounts = AccountsSchema.safeParse(
        await this.parentQuery(TURNKEY_PATHS.listWalletAccounts, accountsBody),
      );
      if (!accounts.success)
        throw new TurnkeyError("response", "unexpected list_wallet_accounts response");
      for (const account of accounts.data.accounts) {
        if (isCardanoTurnkeyAccount(account)) {
          // ADR-002: a compressed Ed25519 account at the CIP-1852 path. Its "address" is
          // the public key; anything else is not a key we can sign Cardano with.
          // Turnkey's Cardano guide: the compressed account's address IS the public key.
          // Anything else is skipped (never guessed); the other accounts still sync.
          const publicKey = account.address.replace(/^0x/, "").toLowerCase();
          const reported = account.publicKey?.replace(/^0x/, "").toLowerCase();
          if (
            !/^[0-9a-f]{64}$/.test(publicKey) ||
            (reported !== undefined && reported !== publicKey)
          ) {
            continue;
          }
          out.push({
            turnkeyWalletId: wallet.walletId,
            walletName: wallet.walletName,
            family: "cardano",
            address: publicKey,
            publicKey,
            derivationPath: account.path,
          });
          continue;
        }
        const family =
          account.addressFormat === "ADDRESS_FORMAT_SOLANA"
            ? "solana"
            : account.addressFormat === "ADDRESS_FORMAT_ETHEREUM"
              ? "evm"
              : null;
        if (family === null) continue; // other chains are not supported by ZyroPay
        out.push({
          turnkeyWalletId: wallet.walletId,
          walletName: wallet.walletName,
          family,
          address: account.address,
          derivationPath: account.path,
        });
      }
    }
    return out;
  }

  async listPrivateKeyAccounts(subOrganizationId: string): Promise<TurnkeyWalletAccount[]> {
    const body: TurnkeyApiTypes["v1GetPrivateKeysRequest"] = { organizationId: subOrganizationId };
    const parsed = PrivateKeysSchema.safeParse(
      await this.parentQuery(TURNKEY_PATHS.listPrivateKeys, body),
    );
    if (!parsed.success)
      throw new TurnkeyError("response", "unexpected list_private_keys response");
    const out: TurnkeyWalletAccount[] = [];
    for (const key of parsed.data.privateKeys) {
      for (const a of key.addresses) {
        const family =
          a.format === "ADDRESS_FORMAT_SOLANA"
            ? "solana"
            : a.format === "ADDRESS_FORMAT_ETHEREUM"
              ? "evm"
              : null;
        if (family === null || a.address === undefined || a.address === "") continue;
        out.push({
          turnkeyWalletId: key.privateKeyId,
          walletName: key.privateKeyName,
          family,
          address: a.address,
          derivationPath: IMPORTED_KEY_DERIVATION_PATH,
        });
      }
    }
    return out;
  }

  async listUsers(subOrganizationId: string): Promise<TurnkeyUserSummary[]> {
    const body: TurnkeyApiTypes["v1GetUsersRequest"] = { organizationId: subOrganizationId };
    const parsed = UsersSchema.safeParse(await this.parentQuery(TURNKEY_PATHS.listUsers, body));
    if (!parsed.success) throw new TurnkeyError("response", "unexpected list_users response");
    return parsed.data.users.map((u) => ({
      userId: u.userId,
      userName: u.userName,
      apiPublicKeys: u.apiKeys.map((k) => k.credential.publicKey.toLowerCase()),
      authenticatorCount: u.authenticators.length,
    }));
  }

  async listPolicies(subOrganizationId: string): Promise<TurnkeyPolicySummary[]> {
    const body: TurnkeyApiTypes["v1GetPoliciesRequest"] = { organizationId: subOrganizationId };
    const parsed = PoliciesSchema.safeParse(
      await this.parentQuery(TURNKEY_PATHS.listPolicies, body),
    );
    if (!parsed.success) throw new TurnkeyError("response", "unexpected list_policies response");
    return parsed.data.policies;
  }

  async forwardCreatePolicies(request: StampedTurnkeyRequest): Promise<string[]> {
    if (!isTurnkeyUrl(request.url, this.config.apiBaseUrl, TURNKEY_PATHS.createPolicies)) {
      throw new TurnkeyError("refused", "not a create_policies URL");
    }
    if (request.stamp.stampHeaderName !== WEBAUTHN_STAMP_HEADER) {
      throw new TurnkeyError("refused", "policy changes require a passkey stamp");
    }
    const parsed = ActivitySchema.safeParse(
      await this.post(request.url, request.body, request.stamp),
    );
    if (!parsed.success) throw new TurnkeyError("response", "unexpected activity response");
    const { activity } = parsed.data;
    const ids = activity.result?.createPoliciesResult?.policyIds;
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED" || ids === undefined) {
      throw new TurnkeyError("activity", `create_policies activity is ${activity.status}`);
    }
    return ids;
  }

  // --- internals -------------------------------------------------------------------

  private url(path: string): string {
    return `${this.config.apiBaseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async parentQuery(path: string, body: object): Promise<unknown> {
    const raw = JSON.stringify(body);
    const stamp = await this.parentStamper.stamp(raw);
    return this.post(this.url(path), raw, stamp);
  }

  private signedFromActivity(json: unknown): SignedTransaction {
    const parsed = ActivitySchema.safeParse(json);
    if (!parsed.success) throw new TurnkeyError("response", "unexpected activity response");
    const { activity } = parsed.data;
    if (activity.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2") {
      throw new TurnkeyError("response", "unexpected activity type");
    }
    const signed = activity.result?.signTransactionResult?.signedTransaction;
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED" || signed === undefined) {
      // CONSENSUS_NEEDED, FAILED, REJECTED, PENDING: never treat as signed.
      throw new TurnkeyError("activity", `sign activity is ${activity.status}`);
    }
    return {
      signedTransaction: signed,
      encoding: "hex",
      activityId: activity.id,
      simulated: false,
    };
  }

  private async post(
    url: string,
    body: string,
    stamp: { stampHeaderName: string; stampHeaderValue: string },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [stamp.stampHeaderName]: stamp.stampHeaderValue,
        },
        body,
        // Never follow a redirect with a stamped body. Workers reject redirect: "error" ("does
        // not make sense at the edge"), so take it manually and refuse any 3xx below.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TurnkeyError(
        timeout ? "timeout" : "http",
        timeout
          ? "Turnkey request timed out"
          : `Turnkey request failed (${error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown"})`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TurnkeyError("http", `Turnkey redirected (${response.status})`, response.status);
    }
    if (!response.ok) {
      // Do not surface Turnkey's message: it can echo request content.
      throw new TurnkeyError("http", `Turnkey responded ${response.status}`, response.status);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new TurnkeyError("response", "Turnkey returned invalid JSON");
    }
  }
}
