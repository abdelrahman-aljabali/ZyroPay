import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  TokenInstruction,
} from "@solana-program/token";
import type { Instruction } from "@solana/kit";
import {
  address as toAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { HttpOptions } from "@zyropay/blockchain";
import {
  ChainError,
  decodeCardanoTx,
  decodeSolanaTransaction,
  readComputeBudget,
  cardanoPosixMsToSlot,
  SolanaRpc,
  solanaPrograms,
  verifyCardanoEscrowLock,
  verifyCardanoTransfer,
} from "@zyropay/blockchain";
import type {
  AssetId,
  BaseUnitAmount,
  CanonicalTransactionPayload,
  HeaderReader,
  JsonObject,
  NetworkId,
  PluginAdapter,
  PluginQuote,
  UnsignedTransaction,
  UnsignedTypedData,
  VerificationResult,
} from "@zyropay/shared";
import {
  AssetIdSchema,
  BaseUnitAmountSchema,
  CanonicalTransactionPayloadSchema,
  addressesEqual,
  chainFamilyOf,
  isValidAddressForNetwork,
  NETWORKS,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
} from "@zyropay/shared";
import type { Hex, TypedDataDefinition } from "viem";
import { getAddress, hashTypedData, keccak256, toHex } from "viem";
import { z } from "zod";
import {
  assertPayloadMatchesQuote,
  manifestFor,
  parseParams,
  runVerifier,
  toJsonObject,
} from "./common";
import type { MasumiEscrowTerms } from "./masumi";
import type { MasumiRegistryClient } from "./masumi-registry";
import { assertMasumiEscrowBinding, masumiEscrowTermsOf, quoteMasumiEscrow } from "./masumi";

/*
 * x402 client (payer side), spec v2 with v1 fallback:
 *   https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 *   https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
 *   https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 *   https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
 *   https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md
 * Implemented natively instead of depending on @x402/* 2.28: those pin zod 3 and
 * @solana-program/* versions two majors behind our @solana/kit 8 stack, and ZyroPay needs the
 * unsigned artifact (EIP-712 typed data / partially-signed Solana tx) handed to Turnkey rather
 * than an in-process signer.
 *
 * Cardano (v2 only): `default` = a plain key-witnessed transfer of `amount` to `payTo`, built
 * by the network's TransactionBuilder (the API owns it) and signed by the user's passkey.
 * `masumi` = a lock into the Masumi escrow (./masumi.ts): validated and bound here (seller
 * signature, deadlines, the exact datum in pluginData.escrow), built by the API's escrow
 * builder, verified by verifyCardanoEscrowLock. Either way the header carries the whole
 * signed transaction (base64 CBOR) plus a nonce naming one of its inputs; the facilitator
 * submits exactly those bytes.
 */

const V1_NETWORKS: Readonly<Record<string, NetworkId>> = {
  base: "base-mainnet",
  "base-sepolia": "base-sepolia",
  solana: "solana-mainnet",
  "solana-devnet": "solana-devnet",
};

/** One normalized `accepts` entry plus the verbatim object (echoed back in the payment). */
export interface X402Requirement {
  readonly x402Version: 1 | 2;
  readonly scheme: string;
  readonly network: NetworkId | null;
  readonly caip2: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: JsonObject;
  readonly resourceUrl: string | null;
  readonly raw: JsonObject;
}

export interface X402PaymentRequired {
  readonly x402Version: 1 | 2;
  readonly resourceUrl: string | null;
  readonly resource: JsonObject | null;
  readonly accepts: readonly X402Requirement[];
}

const JsonRecord = z.record(z.string(), z.unknown());

/** The Cardano scheme names networks `cardano:<name>`; CIP-34 ids (our caip2) also match. */
const X402_NETWORK_ALIASES: Readonly<Record<string, NetworkId>> = {
  "cardano:mainnet": "cardano-mainnet",
  "cardano:preprod": "cardano-preprod",
};

function networkFromCaip2(caip2: string): NetworkId | null {
  const alias = X402_NETWORK_ALIASES[caip2];
  if (alias !== undefined) return alias;
  for (const n of Object.values(NETWORKS)) if (n.caip2 === caip2) return n.id;
  return null;
}

/** The Cardano scheme's asset for ADA. Native tokens are `<policyId>.<assetNameHex>`. */
const X402_LOVELACE = "lovelace";

/**
 * WHATWG-normalized form of a resource URL (lowercase host, no default port, canonical
 * escapes), which is what servers report as `resource.url`. Unparseable input is returned
 * as is, so it can only ever compare equal to itself.
 */
export function normalizeResourceUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * Whether a requirement's `asset` is the asset `assetId` names. Cardano: "lovelace" is the
 * native coin; a token is `<policyId>.<assetNameHex>` against our concatenated unit. Elsewhere
 * x402 pays in tokens only and the asset is the token address.
 */
export function x402AssetMatches(
  network: NetworkId,
  requirementAsset: string,
  assetId: string,
): boolean {
  const token = parseAssetId(assetId).tokenAddress;
  const family = chainFamilyOf(network);
  if (family === "cardano") {
    if (requirementAsset === X402_LOVELACE) return token === null;
    return (
      token !== null && requirementAsset.replace(".", "").toLowerCase() === token.toLowerCase()
    );
  }
  return token !== null && addressesEqual(family, requirementAsset, token);
}

/** Normalize a decoded PaymentRequired (v2) or a v1 402 body. Throws VALIDATION_FAILED. */
export function normalizePaymentRequired(input: unknown): X402PaymentRequired {
  const obj = JsonRecord.safeParse(input);
  if (!obj.success)
    throw new ChainError("VALIDATION_FAILED", "x402: payment requirements must be an object");
  const version = obj.data.x402Version;
  if (version !== 1 && version !== 2)
    throw new ChainError("VALIDATION_FAILED", "x402: unsupported x402Version");
  const accepts = obj.data.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0 || accepts.length > 20) {
    throw new ChainError("VALIDATION_FAILED", "x402: accepts must be a non-empty array");
  }
  const resource = version === 2 ? JsonRecord.safeParse(obj.data.resource) : null;
  const resourceUrl =
    resource?.success === true && typeof resource.data.url === "string" ? resource.data.url : null;
  const normalized = accepts.map((entry): X402Requirement => {
    const e = JsonRecord.safeParse(entry);
    if (!e.success) throw new ChainError("VALIDATION_FAILED", "x402: malformed requirement");
    const r = e.data;
    const amount = version === 2 ? r.amount : r.maxAmountRequired;
    const rawNetwork = typeof r.network === "string" ? r.network : "";
    const network =
      version === 2 ? networkFromCaip2(rawNetwork) : (V1_NETWORKS[rawNetwork] ?? null);
    if (
      typeof r.scheme !== "string" ||
      typeof amount !== "string" ||
      !BaseUnitAmountSchema.safeParse(amount).success
    ) {
      throw new ChainError(
        "VALIDATION_FAILED",
        "x402: requirement needs scheme and an integer amount",
      );
    }
    if (typeof r.asset !== "string" || typeof r.payTo !== "string") {
      throw new ChainError("VALIDATION_FAILED", "x402: requirement needs asset and payTo");
    }
    const timeout =
      typeof r.maxTimeoutSeconds === "number" && Number.isInteger(r.maxTimeoutSeconds)
        ? r.maxTimeoutSeconds
        : 60;
    const extra = JsonRecord.safeParse(r.extra ?? {});
    return {
      x402Version: version,
      scheme: r.scheme,
      network,
      caip2: network === null ? rawNetwork : NETWORKS[network].caip2,
      amount,
      asset: r.asset,
      payTo: r.payTo,
      maxTimeoutSeconds: timeout,
      extra: extra.success ? toJsonObject(extra.data) : {},
      resourceUrl: version === 1 && typeof r.resource === "string" ? r.resource : resourceUrl,
      raw: toJsonObject(r),
    };
  });
  return {
    x402Version: version,
    resourceUrl,
    resource: resource?.success === true ? toJsonObject(resource.data) : null,
    accepts: normalized,
  };
}

function base64Decode(value: string): string {
  const bin = atob(value);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64Encode(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Parse an HTTP 402 response: v2 carries base64 JSON in the PAYMENT-REQUIRED header, v1 puts
 * the JSON in the body. Throws VALIDATION_FAILED on anything else.
 */
export function parseX402Response(input: {
  status: number;
  headers: HeaderReader;
  body: unknown;
}): X402PaymentRequired {
  if (input.status !== 402)
    throw new ChainError("VALIDATION_FAILED", "x402: response is not 402 Payment Required");
  const header = input.headers.get("payment-required");
  if (header !== null) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(base64Decode(header.trim()));
    } catch {
      throw new ChainError("VALIDATION_FAILED", "x402: PAYMENT-REQUIRED header is not base64 JSON");
    }
    return normalizePaymentRequired(decoded);
  }
  const body = typeof input.body === "string" ? (JSON.parse(input.body) as unknown) : input.body;
  return normalizePaymentRequired(body);
}

export interface X402AdapterConfig extends HttpOptions {
  /**
   * Hard per-payment caps in base units, per asset. A payment for an asset without a cap is
   * refused: the adapter never pays above (or without) a configured ceiling, whatever the
   * agent's maxAmount says.
   */
  readonly caps: Partial<Record<AssetId, BaseUnitAmount>>;
  /** Solana RPC per network, needed to build SVM payments. */
  readonly solanaRpcUrls?: Partial<Record<NetworkId, string>>;
  /** Refuse requirements asking for longer validity. Default 600 s. */
  readonly maxTimeoutSeconds?: number;
  /**
   * Live `coinsPerUtxoByte` of a Cardano network (Blockfrost protocol parameters): the
   * Masumi lock datum's collateral depends on it. Without it masumi requirements are refused.
   */
  readonly cardanoCoinsPerUtxoByte?: (network: NetworkId) => Promise<bigint>;
  /**
   * The Masumi registry of a Cardano network (./masumi-registry.ts): a masumi requirement
   * whose terms claim a registered agent is paid only when the claim verifies. Without it
   * (or when it returns null) such claims are refused; unregistered sellers are unaffected.
   */
  readonly masumiRegistry?: (
    network: NetworkId,
  ) => Pick<MasumiRegistryClient, "verifySeller"> | null;
  readonly now?: () => Date;
}

/** x402 Cardano transfer methods ZyroPay pays with. */
export type X402CardanoMethod = "default" | "masumi";

/** The requirement's Cardano transfer method (absent = default), or the raw value. */
export function x402TransferMethodOf(req: Pick<X402Requirement, "extra">): string {
  const method = req.extra.assetTransferMethod;
  return method === undefined ? "default" : typeof method === "string" ? method : "?";
}

const PayParamsSchema = z.strictObject({
  paymentRequired: JsonRecord,
  resourceUrl: z.url({ protocol: /^https$/ }),
  method: z.enum(["GET", "POST"]).default("GET"),
  maxAmount: BaseUnitAmountSchema,
  assetId: AssetIdSchema,
  payer: z.string().min(32).max(64),
  /** Cardano: which transfer method to pay with (default: `default`). */
  transferMethod: z.enum(["default", "masumi"]).optional(),
});

/** What the payload binds to: the exact requirement the user/agent agreed to pay. */
export interface X402Terms {
  readonly x402Version: 1 | 2;
  readonly scheme: "exact";
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly resourceUrl: string;
  /** HTTP method of the paid retry (absent on payloads created before it was recorded). */
  readonly method?: "GET" | "POST";
  readonly accepted: JsonObject;
  readonly resource: JsonObject | null;
  readonly riskCategory: string;
  /** Cardano `masumi`: the escrow lock terms (datum included), bound by payloadHash. */
  readonly escrow?: MasumiEscrowTerms;
}

export interface X402EvmAuthorization {
  readonly kind: "eip712";
  readonly typedData: TypedDataDefinition<
    typeof TRANSFER_WITH_AUTHORIZATION_TYPES,
    "TransferWithAuthorization"
  >;
  /** EIP-712 digest to sign (Turnkey SIGN_RAW_PAYLOAD, or eth_signTypedData_v4 of typedData). */
  readonly digest: Hex;
  readonly payloadHash: string;
  readonly authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Compute-unit price for SVM payments: the spec allows at most 5 lamports/CU. */
const SVM_CU_PRICE = 1n;
const SVM_CU_LIMIT = 40_000;

export interface X402Adapter extends PluginAdapter {
  quote(input: { action: string; network: NetworkId; params: JsonObject }): Promise<PluginQuote>;
  /** EVM exact scheme: the EIP-3009 authorization to sign (there is no transaction). */
  buildPaymentAuthorization(input: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<X402EvmAuthorization>;
  /**
   * EVM exact scheme as a shared UnsignedTypedData: the authorization's EIP-712 typed data as
   * JSON (uint256 as decimal strings) plus its digest, for Turnkey SIGN_RAW_PAYLOAD.
   */
  buildTypedData(input: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTypedData>;
  /** Independent re-derivation of typed data + digest against the payload. Never throws. */
  verifyTypedData(
    typedData: UnsignedTypedData,
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
  /**
   * Solana: verifyX402SolanaPayment (base64). Cardano: the transfer verifier plus the x402
   * binding (hex). EVM: always {ok: false} (typed data).
   */
  verifyTransaction(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
  /** Value of the payment header for the retried request. */
  encodePaymentHeader(input: {
    payload: CanonicalTransactionPayload;
    evm?: { authorization: X402EvmAuthorization["authorization"]; signature: Hex };
    solana?: { signedTransaction: string };
    /** The signed transaction as stored (hex CBOR, vkey witness attached). */
    cardano?: { signedTransaction: string };
  }): { name: "PAYMENT-SIGNATURE" | "X-PAYMENT"; value: string };
}

export function createX402Adapter(config: X402AdapterConfig): X402Adapter {
  const manifest = manifestFor("x402");
  const now = config.now ?? (() => new Date());
  const registryOf = (
    network: NetworkId,
  ): { registry?: Pick<MasumiRegistryClient, "verifySeller"> } => {
    const registry = config.masumiRegistry?.(network) ?? null;
    return registry !== null ? { registry } : {};
  };
  const maxTimeout = config.maxTimeoutSeconds ?? 600;

  function termsOf(payload: CanonicalTransactionPayload): X402Terms {
    if (payload.plugin !== "x402" || payload.pluginData === null) {
      throw new ChainError("PAYLOAD_HASH_MISMATCH", "not an x402 payload");
    }
    return payload.pluginData as unknown as X402Terms;
  }

  async function buildSolana(
    payload: CanonicalTransactionPayload,
    terms: X402Terms,
  ): Promise<UnsignedTransaction> {
    const rpcUrl = config.solanaRpcUrls?.[payload.network];
    if (rpcUrl === undefined)
      throw new ChainError(
        "NETWORK_NOT_SUPPORTED",
        `no Solana RPC configured for ${payload.network}`,
      );
    const rpc = new SolanaRpc({ ...config, rpcUrl, network: payload.network });
    const feePayer =
      terms.accepted.extra !== null &&
      typeof terms.accepted.extra === "object" &&
      !Array.isArray(terms.accepted.extra)
        ? terms.accepted.extra.feePayer
        : undefined;
    if (typeof feePayer !== "string" || !isValidAddressForNetwork(payload.network, feePayer)) {
      throw new ChainError("VALIDATION_FAILED", "x402 SVM requirement has no valid extra.feePayer");
    }
    const mintInfo = await rpc.getMint(terms.asset);
    if (mintInfo === null)
      throw new ChainError("VALIDATION_FAILED", "x402 asset is not an SPL mint");
    if (mintInfo.decimals !== payload.asset.decimals)
      throw new ChainError("DECIMALS_MISMATCH", "x402 asset decimals differ");
    if (solanaPrograms.token2022TransferBlocker(mintInfo.extensions) !== null)
      throw new ChainError("VALIDATION_FAILED", "x402 asset has unsupported Token-2022 extensions");
    const tokenProgram = toAddress(mintInfo.programId);
    const mint = toAddress(terms.asset);
    const [source] = await findAssociatedTokenPda({
      owner: toAddress(payload.from),
      mint,
      tokenProgram,
    });
    const [destination] = await findAssociatedTokenPda({
      owner: toAddress(terms.payTo),
      mint,
      tokenProgram,
    });
    if ((await rpc.getAccountOwner(source)) === null)
      throw new ChainError("INSUFFICIENT_FUNDS", "payer has no token account for this asset");
    // The exact scheme allows no ATA creation: the merchant's token account must exist.
    if ((await rpc.getAccountOwner(destination)) === null)
      throw new ChainError("VALIDATION_FAILED", "payTo has no token account for this asset");
    const blockhash = await rpc.getLatestBlockhash("confirmed");
    const memoValue = (terms.accepted.extra as JsonObject | undefined)?.memo;
    const memoText = typeof memoValue === "string" ? memoValue : payloadHash(payload).slice(0, 32);
    const memo: Instruction = {
      programAddress: toAddress(solanaPrograms.MEMO_PROGRAM),
      accounts: [],
      data: new TextEncoder().encode(memoText.slice(0, 256)),
    };
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(toAddress(feePayer), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash.blockhash as Parameters<
              typeof setTransactionMessageLifetimeUsingBlockhash
            >[0]["blockhash"],
            lastValidBlockHeight: blockhash.lastValidBlockHeight,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: SVM_CU_LIMIT }),
            getSetComputeUnitPriceInstruction({ microLamports: SVM_CU_PRICE }),
            getTransferCheckedInstruction(
              {
                source,
                mint,
                destination,
                authority: createNoopSigner(toAddress(payload.from)),
                amount: parseBaseUnits(payload.amount),
                decimals: payload.asset.decimals,
              },
              { programAddress: tokenProgram },
            ),
            memo,
          ],
          m,
        ),
    );
    const serialized = getBase64EncodedWireTransaction(compileTransaction(message));
    const check = await verifyX402SolanaPayment(serialized, payload);
    if (!check.ok)
      throw new ChainError("INTERNAL_ERROR", `x402 self-check failed: ${check.reason}`);
    const height = await rpc.getBlockHeight("confirmed");
    const remaining =
      blockhash.lastValidBlockHeight > height ? Number(blockhash.lastValidBlockHeight - height) : 0;
    return {
      family: "solana",
      network: payload.network,
      payloadHash: payloadHash(payload),
      encoding: "base64",
      serialized,
      // The facilitator (fee payer) pays the network fee.
      estimatedFee: "0",
      validUntil: new Date(now().getTime() + remaining * 400).toISOString(),
      simulated: false,
    };
  }

  function authorize(raw: CanonicalTransactionPayload, quote: PluginQuote): X402EvmAuthorization {
    const payload = CanonicalTransactionPayloadSchema.parse(raw);
    assertPayloadMatchesQuote("x402", payload, quote, now());
    const terms = termsOf(payload);
    assertPayloadBinding(payload, terms);
    if (chainFamilyOf(payload.network) !== "evm") {
      throw new ChainError(
        "BAD_REQUEST",
        "authorizations are EVM-only; Solana uses buildTransaction",
      );
    }
    return evmAuthorization(payload, terms, now());
  }

  return {
    manifest,

    async quote(input) {
      if (input.action !== "pay")
        throw new ChainError("VALIDATION_FAILED", `unknown x402 action ${input.action}`);
      {
        if (!manifest.networks.includes(input.network))
          throw new ChainError("NETWORK_NOT_SUPPORTED", `x402 is not enabled on ${input.network}`);
        const params = parseParams(PayParamsSchema, input.params);
        const asset = parseAssetId(params.assetId);
        const family = chainFamilyOf(input.network);
        if (
          asset.network !== input.network ||
          (asset.tokenAddress === null && family !== "cardano")
        ) {
          throw new ChainError(
            "VALIDATION_FAILED",
            "x402 pays in a token on the requested network (ADA too on Cardano)",
          );
        }
        if (!isValidAddressForNetwork(input.network, params.payer))
          throw new ChainError("INVALID_ADDRESS", "payer is not valid for the network");
        const cap = config.caps[params.assetId];
        if (cap === undefined)
          throw new ChainError(
            "POLICY_DENIED",
            `no x402 cap configured for ${params.assetId}; refusing to pay`,
          );
        const required = normalizePaymentRequired(params.paymentRequired);
        const wanted = params.transferMethod ?? "default";
        const candidates = required.accepts.filter(
          (r) =>
            r.scheme === "exact" &&
            r.network === input.network &&
            x402AssetMatches(input.network, r.asset, params.assetId) &&
            // Cardano: only the transfer method asked for (escrow is never picked implicitly).
            (family !== "cardano" || x402TransferMethodOf(r) === wanted),
        );
        if (candidates.length === 0)
          throw new ChainError(
            "VALIDATION_FAILED",
            "no exact-scheme requirement for this asset and network",
          );
        // Cheapest acceptable option.
        candidates.sort((a, b) => (parseBaseUnits(a.amount) < parseBaseUnits(b.amount) ? -1 : 1));
        const req = candidates[0];
        if (req === undefined) throw new ChainError("VALIDATION_FAILED", "no requirement");
        const amount = parseBaseUnits(req.amount);
        if (amount === 0n) throw new ChainError("VALIDATION_FAILED", "x402 amount is zero");
        if (amount > parseBaseUnits(params.maxAmount)) {
          throw new ChainError(
            "POLICY_DENIED",
            `x402 asks ${req.amount}, above the agent's maxAmount ${params.maxAmount}`,
          );
        }
        if (amount > parseBaseUnits(cap))
          throw new ChainError(
            "POLICY_DENIED",
            `x402 asks ${req.amount}, above the configured cap ${cap}`,
          );
        const masumi = family === "cardano" && wanted === "masumi";
        // A masumi payTo is the escrow SCRIPT address (checked against the canonical one).
        if (!masumi && !isValidAddressForNetwork(input.network, req.payTo))
          throw new ChainError("INVALID_ADDRESS", "x402 payTo is not valid for the network");
        if (addressesEqual(family, req.payTo, params.payer))
          throw new ChainError("VALIDATION_FAILED", "x402 payTo is the payer");
        if (req.maxTimeoutSeconds <= 0 || req.maxTimeoutSeconds > maxTimeout)
          throw new ChainError("VALIDATION_FAILED", "x402 maxTimeoutSeconds out of range");
        // Bind to the resource the agent asked for: a 402 for another URL is refused.
        if (
          req.resourceUrl !== null &&
          normalizeResourceUrl(req.resourceUrl) !== normalizeResourceUrl(params.resourceUrl)
        ) {
          throw new ChainError(
            "VALIDATION_FAILED",
            "x402 requirement is for a different resource URL",
          );
        }
        if (family === "evm") {
          const method = req.extra.assetTransferMethod;
          if (method !== undefined && method !== "eip3009")
            throw new ChainError(
              "VALIDATION_FAILED",
              `x402 transfer method ${JSON.stringify(method)} is not supported`,
            );
          if (typeof req.extra.name !== "string" || typeof req.extra.version !== "string") {
            throw new ChainError(
              "VALIDATION_FAILED",
              "x402 EVM requirement needs extra.name and extra.version (EIP-712 domain)",
            );
          }
        } else if (family === "cardano") {
          if (req.x402Version !== 2)
            throw new ChainError("VALIDATION_FAILED", "x402 on Cardano is v2 only");
          // `script` locks funds at an arbitrary script with a server-chosen datum: never.
          // `masumi` is the one escrow ZyroPay understands (validated below).
          const method = x402TransferMethodOf(req);
          if (method !== "default" && method !== "masumi")
            throw new ChainError(
              "VALIDATION_FAILED",
              `x402 Cardano transfer method ${JSON.stringify(req.extra.assetTransferMethod)} is not supported`,
            );
          if (req.extra.areFeesSponsored === true)
            throw new ChainError("VALIDATION_FAILED", "sponsored Cardano fees are not supported");
        } else {
          const feePayer = req.extra.feePayer;
          if (typeof feePayer !== "string" || !isValidAddressForNetwork(input.network, feePayer)) {
            throw new ChainError("VALIDATION_FAILED", "x402 SVM requirement needs extra.feePayer");
          }
          if (feePayer === params.payer)
            throw new ChainError("VALIDATION_FAILED", "x402 feePayer is the payer");
        }
        let escrow: MasumiEscrowTerms | undefined;
        if (masumi) {
          if (config.cardanoCoinsPerUtxoByte === undefined)
            throw new ChainError("NETWORK_NOT_SUPPORTED", "masumi escrow is not configured");
          escrow = await quoteMasumiEscrow({
            network: input.network,
            requirement: req.raw,
            payer: params.payer,
            resourceUrl: params.resourceUrl,
            asset: req.asset,
            amount,
            maxTimeoutSeconds: req.maxTimeoutSeconds,
            coinsPerUtxoByte: await config.cardanoCoinsPerUtxoByte(input.network),
            now: now(),
            ...registryOf(input.network),
          });
        }
        const terms: X402Terms = {
          x402Version: req.x402Version,
          scheme: "exact",
          network: req.caip2,
          asset: req.asset,
          payTo: family === "evm" ? getAddress(req.payTo) : req.payTo,
          amount: req.amount,
          maxTimeoutSeconds: req.maxTimeoutSeconds,
          resourceUrl: normalizeResourceUrl(params.resourceUrl),
          method: params.method,
          accepted: req.raw,
          resource: required.resource,
          riskCategory: manifest.riskCategory,
          ...(escrow !== undefined ? { escrow } : {}),
        };
        const windowEnd = now().getTime() + req.maxTimeoutSeconds * 1000;
        return {
          pluginId: "x402",
          pluginData: toJsonObject(terms),
          inputAmount: req.amount,
          expectedOutputAmount: null,
          // A masumi lock is void after the seller's payByTime.
          expiresAt: new Date(
            escrow === undefined ? windowEnd : Math.min(windowEnd, Number(escrow.payByTime)),
          ).toISOString(),
          simulated: false,
        };
      }
    },

    async buildTransaction({ payload: raw, quote }) {
      const payload = CanonicalTransactionPayloadSchema.parse(raw);
      assertPayloadMatchesQuote("x402", payload, quote, now());
      const terms = termsOf(payload);
      assertPayloadBinding(payload, terms);
      const family = chainFamilyOf(payload.network);
      if (family === "evm") {
        throw new ChainError(
          "BAD_REQUEST",
          "x402 EVM payments are EIP-3009 authorizations, not transactions; use buildPaymentAuthorization",
        );
      }
      if (family === "cardano") {
        throw new ChainError(
          "BAD_REQUEST",
          "x402 Cardano payments are plain transfers; build them with the network's builder",
        );
      }
      return buildSolana(payload, terms);
    },

    buildPaymentAuthorization({ payload, quote }) {
      return Promise.resolve().then(() => authorize(payload, quote));
    },

    buildTypedData({ payload: raw, quote }) {
      return Promise.resolve().then(() => {
        const payload = CanonicalTransactionPayloadSchema.parse(raw);
        const auth = authorize(payload, quote);
        const unsigned: UnsignedTypedData = {
          kind: "eip712",
          network: payload.network,
          payloadHash: auth.payloadHash,
          typedData: x402TypedDataToJson(auth.typedData),
          digest: auth.digest.toLowerCase(),
          validUntil: new Date(Number(auth.authorization.validBefore) * 1000).toISOString(),
          simulated: false,
        };
        const check = verifyX402TypedData(unsigned, payload);
        if (!check.ok)
          throw new ChainError("INTERNAL_ERROR", `x402 self-check failed: ${check.reason}`);
        return unsigned;
      });
    },

    verifyTypedData(typedData, payload) {
      return Promise.resolve(verifyX402TypedData(typedData, payload));
    },

    verifyTransaction(serialized, encoding, payload) {
      if (chainFamilyOf(payload.network) === "evm")
        return Promise.resolve({
          ok: false,
          reason: "x402 EVM payments are typed data, not transactions",
        });
      if (chainFamilyOf(payload.network) === "cardano")
        return runVerifier("x402", "hex", encoding, payload, (p) => {
          assertPayloadBinding(p, termsOf(p));
          const escrow = masumiEscrowTermsOf(p.pluginData);
          if (escrow === null) return verifyCardanoTransfer(serialized, encoding, p, p.network);
          return verifyX402MasumiLock(serialized, p, escrow);
        });
      return runVerifier("x402", "base64", encoding, payload, (p) => {
        if (chainFamilyOf(p.network) !== "solana")
          return { ok: false, reason: "x402 EVM payments are typed data, not transactions" };
        assertPayloadBinding(p, termsOf(p));
        return verifyX402SolanaPayment(serialized, p);
      });
    },

    encodePaymentHeader({ payload, evm, solana, cardano }) {
      const inner =
        evm !== undefined
          ? { signature: evm.signature, authorization: evm.authorization }
          : solana !== undefined
            ? { transaction: solana.signedTransaction }
            : cardano !== undefined
              ? cardanoPaymentPayload(cardano.signedTransaction)
              : null;
      if (inner === null) throw new ChainError("BAD_REQUEST", "missing signed payment");
      return x402PaymentHeader(payload, inner);
    },
  };
}

/**
 * The retried request's payment header for a payload and its scheme-specific signed payment
 * (`payload` field): v2 PAYMENT-SIGNATURE echoing the accepted requirement and the resource,
 * v1 X-PAYMENT.
 */
export function x402PaymentHeader(
  payload: CanonicalTransactionPayload,
  inner: Record<string, unknown>,
): { name: "PAYMENT-SIGNATURE" | "X-PAYMENT"; value: string } {
  if (payload.plugin !== "x402" || payload.pluginData === null)
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "not an x402 payload");
  const terms = payload.pluginData as unknown as X402Terms;
  if (terms.x402Version === 2) {
    const body: Record<string, unknown> = {
      x402Version: 2,
      accepted: terms.accepted,
      payload: inner,
    };
    if (terms.resource !== null) body.resource = terms.resource;
    return { name: "PAYMENT-SIGNATURE", value: base64Encode(JSON.stringify(body)) };
  }
  return {
    name: "X-PAYMENT",
    value: base64Encode(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: terms.accepted.network,
        payload: inner,
      }),
    ),
  };
}

function assertPayloadBinding(payload: CanonicalTransactionPayload, terms: X402Terms): void {
  const family = chainFamilyOf(payload.network);
  if (terms.network !== NETWORKS[payload.network].caip2)
    throw new ChainError("NETWORK_MODE_MISMATCH", "x402 terms are for another network");
  if (!addressesEqual(family, payload.to, terms.payTo))
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload recipient is not payTo");
  if (payload.amount !== terms.amount)
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload amount is not the x402 amount");
  if (!x402AssetMatches(payload.network, terms.asset, payload.asset.id))
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload asset is not the x402 asset");
}

/**
 * Independent check of an unsigned Masumi lock against the payload: the bound escrow terms
 * still describe this payload (buyer, seller, deadlines in the datum), then the lock is
 * exactly one map-format output to the escrow with exactly the locked value and the bound
 * datum byte for byte (verifyCardanoEscrowLock), a TTL no later than payByTime, and a fee
 * within the payload's feeCap.
 */
export function verifyX402MasumiLock(
  serialized: string,
  payload: CanonicalTransactionPayload,
  escrow: MasumiEscrowTerms,
): VerificationResult {
  try {
    assertMasumiEscrowBinding(escrow, payload);
    const token = parseAssetId(payload.asset.id).tokenAddress;
    const amount = parseBaseUnits(payload.amount);
    const locked = BigInt(escrow.lockedLovelace);
    const collateral = BigInt(escrow.collateralLovelace);
    // ADA: locked = price + collateral. Token: locked = collateral, plus exactly the token.
    if (locked !== (token === null ? amount : 0n) + collateral)
      return { ok: false, reason: "locked lovelace does not match the price" };
    return verifyCardanoEscrowLock(serialized, {
      network: payload.network,
      from: payload.from,
      escrowAddress: escrow.escrowAddress,
      lovelace: locked,
      ...(token !== null ? { assets: new Map([[token.toLowerCase(), amount]]) } : {}),
      datumCbor: escrow.datumCbor,
      maxTtlSlot: cardanoPosixMsToSlot(payload.network, BigInt(escrow.payByTime), "floor"),
      feeCap: parseBaseUnits(payload.feeCap),
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid escrow lock" };
  }
}

/**
 * Cardano exact-scheme payload: the signed transaction as base64 CBOR and a nonce naming one
 * of its inputs (`<txHash>#<index>`): the facilitator's replay key, spent once the payment
 * lands. Refuses anything that is not a signed transaction.
 */
export function cardanoPaymentPayload(signedHex: string): { transaction: string; nonce: string } {
  if (!/^(?:[0-9a-f]{2})+$/.test(signedHex))
    throw new ChainError("VALIDATION_FAILED", "signed Cardano transaction must be hex CBOR");
  const bytes = Uint8Array.from(signedHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const tx = decodeCardanoTx(bytes, { strict: true });
  if (tx.witnessKeys.length === 0)
    throw new ChainError("VALIDATION_FAILED", "Cardano transaction is not signed");
  const [first] = tx.inputs;
  if (first === undefined)
    throw new ChainError("VALIDATION_FAILED", "Cardano transaction has no inputs");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { transaction: btoa(bin), nonce: `${first.txHash}#${String(first.index)}` };
}

/** EIP-3009 TransferWithAuthorization for the payload. Deterministic: nonce = keccak(payloadHash). */
export function evmAuthorization(
  payload: CanonicalTransactionPayload,
  terms: X402Terms,
  now: Date,
): X402EvmAuthorization {
  const extra = terms.accepted.extra as JsonObject;
  const hash = payloadHash(payload);
  const expiry = Math.floor(Date.parse(payload.expiresAt) / 1000);
  const windowEnd = Math.floor(now.getTime() / 1000) + terms.maxTimeoutSeconds;
  const validBefore = Math.min(expiry, windowEnd);
  const authorization = {
    from: getAddress(payload.from),
    to: getAddress(terms.payTo),
    value: terms.amount,
    validAfter: "0",
    validBefore: String(validBefore),
    nonce: keccak256(toHex(hash)),
  };
  const typedData = {
    domain: {
      name: typeof extra.name === "string" ? extra.name : "",
      version: typeof extra.version === "string" ? extra.version : "",
      chainId: NETWORKS[payload.network].evmChainId ?? 0,
      verifyingContract: getAddress(terms.asset),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce: authorization.nonce,
    },
  };
  return {
    kind: "eip712",
    typedData,
    digest: hashTypedData(typedData),
    payloadHash: hash,
    authorization,
  };
}

/**
 * Independent check of an EIP-3009 authorization against the payload (ADR-001 C7 for x402).
 */
export function verifyX402Authorization(
  auth: X402EvmAuthorization,
  payload: CanonicalTransactionPayload,
): { ok: true } | { ok: false; reason: string } {
  try {
    const terms = payload.pluginData as unknown as X402Terms;
    const extra = terms.accepted.extra as JsonObject;
    const m = auth.typedData.message;
    const d = auth.typedData.domain;
    if (d?.chainId !== NETWORKS[payload.network].evmChainId)
      return { ok: false, reason: "wrong chain id" };
    if (
      d.verifyingContract === undefined ||
      !addressesEqual("evm", d.verifyingContract, terms.asset)
    )
      return { ok: false, reason: "wrong token contract" };
    if (d.name !== extra.name || d.version !== extra.version)
      return { ok: false, reason: "wrong EIP-712 domain" };
    if (!addressesEqual("evm", m.from, payload.from)) return { ok: false, reason: "wrong payer" };
    if (!addressesEqual("evm", m.to, payload.to) || !addressesEqual("evm", m.to, terms.payTo))
      return { ok: false, reason: "wrong recipient" };
    if (m.value !== parseBaseUnits(payload.amount)) return { ok: false, reason: "wrong amount" };
    if (m.validAfter !== 0n) return { ok: false, reason: "unexpected validAfter" };
    if (m.validBefore > BigInt(Math.floor(Date.parse(payload.expiresAt) / 1000)))
      return { ok: false, reason: "authorization outlives the approval" };
    if (m.nonce !== keccak256(toHex(payloadHash(payload))))
      return { ok: false, reason: "nonce not bound to payload" };
    if (hashTypedData(auth.typedData) !== auth.digest)
      return { ok: false, reason: "digest mismatch" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid authorization" };
  }
}

type TransferWithAuthorizationTypedData = X402EvmAuthorization["typedData"];

/**
 * JSON form of x402 TransferWithAuthorization typed data (shared UnsignedTypedData.typedData):
 * uint256 message fields as decimal strings, domain chainId kept as a number.
 */
export function x402TypedDataToJson(typedData: TransferWithAuthorizationTypedData): JsonObject {
  const d = typedData.domain;
  const m = typedData.message;
  return toJsonObject({
    domain: {
      name: d?.name,
      version: d?.version,
      chainId: Number(d?.chainId),
      verifyingContract: d?.verifyingContract,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: m.from,
      to: m.to,
      value: m.value.toString(),
      validAfter: m.validAfter.toString(),
      validBefore: m.validBefore.toString(),
      nonce: m.nonce,
    },
  });
}

const MAX_UINT256 = (1n << 256n) - 1n;
const EvmAddressJson = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Uint256Json = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => /^[0-9]+$/.test(v) && BigInt(v) <= MAX_UINT256, "uint256 out of range");
const TypedDataJsonSchema = z.strictObject({
  domain: z.strictObject({
    name: z.string().max(256),
    version: z.string().max(64),
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    verifyingContract: EvmAddressJson,
  }),
  types: z.unknown(),
  primaryType: z.literal("TransferWithAuthorization"),
  message: z.strictObject({
    from: EvmAddressJson,
    to: EvmAddressJson,
    value: Uint256Json,
    validAfter: Uint256Json,
    validBefore: Uint256Json,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});

/**
 * Inverse of x402TypedDataToJson: strict (unknown keys, other types or primaryType rejected),
 * uint256 fields back to bigint. Throws VALIDATION_FAILED on any malformed field.
 */
export function x402TypedDataFromJson(json: unknown): TransferWithAuthorizationTypedData {
  const parsed = TypedDataJsonSchema.safeParse(json);
  if (!parsed.success) throw new ChainError("VALIDATION_FAILED", "x402 typed data is malformed");
  const { domain, types, message } = parsed.data;
  if (JSON.stringify(types) !== JSON.stringify(TRANSFER_WITH_AUTHORIZATION_TYPES))
    throw new ChainError("VALIDATION_FAILED", "x402 typed data has unexpected types");
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: getAddress(domain.verifyingContract),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(message.from),
      to: getAddress(message.to),
      value: BigInt(message.value),
      validAfter: BigInt(message.validAfter),
      validBefore: BigInt(message.validBefore),
      nonce: message.nonce.toLowerCase() as Hex,
    },
  };
}

/**
 * Independent check of a shared UnsignedTypedData (x402 EVM) against the payload: network,
 * payloadHash, strict JSON shape, digest = hashTypedData(rehydrated), validUntil consistent
 * with validBefore, payload <-> terms binding, then verifyX402Authorization. Fails closed.
 */
export function verifyX402TypedData(
  unsigned: UnsignedTypedData,
  rawPayload: CanonicalTransactionPayload,
): VerificationResult {
  try {
    const parsedPayload = CanonicalTransactionPayloadSchema.safeParse(rawPayload);
    if (!parsedPayload.success) return { ok: false, reason: "invalid payload" };
    const payload = parsedPayload.data;
    if (payload.plugin !== "x402" || payload.pluginData === null)
      return { ok: false, reason: "not an x402 payload" };
    if (chainFamilyOf(payload.network) !== "evm")
      return { ok: false, reason: "typed data is EVM-only" };
    if ((unsigned.kind as string) !== "eip712")
      return { ok: false, reason: "not EIP-712 typed data" };
    if (unsigned.simulated) return { ok: false, reason: "simulated typed data" };
    if (unsigned.network !== payload.network) return { ok: false, reason: "wrong network" };
    if (unsigned.payloadHash !== payloadHash(payload))
      return { ok: false, reason: "payload hash mismatch" };
    if (typeof unsigned.digest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(unsigned.digest))
      return { ok: false, reason: "malformed digest" };
    const typedData = x402TypedDataFromJson(unsigned.typedData);
    const digest = hashTypedData(typedData);
    if (unsigned.digest.toLowerCase() !== digest.toLowerCase())
      return { ok: false, reason: "digest mismatch" };
    const expectedUntil = new Date(Number(typedData.message.validBefore) * 1000).toISOString();
    if (unsigned.validUntil !== null && unsigned.validUntil !== expectedUntil)
      return { ok: false, reason: "validUntil does not match validBefore" };
    assertPayloadBinding(payload, payload.pluginData as unknown as X402Terms);
    const m = typedData.message;
    return verifyX402Authorization(
      {
        kind: "eip712",
        typedData,
        digest,
        payloadHash: unsigned.payloadHash,
        authorization: {
          from: m.from,
          to: m.to,
          value: m.value.toString(),
          validAfter: m.validAfter.toString(),
          validBefore: m.validBefore.toString(),
          nonce: m.nonce,
        },
      },
      payload,
    );
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid typed data" };
  }
}

/**
 * Independent decode of an x402 SVM payment (exact scheme layout): ComputeBudget limit+price
 * (<= 5 lamports/CU), one TransferChecked payer->payTo ATA of the exact amount, optional Memo.
 * The facilitator is fee payer and appears in no instruction.
 */
export async function verifyX402SolanaPayment(
  serialized: string,
  payload: CanonicalTransactionPayload,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const terms = payload.pluginData as unknown as X402Terms;
    const feePayer = (terms.accepted.extra as JsonObject).feePayer;
    const tx = decodeSolanaTransaction(serialized);
    if (tx.usesLookupTables) return { ok: false, reason: "lookup tables not allowed" };
    if (tx.feePayer !== feePayer) return { ok: false, reason: "fee payer is not the facilitator" };
    if (tx.numSigners !== 2 || tx.staticAccounts[1] !== payload.from)
      return { ok: false, reason: "signers must be facilitator + payer" };
    const budget = readComputeBudget(tx.instructions);
    if (budget.microLamportsPerCu > 5_000_000n)
      return { ok: false, reason: "compute unit price above 5 lamports/CU" };
    let transfers = 0;
    for (const ix of budget.otherInstructions) {
      if (ix.accounts.some((a) => a.address === feePayer))
        return { ok: false, reason: "fee payer used inside an instruction" };
      if (ix.programAddress === solanaPrograms.MEMO_PROGRAM) continue;
      if (
        ix.programAddress !== solanaPrograms.TOKEN_PROGRAM &&
        ix.programAddress !== solanaPrograms.TOKEN_2022_PROGRAM
      ) {
        return { ok: false, reason: `unexpected program ${ix.programAddress}` };
      }
      if (identifyTokenInstruction(ix) !== TokenInstruction.TransferChecked)
        return { ok: false, reason: "token instruction is not TransferChecked" };
      const t = parseTransferCheckedInstruction(ix);
      const program = ix.programAddress;
      const [source] = await findAssociatedTokenPda({
        owner: toAddress(payload.from),
        mint: toAddress(terms.asset),
        tokenProgram: program,
      });
      const [destination] = await findAssociatedTokenPda({
        owner: toAddress(terms.payTo),
        mint: toAddress(terms.asset),
        tokenProgram: program,
      });
      if (t.accounts.mint.address !== terms.asset) return { ok: false, reason: "wrong mint" };
      if (t.accounts.source.address !== source || t.accounts.authority.address !== payload.from)
        return { ok: false, reason: "wrong source" };
      if (t.accounts.destination.address !== destination)
        return { ok: false, reason: "destination is not payTo's token account" };
      if (t.data.amount !== parseBaseUnits(payload.amount))
        return { ok: false, reason: "wrong amount" };
      if (t.data.decimals !== payload.asset.decimals)
        return { ok: false, reason: "wrong decimals" };
      transfers++;
    }
    if (transfers !== 1) return { ok: false, reason: "expected exactly one TransferChecked" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "cannot decode" };
  }
}

export { base64Decode as decodeBase64Text, base64Encode as encodeBase64Text };
