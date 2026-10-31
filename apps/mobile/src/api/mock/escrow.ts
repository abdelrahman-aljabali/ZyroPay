import {
  cardanoUnsignedBodyHash,
  nativeAsset,
  type SigningReview,
  type X402Escrow,
  type X402EscrowAction,
  type X402EscrowState,
  type X402Proof,
} from "@zyropay/shared";
import { escrowTermsOf } from "@/lib/escrow";
import { fakeHex, fiatValueOf, iso, type MockApproval } from "./fixtures";

/*
 * DEV MOCK: a simulated Masumi escrow for pay_x402 fixtures that pay into escrow. It follows
 * the request (locking until the lock is CONFIRMED), lets the simulated seller deliver a
 * result, and plays the buyer's refund flow: request (confirms after a few seconds) -> the
 * seller authorizes -> withdraw -> refunded. Nothing is on chain; every review is simulated.
 */

/** Simulated timings (ms). */
const ESCROW_TIMING = { confirmMs: 4_000, authorizeMs: 6_000 } as const;
/** Refund requests must leave this margin before unlock (as the API). */
const REFUND_MARGIN_MS = 3 * 60_000;
const SPEND_FEE = "350000";
/** The smallest well-shaped unsigned tx: its body hash is real (like the approval fixtures). */
const UNSIGNED = "84a0a0f5f6";
/** SHA-256 of the body the (simulated) agent received: the receipt's contentSha256. */
export const MOCK_RECEIVED_SHA256 = fakeHex(500, 32);

/** What the simulated seller records on chain: the body it delivered, or something else. */
export type MockSellerResult = "match" | "mismatch";

export interface MockEscrow {
  state: X402EscrowState;
  lockTx: string | null;
  utxo: string | null;
  resultHash: string | null;
  /** The simulated seller's SubmitResult transaction. */
  resultTx: string | null;
  result: MockSellerResult;
  /** When the simulated seller delivers, ms after the lock confirmed (null: never). */
  deliverAfterMs: number | null;
  lockedAt: number | null;
  authorizeAt: number | null;
  requestTx: string | null;
  withdrawTx: string | null;
  pending: {
    action: X402EscrowAction;
    status: "awaiting_signature" | "submitted" | "confirmed" | "failed";
    txHash: string | null;
    bodyHash: string;
    confirmAt: number | null;
    updatedAt: string;
  } | null;
  checkedAt: string | null;
}

export class EscrowConflict extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function newMockEscrow(
  deliverAfterMs: number | null,
  result: MockSellerResult = "match",
): MockEscrow {
  return {
    state: "locking",
    lockTx: null,
    utxo: null,
    resultHash: null,
    resultTx: null,
    result,
    deliverAfterMs,
    lockedAt: null,
    authorizeAt: null,
    requestTx: null,
    withdrawTx: null,
    pending: null,
    checkedAt: null,
  };
}

/** Walk the simulated escrow forward on read, like the API reading the chain. */
export function advanceEscrow(e: MockEscrow, item: MockApproval, seq: () => number): void {
  const now = Date.now();
  const r = item.review.request;
  e.checkedAt = new Date(now).toISOString();
  if (e.state === "locking") {
    if (r.state === "FAILED") e.state = "failed";
    if (r.state !== "CONFIRMED" || r.txHash === null) return;
    e.state = "funds_locked";
    e.lockTx = r.txHash;
    e.utxo = `${r.txHash}#0`;
    e.lockedAt = now;
  }
  if (
    e.state === "funds_locked" &&
    e.deliverAfterMs !== null &&
    e.lockedAt !== null &&
    now - e.lockedAt >= e.deliverAfterMs
  ) {
    e.state = "result_submitted";
    e.resultHash = e.result === "match" ? MOCK_RECEIVED_SHA256 : fakeHex(seq(), 32);
    e.resultTx = fakeHex(seq(), 32);
    e.utxo = `${e.resultTx}#0`;
  }
  const p = e.pending;
  if (p?.status === "submitted" && p.confirmAt !== null && now >= p.confirmAt) {
    p.status = "confirmed";
    p.updatedAt = iso(0);
    if (p.action === "request_refund") {
      e.state = e.resultHash !== null ? "disputed" : "refund_requested";
      e.requestTx = p.txHash;
      e.utxo = `${p.txHash ?? ""}#0`;
      // The simulated seller agrees to refund a few seconds later.
      e.authorizeAt = now + ESCROW_TIMING.authorizeMs;
    } else {
      e.state = "refunded";
      e.withdrawTx = p.txHash;
      e.utxo = null;
    }
  }
  if (
    e.authorizeAt !== null &&
    now >= e.authorizeAt &&
    (e.state === "refund_requested" || e.state === "disputed")
  ) {
    e.state = "refund_authorized";
    e.utxo = `${fakeHex(seq(), 32)}#0`;
    e.authorizeAt = null;
  }
}

function available(e: MockEscrow, item: MockApproval): X402EscrowAction[] {
  const terms = escrowTermsOf(item.review.payload);
  if (terms === null || e.pending?.status === "submitted") return [];
  const now = Date.now();
  const out: X402EscrowAction[] = [];
  if (
    (e.state === "funds_locked" || e.state === "result_submitted" || e.state === "disputed") &&
    now < new Date(terms.deadlines.unlock).getTime() - REFUND_MARGIN_MS
  )
    out.push("request_refund");
  if (
    e.state === "refund_authorized" ||
    ((e.state === "funds_locked" || e.state === "refund_requested") &&
      e.resultHash === null &&
      now >= new Date(terms.deadlines.submitResult).getTime())
  )
    out.push("withdraw_refund");
  return out;
}

const PROOF_MESSAGE: Readonly<Record<X402Proof["state"], string>> = {
  pending: "Waiting for the seller to record the result on Cardano.",
  verified:
    "Verified on Cardano: what your agent received matches the result the seller recorded on chain.",
  mismatch:
    "The delivered content does not match what the seller recorded on Cardano. You can request a refund in ZyroPay.",
  not_delivered:
    "The seller did not record a result on Cardano before the deadline. You can get a refund in ZyroPay.",
  unverifiable: "The delivered content could not be checked against the on-chain result.",
  receipt_only: "Direct payment: no result is recorded on chain.",
};

/** Proof before release, as the API derives it (the simulated agent received the body). */
function proofOf(e: MockEscrow, submitResult: string): X402Proof | null {
  if (e.state === "locking" || e.state === "failed") return null;
  const missed =
    e.resultHash === null &&
    ["funds_locked", "refund_requested", "refund_authorized", "refunded"].includes(e.state) &&
    Date.now() >= new Date(submitResult).getTime();
  const state: X402Proof["state"] =
    e.resultHash !== null
      ? e.resultHash === MOCK_RECEIVED_SHA256
        ? "verified"
        : "mismatch"
      : missed
        ? "not_delivered"
        : "pending";
  return {
    state,
    receivedHash: MOCK_RECEIVED_SHA256,
    onChainHash: e.resultHash,
    resultTx: e.resultTx,
    checkedAt: e.checkedAt,
    message: PROOF_MESSAGE[state],
  };
}

/** The escrow as the API reports it (X402Escrow), or undefined for a non-escrow payment. */
export function escrowViewOf(e: MockEscrow, item: MockApproval): X402Escrow | undefined {
  const terms = escrowTermsOf(item.review.payload);
  if (terms === null) return undefined;
  const proof = proofOf(e, terms.deadlines.submitResult);
  const actions = available(e, item);
  const failed = proof?.state === "mismatch" || proof?.state === "not_delivered";
  const recommended: X402EscrowAction | null = !failed
    ? null
    : proof.state === "not_delivered" && actions.includes("withdraw_refund")
      ? "withdraw_refund"
      : actions.includes("request_refund")
        ? "request_refund"
        : actions.includes("withdraw_refund")
          ? "withdraw_refund"
          : null;
  return {
    method: "masumi",
    state: e.state,
    escrowAddress: terms.escrowAddress,
    sellerAddress: terms.sellerAddress,
    lockTx: e.lockTx,
    utxo: e.utxo,
    lockedLovelace: terms.lockedLovelace,
    collateralLovelace: terms.collateralLovelace,
    deadlines: terms.deadlines,
    resultHash: e.resultHash,
    proof,
    refund: {
      available: actions,
      recommended,
      reason: recommended === null ? null : (proof?.message ?? null),
      withdrawableAt: e.resultHash === null ? terms.deadlines.submitResult : null,
      pending:
        e.pending === null
          ? null
          : {
              action: e.pending.action,
              status: e.pending.status,
              txHash: e.pending.txHash,
              updatedAt: e.pending.updatedAt,
            },
      requestTx: e.requestTx,
      withdrawTx: e.withdrawTx,
    },
    checkedAt: e.checkedAt,
  };
}

/** Build the (simulated) escrow spend for review, or throw EscrowConflict when not possible. */
export function prepareEscrowSpend(
  e: MockEscrow,
  item: MockApproval,
  action: X402EscrowAction,
): SigningReview {
  const terms = escrowTermsOf(item.review.payload);
  if (terms === null) throw new EscrowConflict("this payment has no escrow");
  if (e.state === "locking")
    throw new EscrowConflict("the escrow payment is not confirmed on chain yet");
  if (e.pending?.status === "submitted")
    throw new EscrowConflict("an escrow transaction is already in flight");
  if (!available(e, item).includes(action)) {
    if (action === "withdraw_refund" && e.resultHash === null)
      throw new EscrowConflict("the refund can be withdrawn after the result deadline", {
        retryAfter: terms.deadlines.submitResult,
      });
    throw new EscrowConflict(
      action === "request_refund"
        ? "a refund can't be requested in this escrow state"
        : "the refund can't be withdrawn in this escrow state",
    );
  }
  const base = item.review;
  const bodyHash = cardanoUnsignedBodyHash(UNSIGNED) ?? "";
  e.pending = {
    action,
    status: "awaiting_signature",
    txHash: null,
    bodyHash,
    confirmAt: null,
    updatedAt: iso(0),
  };
  const fee = fiatValueOf(nativeAsset(base.payload.network), SPEND_FEE);
  return {
    ...base,
    unsignedTransaction: { encoding: "hex", serialized: UNSIGNED },
    ...(base.rawPayload ? { rawPayload: { ...base.rawPayload, payload: bodyHash } } : {}),
    escrowSpend: {
      action,
      escrowUtxo: e.utxo ?? "",
      lockedLovelace: terms.lockedLovelace,
      refundTo: base.payload.from,
      validFrom: iso(-60_000),
      validUntil: iso(10 * 60_000),
    },
    estimatedFee: { amount: SPEND_FEE, value: fee },
    warnings: base.warnings.filter((w) => w.code === "SIMULATED" || w.code === "TESTNET"),
  };
}

/** Accept the stamped spend: it confirms a few seconds later (advanceEscrow). */
export function submitEscrowSpend(
  e: MockEscrow,
  action: X402EscrowAction,
  bodyHash: string,
  txHash: string,
): void {
  if (e.pending?.action !== action || e.pending.status !== "awaiting_signature")
    throw new EscrowConflict("prepare this escrow action first");
  if (e.pending.bodyHash !== bodyHash) throw new EscrowConflict("BODY_HASH");
  e.pending = {
    ...e.pending,
    status: "submitted",
    txHash,
    confirmAt: Date.now() + ESCROW_TIMING.confirmMs,
    updatedAt: iso(0),
  };
}
