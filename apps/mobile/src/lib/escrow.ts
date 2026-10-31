import {
  cardanoEnterpriseAddress,
  cardanoUnsignedBodyHash,
  chainFamilyOf,
  checkCardanoEscrowSpendTx,
  isMasumiEscrowLock,
  parseAssetId,
  payloadHash,
  type CanonicalTransactionPayload,
  type NetworkId,
  type PolicyReasonCode,
  type SigningReview,
  type X402Escrow,
  type X402EscrowAction,
  type X402EscrowState,
  type X402ProofState,
} from "@zyropay/shared";
import { formatDateTime, formatTokenAmount, shortenAddress } from "@zyropay/ui/format";
import {
  deviceVerification,
  txMismatch,
  type DeviceVerification,
  type ReviewIntegrity,
} from "./review";
import { ALLOWANCE_REASON_LABEL } from "./allowance";
import { explorerLink, humanFailure } from "./x402";

/*
 * Presentation helpers for x402 payments locked in Masumi escrow (docs/CARDANO_X402.md),
 * unit-tested. The app only explains and follows the escrow; the API builds every spend and
 * the chain enforces the deadlines. Before approval the terms come from the payload (what the
 * passkey signs binds them); afterwards from the API's live escrow view (getX402Escrow).
 */

/** The seller-signed escrow terms bound in an x402 payload, ready to show. */
export interface EscrowTerms {
  /** Who receives the payment when the escrow releases (not the script address). */
  readonly sellerAddress: string;
  readonly escrowAddress: string;
  readonly lockedLovelace: string;
  readonly collateralLovelace: string;
  readonly deadlines: X402Escrow["deadlines"];
}

const DECIMAL = /^[0-9]+$/;

function msToIso(value: unknown): string | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The Masumi escrow terms of an x402 payload, or null when it is not an escrow lock (the
 * escrow must be the network's canonical Masumi script and the payload's recipient).
 */
export function escrowTermsOf(payload: CanonicalTransactionPayload): EscrowTerms | null {
  if (!isMasumiEscrowLock(payload)) return null;
  const e = payload.pluginData?.escrow as Record<string, unknown> | undefined;
  if (e === undefined) return null;
  const payBy = msToIso(e.payByTime);
  const submitResult = msToIso(e.submitResultTime);
  const unlock = msToIso(e.unlockTime);
  const externalDisputeUnlock = msToIso(e.externalDisputeUnlockTime);
  if (
    typeof e.sellerAddress !== "string" ||
    typeof e.escrowAddress !== "string" ||
    typeof e.lockedLovelace !== "string" ||
    !DECIMAL.test(e.lockedLovelace) ||
    typeof e.collateralLovelace !== "string" ||
    !DECIMAL.test(e.collateralLovelace) ||
    payBy === null ||
    submitResult === null ||
    unlock === null ||
    externalDisputeUnlock === null
  )
    return null;
  return {
    sellerAddress: e.sellerAddress,
    escrowAddress: e.escrowAddress,
    lockedLovelace: e.lockedLovelace,
    collateralLovelace: e.collateralLovelace,
    deadlines: { payBy, submitResult, unlock, externalDisputeUnlock },
  };
}

/** "2.5 ADA". */
export function adaLabel(lovelace: string): string {
  return formatTokenAmount(lovelace, 6, { symbol: "ADA", maxFractionDigits: 6 });
}

/** How far a time is from now, in words: "in 25 min", "in 3 h", "2 days ago", "now". */
export function relativeWords(iso: string, now: Date = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(diff)) return "";
  const abs = Math.abs(diff);
  let span: string;
  if (abs < 60_000) return "now";
  if (abs < 3_600_000) span = `${String(Math.round(abs / 60_000))} min`;
  else if (abs < 48 * 3_600_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    span = h < 6 && m > 0 && m < 60 ? `${String(h)} h ${String(m)} min` : `${String(h)} h`;
  } else span = `${String(Math.round(abs / 86_400_000))} days`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** "30 Oct 2026, 14:05 UTC (in 25 min)". */
export function deadlineWords(iso: string, now: Date = new Date()): string {
  const rel = relativeWords(iso, now);
  return rel === "" ? formatDateTime(iso) : `${formatDateTime(iso)} (${rel})`;
}

/**
 * deadlineWords for a narrow value column: the relative part keeps together (no-break
 * spaces), so "min)" or "h)" never lands on a line of its own.
 */
export function deadlineValue(iso: string, now: Date = new Date()): string {
  const rel = relativeWords(iso, now);
  return rel === ""
    ? formatDateTime(iso)
    : `${formatDateTime(iso)} (${rel.replace(/ /g, "\u00a0")})`;
}

/** The "Protected by Escrow" block on the approval card. */
export interface EscrowProtection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly seller: string;
}

export function escrowProtection(terms: EscrowTerms, now: Date = new Date()): EscrowProtection {
  const lines = [
    "Your payment is locked on Cardano until the seller delivers.",
    `If it isn't delivered by ${deadlineWords(terms.deadlines.submitResult, now)}, you can take it back.`,
    `Once delivered, it is released to the seller after ${deadlineWords(terms.deadlines.unlock, now)}, unless you ask for a refund before then.`,
  ];
  if (terms.collateralLovelace !== "0")
    lines.push(
      `Includes a ${adaLabel(terms.collateralLovelace)} deposit that comes back to you in every outcome.`,
    );
  return {
    title: "Protected by Escrow (Masumi)",
    lines,
    seller: shortenAddress(terms.sellerAddress, 10, 6),
  };
}

const TERMINAL: ReadonlySet<X402EscrowState> = new Set(["refunded", "withdrawn", "failed"]);

/** Nothing moves on from these: stop polling. */
export function isEscrowTerminal(state: X402EscrowState): boolean {
  return TERMINAL.has(state);
}

/** Poll interval for getX402Escrow: faster while a buyer spend is in flight, off once closed. */
export function escrowPollMs(escrow: X402Escrow | null | undefined): number | false {
  if (escrow == null) return false;
  if (isEscrowTerminal(escrow.state)) return false;
  if (escrow.state === "locking" || escrow.refund.pending?.status === "submitted") return 5_000;
  return 15_000;
}

export type EscrowTone = "neutral" | "success" | "danger";
export type EscrowStepStatus = "done" | "active" | "todo" | "failed";

export interface EscrowStep {
  readonly key: string;
  readonly label: string;
  /** A second line: a deadline, a result hash. */
  readonly detail: string | null;
  readonly status: EscrowStepStatus;
  /** A transaction to link to the explorer. */
  readonly txHash: string | null;
}

export interface EscrowView {
  readonly title: string;
  readonly message: string;
  readonly tone: EscrowTone;
  readonly terminal: boolean;
  readonly steps: readonly EscrowStep[];
}

const REFUND_STATES: ReadonlySet<X402EscrowState> = new Set([
  "refund_requested",
  "disputed",
  "refund_authorized",
  "refunded",
]);

function inFlight(e: X402Escrow, action: X402EscrowAction): boolean {
  return e.refund.pending?.action === action && e.refund.pending.status === "submitted";
}

/** Whether this escrow is (or is going) down the refund path. */
function onRefundPath(e: X402Escrow): boolean {
  return (
    REFUND_STATES.has(e.state) ||
    e.refund.requestTx !== null ||
    e.refund.withdrawTx !== null ||
    (e.refund.pending !== null && e.refund.pending.status !== "awaiting_signature")
  );
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

/** Headline and timeline of an escrow, in plain words. */
export function escrowView(e: X402Escrow, now: Date = new Date()): EscrowView {
  const d = e.deadlines;
  const terminal = isEscrowTerminal(e.state);
  const lockedStatus: EscrowStepStatus =
    e.state === "failed" ? "failed" : e.state === "locking" ? "active" : "done";
  const locked: EscrowStep = {
    key: "locked",
    label: e.state === "locking" ? "Locking the payment" : "Locked in escrow",
    detail: e.state === "locking" ? null : `${adaLabel(e.lockedLovelace)} held by the escrow`,
    status: lockedStatus,
    txHash: e.lockTx,
  };
  const steps: EscrowStep[] = [locked];
  if (e.state !== "failed") {
    if (onRefundPath(e)) {
      const requested = e.refund.requestTx !== null || REFUND_STATES.has(e.state);
      // A withdrawal without a request: the seller missed the result deadline.
      if (requested || inFlight(e, "request_refund")) {
        steps.push({
          key: "refund-requested",
          label: "Refund requested",
          detail: null,
          status: requested && !inFlight(e, "request_refund") ? "done" : "active",
          txHash: e.refund.requestTx,
        });
        if (e.state === "disputed")
          steps.push({
            key: "disputed",
            label: "Disputed",
            detail: `The seller delivered anyway. Settled by the escrow's admins, not before ${deadlineWords(d.externalDisputeUnlock, now)}.`,
            status: "active",
            txHash: null,
          });
        else
          steps.push({
            key: "refund-authorized",
            label: "Refund authorized by the seller",
            detail:
              e.state === "refund_requested"
                ? `Or withdraw it yourself after ${deadlineWords(d.submitResult, now)} if nothing was delivered.`
                : null,
            status:
              e.state === "refund_authorized" || e.state === "refunded"
                ? "done"
                : e.state === "refund_requested"
                  ? "active"
                  : "todo",
            txHash: null,
          });
      } else {
        steps.push({
          key: "no-result",
          label: "Nothing delivered in time",
          detail: `The deadline was ${formatDateTime(d.submitResult)}.`,
          status: "done",
          txHash: null,
        });
      }
      steps.push({
        key: "refunded",
        label: "Refunded",
        detail: e.state === "refunded" ? `${adaLabel(e.lockedLovelace)} back, minus the fee` : null,
        status:
          e.state === "refunded" ? "done" : inFlight(e, "withdraw_refund") ? "active" : "todo",
        txHash: e.refund.withdrawTx,
      });
    } else {
      const delivered = e.resultHash !== null;
      steps.push({
        key: "delivered",
        label: delivered ? "Result delivered" : "Waiting for the seller to deliver",
        detail: delivered
          ? `Result hash ${shortHash(e.resultHash ?? "")}`
          : `Deadline ${deadlineWords(d.submitResult, now)}`,
        status: delivered ? "done" : e.state === "funds_locked" ? "active" : "todo",
        txHash: e.proof?.resultTx ?? null,
      });
      steps.push({
        key: "released",
        label: "Released to the seller",
        detail: e.state === "withdrawn" ? null : `After ${deadlineWords(d.unlock, now)}`,
        status:
          e.state === "withdrawn"
            ? "done"
            : e.state === "result_submitted" || e.state === "withdraw_authorized"
              ? "active"
              : "todo",
        txHash: null,
      });
    }
  }
  const head = headline(e, now);
  return { ...head, terminal, steps };
}

function headline(e: X402Escrow, now: Date): Pick<EscrowView, "title" | "message" | "tone"> {
  const d = e.deadlines;
  const withdrawable = e.refund.available.includes("withdraw_refund");
  switch (e.state) {
    case "locking":
      return {
        title: "Locking the payment",
        message: "Waiting for the payment to land in the escrow on Cardano.",
        tone: "neutral",
      };
    case "funds_locked":
      return withdrawable
        ? {
            title: "Not delivered in time",
            message: "The seller missed the deadline. You can withdraw your refund.",
            tone: "neutral",
          }
        : {
            title: "Locked in escrow",
            message: `The seller has until ${deadlineWords(d.submitResult, now)} to deliver. If they don't, you can take the payment back.`,
            tone: "neutral",
          };
    case "result_submitted":
      return {
        title: "Result delivered",
        message: `Released to the seller after ${deadlineWords(d.unlock, now)}, unless you request a refund before then.`,
        tone: "neutral",
      };
    case "refund_requested":
      return withdrawable
        ? {
            title: "Refund requested",
            message: "Nothing was delivered in time. You can withdraw your refund.",
            tone: "neutral",
          }
        : {
            title: "Refund requested",
            message: "Waiting for the seller to authorize the refund.",
            tone: "neutral",
          };
    case "disputed":
      return {
        title: "Disputed",
        message: `You asked for a refund and the seller delivered a result. The escrow's admins settle it, not before ${deadlineWords(d.externalDisputeUnlock, now)}.`,
        tone: "danger",
      };
    case "withdraw_authorized":
      return {
        title: "Releasing to the seller",
        message: "The escrow authorized the seller to collect the payment.",
        tone: "neutral",
      };
    case "refund_authorized":
      return {
        title: "Refund authorized",
        message: "The seller agreed to refund you. Withdraw it to your wallet.",
        tone: "neutral",
      };
    case "refunded":
      return {
        title: "Refunded",
        message: `${adaLabel(e.lockedLovelace)} went back to your wallet, minus the network fee.`,
        tone: "success",
      };
    case "withdrawn":
      return e.resultHash !== null
        ? {
            title: "Released to the seller",
            message: "The seller delivered and collected the payment.",
            tone: "success",
          }
        : {
            title: "Escrow closed",
            message: "The escrow was settled by another transaction (the seller or a dispute).",
            tone: "neutral",
          };
    case "failed":
      return {
        title: "Lock failed",
        message: "The payment never reached the escrow. Nothing is locked.",
        tone: "danger",
      };
    case "unknown":
      return {
        title: "Escrow status unavailable",
        message: "Couldn't read the escrow on Cardano just now. Trying again…",
        tone: "neutral",
      };
  }
}

/**
 * "Proof before release": whether what the agent received is the result the seller
 * recorded on Cardano (the API compares the hashes; the app only explains the verdict).
 */
export interface EscrowProofNotice {
  readonly state: X402ProofState;
  readonly tone: EscrowTone;
  readonly title: string;
  readonly message: string;
  /** Explorer link to the seller's SubmitResult transaction. */
  readonly resultTxUrl: string | null;
  /** The refund action ZyroPay recommends (proof failed), if one is possible now. */
  readonly action: X402EscrowAction | null;
}

export function escrowProofNotice(
  network: NetworkId,
  e: X402Escrow,
  now: Date = new Date(),
): EscrowProofNotice | null {
  const proof = e.proof;
  if (proof === null || proof.state === "receipt_only") return null;
  const resultTxUrl = explorerLink(network, proof.resultTx);
  const action =
    e.refund.recommended !== null && e.refund.available.includes(e.refund.recommended)
      ? e.refund.recommended
      : null;
  const base = { state: proof.state, resultTxUrl, action };
  // Already refunding (or settled): state the finding without the call to action.
  const settling = isEscrowTerminal(e.state) || onRefundPath(e);
  switch (proof.state) {
    case "verified":
      return {
        ...base,
        tone: "success",
        title: "Verified on Cardano ✓",
        message: "What your agent received matches the result the seller recorded on chain.",
      };
    case "mismatch":
      return {
        ...base,
        tone: "danger",
        title: settling ? "Mismatch on Cardano" : "Mismatch — request refund",
        message: settling
          ? "What your agent received does not match the result the seller recorded on Cardano."
          : `What your agent received does not match the result the seller recorded on Cardano. Request a refund before ${deadlineWords(e.deadlines.unlock, now)}, when the payment is released to the seller.`,
      };
    case "not_delivered":
      return {
        ...base,
        tone: "danger",
        title: settling ? "Not delivered" : "Not delivered — get your refund",
        message: "The seller didn't record a result on Cardano before the deadline.",
      };
    case "unverifiable":
      return {
        ...base,
        tone: "neutral",
        title: "Result recorded, not checked",
        message:
          "The seller recorded a result on Cardano, but what your agent received couldn't be checked against it.",
      };
    case "pending":
      if (settling) return null;
      return proof.onChainHash !== null
        ? {
            ...base,
            tone: "neutral",
            title: "Result recorded on Cardano",
            message: "Waiting for your agent to receive it, to compare the two.",
          }
        : {
            ...base,
            tone: "neutral",
            title: "Waiting for the seller to record the result",
            message:
              "Once it's on Cardano, ZyroPay checks it against what your agent received before the payment is released.",
          };
  }
}

/** What the buyer can do on the escrow right now. */
export interface EscrowActions {
  readonly requestRefund: boolean;
  readonly withdrawRefund: boolean;
  /** No withdrawal yet, but one becomes possible at this time (show a countdown). */
  readonly withdrawableAt: string | null;
  /** A buyer spend in flight or that just failed, in words. */
  readonly pendingNote: { readonly tone: EscrowTone; readonly text: string } | null;
}

const ACTION_NOUN: Readonly<Record<X402EscrowAction, string>> = {
  request_refund: "refund request",
  withdraw_refund: "refund withdrawal",
};

export function escrowActions(e: X402Escrow, now: Date = new Date()): EscrowActions {
  const pending = e.refund.pending;
  const busy = pending?.status === "submitted";
  const withdrawRefund = !busy && e.refund.available.includes("withdraw_refund");
  const at = e.refund.withdrawableAt;
  const withdrawableAt =
    !withdrawRefund &&
    !busy &&
    at !== null &&
    new Date(at).getTime() > now.getTime() &&
    e.resultHash === null &&
    (e.state === "funds_locked" || e.state === "refund_requested")
      ? at
      : null;
  let pendingNote: EscrowActions["pendingNote"] = null;
  if (pending?.status === "submitted")
    pendingNote = {
      tone: "neutral",
      text: `Your ${ACTION_NOUN[pending.action]} was sent. Waiting for Cardano to confirm it…`,
    };
  else if (pending?.status === "failed")
    pendingNote = {
      tone: "danger",
      text: `Your ${ACTION_NOUN[pending.action]} didn't go through. Nothing moved; you can try again.`,
    };
  return {
    requestRefund: !busy && e.refund.available.includes("request_refund"),
    withdrawRefund,
    withdrawableAt,
    pendingNote,
  };
}

/** Explorer links of the escrow's transactions, in order. */
export function escrowTxLinks(
  network: NetworkId,
  e: X402Escrow,
): { readonly key: string; readonly label: string; readonly url: string }[] {
  const out: { key: string; label: string; url: string }[] = [];
  const add = (key: string, label: string, hash: string | null) => {
    const url = explorerLink(network, hash);
    if (url !== null) out.push({ key, label, url });
  };
  add("lock", "Lock transaction", e.lockTx);
  add("result", "Result transaction", e.proof?.resultTx ?? null);
  add("request", "Refund request", e.refund.requestTx);
  add("withdraw", "Refund withdrawal", e.refund.withdrawTx);
  return out;
}

/** The review sheet's rows for an escrow spend. */
export function escrowSpendRows(
  review: SigningReview,
): { readonly label: string; readonly value: string }[] | null {
  const s = review.escrowSpend;
  if (s === undefined) return null;
  return [
    {
      label: s.action === "withdraw_refund" ? "Comes back to you" : "Locked amount",
      value:
        s.action === "withdraw_refund"
          ? `${adaLabel(s.lockedLovelace)} minus the fee`
          : adaLabel(s.lockedLovelace),
    },
    { label: "Refund to", value: shortenAddress(s.refundTo, 10, 6) },
    { label: "Valid from", value: formatDateTime(s.validFrom) },
    { label: "Valid until", value: formatDateTime(s.validUntil) },
    { label: "Network fee", value: adaLabel(review.estimatedFee.amount) },
  ];
}

export const ESCROW_ACTION_COPY: Readonly<
  Record<X402EscrowAction, { button: string; title: string; message: string; done: string }>
> = {
  request_refund: {
    button: "Request refund",
    title: "Request a refund",
    message:
      "Tells the escrow you want your payment back. The seller can then authorize the refund; if nothing was delivered by the deadline, you can withdraw it yourself. You pay a small network fee.",
    done: "Refund requested.",
  },
  withdraw_refund: {
    button: "Withdraw refund",
    title: "Withdraw your refund",
    message:
      "Takes the locked payment out of the escrow and back to your wallet. You pay a small network fee.",
    done: "Refund withdrawn.",
  },
};

/**
 * Integrity of an escrow spend review before the passkey signs it (the API re-checks all of
 * it). The payload is the original request (bound by payloadHash, it may have expired long
 * ago); what gets signed is `rawPayload.payload`, the body hash of the escrow spend.
 */
export function checkEscrowReviewIntegrity(
  review: SigningReview,
  action: X402EscrowAction,
  escrow: X402Escrow | null,
  now: Date = new Date(),
): ReviewIntegrity {
  const problems: string[] = [];
  try {
    if (payloadHash(review.payload) !== review.payloadHash)
      problems.push("The payload does not match its hash.");
  } catch {
    problems.push("The request payload is malformed.");
  }
  if (review.request.payloadHash !== review.payloadHash)
    problems.push("The request and review disagree on the payload.");
  const spend = review.escrowSpend;
  const raw = review.rawPayload;
  const network = review.payload.network;
  if (chainFamilyOf(network) !== "cardano") problems.push("Escrow is only used on Cardano.");
  if (spend === undefined) problems.push("This is not an escrow review.");
  else {
    if (spend.action !== action) problems.push("The review is for a different escrow action.");
    if (spend.refundTo !== review.payload.from)
      problems.push("The refund does not go to the wallet that paid.");
    if (escrow !== null && spend.lockedLovelace !== escrow.lockedLovelace)
      problems.push("The amount differs from what is locked in the escrow.");
    if (escrow?.utxo != null && spend.escrowUtxo !== escrow.utxo)
      problems.push("The review spends a different escrow output.");
    if (new Date(spend.validUntil).getTime() <= now.getTime())
      problems.push("This review is no longer valid; prepare it again.");
  }
  if (raw === undefined) problems.push("The Cardano signing payload is missing.");
  else {
    try {
      if (cardanoEnterpriseAddress(raw.signWith, network) !== review.payload.from)
        problems.push("The signing key does not belong to the paying address.");
    } catch {
      problems.push("The signing key is malformed.");
    }
    if (!review.request.simulated) {
      const hash = cardanoUnsignedBodyHash(review.unsignedTransaction.serialized);
      if (hash !== raw.payload)
        problems.push("The Cardano signing payload does not match the transaction.");
    }
  }
  let verified: DeviceVerification | undefined;
  if (spend !== undefined && !review.request.simulated && chainFamilyOf(network) === "cardano") {
    const decoded = escrowSpendTxProblem(review, spend, now);
    if (typeof decoded === "string") problems.push(decoded);
    else verified = decoded;
  }
  const ok = problems.length === 0;
  return ok && verified !== undefined ? { ok, problems, verified } : { ok, problems };
}

/**
 * Decode the escrow spend on this device and match it against the review rows: it spends
 * the shown escrow UTxO with the action's redeemer and the Masumi script only, the buyer is
 * the only required signer and gets the collateral back, a refund request keeps the locked
 * value in the escrow, a withdrawal pays everything back to `refundTo` (= the paying
 * wallet), the fee is at most the one shown and the validity window is the one shown.
 */
function escrowSpendTxProblem(
  review: SigningReview,
  spend: NonNullable<SigningReview["escrowSpend"]>,
  now: Date,
): string | DeviceVerification {
  if (review.unsignedTransaction.encoding !== "hex")
    return txMismatch("it is not in the expected encoding");
  let numbers: { locked: bigint; fee: bigint; amount: bigint; unit: string | null };
  try {
    numbers = {
      locked: BigInt(spend.lockedLovelace),
      fee: BigInt(review.estimatedFee.amount),
      amount: BigInt(review.payload.amount),
      unit: parseAssetId(review.payload.asset.id).tokenAddress?.toLowerCase() ?? null,
    };
  } catch {
    return txMismatch("the escrow amounts are malformed");
  }
  const check = checkCardanoEscrowSpendTx(review.unsignedTransaction.serialized, {
    network: review.payload.network,
    from: review.payload.from,
    action: spend.action,
    escrowUtxo: spend.escrowUtxo,
    lockedLovelace: numbers.locked,
    unit: numbers.unit,
    amount: numbers.amount,
    validFrom: spend.validFrom,
    validUntil: spend.validUntil,
    maxFee: numbers.fee,
    now,
  });
  return check.ok ? deviceVerification(spend.action, check) : txMismatch(check.reason);
}

/** Plain words for an escrow action error (code + message + details from ApiError). */
export function escrowErrorMessage(err: {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): string {
  switch (err.code) {
    case "INSUFFICIENT_FUNDS":
      return "Your wallet needs some ADA on its own (not mixed with tokens) to pay the network fee and the collateral Cardano holds while the escrow script runs (150% of the fee, returned unless the script fails). Add a little ADA and try again.";
    case "PAYLOAD_HASH_MISMATCH":
      return "The escrow changed since you reviewed it, so nothing was signed. Review it again.";
    case "CONFLICT": {
      const retry = err.details?.retryAfter;
      const base = humanFailure(err.message).replace(/\.$/, "");
      return typeof retry === "string" && !Number.isNaN(new Date(retry).getTime())
        ? `Not possible right now: ${base.charAt(0).toLowerCase()}${base.slice(1)}. Try again after ${formatDateTime(retry)}.`
        : `Not possible right now: ${base.charAt(0).toLowerCase()}${base.slice(1)}.`;
    }
    default:
      return humanFailure(err.message);
  }
}

/** Short labels for policy reason codes (the API's message says the rest). */
const POLICY_REASON_LABEL: Readonly<Record<PolicyReasonCode, string>> = {
  AGENT_REVOKED: "Agent access revoked",
  SESSION_EXPIRED: "Agent session expired",
  TOOL_NOT_ALLOWED: "Tool not allowed",
  WALLET_NOT_ALLOWED: "Wallet not shared",
  NETWORK_NOT_ALLOWED: "Network not allowed",
  SPENDING_DISABLED: "Spending is off",
  PROTOCOL_REQUIRED: "Protocol required",
  PROTOCOL_NOT_ALLOWED: "Protocol not allowed",
  RECIPIENT_REQUIRED: "Recipient required",
  RECIPIENT_NOT_ALLOWED: "Recipient not on your list",
  VALUATION_UNAVAILABLE: "No price available",
  PER_TRANSACTION_LIMIT_EXCEEDED: "Over the per-payment limit",
  DAILY_LIMIT_EXCEEDED: "Over the daily limit",
  MONTHLY_LIMIT_EXCEEDED: "Over the monthly limit",
  AUTONOMY_NOT_SUPPORTED: "Always needs approval",
  ALWAYS_ASK: "Always ask",
  ESCROW_REQUIRED: "Escrow required above your threshold",
  AGENT_NOT_REGISTERED: "Seller isn't a registered Masumi agent",
  AGENT_NOT_TRUSTED: "Seller isn't on your trusted agents",
  ...ALLOWANCE_REASON_LABEL,
};

/** "Over the daily limit: exceeds daily limit (spent + reserved)." */
export function policyReasonText(reason: { readonly code: string; readonly message: string }) {
  const label = (POLICY_REASON_LABEL as Record<string, string | undefined>)[reason.code];
  const message = humanFailure(reason.message);
  return label === undefined
    ? message
    : `${label}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
}
