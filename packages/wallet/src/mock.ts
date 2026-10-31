/*
 * MockTurnkey: an in-memory stand-in for Turnkey for local development and tests.
 * Every result is `simulated: true`. The API refuses to use it in production mode.
 *
 * It enforces the same request shapes as the real gateway, and treats a WebAuthn stamp
 * as valid when its signature equals `mockPasskeySignature(credentialId, body)`, so the
 * API's own checks (stamp covers body, org, signWith, byte equality) run unchanged.
 */
import type {
  ChainFamily,
  RawPayloadSignature,
  SignedTransaction,
  StampedTurnkeyRequest,
  UnsignedTransaction,
} from "@zyropay/shared";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  CARDANO_TURNKEY_ACCOUNT,
  IMPORTED_KEY_DERIVATION_PATH,
  sha256Hex,
  toChecksumAddress,
} from "@zyropay/shared";
import { bytesToBase64Url, bytesToHex, decodeTransaction, hexToBytes } from "./encoding";
import { parseWebauthnStamp, TURNKEY_PATHS, WEBAUTHN_STAMP_HEADER } from "./stamped";
import { TurnkeyError } from "./turnkey-client";
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

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) + BigInt(b);
  let out = "";
  while (value > 0n) {
    out = BASE58.charAt(Number(value % 58n)) + out;
    value /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/**
 * Deterministic valid addresses for a seed (32-byte Solana key, EIP-55 EVM address, and a
 * Cardano Ed25519 public key). DEVELOPMENT ONLY: the Cardano key is a real Ed25519 key
 * whose secret is derivable from the seed, so the mock produces signatures the ledger
 * accepts (useful on preprod) and must never hold real funds.
 */
export function mockAddresses(seed: string): {
  solana: string;
  evm: string;
  cardanoPublicKey: string;
} {
  return {
    solana: base58Encode(hexToBytes(sha256Hex(`sol:${seed}`))),
    evm: toChecksumAddress(`0x${sha256Hex(`evm:${seed}`).slice(0, 40)}`),
    cardanoPublicKey: bytesToHex(ed25519.getPublicKey(mockCardanoSecret(seed))),
  };
}

function mockCardanoSecret(seed: string): Uint8Array {
  return hexToBytes(sha256Hex(`ada:${seed}`));
}

export function mockPasskeySignature(credentialId: string, body: string): string {
  return sha256Hex(`mock-passkey:${credentialId}:${body}`);
}

/** Build a WebAuthn-format stamp the way @turnkey/webauthn-stamper does (mock signature). */
export function mockPasskeyStamp(
  credentialId: string,
  body: string,
): StampedTurnkeyRequest["stamp"] {
  const challenge = bytesToBase64Url(new TextEncoder().encode(sha256Hex(body)));
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: "https://mock.zyropay",
  });
  return {
    stampHeaderName: WEBAUTHN_STAMP_HEADER,
    stampHeaderValue: JSON.stringify({
      authenticatorData: "bW9jaw",
      clientDataJson: bytesToBase64Url(new TextEncoder().encode(clientData)),
      credentialId,
      signature: mockPasskeySignature(credentialId, body),
    }),
  };
}

interface MockSubOrg {
  readonly organizationId: string;
  quorum: RootQuorum;
  readonly users: Map<
    string,
    { userName: string; apiPublicKeys: string[]; authenticatorCount: number }
  >;
  readonly accounts: TurnkeyWalletAccount[];
  /** ADR-003: imported raw private keys, one account each. */
  readonly privateKeys: TurnkeyWalletAccount[];
  readonly policies: TurnkeyPolicySummary[];
  /** Ed25519 secrets of the Cardano accounts, by public key (development mock only). */
  readonly cardanoSecrets: Map<string, Uint8Array>;
}

export interface MockTurnkeyOptions {
  readonly apiBaseUrl?: string;
  readonly resolveDelegatedKey?: DelegatedKeyResolver;
  /**
   * Local development convenience: an unknown passkey credential `dev-*` provisions a
   * fresh sub-org (root = that user, one Solana + one EVM account). Off by default.
   */
  readonly autoProvisionDevCredentials?: boolean;
}

export class MockTurnkey implements Signer, TurnkeyDirectory {
  readonly simulated = true;
  readonly apiBaseUrl: string;
  private readonly subOrgs = new Map<string, MockSubOrg>();
  /** credentialId -> { organizationId, userId } */
  private readonly credentials = new Map<string, { organizationId: string; userId: string }>();
  readonly signed: {
    organizationId: string;
    signWith: string;
    via: "passkey" | "delegated";
    kind?: "raw_payload";
  }[] = [];
  private resolveDelegatedKey: DelegatedKeyResolver;
  private counter = 0;

  constructor(private readonly options: MockTurnkeyOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.turnkey.com";
    this.resolveDelegatedKey = options.resolveDelegatedKey ?? (() => Promise.resolve(null));
  }

  setDelegatedKeyResolver(resolver: DelegatedKeyResolver): void {
    this.resolveDelegatedKey = resolver;
  }

  /** Create a sub-org whose root quorum is exactly the passkey user (the expected layout). */
  createSubOrg(input: {
    credentialId: string;
    seed?: string;
    quorum?: RootQuorum;
    extraUsers?: string[];
  }): {
    organizationId: string;
    userId: string;
    solana: string;
    evm: string;
    cardanoPublicKey: string;
  } {
    this.counter += 1;
    const seed = input.seed ?? `${input.credentialId}:${this.counter}`;
    const organizationId = `mock-org-${sha256Hex(`org:${seed}`).slice(0, 16)}`;
    const userId = `mock-user-${sha256Hex(`user:${seed}`).slice(0, 16)}`;
    const walletId = `mock-wallet-${sha256Hex(`wallet:${seed}`).slice(0, 16)}`;
    const addresses = mockAddresses(seed);
    const users = new Map<
      string,
      { userName: string; apiPublicKeys: string[]; authenticatorCount: number }
    >();
    users.set(userId, { userName: "passkey user", apiPublicKeys: [], authenticatorCount: 1 });
    for (const extra of input.extraUsers ?? []) {
      users.set(extra, { userName: extra, apiPublicKeys: [], authenticatorCount: 0 });
    }
    this.subOrgs.set(organizationId, {
      organizationId,
      quorum: input.quorum ?? { threshold: 1, userIds: [userId] },
      users,
      accounts: [
        {
          turnkeyWalletId: walletId,
          walletName: "Default",
          family: "solana",
          address: addresses.solana,
          derivationPath: "m/44'/501'/0'/0'",
        },
        {
          turnkeyWalletId: walletId,
          walletName: "Default",
          family: "evm",
          address: addresses.evm,
          derivationPath: "m/44'/60'/0'/0/0",
        },
        {
          turnkeyWalletId: walletId,
          walletName: "Default",
          family: "cardano",
          address: addresses.cardanoPublicKey,
          publicKey: addresses.cardanoPublicKey,
          derivationPath: CARDANO_TURNKEY_ACCOUNT.path,
        },
      ],
      privateKeys: [],
      policies: [],
      cardanoSecrets: new Map([[addresses.cardanoPublicKey, mockCardanoSecret(seed)]]),
    });
    this.credentials.set(input.credentialId, { organizationId, userId });
    return { organizationId, userId, ...addresses };
  }

  /**
   * Simulate the app creating a new wallet in a sub-org with the user's passkey (the
   * Wallets tab "+" flow). Returns the new wallet id and its account addresses; only the
   * requested families get an account (default: Solana + EVM).
   */
  createWallet(
    organizationId: string,
    input: { name?: string; families?: readonly ChainFamily[]; seed?: string } = {},
  ): {
    turnkeyWalletId: string;
    solana: string | null;
    evm: string | null;
    cardanoPublicKey: string | null;
  } {
    const org = this.org(organizationId);
    this.counter += 1;
    const seed = input.seed ?? `${organizationId}:wallet:${this.counter}`;
    const turnkeyWalletId = `mock-wallet-${sha256Hex(`wallet:${seed}`).slice(0, 16)}`;
    const addresses = mockAddresses(seed);
    const families = input.families ?? ["solana", "evm"];
    const walletName = input.name ?? `Wallet ${this.counter}`;
    const hasSolana = families.includes("solana");
    const hasEvm = families.includes("evm");
    const hasCardano = families.includes("cardano");
    if (hasSolana) {
      org.accounts.push({
        turnkeyWalletId,
        walletName,
        family: "solana",
        address: addresses.solana,
        derivationPath: "m/44'/501'/0'/0'",
      });
    }
    if (hasEvm) {
      org.accounts.push({
        turnkeyWalletId,
        walletName,
        family: "evm",
        address: addresses.evm,
        derivationPath: "m/44'/60'/0'/0/0",
      });
    }
    if (hasCardano) {
      org.accounts.push({
        turnkeyWalletId,
        walletName,
        family: "cardano",
        address: addresses.cardanoPublicKey,
        publicKey: addresses.cardanoPublicKey,
        derivationPath: CARDANO_TURNKEY_ACCOUNT.path,
      });
      org.cardanoSecrets.set(addresses.cardanoPublicKey, mockCardanoSecret(seed));
    }
    return {
      turnkeyWalletId,
      solana: hasSolana ? addresses.solana : null,
      evm: hasEvm ? addresses.evm : null,
      cardanoPublicKey: hasCardano ? addresses.cardanoPublicKey : null,
    };
  }

  /** Simulate the app creating the delegated non-root API-key user (ADR-001 D6). */
  addApiKeyUser(organizationId: string, userId: string, publicKey: string): void {
    this.org(organizationId).users.set(userId, {
      userName: "zyropay-delegated",
      apiPublicKeys: [publicKey.toLowerCase()],
      authenticatorCount: 0,
    });
  }

  addPolicy(organizationId: string, policy: TurnkeyPolicySummary): void {
    this.org(organizationId).policies.push(policy);
  }

  setRootQuorum(organizationId: string, quorum: RootQuorum): void {
    this.org(organizationId).quorum = quorum;
  }

  // --- Signer ---------------------------------------------------------------------

  async forwardStampedQuery<T>(request: StampedTurnkeyRequest): Promise<T> {
    if (!request.url.endsWith(TURNKEY_PATHS.whoami))
      throw new TurnkeyError("refused", "mock: only whoami");
    return (await this.whoami(request)) as T;
  }

  forwardStampedSignRequest(request: StampedTurnkeyRequest): Promise<SignedTransaction> {
    const identity = this.authenticate(request);
    const body = JSON.parse(request.body) as {
      organizationId: string;
      parameters: { signWith: string; unsignedTransaction: string };
    };
    if (body.organizationId !== identity.organizationId) {
      throw new TurnkeyError("http", "mock: stamp belongs to another organization", 403);
    }
    this.signed.push({
      organizationId: body.organizationId,
      signWith: body.parameters.signWith,
      via: "passkey",
    });
    return Promise.resolve(this.sign(body.parameters.unsignedTransaction));
  }

  forwardStampedSignRawPayload(request: StampedTurnkeyRequest): Promise<RawPayloadSignature> {
    if (!request.url.endsWith(TURNKEY_PATHS.signRawPayload))
      return Promise.reject(new TurnkeyError("refused", "mock: not a sign_raw_payload URL"));
    const identity = this.authenticate(request);
    const body = JSON.parse(request.body) as {
      type: string;
      organizationId: string;
      parameters: { signWith: string; payload: string; hashFunction?: string };
    };
    if (body.type !== "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2") {
      return Promise.reject(new TurnkeyError("response", "mock: unexpected activity type"));
    }
    if (body.organizationId !== identity.organizationId) {
      return Promise.reject(
        new TurnkeyError("http", "mock: stamp belongs to another organization", 403),
      );
    }
    this.signed.push({
      organizationId: body.organizationId,
      signWith: body.parameters.signWith,
      via: "passkey",
      kind: "raw_payload",
    });
    const payload = body.parameters.payload.replace(/^0x/, "").toLowerCase();
    if (body.parameters.hashFunction === "HASH_FUNCTION_NOT_APPLICABLE") {
      // Ed25519 (Cardano): a REAL signature with the org's development key, so the API's
      // witness verification runs unchanged. r || s is the 64-byte signature, no v.
      const org = this.org(identity.organizationId);
      const secret = org.cardanoSecrets.get(body.parameters.signWith.toLowerCase());
      if (secret === undefined) {
        return Promise.reject(new TurnkeyError("http", "mock: unknown Ed25519 signWith", 400));
      }
      const signature = bytesToHex(ed25519.sign(hexToBytes(payload), secret));
      return Promise.resolve({
        r: signature.slice(0, 64),
        s: signature.slice(64),
        v: "",
        activityId: `mock-activity-${sha256Hex(`ed25519:${payload}`).slice(0, 16)}`,
        simulated: true,
      });
    }
    return Promise.resolve({
      r: sha256Hex(`mock-r:${payload}`),
      s: sha256Hex(`mock-s:${payload}`),
      v: "1b",
      activityId: `mock-activity-${sha256Hex(`raw:${payload}`).slice(0, 16)}`,
      simulated: true,
    });
  }

  async signWithDelegatedKey(input: {
    subOrganizationId: string;
    signWith: string;
    unsigned: UnsignedTransaction;
  }): Promise<SignedTransaction> {
    const key = await this.resolveDelegatedKey(input.subOrganizationId);
    if (key === null) throw new TurnkeyError("refused", "no active delegated signer");
    const org = this.org(input.subOrganizationId);
    const registered = [...org.users.values()].some((u) =>
      u.apiPublicKeys.includes(key.publicKey.toLowerCase()),
    );
    if (!registered)
      throw new TurnkeyError("http", "mock: API key is not a user of this sub-org", 401);
    this.signed.push({
      organizationId: input.subOrganizationId,
      signWith: input.signWith,
      via: "delegated",
    });
    return this.sign(
      bytesToHex(decodeTransaction(input.unsigned.serialized, input.unsigned.encoding)),
    );
  }

  // --- Directory ------------------------------------------------------------------

  whoami(request: StampedTurnkeyRequest): Promise<TurnkeyIdentity> {
    const identity = this.authenticate(request);
    return Promise.resolve({ ...identity, username: "passkey user" });
  }

  getRootQuorum(subOrganizationId: string): Promise<RootQuorum> {
    return Promise.resolve(this.org(subOrganizationId).quorum);
  }

  listWalletAccounts(subOrganizationId: string): Promise<TurnkeyWalletAccount[]> {
    return Promise.resolve([...this.org(subOrganizationId).accounts]);
  }

  listPrivateKeyAccounts(subOrganizationId: string): Promise<TurnkeyWalletAccount[]> {
    return Promise.resolve([...this.org(subOrganizationId).privateKeys]);
  }

  /**
   * Simulate the app importing a raw private key into a sub-org with the user's passkey
   * (ADR-003: IMPORT_PRIVATE_KEY). Only the address is modelled; no key material exists.
   */
  importPrivateKey(
    organizationId: string,
    input: { family: "solana" | "evm"; name?: string; seed?: string },
  ): { privateKeyId: string; address: string } {
    const org = this.org(organizationId);
    this.counter += 1;
    const seed = input.seed ?? `${organizationId}:key:${this.counter}`;
    const privateKeyId = `mock-private-key-${sha256Hex(`key:${seed}`).slice(0, 16)}`;
    const addresses = mockAddresses(seed);
    const address = input.family === "solana" ? addresses.solana : addresses.evm;
    org.privateKeys.push({
      turnkeyWalletId: privateKeyId,
      walletName: input.name ?? `Imported key ${String(this.counter)}`,
      family: input.family,
      address,
      derivationPath: IMPORTED_KEY_DERIVATION_PATH,
    });
    return { privateKeyId, address };
  }

  listUsers(subOrganizationId: string): Promise<TurnkeyUserSummary[]> {
    return Promise.resolve(
      [...this.org(subOrganizationId).users.entries()].map(([userId, u]) => ({ userId, ...u })),
    );
  }

  listPolicies(subOrganizationId: string): Promise<TurnkeyPolicySummary[]> {
    return Promise.resolve([...this.org(subOrganizationId).policies]);
  }

  forwardCreatePolicies(request: StampedTurnkeyRequest): Promise<string[]> {
    const identity = this.authenticate(request);
    const body = JSON.parse(request.body) as {
      parameters: { policies: { effect: "EFFECT_ALLOW" | "EFFECT_DENY"; consensus?: string }[] };
    };
    const ids = body.parameters.policies.map((p, i) => {
      const policyId = `mock-policy-${sha256Hex(`${request.body}:${i}`).slice(0, 12)}`;
      this.addPolicy(identity.organizationId, {
        policyId,
        effect: p.effect,
        consensus: p.consensus ?? "",
      });
      return policyId;
    });
    return Promise.resolve(ids);
  }

  // --- internals ------------------------------------------------------------------

  private sign(unsignedHex: string): SignedTransaction {
    const clean = unsignedHex.startsWith("0x") ? unsignedHex.slice(2) : unsignedHex;
    return {
      signedTransaction: `${clean}${sha256Hex(`mock-signature:${clean}`)}`,
      encoding: "hex",
      activityId: `mock-activity-${sha256Hex(clean).slice(0, 16)}`,
      simulated: true,
    };
  }

  private authenticate(request: StampedTurnkeyRequest): { organizationId: string; userId: string } {
    if (request.stamp.stampHeaderName !== WEBAUTHN_STAMP_HEADER) {
      throw new TurnkeyError("http", "mock: only passkey stamps are supported", 401);
    }
    const stamp = parseWebauthnStamp(request.stamp.stampHeaderValue);
    if (
      stamp === null ||
      stamp.signature !== mockPasskeySignature(stamp.credentialId, request.body)
    ) {
      throw new TurnkeyError("http", "mock: invalid stamp", 401);
    }
    let identity = this.credentials.get(stamp.credentialId);
    if (
      identity === undefined &&
      this.options.autoProvisionDevCredentials === true &&
      stamp.credentialId.startsWith("dev-")
    ) {
      const created = this.createSubOrg({
        credentialId: stamp.credentialId,
        seed: stamp.credentialId,
      });
      identity = { organizationId: created.organizationId, userId: created.userId };
    }
    if (identity === undefined) throw new TurnkeyError("http", "mock: unknown credential", 401);
    return identity;
  }

  private org(id: string): MockSubOrg {
    const org = this.subOrgs.get(id);
    if (org === undefined) throw new TurnkeyError("http", "mock: organization not found", 404);
    return org;
  }
}
