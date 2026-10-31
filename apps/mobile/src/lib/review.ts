import {
  cardanoEnterpriseAddress,
  cardanoUnsignedBodyHash,
  chainFamilyOf,
  checkCardanoEscrowLockTx,
  checkCardanoTransferTx,
  getNetwork,
  isMasumiEscrowLock,
  nativeAsset,
  parseAssetId,
  payloadHash,
  type ApprovalRequest,
  type CardanoTxCheck,
  type RequestSource,
  type SigningReview,
  type StampedTurnkeyRequest,
} from "@zyropay/shared";
import type { PasskeySigner } from "./turnkey/signer";
import { formatFiat, formatTokenAmount, shortenAddress, withPriceMarker } from "@zyropay/ui/format";

/*
 * Presentation + integrity helpers for a SigningReview (unit-tested).
 * The app independently recomputes the payload hash before letting the user
 * sign, so a review whose displayed terms differ from what the hash binds is
 * never signable (defence in depth for SECURITY T2/T9; the API re-checks).
 */

const ACTION_LABEL: Readonly<Record<RequestSource, string>> = {
  app_send: "Send",
  send: "Send",
  swap: "Swap",
  pay_x402: "Pay (x402)",
};

export interface ReviewIntegrity {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /**
   * Set when the app decoded the transaction itself and it does exactly what the review
   * shows (Cardano): what it proved, for the "Verified on this device" line.
   */
  readonly verified?: DeviceVerification;
}

/** What the on-device decode proved the transaction pays (base units). */
export interface DeviceVerification {
  readonly kind: "transfer" | "escrow_lock" | "request_refund" | "withdraw_refund";
  /** Where the money goes: the recipient, the Masumi escrow, or back to the buyer. */
  readonly payTo: string;
  /** Lovelace on that output. */
  readonly lovelace: string;
  /** The token on that output, if any (unit + base units). */
  readonly token: { readonly unit: string; readonly amount: string } | null;
}

/** Prefix of every problem the on-device transaction decode reports. */
export const TX_MISMATCH = "The transaction does not match what is shown:";

/** A failed on-device decode check as a problem line ("...: it pays a different address."). */
export function txMismatch(reason: string): string {
  return `${TX_MISMATCH} ${reason}.`;
}

/** What a passed check proved, from the checked output. */
export function deviceVerification(
  kind: DeviceVerification["kind"],
  check: Extract<CardanoTxCheck, { ok: true }>,
): DeviceVerification {
  const [token] = [...check.payout.assets];
  return {
    kind,
    payTo: check.payout.address,
    lovelace: check.payout.lovelace.toString(),
    token: token === undefined ? null : { unit: token[0], amount: token[1].toString() },
  };
}

/**
 * "Verified on this device: the transaction pays 2 ADA to addr_test1qz…x8k2f." `amountLabel`
 * is the review's formatted amount (summarizeReview), which the check proved is paid.
 */
export function deviceVerifiedLine(v: DeviceVerification, amountLabel: string): string {
  const ada = formatTokenAmount(v.lovelace, 6, { symbol: "ADA", maxFractionDigits: 6 });
  const to = shortenAddress(v.payTo, 10, 6);
  switch (v.kind) {
    case "transfer":
      return `Verified on this device: the transaction pays ${amountLabel} to ${to}.`;
    case "escrow_lock":
      return `Verified on this device: the transaction locks ${v.token === null ? ada : `${amountLabel} (with ${ada})`} in the Masumi escrow ${to}, under the terms shown.`;
    case "request_refund":
      return `Verified on this device: the payment stays in the Masumi escrow (${ada}) and any change comes back to ${to}.`;
    case "withdraw_refund":
      return `Verified on this device: the refund (${ada}, after the fee) comes back to your wallet ${to}.`;
  }
}

export function checkReviewIntegrity(
  review: SigningReview,
  approval?: ApprovalRequest,
  now: Date = new Date(),
): ReviewIntegrity {
  const problems: string[] = [];
  let computed: string | null = null;
  try {
    computed = payloadHash(review.payload);
  } catch {
    problems.push("The request payload is malformed.");
  }
  if (computed !== null && computed !== review.payloadHash)
    problems.push("The payload does not match its hash.");
  if (review.request.payloadHash !== review.payloadHash)
    problems.push("The request and review disagree on the payload.");
  if (approval && approval.payloadHash !== review.payloadHash)
    problems.push("This approval is bound to a different payload.");
  if (
    review.request.payload.to !== review.payload.to ||
    review.request.payload.amount !== review.payload.amount
  ) {
    problems.push("The recipient or amount changed after the request was created.");
  }
  if (new Date(review.payload.expiresAt).getTime() <= now.getTime())
    problems.push("The request has expired.");
  const cardano = cardanoProblems(review, now);
  problems.push(...cardano.problems, ...typedDataProblems(review));
  const ok = problems.length === 0;
  return ok && cardano.verified !== undefined
    ? { ok, problems, verified: cardano.verified }
    : { ok, problems };
}

/**
 * x402 on EVM: the passkey signs `typedData.digest`, which the contract says equals the
 * unsigned "transaction". The API re-derives the typed data from the payload and checks the
 * digest before it forwards the stamp; here the app makes sure it signs what it was shown.
 */
function typedDataProblems(review: SigningReview): string[] {
  const typed = review.typedData;
  if (typed === undefined) return [];
  if (chainFamilyOf(review.payload.network) !== "evm")
    return ["Typed-data signing is only used on EVM networks."];
  if (typed.digest.toLowerCase() !== review.unsignedTransaction.serialized.toLowerCase())
    return ["The typed-data digest does not match the reviewed request."];
  return [];
}

/**
 * Cardano (ADR-002): the passkey signs a raw body hash, so check (a) it is the hash of the
 * body inside the reviewed transaction, (b) the signing key derives the sending address and
 * (c) decoding the transaction on this device, it does exactly what the screen shows
 * (cardanoTxProblems). Mock-mode transactions are not CBOR, so (a) and (c) only run on real
 * (non-simulated) reviews.
 */
function cardanoProblems(
  review: SigningReview,
  now: Date,
): { problems: string[]; verified?: DeviceVerification } {
  const { network } = review.payload;
  if (chainFamilyOf(network) !== "cardano") return { problems: [] };
  const raw = review.rawPayload;
  if (raw === undefined) return { problems: ["The Cardano signing payload is missing."] };
  const problems: string[] = [];
  try {
    if (cardanoEnterpriseAddress(raw.signWith, network) !== review.payload.from)
      problems.push("The signing key does not belong to the sending address.");
  } catch {
    problems.push("The signing key is malformed.");
  }
  if (review.request.simulated) return { problems };
  const hash = cardanoUnsignedBodyHash(review.unsignedTransaction.serialized);
  if (hash !== raw.payload)
    problems.push("The Cardano signing payload does not match the transaction.");
  const decoded = cardanoTxProblems(review, now);
  if ("problem" in decoded) return { problems: [...problems, decoded.problem] };
  return { problems, verified: decoded.verified };
}

/** Number of a decimal string field of the bound escrow terms, or null. */
function escrowField(review: SigningReview, key: string): string | null {
  const escrow = review.payload.pluginData?.escrow;
  if (escrow === null || typeof escrow !== "object" || Array.isArray(escrow)) return null;
  const v = (escrow as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Decode the unsigned Cardano payment and match it against the payload the screen shows
 * (bound by payloadHash): a plain transfer pays `to` exactly `amount` with change only back
 * to `from`; a Masumi escrow lock pays the canonical escrow address exactly the bound
 * locked value with the bound datum. Fee within the cap and the fee shown, TTL not past.
 */
function cardanoTxProblems(
  review: SigningReview,
  now: Date,
): { problem: string } | { verified: DeviceVerification } {
  const p = review.payload;
  if (review.unsignedTransaction.encoding !== "hex")
    return { problem: txMismatch("it is not in the expected encoding") };
  const hex = review.unsignedTransaction.serialized;
  let amount: bigint;
  let maxFee: bigint;
  let shownFee: bigint;
  let unit: string | null;
  try {
    amount = BigInt(p.amount);
    maxFee = BigInt(p.feeCap);
    shownFee = BigInt(review.estimatedFee.amount);
    unit = parseAssetId(p.asset.id).tokenAddress?.toLowerCase() ?? null;
  } catch {
    return { problem: txMismatch("the request's amounts are malformed") };
  }
  const common = { network: p.network, from: p.from, amount, unit, maxFee, now };
  let check: CardanoTxCheck;
  let kind: DeviceVerification["kind"];
  if (isMasumiEscrowLock(p)) {
    const locked = escrowField(review, "lockedLovelace");
    const collateral = escrowField(review, "collateralLovelace");
    const datum = escrowField(review, "datumCbor");
    const payBy = escrowField(review, "payByTime");
    if (
      locked === null ||
      collateral === null ||
      datum === null ||
      payBy === null ||
      ![locked, collateral, payBy].every((v) => /^[0-9]+$/.test(v))
    )
      return { problem: txMismatch("the escrow terms are incomplete") };
    kind = "escrow_lock";
    check = checkCardanoEscrowLockTx(hex, {
      ...common,
      lockedLovelace: BigInt(locked),
      collateralLovelace: BigInt(collateral),
      datumCbor: datum,
      payByMs: Number(payBy),
    });
  } else {
    kind = "transfer";
    check = checkCardanoTransferTx(hex, { ...common, to: p.to });
  }
  if (!check.ok) return { problem: txMismatch(check.reason) };
  if (check.tx.fee > shownFee)
    return { problem: txMismatch("its network fee is higher than the fee shown") };
  return { verified: deviceVerification(kind, check) };
}

/**
 * Stamp what this review asks the passkey to sign: SIGN_RAW_PAYLOAD over the body hash for
 * Cardano (`review.rawPayload`), SIGN_RAW_PAYLOAD over the EIP-712 digest for x402 on EVM
 * (`review.typedData`, signed by the wallet address with HASH_FUNCTION_NO_OP, as the API's
 * verifySignRawPayloadRequest expects), SIGN_TRANSACTION over the unsigned bytes otherwise.
 */
export function stampForReview(
  signer: PasskeySigner,
  review: SigningReview,
  organizationId: string,
): Promise<StampedTurnkeyRequest> {
  if (review.rawPayload !== undefined) {
    return signer.stampSignRawPayload({
      organizationId,
      signWith: review.rawPayload.signWith,
      payload: review.rawPayload.payload,
    });
  }
  if (review.typedData !== undefined) {
    return signer.stampSignRawPayload({
      organizationId,
      signWith: review.payload.from,
      payload: review.typedData.digest,
      hashFunction: "HASH_FUNCTION_NO_OP",
    });
  }
  return signer.stampSignTransaction({
    organizationId,
    signWith: review.payload.from,
    unsignedTransaction: review.unsignedTransaction,
    network: review.payload.network,
  });
}

export interface ReviewSummary {
  readonly action: string;
  readonly amountLabel: string;
  readonly fiatLabel: string | null;
  readonly feeLabel: string;
  readonly recipientShort: string;
  readonly networkName: string;
  readonly isTestnet: boolean;
}

export function summarizeReview(review: SigningReview, symbol: string): ReviewSummary {
  const p = review.payload;
  const native = nativeAsset(p.network);
  const fee = formatTokenAmount(review.estimatedFee.amount, native.decimals, {
    symbol: native.symbol,
    maxFractionDigits: 9,
  });
  return {
    action: ACTION_LABEL[p.tool],
    amountLabel: formatTokenAmount(p.amount, p.asset.decimals, {
      symbol,
      maxFractionDigits: p.asset.decimals,
    }),
    fiatLabel: review.value
      ? withPriceMarker(
          `≈ ${formatFiat(review.value.value, review.value.currency)}`,
          review.priceBasis,
        )
      : null,
    feeLabel: review.estimatedFee.value
      ? `${fee} (≈ ${withPriceMarker(formatFiat(review.estimatedFee.value.value, review.estimatedFee.value.currency), review.priceBasis)})`
      : fee,
    recipientShort: shortenAddress(p.to, 6, 6),
    networkName: getNetwork(p.network).displayName,
    isTestnet: getNetwork(p.network).isTestnet,
  };
}

/** The asset symbol is not in the canonical payload; use the native symbol or the known token. */
export function symbolFor(
  review: SigningReview,
  knownSymbols: ReadonlyMap<string, string>,
): string {
  if (review.payload.asset.kind === "native") return nativeAsset(review.payload.network).symbol;
  return knownSymbols.get(review.payload.asset.id) ?? "tokens";
}

export interface ReviewRisk {
  readonly tone: "neutral" | "caution" | "danger";
  readonly label: string;
}

/** One plain-language risk line for the approval card, worst signal first. */
export function riskOf(review: SigningReview, integrityOk: boolean): ReviewRisk {
  if (!integrityOk) return { tone: "danger", label: "Failed integrity check" };
  const codes = new Set(review.warnings.map((w) => w.code));
  if (codes.has("UNVERIFIED_TOKEN")) return { tone: "caution", label: "Unverified token" };
  if (codes.has("FIRST_TIME_RECIPIENT")) return { tone: "caution", label: "New recipient" };
  if (codes.has("HIGH_FEE")) return { tone: "caution", label: "High network fee" };
  if (codes.has("PRICE_UNAVAILABLE")) return { tone: "caution", label: "Value unknown" };
  return { tone: "neutral", label: "No warnings" };
}
