/*
 * Delegated signer for autonomous mode (ADR-001 D5/D6/D8).
 *  - Always Ask (default) = no delegated signer exists = ZyroPay can sign nothing.
 *  - The API generates the P-256 key; only the AES-256-GCM ciphertext is stored, bound to
 *    the user id (AAD). The app's passkey creates the non-root Turnkey user and policies.
 *  - Activation reads the sub-org with the parent-org key and requires: the Turnkey user
 *    holds exactly our public key, has no authenticators, and is NOT in the root quorum.
 *  - Revocation destroys the ciphertext immediately (server-side effect is instant).
 */
import { encryptSecret, generateP256ApiKeyPair } from "@zyropay/wallet";
import { and, eq, ne } from "drizzle-orm";
import type { DelegatedSigner } from "../contracts";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { AppError } from "../lib/errors";
import { audit } from "./audit";
import { mapTurnkeyError } from "./auth";
import type { DelegatedSignerRow } from "./mappers";
import { isoOrNull } from "./mappers";
import { enqueueNotification } from "./notifications";

const DESTROYED = "destroyed";

function toDelegatedSigner(row: DelegatedSignerRow): DelegatedSigner {
  return {
    id: row.id,
    status: row.status,
    apiPublicKey: row.apiPublicKey,
    turnkeyUserId: row.turnkeyUserId.startsWith("pending:") ? null : row.turnkeyUserId,
    turnkeyPolicyIds: row.turnkeyPolicyIds,
    createdAt: row.createdAt.toISOString(),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

export async function liveSigner(db: Db, userId: string): Promise<DelegatedSignerRow | null> {
  const [row] = await db
    .select()
    .from(t.delegatedSigners)
    .where(and(eq(t.delegatedSigners.userId, userId), ne(t.delegatedSigners.status, "revoked")));
  return row ?? null;
}

export async function getDelegatedSigner(
  ctx: Ctx,
  userId: string,
): Promise<DelegatedSigner | null> {
  const row = await liveSigner(ctx.deps.db, userId);
  return row === null ? null : toDelegatedSigner(row);
}

export async function createDelegatedSigner(ctx: Ctx, userId: string): Promise<DelegatedSigner> {
  const { deps } = ctx;
  const existing = await liveSigner(deps.db, userId);
  if (existing !== null) return toDelegatedSigner(existing);
  const kek = deps.config.delegatedKeyEncryptionKey;
  if (kek === null)
    throw new AppError("FORBIDDEN", "autonomous mode is not available in this deployment");
  const pair = await generateP256ApiKeyPair();
  const id = deps.ids.newId();
  const now = deps.clock.now();
  const [row] = await deps.db
    .insert(t.delegatedSigners)
    .values({
      id,
      userId,
      turnkeyUserId: `pending:${id}`,
      apiPublicKey: pair.publicKey,
      encryptedApiPrivateKey: await encryptSecret(pair.privateKey, kek, userId),
      turnkeyPolicyIds: [],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const signer = row ?? (await liveSigner(deps.db, userId));
  if (signer === null) throw new Error("delegated signer insert failed");
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "delegated_signer.created",
    targetType: "delegated_signer",
    targetId: signer.id,
  });
  return toDelegatedSigner(signer);
}

export async function activateDelegatedSigner(
  ctx: Ctx,
  userId: string,
  subOrgId: string,
  turnkeyUserId: string,
): Promise<DelegatedSigner> {
  const { deps } = ctx;
  const signer = await liveSigner(deps.db, userId);
  if (signer === null) throw new AppError("NOT_FOUND", "no delegated signer; create one first");
  if (signer.status === "active") {
    if (signer.turnkeyUserId === turnkeyUserId) return toDelegatedSigner(signer);
    throw new AppError("CONFLICT", "delegated signer is already active");
  }
  const refused = new AppError("FORBIDDEN", "the Turnkey user does not match the delegated signer");
  let users;
  let quorum;
  try {
    [users, quorum] = await Promise.all([
      deps.turnkey.listUsers(subOrgId),
      deps.turnkey.getRootQuorum(subOrgId),
    ]);
  } catch (error) {
    throw mapTurnkeyError(error, refused);
  }
  const target = users.find((u) => u.userId === turnkeyUserId);
  const ok =
    target !== undefined &&
    target.apiPublicKeys.length === 1 &&
    target.apiPublicKeys[0] === signer.apiPublicKey.toLowerCase() &&
    target.authenticatorCount === 0 &&
    !quorum.userIds.includes(turnkeyUserId);
  if (!ok) {
    await audit(ctx, {
      actorType: "user",
      actorId: userId,
      userId,
      action: "security.delegated_signer_activation_refused",
      targetType: "delegated_signer",
      targetId: signer.id,
    });
    throw refused;
  }
  const policies = await deps.turnkey.listPolicies(subOrgId).catch((error: unknown) => {
    throw mapTurnkeyError(error, refused);
  });
  const now = deps.clock.now();
  const [updated] = await deps.db
    .update(t.delegatedSigners)
    .set({
      turnkeyUserId,
      status: "active",
      turnkeyPolicyIds: policies
        .filter((p) => p.consensus.includes(turnkeyUserId))
        .map((p) => p.policyId),
      updatedAt: now,
    })
    .where(and(eq(t.delegatedSigners.id, signer.id), eq(t.delegatedSigners.status, "pending")))
    .returning();
  if (updated === undefined)
    throw new AppError("CONFLICT", "delegated signer changed concurrently");
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "delegated_signer.activated",
    targetType: "delegated_signer",
    targetId: signer.id,
  });
  await enqueueNotification(ctx, {
    userId,
    event: "security_event",
    dedupeKey: `delegated:activated:${signer.id}`,
    title: "Autonomous signing enabled",
    body: "ZyroPay can now sign within the limits you set for autonomous agents.",
    data: {},
  });
  return toDelegatedSigner(updated);
}

/** Revoke + destroy the key; every autonomous agent falls back to always_ask. `db` may be a tx. */
export async function revokeDelegatedSignerTx(
  db: Db,
  userId: string,
  now: Date,
): Promise<string | null> {
  const [revoked] = await db
    .update(t.delegatedSigners)
    .set({ status: "revoked", encryptedApiPrivateKey: DESTROYED, revokedAt: now, updatedAt: now })
    .where(and(eq(t.delegatedSigners.userId, userId), ne(t.delegatedSigners.status, "revoked")))
    .returning({ id: t.delegatedSigners.id });
  return revoked?.id ?? null;
}

export async function deleteDelegatedSigner(ctx: Ctx, userId: string): Promise<void> {
  const { deps } = ctx;
  const now = deps.clock.now();
  const signerId = await deps.db.transaction(async (tx) => {
    const id = await revokeDelegatedSignerTx(tx, userId, now);
    const autonomous = await tx
      .select({ agentId: t.agentPolicies.agentId, version: t.agentPolicies.version })
      .from(t.agentPolicies)
      .innerJoin(t.agents, eq(t.agents.id, t.agentPolicies.agentId))
      .where(and(eq(t.agents.userId, userId), eq(t.agentPolicies.mode, "autonomous")))
      .for("update");
    for (const a of autonomous) {
      await tx
        .update(t.agentPolicies)
        .set({ mode: "always_ask", version: a.version + 1, updatedAt: now })
        .where(eq(t.agentPolicies.agentId, a.agentId));
    }
    return id;
  });
  if (signerId !== null) {
    await audit(ctx, {
      actorType: "user",
      actorId: userId,
      userId,
      action: "delegated_signer.revoked",
      targetType: "delegated_signer",
      targetId: signerId,
    });
  }
}
