/*
 * App sessions: opaque access token (short TTL) + rotating refresh token. Only sha256
 * hashes are stored. Reusing a rotated refresh token revokes every session of the user
 * (token theft signal) and is audited as a security event.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { newOpaqueToken, sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface UserPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly subOrganizationId: string;
}

async function issueAccessToken(ctx: Ctx, db: Db, sessionId: string, userId: string) {
  const now = ctx.deps.clock.now();
  const token = newOpaqueToken("zp_at");
  const expiresAt = new Date(now.getTime() + ctx.deps.config.accessTokenTtlSeconds * 1000);
  await db.insert(t.sessionAccessTokens).values({
    id: ctx.deps.ids.newId(),
    sessionId,
    userId,
    tokenHash: sha256Hex(token),
    createdAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Create a new session (login). `db` may be a transaction. */
export async function createSession(
  ctx: Ctx,
  db: Db,
  userId: string,
  userAgent: string | null,
  rotatedFromId: string | null = null,
): Promise<SessionTokens> {
  const now = ctx.deps.clock.now();
  const refreshToken = newOpaqueToken("zp_rt");
  const refreshExpiresAt = new Date(now.getTime() + ctx.deps.config.refreshTokenTtlSeconds * 1000);
  const sessionId = ctx.deps.ids.newId();
  await db.insert(t.sessions).values({
    id: sessionId,
    userId,
    refreshTokenHash: sha256Hex(refreshToken),
    rotatedFromId,
    userAgent: userAgent === null ? null : userAgent.slice(0, 256),
    createdAt: now,
    expiresAt: refreshExpiresAt,
  });
  const access = await issueAccessToken(ctx, db, sessionId, userId);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/** Resolve a bearer access token. Null when unknown, expired, revoked or the user is gone. */
export async function authenticateAccessToken(
  ctx: Ctx,
  token: string,
): Promise<UserPrincipal | null> {
  if (!/^zp_at_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = ctx.deps.clock.now();
  const rows = await ctx.deps.db
    .select({
      userId: t.sessionAccessTokens.userId,
      sessionId: t.sessionAccessTokens.sessionId,
      subOrganizationId: t.users.turnkeySubOrganizationId,
    })
    .from(t.sessionAccessTokens)
    .innerJoin(t.sessions, eq(t.sessions.id, t.sessionAccessTokens.sessionId))
    .innerJoin(t.users, eq(t.users.id, t.sessionAccessTokens.userId))
    .where(
      and(
        eq(t.sessionAccessTokens.tokenHash, sha256Hex(token)),
        isNull(t.sessionAccessTokens.revokedAt),
        gt(t.sessionAccessTokens.expiresAt, now),
        isNull(t.sessions.revokedAt),
        gt(t.sessions.expiresAt, now),
        isNull(t.users.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function refreshSession(
  ctx: Ctx,
  refreshToken: string,
  userAgent: string | null,
): Promise<SessionTokens> {
  const invalid = new AppError("UNAUTHENTICATED", "invalid refresh token");
  if (!/^zp_rt_[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw invalid;
  const hash = sha256Hex(refreshToken);
  const now = ctx.deps.clock.now();

  const outcome = await ctx.deps.db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(t.sessions)
      .where(eq(t.sessions.refreshTokenHash, hash))
      .for("update");
    if (session === undefined) return { kind: "invalid" as const };
    if (session.revokedAt !== null) {
      // A rotated/revoked refresh token was presented again: assume theft, kill all sessions.
      await revokeAllSessions(tx, session.userId, now);
      return { kind: "reuse" as const, userId: session.userId, sessionId: session.id };
    }
    if (session.expiresAt <= now) return { kind: "invalid" as const };
    await tx.update(t.sessions).set({ revokedAt: now }).where(eq(t.sessions.id, session.id));
    await tx
      .update(t.sessionAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(t.sessionAccessTokens.sessionId, session.id),
          isNull(t.sessionAccessTokens.revokedAt),
        ),
      );
    const tokens = await createSession(ctx, tx, session.userId, userAgent, session.id);
    return { kind: "ok" as const, tokens, userId: session.userId };
  });

  if (outcome.kind === "reuse") {
    await audit(ctx, {
      actorType: "user",
      actorId: outcome.userId,
      userId: outcome.userId,
      action: "security.refresh_token_reuse",
      targetType: "session",
      targetId: outcome.sessionId,
    });
    await enqueueNotification(ctx, {
      userId: outcome.userId,
      event: "security_event",
      dedupeKey: `security:refresh-reuse:${outcome.sessionId}`,
      title: "Security alert",
      body: "We signed you out everywhere after a suspicious sign-in attempt.",
      data: {},
    });
    throw invalid;
  }
  if (outcome.kind === "invalid") throw invalid;
  await audit(ctx, {
    actorType: "user",
    actorId: outcome.userId,
    userId: outcome.userId,
    action: "session.refreshed",
  });
  return outcome.tokens;
}

export async function revokeSession(ctx: Ctx, principal: UserPrincipal): Promise<void> {
  const now = ctx.deps.clock.now();
  await ctx.deps.db.transaction(async (tx) => {
    await tx
      .update(t.sessions)
      .set({ revokedAt: now })
      .where(and(eq(t.sessions.id, principal.sessionId), isNull(t.sessions.revokedAt)));
    await tx
      .update(t.sessionAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(t.sessionAccessTokens.sessionId, principal.sessionId),
          isNull(t.sessionAccessTokens.revokedAt),
        ),
      );
  });
  await audit(ctx, {
    actorType: "user",
    actorId: principal.userId,
    userId: principal.userId,
    action: "session.revoked",
    targetType: "session",
    targetId: principal.sessionId,
  });
}

async function revokeAllSessions(db: Db, userId: string, now: Date): Promise<void> {
  await db
    .update(t.sessions)
    .set({ revokedAt: now })
    .where(and(eq(t.sessions.userId, userId), isNull(t.sessions.revokedAt)));
  await db
    .update(t.sessionAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(t.sessionAccessTokens.userId, userId), isNull(t.sessionAccessTokens.revokedAt)));
}
