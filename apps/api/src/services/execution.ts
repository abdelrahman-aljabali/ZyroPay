/*
 * Async execution stages (queue consumer + cron). Every step is idempotent:
 *  - execute:   APPROVED -> SIGNING under the optimistic lock (exactly one winner), then the
 *               delegated key signs; the signed bytes are stored before broadcasting.
 *  - broadcast: C7 (signed bytes == reviewed bytes, expected signer), then the tx hash is
 *               DERIVED from the signed bytes and stored before sending. It re-sends the SAME
 *               stored bytes (a rebroadcast is a no-op on chain); SIGNING -> BROADCAST once;
 *               executed_transactions is UNIQUE per request. A failed send is reconciled
 *               against the chain by that hash: known/landed => BROADCAST, provably dead
 *               (Solana blockhash expired, EVM nonce replaced) => FAILED, otherwise it stays
 *               SIGNING and is retried; it is never marked FAILED blindly.
 *  - confirm:   BROADCAST -> CONFIRMED/FAILED from our own RPC read via the confirmation
 *               tracker (never a webhook alone); reservation -> settled + one ledger row, or
 *               released on failure.
 *  - expire:    pre-signing requests past expiresAt -> EXPIRED, reservation released.
 */
import { chainFamilyOf } from "@zyropay/shared";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import * as t from "../db/tables";
import type { AppDeps, Ctx } from "../deps";
import { audit } from "./audit";
import type { TxRequestRow } from "./mappers";
import { rebuildIfExpiring, verifyStored } from "./build";
import { enqueueNotification } from "./notifications";
import {
  applyEvent,
  getArtifacts,
  releaseReservation,
  settleReservation,
  upsertArtifacts,
  VersionConflictError,
  withdrawRequest,
} from "./tx-state";
import { decryptSecret } from "@zyropay/wallet";
import { executeAllowanceSpend, isAllowanceRequest } from "./allowances";
import { updateRequestData } from "./tx-state";

const MAX_BROADCAST_ATTEMPTS = 5;
const MAX_CONFIRM_ATTEMPTS = 40;

function systemCtx(deps: AppDeps, requestId = "system"): Ctx {
  return { deps, requestId, ip: null };
}

async function loadRequest(deps: AppDeps, requestId: string): Promise<TxRequestRow | null> {
  const [row] = await deps.db
    .select()
    .from(t.transactionRequests)
    .where(eq(t.transactionRequests.id, requestId));
  return row ?? null;
}

async function failRequest(deps: AppDeps, row: TxRequestRow, reason: string): Promise<void> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await applyEvent(tx, row, "FAIL", now, { failureReason: reason });
    await releaseReservation(tx, row.id, now);
    await tx
      .update(t.executedTransactions)
      .set({ status: "failed", error: reason.slice(0, 200), updatedAt: now })
      .where(eq(t.executedTransactions.transactionRequestId, row.id));
  });
  await enqueueNotification(systemCtx(deps), {
    userId: row.userId,
    event: "transaction_failed",
    dedupeKey: `failed:${row.id}`,
    title: "Payment failed",
    body: "A payment could not be completed. No funds were moved by ZyroPay.",
    data: { requestId: row.id },
  });
}

/** Decrypt the user's active delegated key for a sub-org (Signer port resolver). */
export async function resolveDelegatedKey(deps: AppDeps, subOrganizationId: string) {
  const key = deps.config.delegatedKeyEncryptionKey;
  if (key === null) return null;
  const [row] = await deps.db
    .select({ signer: t.delegatedSigners, userId: t.users.id })
    .from(t.delegatedSigners)
    .innerJoin(t.users, eq(t.users.id, t.delegatedSigners.userId))
    .where(
      and(
        eq(t.users.turnkeySubOrganizationId, subOrganizationId),
        eq(t.delegatedSigners.status, "active"),
      ),
    );
  if (row === undefined) return null;
  const privateKey = await decryptSecret(row.signer.encryptedApiPrivateKey, key, row.userId);
  return { publicKey: row.signer.apiPublicKey, privateKey };
}

/** Autonomous path (ADR-001 D6): delegated-key signing of an APPROVED agent request. */
export async function executeAutonomous(deps: AppDeps, requestId: string): Promise<void> {
  const row = await loadRequest(deps, requestId);
  if (row === null || row.state !== "APPROVED" || row.agentId === null) return; // idempotent no-op
  if (await isAllowanceRequest(deps.db, row.id)) {
    // Auto-pay on Cardano: the agent key spends the on-chain allowance (docs/AUTOPAY.md).
    await executeAllowanceSpend(deps, requestId, {
      fail: (r, reason) => failRequest(deps, r, reason),
      markBroadcast: (r, txHash) => markBroadcast(deps, r, txHash, null),
      applyEvent: (r, event) => applyEvent(deps.db, r, event, deps.clock.now()),
      updateData: (r, patch) => updateRequestData(deps.db, r, deps.clock.now(), patch),
      upsertArtifacts: (patch) => upsertArtifacts(deps.db, requestId, deps.clock.now(), patch),
      withdraw: async (r, reason) => {
        await deps.db
          .transaction((tx) => withdrawRequest(tx, r, "EXPIRE", deps.clock.now(), reason))
          .catch(() => undefined);
      },
    });
    return;
  }
  const now = deps.clock.now();
  if (row.expiresAt <= now) {
    await deps.db
      .transaction((tx) => withdrawRequest(tx, row, "EXPIRE", now, "expired before signing"))
      .catch(() => undefined);
    return;
  }
  if (row.unsignedTransaction === null || row.unsignedTransactionEncoding === null) {
    await failRequest(deps, row, "transaction was not built");
    return;
  }
  // Re-check the agent at execution time (revocation may have happened after approval).
  const [policy] = await deps.db
    .select()
    .from(t.agentPolicies)
    .where(eq(t.agentPolicies.agentId, row.agentId));
  const [user] = await deps.db.select().from(t.users).where(eq(t.users.id, row.userId));
  if (
    policy === undefined ||
    policy.revoked ||
    policy.mode !== "autonomous" ||
    user === undefined
  ) {
    await deps.db
      .transaction((tx) => withdrawRequest(tx, row, "CANCEL", now, "agent no longer autonomous"))
      .catch(() => undefined);
    return;
  }
  // ADR-001 D4: a Solana transfer queued for a while may need a fresh blockhash.
  let current = row;
  try {
    current = await rebuildIfExpiring(systemCtx(deps, requestId), row, 20_000);
  } catch (error) {
    deps.logger.warn("execute.rebuild_failed", { requestId, error });
  }
  if (current.unsignedTransaction === null || current.unsignedTransactionEncoding === null) {
    await failRequest(deps, current, "transaction was not built");
    return;
  }
  const verdict = await verifyStored(deps, current, await getArtifacts(deps.db, current.id));
  if (!verdict.ok) {
    deps.logger.error("execute.verify_failed", { requestId, reason: verdict.reason });
    await failRequest(deps, current, "transaction verification failed");
    return;
  }

  let signing: TxRequestRow;
  try {
    signing = await applyEvent(deps.db, current, "START_SIGNING", now);
  } catch (error) {
    if (error instanceof VersionConflictError) return; // another worker won the race
    throw error;
  }
  const artifacts = await getArtifacts(deps.db, row.id);
  if (artifacts?.signingKind === "typed_data") {
    // Never reached (policy downgrades typed data to approval); refuse defensively.
    await failRequest(deps, signing, "typed data is never signed autonomously");
    return;
  }
  if (chainFamilyOf(signing.network) === "cardano") {
    // Never reached (AUTONOMY_ELIGIBLE_FAMILIES excludes Cardano, ADR-002); refuse defensively.
    await failRequest(deps, signing, "Cardano payments are never signed autonomously");
    return;
  }
  try {
    const signed = await deps.turnkey.signWithDelegatedKey({
      subOrganizationId: user.turnkeySubOrganizationId,
      signWith: signing.payload.from,
      unsigned: {
        family: chainFamilyOf(signing.network),
        network: signing.network,
        payloadHash: signing.payloadHash,
        encoding: current.unsignedTransactionEncoding,
        serialized: current.unsignedTransaction,
        estimatedFee: artifacts?.estimatedFee ?? signing.payload.feeCap,
        validUntil: artifacts?.unsignedValidUntil?.toISOString() ?? null,
        simulated: signing.simulated,
      },
    });
    if (signed.simulated && !deps.config.useMocks) throw new Error("simulated signature refused");
    await upsertArtifacts(deps.db, row.id, deps.clock.now(), {
      signedTransaction: signed.signedTransaction,
      signedEncoding: signed.encoding,
      turnkeyActivityId: signed.activityId,
      signedAt: deps.clock.now(),
    });
  } catch (error) {
    deps.logger.error("execute.sign_failed", { requestId, error });
    await failRequest(deps, signing, "delegated signing failed");
    return;
  }
  await audit(systemCtx(deps), {
    actorType: "system",
    userId: row.userId,
    action: "tx_request.signed_autonomously",
    targetType: "transaction_request",
    targetId: row.id,
    metadata: { agentId: row.agentId, payloadHash: row.payloadHash },
  });
  await broadcastSigned(deps, row.id, { inline: true });
}

/** Broadcast errors after which the transaction provably cannot land as signed. */
function isDefinitiveSendError(error: unknown): boolean {
  const e = error as { code?: unknown; details?: { reason?: unknown } } | null;
  if (e?.code === "INSUFFICIENT_FUNDS") return true;
  const reason = e?.details?.reason;
  return (
    e?.code === "BROADCAST_FAILED" &&
    (reason === "blockhash_expired" ||
      reason === "nonce_too_low" ||
      // Cardano: TTL passed, or the inputs were spent by another transaction.
      reason === "ttl_expired" ||
      reason === "inputs_spent")
  );
}

/** SIGNING -> BROADCAST with the (derived) hash; idempotent. */
export async function markBroadcast(
  deps: AppDeps,
  row: TxRequestRow,
  txHash: string,
  turnkeyActivityId: string | null,
): Promise<TxRequestRow> {
  const now = deps.clock.now();
  let updated: TxRequestRow;
  try {
    updated = await deps.db.transaction(async (tx) => {
      const r = await applyEvent(tx, row, "BROADCASTED", now, { txHash });
      await tx
        .insert(t.executedTransactions)
        .values({
          transactionRequestId: r.id,
          walletId: r.walletId,
          network: r.network,
          txHash,
          status: "pending",
          turnkeyActivityId,
          simulated: r.simulated,
          broadcastAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      return r;
    });
  } catch (error) {
    if (error instanceof VersionConflictError) return (await loadRequest(deps, row.id)) ?? row;
    throw error;
  }
  await deps.queue.send({ type: "confirm", requestId: row.id }, { delaySeconds: 15 });
  await enqueueNotification(systemCtx(deps), {
    userId: row.userId,
    event: "transaction_executed",
    dedupeKey: `executed:${row.id}`,
    title: "Payment sent",
    body: "Your payment was submitted to the network.",
    data: { requestId: row.id },
  });
  return updated;
}

/**
 * An x402 payment still SIGNING (never handed to the resource) whose signed authorization or
 * transaction can no longer be valid fails, releasing its reservation; the cron would
 * otherwise re-queue it forever. Returns true when it failed the request.
 */
async function x402PastValidity(
  deps: AppDeps,
  row: TxRequestRow,
  artifacts: NonNullable<Awaited<ReturnType<typeof getArtifacts>>>,
): Promise<boolean> {
  const validUntil = artifacts.unsignedValidUntil;
  if (validUntil === null || validUntil.getTime() > deps.clock.now().getTime()) return false;
  await failRequest(deps, row, "the payment was not delivered before it expired");
  return true;
}

/**
 * Broadcast the stored signed bytes. `inline` (request path / first attempt): on error,
 * schedule a queued retry instead of throwing. Returns the (possibly updated) request.
 */
export async function broadcastSigned(
  deps: AppDeps,
  requestId: string,
  opts: { inline: boolean },
): Promise<TxRequestRow> {
  const row = await loadRequest(deps, requestId);
  if (row === null) throw new Error("request disappeared");
  if (row.state !== "SIGNING") return row; // already broadcast (or failed): idempotent
  const artifacts = await getArtifacts(deps.db, row.id);
  if (artifacts?.signedTransaction == null || artifacts.signedEncoding === null) {
    await failRequest(deps, row, "no signature stored");
    return (await loadRequest(deps, requestId)) ?? row;
  }
  // x402 payments are handed to the resource server, which settles them through its
  // facilitator; ZyroPay never broadcasts them. EVM (EIP-3009 signature) and Solana
  // (facilitator-paid transaction) stop here. Cardano runs the checks below first (C7, the
  // tx id derived from the signed bytes), then waits for the hand-off (services/x402.ts).
  const x402 = row.payload.plugin === "x402";
  if (x402 && (await x402PastValidity(deps, row, artifacts))) return row;
  if (artifacts.signingKind === "typed_data" || (x402 && chainFamilyOf(row.network) !== "cardano"))
    return row;
  if (row.unsignedTransaction === null || row.unsignedTransactionEncoding === null) {
    await failRequest(deps, row, "transaction was not built");
    return (await loadRequest(deps, requestId)) ?? row;
  }

  let signedTransaction = artifacts.signedTransaction;
  let signedEncoding = artifacts.signedEncoding;
  let expectedTxHash = artifacts.expectedTxHash;
  if (expectedTxHash === null) {
    // First attempt: normalize Turnkey's output, run C7, derive and store the hash.
    try {
      const normalized = deps.chain.normalizeSigned({
        network: row.network,
        signedTransaction,
        encoding: signedEncoding,
      });
      await deps.chain.assertSignedMatchesUnsigned({
        network: row.network,
        encoding: row.unsignedTransactionEncoding,
        signed: normalized.signedTransaction,
        unsigned: row.unsignedTransaction,
        expectedSigner: row.payload.from,
      });
      signedTransaction = normalized.signedTransaction;
      signedEncoding = normalized.encoding;
      expectedTxHash = deps.chain.txHashOf({
        network: row.network,
        signedTransaction,
        encoding: signedEncoding,
      });
    } catch (error) {
      deps.logger.error("broadcast.signed_mismatch", { requestId, error });
      await audit(systemCtx(deps), {
        actorType: "system",
        userId: row.userId,
        action: "security.signed_transaction_mismatch",
        targetType: "transaction_request",
        targetId: row.id,
      });
      await failRequest(deps, row, "signed transaction does not match the reviewed one");
      return (await loadRequest(deps, requestId)) ?? row;
    }
    await upsertArtifacts(deps.db, row.id, deps.clock.now(), {
      signedTransaction,
      signedEncoding,
      expectedTxHash,
    });
  }
  if (x402) return row;
  const attempt = artifacts.broadcastAttempts + 1;
  await upsertArtifacts(deps.db, row.id, deps.clock.now(), { broadcastAttempts: attempt });
  try {
    const result = await deps.chain.broadcaster(row.network).broadcast({
      network: row.network,
      signedTransaction,
      encoding: signedEncoding,
    });
    if (result.simulated && !deps.config.useMocks) throw new Error("simulated broadcast refused");
    if (result.txHash !== expectedTxHash) {
      deps.logger.warn("broadcast.hash_mismatch", { requestId });
    }
    return await markBroadcast(deps, row, expectedTxHash, artifacts.turnkeyActivityId);
  } catch (error) {
    deps.logger.warn("broadcast.failed", { requestId, attempt, error });
    // Reconcile by the derived hash: the send may have reached the network anyway.
    const meta = artifacts.unsignedMeta;
    const outcome = await deps.chain
      .track({
        network: row.network,
        txHash: expectedTxHash,
        ...(typeof meta?.lastValidBlockHeight === "string"
          ? { lastValidBlockHeight: meta.lastValidBlockHeight }
          : {}),
        ...(typeof meta?.ttlSlot === "string" ? { validUntilSlot: meta.ttlSlot } : {}),
        ...(artifacts.evmNonce !== null
          ? { from: row.payload.from, nonce: artifacts.evmNonce }
          : {}),
      })
      .catch(() => null);
    if (
      outcome !== null &&
      (outcome.status === "confirmed" ||
        outcome.status === "failed" ||
        (outcome.status === "pending" && !outcome.rebroadcastSuggested))
    ) {
      // Known to the network: track it like any broadcast transaction.
      return markBroadcast(deps, row, expectedTxHash, artifacts.turnkeyActivityId);
    }
    if (outcome?.status === "expired" || outcome?.status === "replaced") {
      await failRequest(
        deps,
        row,
        outcome.status === "expired"
          ? "validity expired before landing (blockhash or TTL)"
          : "nonce replaced",
      );
      return (await loadRequest(deps, requestId)) ?? row;
    }
    if (attempt >= MAX_BROADCAST_ATTEMPTS) {
      if (isDefinitiveSendError(error)) {
        await failRequest(deps, row, "broadcast failed");
        return (await loadRequest(deps, requestId)) ?? row;
      }
      // Unknown outcome: keep SIGNING; the cron re-polls (same bytes, same hash).
      await audit(systemCtx(deps), {
        actorType: "system",
        userId: row.userId,
        action: "tx_request.broadcast_unresolved",
        targetType: "transaction_request",
        targetId: row.id,
        metadata: { attempts: attempt },
      });
      return row;
    }
    if (opts.inline) {
      await deps.queue.send({ type: "broadcast", requestId }, { delaySeconds: 10 });
      return row;
    }
    throw error; // queue retry
  }
}

export async function confirmRequest(deps: AppDeps, requestId: string): Promise<void> {
  const row = await loadRequest(deps, requestId);
  if (row?.state !== "BROADCAST" || row.txHash === null) return;
  const artifacts = await getArtifacts(deps.db, row.id);
  const meta = artifacts?.unsignedMeta ?? null;
  const status = await deps.chain.track({
    network: row.network,
    txHash: row.txHash,
    ...(typeof meta?.lastValidBlockHeight === "string"
      ? { lastValidBlockHeight: meta.lastValidBlockHeight }
      : {}),
    ...(typeof meta?.ttlSlot === "string" ? { validUntilSlot: meta.ttlSlot } : {}),
    ...(artifacts?.evmNonce != null ? { from: row.payload.from, nonce: artifacts.evmNonce } : {}),
  });
  if (status.simulated && !deps.config.useMocks) return;
  const now = deps.clock.now();
  if (status.status === "pending" && status.rebroadcastSuggested && artifacts !== null) {
    // The node lost the transaction but it can still land: re-send the same bytes.
    const { signedTransaction, signedEncoding } = artifacts;
    if (signedTransaction !== null && signedEncoding !== null) {
      await deps.chain
        .broadcaster(row.network)
        .broadcast({ network: row.network, signedTransaction, encoding: signedEncoding })
        .catch((error: unknown) => {
          deps.logger.warn("confirm.rebroadcast_failed", { requestId, error });
        });
    }
  }
  if (status.status === "pending") {
    const attempts = (artifacts?.confirmAttempts ?? 0) + 1;
    await upsertArtifacts(deps.db, row.id, now, { confirmAttempts: attempts });
    if (attempts < MAX_CONFIRM_ATTEMPTS) {
      await deps.queue.send(
        { type: "confirm", requestId },
        { delaySeconds: Math.min(15 * attempts, 300) },
      );
    }
    return; // the cron re-polls stragglers
  }
  if (status.status === "failed" || status.status === "expired" || status.status === "replaced") {
    const reason =
      status.status === "failed"
        ? (status.error ?? "transaction failed on chain")
        : status.status === "expired"
          ? "validity expired before landing (blockhash or TTL)"
          : "nonce was used by another transaction";
    await failRequest(deps, row, reason.slice(0, 200));
    return;
  }
  try {
    await deps.db.transaction(async (tx) => {
      const r = await applyEvent(tx, row, "CONFIRMED", now);
      const [executed] = await tx
        .update(t.executedTransactions)
        .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
        .where(eq(t.executedTransactions.transactionRequestId, r.id))
        .returning();
      await settleReservation(tx, r, executed?.broadcastAt ?? now, now);
    });
  } catch (error) {
    if (error instanceof VersionConflictError) return;
    throw error;
  }
  await enqueueNotification(systemCtx(deps), {
    userId: row.userId,
    event: "transaction_confirmed",
    dedupeKey: `confirmed:${row.id}`,
    title: "Payment confirmed",
    body: "Your payment is confirmed on the network.",
    data: { requestId: row.id },
  });
}

/** Cron: expire pre-signing requests past their deadline; re-poll stuck broadcasts. */
export async function sweep(
  deps: AppDeps,
  limit = 100,
): Promise<{ expired: number; repolled: number }> {
  const now = deps.clock.now();
  const due = await deps.db
    .select()
    .from(t.transactionRequests)
    .where(
      and(
        inArray(t.transactionRequests.state, [
          "CREATED",
          "POLICY_CHECK",
          "PENDING_APPROVAL",
          "APPROVED",
        ]),
        lt(t.transactionRequests.expiresAt, now),
      ),
    )
    .limit(limit);
  let expired = 0;
  for (const row of due) {
    try {
      const hadApproval = row.state === "PENDING_APPROVAL";
      await deps.db.transaction((tx) => withdrawRequest(tx, row, "EXPIRE", now, "expired"));
      expired++;
      if (hadApproval) {
        await enqueueNotification(systemCtx(deps), {
          userId: row.userId,
          event: "approval_expired",
          dedupeKey: `expired:${row.id}`,
          title: "Approval expired",
          body: "A payment request expired before it was approved.",
          data: { requestId: row.id },
        });
      }
    } catch (error) {
      if (!(error instanceof VersionConflictError))
        deps.logger.error("sweep.expire_failed", { requestId: row.id, error });
    }
  }
  await deps.db
    .update(t.agentConnections)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(t.agentConnections.status, "pending"), lt(t.agentConnections.expiresAt, now)));
  await deps.db.delete(t.loginStampReplays).where(lt(t.loginStampReplays.expiresAt, now));
  await deps.db
    .delete(t.rateLimitCounters)
    .where(lt(t.rateLimitCounters.windowStart, new Date(now.getTime() - 3_600_000)));

  const stuck = await deps.db
    .select({ id: t.transactionRequests.id, state: t.transactionRequests.state })
    .from(t.transactionRequests)
    .where(
      and(
        inArray(t.transactionRequests.state, ["BROADCAST", "SIGNING"]),
        lt(t.transactionRequests.updatedAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    )
    .limit(limit);
  for (const s of stuck) {
    await deps.queue.send(
      s.state === "BROADCAST"
        ? { type: "confirm", requestId: s.id }
        : { type: "broadcast", requestId: s.id },
    );
  }
  const pendingWebhooks = await deps.db
    .select({ id: t.webhookEvents.id })
    .from(t.webhookEvents)
    .where(
      and(
        isNull(t.webhookEvents.processedAt),
        lt(t.webhookEvents.receivedAt, new Date(now.getTime() - 5 * 60_000)),
        lt(t.webhookEvents.attempts, 10),
      ),
    )
    .limit(limit);
  for (const w of pendingWebhooks) await deps.queue.send({ type: "webhook", webhookEventId: w.id });
  return { expired, repolled: stuck.length };
}
