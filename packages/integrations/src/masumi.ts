/*
 * Masumi escrow (x402 Cardano `assetTransferMethod: "masumi"`, payment-v2 `vested_pay`), buyer
 * side. Spec: docs/CARDANO_X402.md "Masumi escrow".
 *
 * Nothing runs on chain when the funds are locked, so a malformed datum would strand them:
 * every lock rule is checked here, before anything is signed, with the reference
 * implementation's own pure functions (`@x402/cardano` 2.29, which the facilitator uses):
 *  - validateMasumiExtra (wire schema) + verifyMasumiAuthorization (seller COSE signature over
 *    the terms digest, request commitment recomputed from echoed content, payTo == derived
 *    escrow address, deadline rules, 30-day horizon). A registered-agent claim
 *    (`terms.agentIdentifier`) is honoured only with a registry check (./masumi-registry.ts):
 *    the signing key holds the live registry NFT whose metadata names this endpoint and price;
 *    without one any claim is refused;
 *  - the payment window (payByTime in the future, within maxTimeoutSeconds), the canonical
 *    deployment only, the commitment naming the paid resource URL;
 *  - buildMasumiLock (the 19-field FundsLocked datum and the exact lovelace to lock), then a
 *    field-by-field round trip through parseMasumiLockDatum against the signed terms.
 * The result is bound into the payload's pluginData (`escrow`, including the datum bytes),
 * so payloadHash commits to it and the lock verifier checks the transaction carries exactly
 * that datum.
 *
 * Refund spends (SetRefundRequested, WithdrawRefund) need the datum's state and a continuing
 * datum computed per vested_pay.ak: `masumiEscrowView` and `masumiRefundRequestDatum`.
 */
import { Data } from "@evolution-sdk/evolution";
import type { CardanoExtraMasumi, MasumiDatumView, MasumiRegistryValidator } from "@x402/cardano";
import {
  buildMasumiLock,
  MASUMI_DEFAULT_DEPLOYMENT,
  MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE,
  MASUMI_MAX_DEADLINE_HORIZON_MS,
  parseMasumiLockDatum,
  validateMasumiExtra,
  verifyMasumiAuthorization,
} from "@x402/cardano";
import { ChainError, masumiEscrowAddress } from "@zyropay/blockchain";
import type { JsonObject, NetworkId } from "@zyropay/shared";
import {
  cardanoPaymentKeyHash,
  chainFamilyOf,
  MASUMI_ESCROW_ADDRESSES,
  parseShelleyAddress,
} from "@zyropay/shared";
import type { MasumiRegistryClient, MasumiVerifyResult } from "./masumi-registry";

/** The escrow terms ZyroPay binds into an x402 payload's pluginData (`escrow`). */
export interface MasumiEscrowTerms {
  readonly method: "masumi";
  readonly escrowAddress: string;
  /** Seller-signed terms digest (x402 settlement key). */
  readonly termsDigest: string;
  readonly sellerAddress: string;
  /** Exact inline datum of the lock (hex CBOR, FundsLocked). */
  readonly datumCbor: string;
  /** Lovelace on the escrow output (price for ADA payments + collateral). */
  readonly lockedLovelace: string;
  /** datum collateral_return_lovelace: returns to the buyer in every outcome. */
  readonly collateralLovelace: string;
  readonly coinsPerUtxoByte: string;
  readonly inputHash: string;
  /** POSIX ms, decimal strings (seller-signed). */
  readonly payByTime: string;
  readonly submitResultTime: string;
  readonly unlockTime: string;
  readonly externalDisputeUnlockTime: string;
  /** vested_pay cooldown_period of the canonical deployment (ms). */
  readonly cooldownPeriodMs: string;
  /**
   * The seller's verified Masumi registry identity (datum `agent_identifier`): the
   * agentIdentifier (policy id + asset name, 120 hex) and its registered name, or null for an
   * unregistered seller. Only a claim that passed the registry check is ever bound here.
   * Absent on payloads quoted before registry support (= null).
   */
  readonly agentIdentifier?: string | null;
  readonly agentName?: string | null;
  /** Payment key hash of `sellerAddress` (Masumi `sellerVkey`). */
  readonly sellerPaymentKeyHash?: string;
}

/** The user must have time to approve with the passkey before payByTime. */
const MIN_PAY_WINDOW_MS = 60_000;
/** Tolerated clock skew between ZyroPay and the seller. */
const CLOCK_SKEW_MS = 30_000;

const fail = (message: string): never => {
  throw new ChainError("VALIDATION_FAILED", `x402 masumi: ${message}`);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

interface Credentials {
  readonly payment: string;
  readonly stake: { readonly hash: string; readonly isScript: boolean } | null;
}

/**
 * Payment key hash and stake credential of a base or enterprise key address (the datum
 * encodes both); throws for script, pointer, reward and malformed addresses.
 */
function credentials(address: string, what: string): Credentials {
  const parsed = parseShelleyAddress(address);
  const payment = cardanoPaymentKeyHash(address);
  if (parsed === null || payment === null) return fail(`${what} must be a payment-key address`);
  if (parsed.type <= 3) {
    const hash = Array.from(parsed.bytes.subarray(29, 57), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return { payment, stake: { hash, isScript: parsed.type === 2 || parsed.type === 3 } };
  }
  if (parsed.type === 6) return { payment, stake: null };
  return fail(`${what} must be a base or enterprise address`);
}

function sameCredentials(view: MasumiDatumView["buyer"], expected: Credentials): boolean {
  if (view.payment.isScript || view.payment.hash !== expected.payment) return false;
  if (view.pointer !== undefined) return false;
  if (expected.stake === null) return view.stake === undefined;
  return (
    view.stake !== undefined &&
    view.stake.isScript === expected.stake.isScript &&
    view.stake.hash === expected.stake.hash
  );
}

/**
 * Round trip of a lock datum against the terms it must encode. Fails closed on any field:
 * the datum is what the escrow will be judged by, forever.
 */
function assertLockDatum(
  datumCbor: string,
  input: {
    buyer: string;
    extra: CardanoExtraMasumi;
    collateralLovelace: bigint;
  },
): void {
  const view = parseMasumiLockDatum(datumCbor);
  if (view === null) return fail("the built datum does not decode as a vested_pay datum");
  const { extra } = input;
  const t = extra.terms;
  const checks: [boolean, string][] = [
    [sameCredentials(view.buyer, credentials(input.buyer, "the buyer")), "buyer"],
    [view.buyerReturnAddress === null, "buyer_return_address"],
    [sameCredentials(view.seller, credentials(t.sellerAddress, "the seller")), "seller"],
    [view.sellerReturnAddress === null, "seller_return_address"],
    [view.referenceKey === extra.referenceKey.toLowerCase(), "reference_key"],
    [view.referenceSignature === extra.referenceSignature.toLowerCase(), "reference_signature"],
    [view.sellerNonce === t.sellerNonce, "seller_nonce"],
    [view.buyerNonce === t.buyerNonce, "buyer_nonce"],
    [view.agentIdentifier === (t.agentIdentifier ?? ""), "agent_identifier"],
    [view.collateralReturnLovelace === input.collateralLovelace, "collateral_return_lovelace"],
    [view.inputHash === t.inputHash, "input_hash"],
    [view.resultHash === "", "result_hash"],
    [view.payByTime === BigInt(t.payByTime), "pay_by_time"],
    [view.submitResultTime === BigInt(t.submitResultTime), "submit_result_time"],
    [view.unlockTime === BigInt(t.unlockTime), "unlock_time"],
    [view.externalDisputeUnlockTime === BigInt(t.externalDisputeUnlockTime), "dispute_time"],
    [view.sellerCooldownTime === 0n && view.buyerCooldownTime === 0n, "cooldowns"],
    [view.state === 0n, "state"],
  ];
  const wrong = checks.find(([ok]) => !ok);
  if (wrong !== undefined) fail(`the built datum has a wrong ${wrong[1]}`);
}

export interface MasumiQuoteInput {
  readonly network: NetworkId;
  /** The accepted requirement exactly as the server sent it. */
  readonly requirement: JsonObject;
  readonly payer: string;
  readonly resourceUrl: string;
  /** Requested asset unit ("lovelace" or "<policy>.<name>") and amount (base units). */
  readonly asset: string;
  readonly amount: bigint;
  readonly maxTimeoutSeconds: number;
  readonly coinsPerUtxoByte: bigint;
  readonly now: Date;
  /**
   * Registry check for a registered-agent claim (`terms.agentIdentifier`). Without
   * `registry` or `registryValidator` a claim is refused; unregistered sellers need neither.
   * `registry` also records the verified name in the terms (`agentName`).
   */
  readonly registry?: Pick<MasumiRegistryClient, "verifySeller">;
  readonly registryValidator?: MasumiRegistryValidator;
}

/**
 * Validate a masumi requirement and build the lock terms. Throws VALIDATION_FAILED (or
 * NETWORK_NOT_SUPPORTED) on anything ZyroPay would not lock funds for.
 */
export async function quoteMasumiEscrow(input: MasumiQuoteInput): Promise<MasumiEscrowTerms> {
  const { network, requirement } = input;
  if (chainFamilyOf(network) !== "cardano")
    throw new ChainError("NETWORK_NOT_SUPPORTED", "masumi escrow is Cardano-only");
  const canonical = MASUMI_ESCROW_ADDRESSES[network];
  if (canonical === undefined || canonical !== masumiEscrowAddress(network))
    throw new ChainError("NETWORK_NOT_SUPPORTED", `no Masumi escrow on ${network}`);
  const wireNetwork = typeof requirement.network === "string" ? requirement.network : "";
  const schema = validateMasumiExtra(requirement.extra, wireNetwork);
  if (!schema.ok) return fail(`malformed extra (${schema.detail})`);
  const extra = schema.extra;
  // Only the canonical (2-of-3 admins, 7 min cooldown) deployment: ZyroPay's spend builder
  // carries exactly that script, and a look-alike validator is another trust domain.
  if (extra.deployment !== undefined) fail("non-canonical escrow deployments are not supported");
  if (requirement.payTo !== canonical) fail("payTo is not the canonical Masumi escrow address");
  const t = extra.terms;
  const claimed = t.agentIdentifier != null && t.agentIdentifier !== "";
  // The registry check, recording its verdict (for a precise refusal and the bound name).
  let verdict: MasumiVerifyResult | null = null;
  const registry = input.registry;
  const validator: MasumiRegistryValidator | undefined =
    registry !== undefined
      ? async (claim) => {
          try {
            verdict = await registry.verifySeller({
              agentIdentifier: claim.agentIdentifier,
              sellerAddress: claim.sellerAddress,
              resourceUrl: claim.resource.url,
              asset: claim.asset,
              amount: claim.amount,
              requireEscrow: true,
            });
            return verdict.ok;
          } catch {
            return false;
          }
        }
      : input.registryValidator;
  if (claimed && validator === undefined)
    fail("registered-agent claims need the registry check, which is not configured");
  const auth = await verifyMasumiAuthorization(
    extra,
    requirement as unknown as Parameters<typeof verifyMasumiAuthorization>[1],
    {
      requireAllPartContent: true,
      maxDeadlineHorizonMs: MASUMI_MAX_DEADLINE_HORIZON_MS,
      resource: { url: input.resourceUrl },
      ...(validator !== undefined ? { validateRegistryClaim: validator } : {}),
    },
  );
  if (!auth.ok) {
    const v = verdict as MasumiVerifyResult | null;
    // An unreadable registry says nothing about the seller: a retryable outage, not a refusal.
    if (claimed && v !== null && !v.ok && v.reasons.includes("upstream_unavailable"))
      throw new ChainError(
        "UPSTREAM_UNAVAILABLE",
        "x402 masumi: the Masumi registry could not be read to verify the seller; retry",
        { retryable: true },
      );
    if (claimed && v !== null && !v.ok)
      fail(`the seller's Masumi registry identity did not verify (${v.reasons.join(", ")})`);
    return fail(`seller authorization rejected (${auth.reason})`);
  }
  if (auth.escrowAddress !== canonical) fail("derived escrow address differs");
  const agentIdentifier = claimed ? (t.agentIdentifier as string).toLowerCase() : null;
  const verified = verdict as MasumiVerifyResult | null;
  const seller = credentials(t.sellerAddress, "the seller");
  if (seller.payment === cardanoPaymentKeyHash(input.payer)) fail("the seller is the payer");
  const sellerParsed = parseShelleyAddress(t.sellerAddress);
  const payerParsed = parseShelleyAddress(input.payer);
  if (sellerParsed?.networkId !== payerParsed?.networkId) fail("the seller is on another network");

  const nowMs = BigInt(input.now.getTime());
  const payBy = BigInt(t.payByTime);
  if (payBy <= nowMs + BigInt(MIN_PAY_WINDOW_MS))
    fail("payByTime is too close (no time left to approve)");
  if (payBy > nowMs + BigInt(input.maxTimeoutSeconds) * 1000n + BigInt(CLOCK_SKEW_MS))
    fail("payByTime is beyond maxTimeoutSeconds");

  // The commitment says what the seller must deliver: its resource part must be this URL.
  for (const part of extra.inputCommitment.parts) {
    if (part.name !== "resource") continue;
    const url: unknown = isRecord(part.content) ? part.content.url : undefined;
    if (typeof url !== "string" || !sameUrl(url, input.resourceUrl))
      fail("the request commitment names another resource");
  }

  const lock = buildMasumiLock(
    extra,
    input.payer,
    input.asset,
    input.amount,
    input.coinsPerUtxoByte,
  );
  if (
    lock.collateralLovelace < 0n ||
    lock.collateralLovelace > MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE
  )
    fail("collateral is out of range");
  const datumCbor = Data.toCBORHex(lock.datum.data).toLowerCase();
  assertLockDatum(datumCbor, {
    buyer: input.payer,
    extra,
    collateralLovelace: lock.collateralLovelace,
  });
  return {
    method: "masumi",
    escrowAddress: canonical,
    termsDigest: auth.termsDigest,
    sellerAddress: t.sellerAddress,
    datumCbor,
    lockedLovelace: lock.lockedLovelace.toString(),
    collateralLovelace: lock.collateralLovelace.toString(),
    coinsPerUtxoByte: input.coinsPerUtxoByte.toString(),
    inputHash: t.inputHash,
    payByTime: t.payByTime,
    submitResultTime: t.submitResultTime,
    unlockTime: t.unlockTime,
    externalDisputeUnlockTime: t.externalDisputeUnlockTime,
    cooldownPeriodMs: MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod,
    agentIdentifier,
    agentName: agentIdentifier !== null ? (verified?.agent?.name ?? null) : null,
    sellerPaymentKeyHash: seller.payment,
  };
}

const DECIMAL = /^(0|[1-9][0-9]{0,30})$/;

/** The `escrow` object of an x402 payload's pluginData, or null when it is not masumi. */
export function masumiEscrowTermsOf(
  pluginData: JsonObject | null | undefined,
): MasumiEscrowTerms | null {
  const escrow = pluginData?.escrow;
  if (!isRecord(escrow) || escrow.method !== "masumi") return null;
  const strings = [
    "escrowAddress",
    "termsDigest",
    "sellerAddress",
    "datumCbor",
    "inputHash",
  ] as const;
  const numbers = [
    "lockedLovelace",
    "collateralLovelace",
    "coinsPerUtxoByte",
    "payByTime",
    "submitResultTime",
    "unlockTime",
    "externalDisputeUnlockTime",
    "cooldownPeriodMs",
  ] as const;
  for (const k of strings) if (typeof escrow[k] !== "string") return fail(`escrow.${k} is missing`);
  for (const k of numbers) {
    const v = escrow[k];
    if (typeof v !== "string" || !DECIMAL.test(v)) return fail(`escrow.${k} is malformed`);
  }
  if (!/^(?:[0-9a-f]{2})+$/.test(escrow.datumCbor as string)) fail("escrow.datumCbor is not hex");
  const id = escrow.agentIdentifier;
  if (id !== undefined && id !== null && (typeof id !== "string" || !/^[0-9a-f]{120}$/.test(id)))
    fail("escrow.agentIdentifier is malformed");
  const name = escrow.agentName;
  if (name !== undefined && name !== null && (typeof name !== "string" || name.length > 200))
    fail("escrow.agentName is malformed");
  const pkh = escrow.sellerPaymentKeyHash;
  if (pkh !== undefined && (typeof pkh !== "string" || !/^[0-9a-f]{56}$/.test(pkh)))
    fail("escrow.sellerPaymentKeyHash is malformed");
  return escrow as unknown as MasumiEscrowTerms;
}

/**
 * Independent re-check of bound escrow terms against the payload (before signing): the
 * escrow is the canonical address and the payload's recipient, and the datum still encodes
 * exactly the buyer (payload.from), the seller, the collateral and the deadlines it claims.
 */
export function assertMasumiEscrowBinding(
  terms: MasumiEscrowTerms,
  payload: { network: NetworkId; from: string; to: string },
): void {
  const canonical = MASUMI_ESCROW_ADDRESSES[payload.network];
  if (canonical === undefined || terms.escrowAddress !== canonical || payload.to !== canonical)
    fail("the payload does not pay the canonical escrow");
  if (terms.cooldownPeriodMs !== MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod)
    fail("unexpected escrow cooldown");
  const view = parseMasumiLockDatum(terms.datumCbor);
  if (view === null) return fail("the bound datum does not decode");
  const checks: [boolean, string][] = [
    [sameCredentials(view.buyer, credentials(payload.from, "the buyer")), "buyer"],
    [view.buyerReturnAddress === null, "buyer_return_address"],
    [sameCredentials(view.seller, credentials(terms.sellerAddress, "the seller")), "seller"],
    [view.agentIdentifier === (terms.agentIdentifier ?? ""), "agent_identifier"],
    [
      terms.sellerPaymentKeyHash === undefined ||
        terms.sellerPaymentKeyHash === cardanoPaymentKeyHash(terms.sellerAddress),
      "seller_key_hash",
    ],
    [view.collateralReturnLovelace === BigInt(terms.collateralLovelace), "collateral"],
    [view.inputHash === terms.inputHash, "input_hash"],
    [view.resultHash === "", "result_hash"],
    [view.payByTime === BigInt(terms.payByTime), "pay_by_time"],
    [view.submitResultTime === BigInt(terms.submitResultTime), "submit_result_time"],
    [view.unlockTime === BigInt(terms.unlockTime), "unlock_time"],
    [view.externalDisputeUnlockTime === BigInt(terms.externalDisputeUnlockTime), "dispute"],
    [view.sellerCooldownTime === 0n && view.buyerCooldownTime === 0n, "cooldowns"],
    [view.state === 0n, "state"],
  ];
  const wrong = checks.find(([ok]) => !ok);
  if (wrong !== undefined) fail(`the bound datum has a wrong ${wrong[1]}`);
}

// --- lifecycle --------------------------------------------------------------------------

/** vested_pay `State` constructor indexes, as ZyroPay names them. */
export const MASUMI_DATUM_STATES = [
  "funds_locked",
  "result_submitted",
  "refund_requested",
  "disputed",
  "withdraw_authorized",
  "refund_authorized",
] as const;
export type MasumiDatumState = (typeof MASUMI_DATUM_STATES)[number];

export interface MasumiEscrowView {
  readonly state: MasumiDatumState;
  readonly resultHash: string | null;
  readonly referenceSignature: string;
  readonly buyerKeyHash: string | null;
  readonly submitResultTime: bigint;
  readonly unlockTime: bigint;
  readonly sellerCooldownTime: bigint;
  readonly buyerCooldownTime: bigint;
}

/** Decoded view of an escrow UTxO's inline datum; null when it is not a vested_pay datum. */
export function masumiEscrowView(datumCbor: string): MasumiEscrowView | null {
  let view: MasumiDatumView | null;
  try {
    view = parseMasumiLockDatum(datumCbor.toLowerCase());
  } catch {
    return null;
  }
  if (view === null) return null;
  const state = MASUMI_DATUM_STATES[Number(view.state)];
  if (state === undefined || view.state > 5n) return null;
  return {
    state,
    resultHash: view.resultHash === "" ? null : view.resultHash,
    referenceSignature: view.referenceSignature,
    buyerKeyHash: view.buyer.payment.isScript ? null : view.buyer.payment.hash,
    submitResultTime: view.submitResultTime,
    unlockTime: view.unlockTime,
    sellerCooldownTime: view.sellerCooldownTime,
    buyerCooldownTime: view.buyerCooldownTime,
  };
}

/**
 * Continuing datum of a SetRefundRequested spend (vested_pay.ak, SetRefundRequested): the
 * input datum with seller_cooldown_time = 0, buyer_cooldown_time = upper bound (POSIX ms of
 * the TTL slot) + cooldown_period, and state RefundRequested (no result yet) or Disputed
 * (a result was submitted). Every other field is copied unchanged. Throws VALIDATION_FAILED
 * when the input datum is not one a buyer may request a refund from.
 */
export function masumiRefundRequestDatum(
  inputDatumCbor: string,
  ttlPosixMs: bigint,
  cooldownPeriodMs: bigint,
): string {
  const view = masumiEscrowView(inputDatumCbor);
  if (view === null) return fail("the escrow datum does not decode");
  if (!["funds_locked", "result_submitted", "disputed"].includes(view.state))
    fail(`a refund cannot be requested in state ${view.state}`);
  const data = Data.fromCBORHex(inputDatumCbor.toLowerCase());
  if (!(data instanceof Data.Constr) || data.index !== 0n || data.fields.length !== 19)
    return fail("the escrow datum is not a 19-field Constr 0");
  const fields = [...data.fields];
  fields[16] = 0n;
  fields[17] = ttlPosixMs + cooldownPeriodMs;
  fields[18] = Data.constr(view.resultHash === null ? 2n : 3n, []);
  const out = Data.toCBORHex(Data.constr(0n, fields)).toLowerCase();
  // Self-check: the continuing datum decodes, and only the three fields changed.
  const next = parseMasumiLockDatum(out);
  const before = parseMasumiLockDatum(inputDatumCbor.toLowerCase());
  if (next === null || before === null) return fail("the continuing datum does not decode");
  const expected = {
    ...before,
    sellerCooldownTime: 0n,
    buyerCooldownTime: ttlPosixMs + cooldownPeriodMs,
    state: view.resultHash === null ? 2n : 3n,
  };
  if (JSON.stringify(next, bigintJson) !== JSON.stringify(expected, bigintJson))
    fail("the continuing datum changed more than the refund fields");
  return out;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
