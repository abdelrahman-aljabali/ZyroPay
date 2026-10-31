/*
 * Masumi escrow state of a pay_x402 request (docs/CARDANO_X402.md "Masumi escrow"):
 * what is stored in transaction_request_artifacts.x402_escrow, the shared X402Escrow view
 * derived from it, and the refresh that reads the chain.
 *
 * The lock is the request's own transaction (escrow output = output 0, enforced by the lock
 * verifier). Once the request is CONFIRMED the escrow UTxO is read from the chain and
 * followed through continuing outputs (a refund request, a seller's SubmitResult or
 * AuthorizeRefund) by its datum's reference_signature. A buyer spend in flight is tracked
 * by its transaction id. Every chain answer is re-checked: a UTxO whose datum is not a
 * vested_pay datum for THIS escrow (other reference_signature, other buyer) is "unknown".
 * Persisting uses compare-and-set on the stored JSON, so a concurrent refresh never
 * overwrites a newer spend.
 */
import type {
  JsonObject,
  X402Escrow,
  X402EscrowAction,
  X402EscrowState,
  X402Proof,
  X402ProofState,
} from "@zyropay/shared";
import { cardanoPaymentKeyHash, isTerminalState } from "@zyropay/shared";
import type { MasumiEscrowTerms } from "@zyropay/integrations";
import { masumiEscrowTermsOf, masumiEscrowView } from "@zyropay/integrations";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { EscrowOnChain } from "../chain";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { audit } from "./audit";
import type { Artifacts } from "./build";
import type { TxRequestRow } from "./mappers";

/** Chain reads are reused for this long (get_approval_status polls every few seconds). */
const ESCROW_READ_MAX_AGE_MS = 20_000;
/** A refund request must leave this much time before the unlock time. */
export const REFUND_REQUEST_MARGIN_MS = 3 * 60_000;

const RefSchema = z.object({
  txHash: z.string().regex(/^[0-9a-f]{64}$/),
  index: z.number().int().min(0),
});
const UtxoSchema = RefSchema.extend({
  address: z.string(),
  lovelace: z.string().regex(/^[0-9]+$/),
  assets: z.record(z.string(), z.string().regex(/^[0-9]+$/)),
  inlineDatum: z.string().regex(/^(?:[0-9a-f]{2})+$/),
});
const ActionSchema = z.enum(["request_refund", "withdraw_refund"]);
const PendingSchema = z.object({
  action: ActionSchema,
  status: z.enum(["awaiting_signature", "submitted", "confirmed", "failed"]),
  unsigned: z.string(),
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
  fee: z.string(),
  continuingDatumCbor: z.string().nullable(),
  validityStartSlot: z.string(),
  ttlSlot: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  utxo: UtxoSchema,
  txHash: z.string().nullable(),
  signedTransaction: z.string().nullable(),
  failureReason: z.string().nullable(),
  updatedAt: z.string(),
});
export type PendingSpend = z.infer<typeof PendingSchema>;

const StoredSchema = z.object({
  /** The escrow UTxO last seen (null: the lock output). */
  current: RefSchema.nullable(),
  snapshot: z
    .object({
      state: z.enum([
        "funds_locked",
        "result_submitted",
        "refund_requested",
        "disputed",
        "withdraw_authorized",
        "refund_authorized",
        "refunded",
        "withdrawn",
        "unknown",
      ]),
      resultHash: z.string().nullable(),
      buyerCooldownTime: z.string(),
      utxo: UtxoSchema.nullable(),
      checkedAt: z.string(),
    })
    .nullable(),
  pending: PendingSchema.nullable(),
  requestTx: z.string().nullable(),
  withdrawTx: z.string().nullable(),
  /** The seller's SubmitResult transaction (the UTxO first seen in result_submitted). */
  resultTx: z.string().nullable().optional(),
  /** Last recorded proof verdict (audited once per change; see recordProof). */
  proof: z
    .object({
      state: z.enum(["pending", "verified", "mismatch", "not_delivered", "unverifiable"]),
      receivedHash: z.string().nullable(),
      onChainHash: z.string().nullable(),
      checkedAt: z.string(),
    })
    .nullable()
    .optional(),
});
export type StoredEscrow = z.infer<typeof StoredSchema>;

const EMPTY: StoredEscrow = {
  current: null,
  snapshot: null,
  pending: null,
  requestTx: null,
  withdrawTx: null,
};

/** The stored escrow state (fails closed to empty on a malformed row, never throws). */
export function storedEscrow(artifacts: Artifacts | null): StoredEscrow {
  const parsed = StoredSchema.safeParse(artifacts?.x402Escrow ?? null);
  return parsed.success ? parsed.data : EMPTY;
}

/** The masumi terms of a request, or null for any other request. */
export function escrowTermsOf(row: TxRequestRow): MasumiEscrowTerms | null {
  if (row.payload.plugin !== "x402") return null;
  try {
    return masumiEscrowTermsOf(row.payload.pluginData);
  } catch {
    return null;
  }
}

/** Lock transaction id: derived from the signed bytes (hand-off) or the tracked hash. */
function lockTxOf(row: TxRequestRow, artifacts: Artifacts | null): string | null {
  return artifacts?.expectedTxHash ?? row.txHash ?? null;
}

const iso = (ms: bigint | string) => new Date(Number(ms)).toISOString();

/** Buyer actions possible at `now` for a datum state (pending spends aside). */
export function availableActions(
  state: X402EscrowState,
  terms: MasumiEscrowTerms,
  snapshot: StoredEscrow["snapshot"],
  now: Date,
): X402EscrowAction[] {
  const t = now.getTime();
  const out: X402EscrowAction[] = [];
  const cooldown = Number(snapshot?.buyerCooldownTime ?? "0");
  if (
    (state === "funds_locked" || state === "result_submitted" || state === "disputed") &&
    t < Number(terms.unlockTime) - REFUND_REQUEST_MARGIN_MS &&
    t >= cooldown
  )
    out.push("request_refund");
  if (
    state === "refund_authorized" ||
    ((state === "funds_locked" || state === "refund_requested") &&
      snapshot?.resultHash == null &&
      t >= Number(terms.submitResultTime))
  )
    out.push("withdraw_refund");
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HASH = /^(?:[0-9a-f]{2}){1,64}$/;

/** SHA-256 of the body the agent received (the MCP worker's own hash, never the seller's). */
function receivedHashOf(artifacts: Artifacts | null): string | null {
  if (artifacts?.x402DeliveredAt == null) return null;
  const receipt: unknown = artifacts.x402Report?.receipt;
  if (typeof receipt !== "object" || receipt === null) return null;
  const hash = (receipt as { contentSha256?: unknown }).contentSha256;
  return typeof hash === "string" && HEX64.test(hash.toLowerCase()) ? hash.toLowerCase() : null;
}

/** States in which "no result on chain" after the submitResult deadline means not delivered. */
const NO_RESULT_STATES: ReadonlySet<X402EscrowState> = new Set([
  "funds_locked",
  "refund_requested",
  "refund_authorized",
  "refunded",
]);

const PROOF_MESSAGES: Readonly<Record<Exclude<X402ProofState, "receipt_only">, string>> = {
  pending: "Waiting for the seller to record the result on Cardano.",
  verified:
    "Verified on Cardano: what your agent received matches the result the seller recorded on chain.",
  mismatch:
    "The delivered content does not match what the seller recorded on Cardano. You can request a refund in ZyroPay.",
  not_delivered:
    "The seller did not record a result on Cardano before the deadline. You can get a refund in ZyroPay.",
  unverifiable:
    "The seller recorded a result on Cardano, but the delivered content could not be checked against it (it was truncated or not text).",
};

/**
 * Proof before release: compare the hash of the body the agent received with the escrow
 * datum's result_hash. Pure (stored state + now); null once the lock failed.
 */
function escrowProof(
  state: X402EscrowState,
  terms: MasumiEscrowTerms,
  stored: StoredEscrow,
  artifacts: Artifacts | null,
  now: Date,
): X402Proof | null {
  if (state === "failed") return null;
  const snapshot = stored.snapshot;
  // A later unreadable / foreign read never erases a result already seen.
  const raw = snapshot?.resultHash ?? stored.proof?.onChainHash ?? null;
  const onChainHash = raw !== null && HASH.test(raw.toLowerCase()) ? raw.toLowerCase() : null;
  const receivedHash = receivedHashOf(artifacts);
  const resultTx =
    stored.resultTx ??
    (snapshot?.state === "result_submitted" && snapshot.utxo !== null
      ? snapshot.utxo.txHash
      : null);
  let verdict: Exclude<X402ProofState, "receipt_only">;
  if (onChainHash !== null) {
    if (artifacts?.x402DeliveredAt == null) verdict = "pending";
    else if (receivedHash === null) verdict = "unverifiable";
    else verdict = receivedHash === onChainHash ? "verified" : "mismatch";
  } else if (
    snapshot !== null &&
    NO_RESULT_STATES.has(snapshot.state) &&
    now.getTime() >= Number(terms.submitResultTime)
  )
    verdict = "not_delivered";
  else verdict = "pending";
  return {
    state: verdict,
    receivedHash,
    onChainHash,
    resultTx: resultTx !== null && HEX64.test(resultTx) ? resultTx : null,
    checkedAt: snapshot?.checkedAt ?? null,
    message: PROOF_MESSAGES[verdict],
  };
}

/** The buyer action to recommend when the proof failed (one of `available`). */
function recommendedAction(
  proof: X402Proof | null,
  available: readonly X402EscrowAction[],
): X402EscrowAction | null {
  if (proof?.state === "not_delivered" && available.includes("withdraw_refund"))
    return "withdraw_refund";
  if (proof?.state !== "mismatch" && proof?.state !== "not_delivered") return null;
  if (available.includes("request_refund")) return "request_refund";
  return available.includes("withdraw_refund") ? "withdraw_refund" : null;
}

/** The shared X402Escrow view of stored state (no chain access). */
export function escrowSummary(
  row: TxRequestRow,
  artifacts: Artifacts | null,
  now: Date,
): X402Escrow | undefined {
  const terms = escrowTermsOf(row);
  if (terms === null) return undefined;
  const stored = storedEscrow(artifacts);
  const lockTx = lockTxOf(row, artifacts);
  let state: X402EscrowState;
  if (row.state !== "CONFIRMED") state = isTerminalState(row.state) ? "failed" : "locking";
  else state = stored.snapshot?.state ?? "unknown";
  const pending = stored.pending;
  const inFlight = pending?.status === "submitted";
  const available = inFlight ? [] : availableActions(state, terms, stored.snapshot, now);
  const current = stored.current ?? (lockTx !== null ? { txHash: lockTx, index: 0 } : null);
  const waitsForDeadline =
    (state === "funds_locked" || state === "refund_requested") &&
    stored.snapshot?.resultHash == null &&
    now.getTime() < Number(terms.submitResultTime);
  const proof = state === "locking" ? null : escrowProof(state, terms, stored, artifacts, now);
  const recommended = recommendedAction(proof, available);
  return {
    method: "masumi",
    state,
    escrowAddress: terms.escrowAddress,
    sellerAddress: terms.sellerAddress,
    lockTx,
    utxo: current === null ? null : `${current.txHash}#${String(current.index)}`,
    lockedLovelace: terms.lockedLovelace,
    collateralLovelace: terms.collateralLovelace,
    deadlines: {
      payBy: iso(terms.payByTime),
      submitResult: iso(terms.submitResultTime),
      unlock: iso(terms.unlockTime),
      externalDisputeUnlock: iso(terms.externalDisputeUnlockTime),
    },
    resultHash: stored.snapshot?.resultHash ?? null,
    proof,
    refund: {
      available,
      recommended,
      reason: recommended === null ? null : (proof?.message ?? null),
      withdrawableAt: waitsForDeadline ? iso(terms.submitResultTime) : null,
      pending:
        pending === null
          ? null
          : {
              action: pending.action,
              status: pending.status,
              txHash: pending.txHash,
              updatedAt: pending.updatedAt,
            },
      requestTx: stored.requestTx,
      withdrawTx: stored.withdrawTx,
    },
    checkedAt: stored.snapshot?.checkedAt ?? null,
  };
}

/**
 * Compare-and-set of the stored escrow JSON: writes `next` only if the row still holds
 * `prev` (or none). Returns false when another writer got there first.
 */
export async function casEscrow(
  ctx: Ctx,
  requestId: string,
  /** The stored JSON this write replaces (null: none stored yet). */
  prev: unknown,
  next: StoredEscrow,
): Promise<boolean> {
  const { deps } = ctx;
  const now = deps.clock.now();
  const value = next as unknown as JsonObject;
  const col = t.transactionRequestArtifacts.x402Escrow;
  const updated = await deps.db
    .update(t.transactionRequestArtifacts)
    .set({ x402Escrow: value, updatedAt: now })
    .where(
      and(
        eq(t.transactionRequestArtifacts.transactionRequestId, requestId),
        prev === null || prev === undefined
          ? isNull(col)
          : sql`${col} = ${JSON.stringify(prev)}::jsonb`,
      ),
    )
    .returning({ id: t.transactionRequestArtifacts.transactionRequestId });
  return updated.length === 1;
}

/** Same escrow (reference_signature) and same buyer as the lock: else the read is refused. */
function sameEscrow(utxo: EscrowOnChain, terms: MasumiEscrowTerms, from: string): boolean {
  const lock = masumiEscrowView(terms.datumCbor);
  const view = masumiEscrowView(utxo.inlineDatum);
  return (
    lock !== null &&
    view !== null &&
    utxo.address === terms.escrowAddress &&
    view.referenceSignature === lock.referenceSignature &&
    view.buyerKeyHash === cardanoPaymentKeyHash(from)
  );
}

/**
 * Read the escrow from the chain (when the lock is confirmed and the last read is older
 * than `maxAgeMs`), track a submitted buyer spend, persist, and return the view. Chain
 * failures never throw: the last known state is kept (or "unknown").
 */
export async function refreshEscrow(
  ctx: Ctx,
  row: TxRequestRow,
  artifacts: Artifacts | null,
  options: { maxAgeMs?: number } = {},
): Promise<X402Escrow | undefined> {
  const { deps } = ctx;
  const terms = escrowTermsOf(row);
  if (terms === null) return undefined;
  const now = deps.clock.now();
  const before = storedEscrow(artifacts);
  const lockTx = lockTxOf(row, artifacts);
  const maxAge = options.maxAgeMs ?? ESCROW_READ_MAX_AGE_MS;
  const fresh =
    before.snapshot !== null &&
    now.getTime() - Date.parse(before.snapshot.checkedAt) < maxAge &&
    before.pending?.status !== "submitted";
  if (row.state !== "CONFIRMED" || lockTx === null || fresh)
    return recordProof(ctx, row, artifacts, now);

  const next: StoredEscrow = structuredClone(before);
  let escrowChain;
  try {
    escrowChain = deps.chain.cardanoEscrow(row.network);
  } catch {
    return recordProof(ctx, row, artifacts, now);
  }
  const pending = next.pending;
  if (pending?.status === "submitted" && pending.txHash !== null) {
    const outcome = await deps.chain
      .track({ network: row.network, txHash: pending.txHash, validUntilSlot: pending.ttlSlot })
      .catch(() => null);
    if (outcome?.status === "confirmed") {
      pending.status = "confirmed";
      pending.updatedAt = now.toISOString();
      if (pending.action === "request_refund") next.requestTx = pending.txHash;
      else next.withdrawTx = pending.txHash;
      await audit(ctx, {
        actorType: "system",
        userId: row.userId,
        action:
          pending.action === "request_refund"
            ? "x402.escrow_refund_request_confirmed"
            : "x402.escrow_refund_withdrawal_confirmed",
        targetType: "transaction_request",
        targetId: row.id,
        metadata: { txHash: pending.txHash },
      });
    } else if (
      outcome?.status === "failed" ||
      outcome?.status === "expired" ||
      outcome?.status === "replaced"
    ) {
      pending.status = "failed";
      pending.failureReason = outcome.error ?? `the transaction ${outcome.status}`;
      pending.updatedAt = now.toISOString();
    } else if (outcome?.rebroadcastSuggested === true && pending.signedTransaction !== null) {
      // The node lost it but it can still land: re-send the same bytes.
      await escrowChain.submit(pending.signedTransaction).catch(() => undefined);
    }
  }

  const lockView = masumiEscrowView(terms.datumCbor);
  const ref = next.current ?? { txHash: lockTx, index: 0 };
  let snapshot: StoredEscrow["snapshot"] = next.snapshot;
  try {
    if (lockView === null) throw new Error("the bound datum does not decode");
    const read = await escrowChain.read(ref, {
      referenceSignature: lockView.referenceSignature,
      lockDatumCbor: terms.datumCbor,
      lockLovelace: terms.lockedLovelace,
    });
    const checkedAt = now.toISOString();
    if (read.status === "unspent") {
      const view = masumiEscrowView(read.utxo.inlineDatum);
      if (view === null || !sameEscrow(read.utxo, terms, row.payload.from)) {
        deps.logger.warn("x402.escrow_foreign_utxo", { requestId: row.id });
        snapshot = {
          state: "unknown",
          resultHash: null,
          buyerCooldownTime: "0",
          utxo: null,
          checkedAt,
        };
      } else {
        next.current = { txHash: read.utxo.txHash, index: read.utxo.index };
        snapshot = {
          state: view.state,
          resultHash: view.resultHash,
          buyerCooldownTime: view.buyerCooldownTime.toString(),
          utxo: read.utxo,
          checkedAt,
        };
      }
    } else if (read.status === "spent") {
      const ours =
        read.spentBy === next.withdrawTx ||
        (next.pending?.action === "withdraw_refund" && next.pending.txHash === read.spentBy);
      if (ours && next.pending !== null && next.pending.status !== "confirmed") {
        next.pending.status = "confirmed";
        next.pending.updatedAt = checkedAt;
      }
      if (ours) next.withdrawTx = read.spentBy;
      snapshot = {
        state: ours ? "refunded" : "withdrawn",
        resultHash: next.snapshot?.resultHash ?? null,
        buyerCooldownTime: "0",
        utxo: null,
        checkedAt,
      };
    } else {
      snapshot = {
        state: next.snapshot?.state ?? "unknown",
        resultHash: next.snapshot?.resultHash ?? null,
        buyerCooldownTime: next.snapshot?.buyerCooldownTime ?? "0",
        utxo: next.snapshot?.utxo ?? null,
        checkedAt,
      };
    }
  } catch (error) {
    deps.logger.warn("x402.escrow_read_failed", { requestId: row.id, error });
  }
  next.snapshot = snapshot;
  if (
    next.resultTx == null &&
    snapshot?.state === "result_submitted" &&
    snapshot.resultHash !== null &&
    snapshot.utxo !== null
  )
    next.resultTx = snapshot.utxo.txHash;
  const persisted = await casEscrow(ctx, row.id, artifacts?.x402Escrow ?? null, next).catch(
    () => false,
  );
  const view = { ...artifacts, x402Escrow: next } as Artifacts;
  return recordProof(ctx, row, persisted ? view : artifacts, now);
}

const PROOF_AUDIT: Readonly<Partial<Record<X402ProofState, string>>> = {
  verified: "x402.proof_verified",
  mismatch: "security.x402_proof_mismatch",
  not_delivered: "x402.proof_not_delivered",
  unverifiable: "x402.proof_unverifiable",
};

/**
 * Persist the proof verdict when it changed (compare-and-set, so concurrent polls audit a
 * change once) and return the view. Never throws.
 */
async function recordProof(
  ctx: Ctx,
  row: TxRequestRow,
  artifacts: Artifacts | null,
  now: Date,
): Promise<X402Escrow | undefined> {
  const view = escrowSummary(row, artifacts, now);
  const proof = view?.proof ?? null;
  if (view === undefined || proof === null || proof.state === "receipt_only") return view;
  const stored = storedEscrow(artifacts);
  const before = stored.proof ?? null;
  if (
    before?.state === proof.state &&
    before.onChainHash === proof.onChainHash &&
    before.receivedHash === proof.receivedHash
  )
    return view;
  if (before === null && proof.state === "pending") return view;
  const next: StoredEscrow = {
    ...stored,
    resultTx: stored.resultTx ?? proof.resultTx,
    proof: {
      state: proof.state,
      receivedHash: proof.receivedHash,
      onChainHash: proof.onChainHash,
      checkedAt: now.toISOString(),
    },
  };
  const persisted = await casEscrow(ctx, row.id, artifacts?.x402Escrow ?? null, next).catch(
    () => false,
  );
  if (!persisted) return view;
  const action = PROOF_AUDIT[proof.state];
  if (action !== undefined && before?.state !== proof.state) {
    if (proof.state === "mismatch")
      ctx.deps.logger.warn("x402.proof_mismatch", { requestId: row.id });
    await audit(ctx, {
      actorType: "system",
      userId: row.userId,
      action,
      targetType: "transaction_request",
      targetId: row.id,
      metadata: {
        receivedHash: proof.receivedHash,
        onChainHash: proof.onChainHash,
        resultTx: proof.resultTx,
      },
    }).catch(() => undefined);
  }
  return view;
}
