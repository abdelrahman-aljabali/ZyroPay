/*
 * User approvals and in-app send submission (ARCHITECTURE.md §2.3, §2.5; ADR-001 D2/D4).
 *
 * An approval is bound to payloadHash. Approve = sign: the passkey-stamped
 * SIGN_TRANSACTION_V2 must (a) quote the same payloadHash as the approval and request,
 * (b) be stamped by the passkey over exactly that body, (c) target the user's sub-org
 * and wallet address, (d) carry byte-for-byte the unsigned transaction we built, which
 * (e) independently decodes to the payload, and (f) be fresh. Stale, altered, duplicate,
 * executed or expired approvals are refused. The state moves to SIGNING under the
 * optimistic lock BEFORE forwarding, so a second approve can never sign twice.
 */
import type {
  ApprovalRequest,
  ApprovalStatus,
  SigningReview,
  StampedTurnkeyRequest,
  TransactionRequestResult,
} from "@zyropay/shared";
import {
  cardanoPaymentKeyHash,
  chainFamilyOf,
  isPastPointOfNoReturn,
  isTerminalState,
  payloadHash,
} from "@zyropay/shared";
import {
  verifySignCardanoRequest,
  verifySignRawPayloadRequest,
  verifySignTransactionRequest,
} from "@zyropay/wallet";
import { and, desc, eq, lt } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import { audit } from "./audit";
import { broadcastSigned } from "./execution";
import type { ApprovalRow, TxRequestRow, UserRow } from "./mappers";
import { toAgent, toApproval, toRequestResult } from "./mappers";
import { rebuildIfExpiring, verifyStored } from "./build";
import { buildReview, cardanoPublicKeyFor } from "./requests";
import type { UserPrincipal } from "./sessions";
import {
  applyEvent,
  getArtifacts,
  releaseReservation,
  upsertArtifacts,
  withdrawRequest,
} from "./tx-state";
import { refreshEscrow } from "./escrow-view";
import { x402DeliveryOf } from "./x402";

/** Rebuild a Solana tx when its blockhash has less than this left (ADR-001 D4). */
const REBUILD_MARGIN_MS = 20_000;
/**
 * x402 payments are signed, then handed to the resource server by the agent's next status
 * poll, and the facilitator refuses an expired TTL: leave room for that hand-off.
 */
const X402_REBUILD_MARGIN_MS = 120_000;

export async function loadOwnedRequest(
  ctx: Ctx,
  userId: string,
  requestId: string,
): Promise<TxRequestRow> {
  const [row] = await ctx.deps.db
    .select()
    .from(t.transactionRequests)
    .where(and(eq(t.transactionRequests.id, requestId), eq(t.transactionRequests.userId, userId)));
  if (row === undefined) throw notFound("transaction request");
  return row;
}

async function loadOwnedApproval(
  ctx: Ctx,
  userId: string,
  approvalId: string,
): Promise<{ approval: ApprovalRow; request: TxRequestRow }> {
  const [approval] = await ctx.deps.db
    .select()
    .from(t.approvalRequests)
    .where(and(eq(t.approvalRequests.id, approvalId), eq(t.approvalRequests.userId, userId)));
  if (approval === undefined) throw notFound("approval");
  return { approval, request: await loadOwnedRequest(ctx, userId, approval.transactionRequestId) };
}

export async function loadUser(ctx: Ctx, userId: string): Promise<UserRow> {
  const [user] = await ctx.deps.db.select().from(t.users).where(eq(t.users.id, userId));
  if (user === undefined) throw notFound("user");
  return user;
}

/** Expire a request that is past its deadline (and say so). */
async function expireNow(ctx: Ctx, row: TxRequestRow): Promise<never> {
  if (!isTerminalState(row.state) && !isPastPointOfNoReturn(row.state)) {
    try {
      await ctx.deps.db.transaction((tx) =>
        withdrawRequest(tx, row, "EXPIRE", ctx.deps.clock.now(), "expired"),
      );
    } catch {
      // A concurrent sweep may have expired it already.
    }
  }
  throw new AppError("REQUEST_EXPIRED", "this request has expired");
}

/**
 * ADR-002: a Cardano approval is a passkey-stamped SIGN_RAW_PAYLOAD_V2 over the body hash
 * the API recomputes from the stored unsigned transaction, by the wallet's stored Ed25519
 * key (which must hash to payload.from's payment credential).
 */
async function cardanoSignCheck(
  ctx: Ctx,
  user: UserRow,
  row: TxRequestRow,
  signRequest: StampedTurnkeyRequest,
  now: Date,
): Promise<ReturnType<typeof verifySignCardanoRequest>> {
  if (row.unsignedTransaction === null)
    throw new AppError("CONFLICT", "transaction is not built yet");
  return verifyCardanoStamp(
    ctx,
    user,
    { walletId: row.walletId, from: row.payload.from, network: row.network },
    row.unsignedTransaction,
    signRequest,
    now,
  );
}

/**
 * The Cardano stamp check for ANY unsigned transaction of a wallet (a request's payment or
 * an escrow spend): SIGN_RAW_PAYLOAD_V2 by the wallet's stored Ed25519 key (which must hash
 * to `from`'s payment credential), over the body hash recomputed from `unsigned`, to the
 * user's sub-org, fresh.
 */
export async function verifyCardanoStamp(
  ctx: Ctx,
  user: UserRow,
  signer: { walletId: string; from: string; network: TxRequestRow["network"] },
  unsigned: string,
  signRequest: StampedTurnkeyRequest,
  now: Date,
): Promise<ReturnType<typeof verifySignCardanoRequest>> {
  const { deps } = ctx;
  const publicKey = await cardanoPublicKeyFor(ctx, signer.walletId, signer.from);
  let bodyHash: string;
  try {
    bodyHash = deps.chain.cardanoSigningPayload({ network: signer.network, unsigned });
  } catch {
    throw new AppError("SIGNING_FAILED", "stored Cardano transaction is malformed");
  }
  return verifySignCardanoRequest(signRequest, {
    turnkeyApiBaseUrl: deps.config.turnkeyApiBaseUrl,
    organizationId: user.turnkeySubOrganizationId,
    publicKey,
    paymentKeyHash: cardanoPaymentKeyHash(signer.from) ?? "",
    bodyHash,
    now,
  });
}

/** ADR-001 D2 checks shared by approve and in-app submit. Throws on any mismatch. */
async function verifySignedSubmission(
  ctx: Ctx,
  user: UserRow,
  row: TxRequestRow,
  quotedHash: string,
  signRequest: StampedTurnkeyRequest,
): Promise<void> {
  const { deps } = ctx;
  // (a) payload hash: quoted == stored == recomputed from the stored payload.
  let recomputed: string;
  try {
    recomputed = payloadHash(row.payload);
  } catch {
    recomputed = "";
  }
  if (quotedHash !== row.payloadHash || recomputed !== row.payloadHash) {
    await audit(ctx, {
      actorType: "user",
      actorId: user.id,
      userId: user.id,
      action: "security.payload_hash_mismatch",
      targetType: "transaction_request",
      targetId: row.id,
    });
    throw new AppError("PAYLOAD_HASH_MISMATCH", "the approval does not match this request");
  }
  if (row.unsignedTransaction === null || row.unsignedTransactionEncoding === null) {
    throw new AppError("CONFLICT", "transaction is not built yet");
  }
  const artifacts = await getArtifacts(deps.db, row.id);
  const now = deps.clock.now();
  if (
    artifacts?.unsignedValidUntil != null &&
    artifacts.unsignedValidUntil.getTime() <= now.getTime()
  ) {
    throw new AppError("CONFLICT", "the unsigned transaction expired; fetch the review again");
  }
  // (b)-(d), (f): stamp, URL, org, signWith, tx type / digest, byte equality, freshness.
  const check =
    chainFamilyOf(row.network) === "cardano"
      ? await cardanoSignCheck(ctx, user, row, signRequest, now)
      : artifacts?.signingKind === "typed_data"
        ? verifySignRawPayloadRequest(signRequest, {
            turnkeyApiBaseUrl: deps.config.turnkeyApiBaseUrl,
            organizationId: user.turnkeySubOrganizationId,
            signWith: row.payload.from,
            digest: row.unsignedTransaction,
            now,
          })
        : verifySignTransactionRequest(signRequest, {
            turnkeyApiBaseUrl: deps.config.turnkeyApiBaseUrl,
            organizationId: user.turnkeySubOrganizationId,
            signWith: row.payload.from,
            family: chainFamilyOf(row.network),
            unsigned: {
              encoding: row.unsignedTransactionEncoding,
              serialized: row.unsignedTransaction,
            },
            now,
          });
  if (!check.ok) {
    await audit(ctx, {
      actorType: "user",
      actorId: user.id,
      userId: user.id,
      action: "security.sign_request_rejected",
      targetType: "transaction_request",
      targetId: row.id,
      metadata: { reason: check.code },
    });
    throw new AppError(
      "PAYLOAD_HASH_MISMATCH",
      "the signed request does not match the reviewed transaction",
      { reason: check.code },
    );
  }
  // (e) independent decode of what will be signed (transfer, plugin or typed-data verifier).
  const verdict = await verifyStored(deps, row, artifacts);
  if (!verdict.ok) {
    deps.logger.error("tx_request.verify_failed", { requestId: row.id, reason: verdict.reason });
    throw new AppError("SIGNING_FAILED", "transaction verification failed");
  }
}

/** Forward the passkey stamp, persist the signature, broadcast. SIGNING already set. */
async function signAndBroadcast(
  ctx: Ctx,
  row: TxRequestRow,
  signRequest: StampedTurnkeyRequest,
): Promise<TxRequestRow> {
  const { deps } = ctx;
  const typedData = (await getArtifacts(deps.db, row.id))?.signingKind === "typed_data";
  let signed: { signedTransaction: string; encoding: "base64" | "hex"; activityId: string };
  try {
    if (chainFamilyOf(row.network) === "cardano") {
      // ADR-002: Turnkey returns a 64-byte Ed25519 signature (r || s) over the body hash;
      // the API attaches it as the vkey witness, verifying key ownership and the signature.
      const sig = await deps.turnkey.forwardStampedSignRawPayload(signRequest);
      if (sig.simulated && !deps.config.useMocks) throw new Error("simulated signature refused");
      if (row.unsignedTransaction === null) throw new Error("transaction is not built");
      const publicKey = await cardanoPublicKeyFor(ctx, row.walletId, row.payload.from);
      const witnessed = deps.chain.attachCardanoWitness({
        network: row.network,
        unsigned: row.unsignedTransaction,
        publicKey,
        signature: `${sig.r}${sig.s}`,
        expectedSigner: row.payload.from,
      });
      signed = { ...witnessed, activityId: sig.activityId };
    } else if (typedData) {
      // x402 on EVM: a 65-byte r||s||v signature over the EIP-712 digest.
      const sig = await deps.turnkey.forwardStampedSignRawPayload(signRequest);
      if (sig.simulated && !deps.config.useMocks) throw new Error("simulated signature refused");
      if (sig.v === "") throw new Error("secp256k1 signature without a recovery id");
      signed = {
        signedTransaction: `0x${sig.r}${sig.s}${sig.v.padStart(2, "0")}`,
        encoding: "hex",
        activityId: sig.activityId,
      };
    } else {
      const tx = await deps.turnkey.forwardStampedSignRequest(signRequest);
      if (tx.simulated && !deps.config.useMocks) throw new Error("simulated signature refused");
      signed = tx;
    }
  } catch (error) {
    deps.logger.error("tx_request.sign_failed", { requestId: row.id, error });
    await deps.db.transaction(async (tx) => {
      await applyEvent(tx, row, "FAIL", deps.clock.now(), { failureReason: "signing failed" });
      await releaseReservation(tx, row.id, deps.clock.now());
    });
    throw new AppError("SIGNING_FAILED", "signing failed");
  }
  await upsertArtifacts(deps.db, row.id, deps.clock.now(), {
    signedTransaction: signed.signedTransaction,
    signedEncoding: signed.encoding,
    turnkeyActivityId: signed.activityId,
    signedAt: deps.clock.now(),
  });
  // broadcastSigned leaves x402 payments in SIGNING: they are delivered to the resource
  // server (which settles through its facilitator), not broadcast by ZyroPay.
  return broadcastSigned(ctx.deps, row.id, { inline: true });
}

// ---------------------------------------------------------------------------
// In-app send
// ---------------------------------------------------------------------------

export async function submitSend(
  ctx: Ctx,
  principal: UserPrincipal,
  requestId: string,
  body: { payloadHash: string; signRequest: StampedTurnkeyRequest },
): Promise<TransactionRequestResult> {
  const { deps } = ctx;
  const row = await loadOwnedRequest(ctx, principal.userId, requestId);
  if (row.source !== "app_send" || row.agentId !== null) throw notFound("send request");
  if (row.state !== "CREATED")
    throw new AppError("ILLEGAL_STATE_TRANSITION", `request is ${row.state}`);
  if (row.expiresAt.getTime() <= deps.clock.now().getTime()) await expireNow(ctx, row);
  const user = await loadUser(ctx, principal.userId);
  await verifySignedSubmission(ctx, user, row, body.payloadHash, body.signRequest);

  const signing = await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    let r = await applyEvent(tx, row, "START_POLICY_CHECK", now);
    r = await applyEvent(tx, r, "POLICY_ALLOWED", now, {
      policyDecision: "allow",
      policyReasons: [],
    });
    r = await applyEvent(tx, r, "START_SIGNING", now);
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: user.id,
        userId: user.id,
        action: "send.submitted",
        targetType: "transaction_request",
        targetId: r.id,
        metadata: { payloadHash: r.payloadHash },
      },
      tx,
    );
    return r;
  });
  const done = await signAndBroadcast(ctx, signing, body.signRequest);
  return toRequestResult(done, null, deps.config.deepLinkScheme);
}

export async function cancelRequest(
  ctx: Ctx,
  principal: UserPrincipal,
  requestId: string,
): Promise<TransactionRequestResult> {
  const { deps } = ctx;
  const row = await loadOwnedRequest(ctx, principal.userId, requestId);
  const updated = await deps.db.transaction(async (tx) => {
    const r = await withdrawRequest(tx, row, "CANCEL", deps.clock.now(), "cancelled by user");
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: principal.userId,
        userId: principal.userId,
        action: "tx_request.cancelled",
        targetType: "transaction_request",
        targetId: r.id,
      },
      tx,
    );
    return r;
  });
  const [approval] = await deps.db
    .select()
    .from(t.approvalRequests)
    .where(eq(t.approvalRequests.transactionRequestId, row.id));
  return toRequestResult(updated, approval ?? null, deps.config.deepLinkScheme);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function listApprovals(
  ctx: Ctx,
  userId: string,
  query: { status?: ApprovalStatus | undefined; limit: number; cursor?: string | undefined },
): Promise<{ approvals: ApprovalRequest[]; nextCursor: string | null }> {
  // Cursor = createdAt ISO of the last item (newest first), validated.
  let before: Date | null = null;
  if (query.cursor !== undefined) {
    const parsed = Date.parse(query.cursor);
    if (!Number.isFinite(parsed)) throw new AppError("BAD_REQUEST", "invalid cursor");
    before = new Date(parsed);
  }
  const conditions = [eq(t.approvalRequests.userId, userId)];
  if (query.status !== undefined) conditions.push(eq(t.approvalRequests.status, query.status));
  if (before !== null) conditions.push(lt(t.approvalRequests.createdAt, before));
  const rows = await ctx.deps.db
    .select()
    .from(t.approvalRequests)
    .where(and(...conditions))
    .orderBy(desc(t.approvalRequests.createdAt), desc(t.approvalRequests.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    approvals: page.map(toApproval),
    nextCursor:
      rows.length > query.limit && last !== undefined ? last.createdAt.toISOString() : null,
  };
}

export async function getApproval(ctx: Ctx, userId: string, approvalId: string) {
  const { deps } = ctx;
  let { approval, request } = await loadOwnedApproval(ctx, userId, approvalId);
  const now = deps.clock.now();
  if (approval.status === "pending" && (approval.expiresAt <= now || request.expiresAt <= now)) {
    try {
      request = await deps.db.transaction((tx) =>
        withdrawRequest(tx, request, "EXPIRE", now, "expired"),
      );
    } catch {
      /* concurrent change; re-read below */
    }
    ({ approval, request } = await loadOwnedApproval(ctx, userId, approvalId));
  }
  // ADR-001 D4: rebuild when the stored tx is near blockhash expiry; payloadHash is unchanged.
  if (request.state === "PENDING_APPROVAL") {
    try {
      request = await rebuildIfExpiring(
        ctx,
        request,
        request.payload.plugin === "x402" ? X402_REBUILD_MARGIN_MS : REBUILD_MARGIN_MS,
      );
    } catch (error) {
      deps.logger.warn("approval.rebuild_failed", { approvalId, error });
    }
  }
  let agent = null;
  if (approval.agentId !== null) {
    const [row] = await deps.db
      .select()
      .from(t.agents)
      .innerJoin(t.agentPolicies, eq(t.agentPolicies.agentId, t.agents.id))
      .where(and(eq(t.agents.id, approval.agentId), eq(t.agents.userId, userId)));
    agent = row === undefined ? null : toAgent(row.agents, row.agent_policies);
  }
  let review: SigningReview;
  if (request.unsignedTransaction === null) {
    throw new AppError("CONFLICT", "transaction is not built yet");
  } else {
    review = await buildReview(ctx, request, null);
  }
  // pay_x402: delivery to the seller and the verdict on its delivery receipt.
  let x402;
  if (request.payload.plugin === "x402") {
    const artifacts = await getArtifacts(deps.db, request.id);
    x402 = x402DeliveryOf(request, artifacts, await refreshEscrow(ctx, request, artifacts));
  }
  return { approval: toApproval(approval), review, agent, ...(x402 ? { x402 } : {}) };
}

export async function approveApproval(
  ctx: Ctx,
  principal: UserPrincipal,
  approvalId: string,
  body: { payloadHash: string; signRequest: StampedTurnkeyRequest },
) {
  const { deps } = ctx;
  const { approval, request } = await loadOwnedApproval(ctx, principal.userId, approvalId);
  const now = deps.clock.now();
  if (approval.status === "expired")
    throw new AppError("REQUEST_EXPIRED", "this approval has expired");
  if (approval.status !== "pending")
    throw new AppError("CONFLICT", `approval is already ${approval.status}`);
  if (approval.expiresAt <= now || request.expiresAt <= now) await expireNow(ctx, request);
  if (body.payloadHash !== approval.payloadHash) {
    await audit(ctx, {
      actorType: "user",
      actorId: principal.userId,
      userId: principal.userId,
      action: "security.payload_hash_mismatch",
      targetType: "approval",
      targetId: approval.id,
    });
    throw new AppError("PAYLOAD_HASH_MISMATCH", "the approval does not match this request");
  }
  if (request.state !== "PENDING_APPROVAL")
    throw new AppError("ILLEGAL_STATE_TRANSITION", `request is ${request.state}`);
  if (request.agentId !== null) {
    const [policy] = await deps.db
      .select()
      .from(t.agentPolicies)
      .where(eq(t.agentPolicies.agentId, request.agentId));
    if (policy === undefined || policy.revoked)
      throw new AppError("FORBIDDEN", "the agent was revoked");
  }
  const user = await loadUser(ctx, principal.userId);
  await verifySignedSubmission(ctx, user, request, body.payloadHash, body.signRequest);

  const { signing, decided } = await deps.db.transaction(async (tx) => {
    const [decidedRow] = await tx
      .update(t.approvalRequests)
      .set({ status: "approved", decidedAt: now, updatedAt: now })
      .where(
        and(
          eq(t.approvalRequests.id, approval.id),
          eq(t.approvalRequests.status, "pending"),
          eq(t.approvalRequests.payloadHash, request.payloadHash),
        ),
      )
      .returning();
    if (decidedRow === undefined) throw new AppError("CONFLICT", "approval was already decided");
    let r = await applyEvent(tx, request, "USER_APPROVED", now);
    r = await applyEvent(tx, r, "START_SIGNING", now);
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: user.id,
        userId: user.id,
        action: "tx_request.approved",
        targetType: "approval",
        targetId: approval.id,
        metadata: { requestId: r.id, payloadHash: r.payloadHash },
      },
      tx,
    );
    return { signing: r, decided: decidedRow };
  });
  const done = await signAndBroadcast(ctx, signing, body.signRequest);
  const signedActivity = (await getArtifacts(deps.db, done.id))?.turnkeyActivityId ?? null;
  if (signedActivity !== null) {
    await deps.db
      .update(t.approvalRequests)
      .set({ turnkeyActivityId: signedActivity })
      .where(eq(t.approvalRequests.id, decided.id));
  }
  return {
    approval: toApproval(decided),
    request: toRequestResult(done, decided, deps.config.deepLinkScheme),
  };
}

export async function rejectApproval(
  ctx: Ctx,
  principal: UserPrincipal,
  approvalId: string,
  reason: string | undefined,
) {
  const { deps } = ctx;
  const { approval, request } = await loadOwnedApproval(ctx, principal.userId, approvalId);
  if (approval.status !== "pending")
    throw new AppError("CONFLICT", `approval is already ${approval.status}`);
  const now = deps.clock.now();
  const result = await deps.db.transaction(async (tx) => {
    const [decided] = await tx
      .update(t.approvalRequests)
      .set({ status: "rejected", decidedAt: now, updatedAt: now, rejectionReason: reason ?? null })
      .where(and(eq(t.approvalRequests.id, approval.id), eq(t.approvalRequests.status, "pending")))
      .returning();
    if (decided === undefined) throw new AppError("CONFLICT", "approval was already decided");
    const r = await applyEvent(tx, request, "USER_REJECTED", now, {
      failureReason: "rejected by user",
    });
    await releaseReservation(tx, request.id, now);
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: principal.userId,
        userId: principal.userId,
        action: "tx_request.rejected",
        targetType: "approval",
        targetId: approval.id,
      },
      tx,
    );
    return { decided, r };
  });
  return {
    approval: toApproval(result.decided),
    request: toRequestResult(result.r, result.decided, deps.config.deepLinkScheme),
  };
}
