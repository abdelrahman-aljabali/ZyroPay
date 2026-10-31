/*
 * Durable state machine persistence. Every state change goes through `applyEvent`:
 * the next state comes from the shared `transition()` (illegal => throws), and the row is
 * updated with optimistic locking (`WHERE id = $1 AND version = $2`). A lost race raises
 * VERSION_CONFLICT, so two workers can never both move a request (e.g. into SIGNING).
 */
import type { TxRequestEvent } from "@zyropay/shared";
import { transition } from "@zyropay/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import { AppError } from "../lib/errors";
import type { ApprovalRow, TxRequestRow } from "./mappers";

type RequestPatch = Partial<
  Pick<
    TxRequestRow,
    | "policyDecision"
    | "policyReasons"
    | "policyVersion"
    | "valuationUsdMinor"
    | "txHash"
    | "failureReason"
    | "unsignedTransaction"
    | "unsignedTransactionEncoding"
    | "simulated"
  >
>;

export class VersionConflictError extends AppError {
  constructor() {
    super("VERSION_CONFLICT", "request was modified concurrently; retry");
  }
}

export async function applyEvent(
  db: Db,
  row: TxRequestRow,
  event: TxRequestEvent,
  now: Date,
  patch: RequestPatch = {},
): Promise<TxRequestRow> {
  const next = transition(row.state, event);
  const [updated] = await db
    .update(t.transactionRequests)
    .set({ ...patch, state: next, version: row.version + 1, updatedAt: now })
    .where(
      and(eq(t.transactionRequests.id, row.id), eq(t.transactionRequests.version, row.version)),
    )
    .returning();
  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

/** Data-only update (no state change) under the same optimistic lock. */
export async function updateRequestData(
  db: Db,
  row: TxRequestRow,
  now: Date,
  patch: RequestPatch,
): Promise<TxRequestRow> {
  const [updated] = await db
    .update(t.transactionRequests)
    .set({ ...patch, version: row.version + 1, updatedAt: now })
    .where(
      and(eq(t.transactionRequests.id, row.id), eq(t.transactionRequests.version, row.version)),
    )
    .returning();
  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

export async function releaseReservation(db: Db, requestId: string, now: Date): Promise<void> {
  await db
    .update(t.spendingReservations)
    .set({ status: "released", resolvedAt: now })
    .where(
      and(
        eq(t.spendingReservations.transactionRequestId, requestId),
        eq(t.spendingReservations.status, "active"),
      ),
    );
}

/** Confirmed: reservation -> settled and one ledger row (UNIQUE per request => exactly once). */
export async function settleReservation(
  db: Db,
  request: TxRequestRow,
  occurredAt: Date,
  now: Date,
): Promise<void> {
  if (request.agentId === null) return;
  const [reservation] = await db
    .update(t.spendingReservations)
    .set({ status: "settled", resolvedAt: now })
    .where(
      and(
        eq(t.spendingReservations.transactionRequestId, request.id),
        eq(t.spendingReservations.status, "active"),
      ),
    )
    .returning();
  const amount = reservation?.amountUsdMinor ?? request.valuationUsdMinor;
  if (amount === null) return; // unvalued request approved by the human: nothing to attribute
  await db
    .insert(t.spendingLedger)
    .values({
      agentId: request.agentId,
      userId: request.userId,
      transactionRequestId: request.id,
      amountUsdMinor: amount,
      occurredAt,
      createdAt: now,
    })
    .onConflictDoNothing();
}

async function setPendingApprovalStatus(
  db: Db,
  requestId: string,
  status: ApprovalRow["status"],
  now: Date,
  reason?: string,
): Promise<void> {
  await db
    .update(t.approvalRequests)
    .set({
      status,
      decidedAt: now,
      updatedAt: now,
      ...(reason !== undefined ? { rejectionReason: reason } : {}),
    })
    .where(
      and(
        eq(t.approvalRequests.transactionRequestId, requestId),
        eq(t.approvalRequests.status, "pending"),
      ),
    );
}

export async function getArtifacts(db: Db, requestId: string) {
  const [row] = await db
    .select()
    .from(t.transactionRequestArtifacts)
    .where(eq(t.transactionRequestArtifacts.transactionRequestId, requestId));
  return row ?? null;
}

export async function upsertArtifacts(
  db: Db,
  requestId: string,
  now: Date,
  patch: Partial<Omit<typeof t.transactionRequestArtifacts.$inferInsert, "transactionRequestId">>,
): Promise<void> {
  await db
    .insert(t.transactionRequestArtifacts)
    .values({ transactionRequestId: requestId, updatedAt: now, ...patch })
    .onConflictDoUpdate({
      target: t.transactionRequestArtifacts.transactionRequestId,
      set: { ...patch, updatedAt: now },
    });
}

/** Withdraw a request before signing: CANCEL/EXPIRE + close approval + release reservation. */
export async function withdrawRequest(
  db: Db,
  row: TxRequestRow,
  event: "CANCEL" | "EXPIRE" | "FAIL",
  now: Date,
  reason: string,
): Promise<TxRequestRow> {
  const updated = await applyEvent(db, row, event, now, { failureReason: reason });
  await releaseReservation(db, row.id, now);
  await setPendingApprovalStatus(db, row.id, event === "EXPIRE" ? "expired" : "cancelled", now);
  return updated;
}
