/*
 * Sign-in exchange (ARCHITECTURE.md §2.1, ADR-001 D1/D2).
 *
 *  1. Check the stamped get_whoami (URL, body shape; for passkey stamps, that the WebAuthn
 *     challenge covers the body).
 *  2. One-time use: a whoami body has no timestamp, so a captured stamp would otherwise be
 *     a reusable credential. Its hash is recorded before forwarding; replays are refused.
 *  3. Forward unmodified to Turnkey, which verifies the stamp -> {organizationId, userId}.
 *  4. Refuse the parent organization itself, and read the sub-org root quorum with the
 *     parent-org key (fails for orgs that are not our sub-orgs).
 *  5. First login: quorum must be exactly {that user}, threshold 1 (non-custodial check).
 *     Later logins: the user must be in the root quorum and must not be the delegated
 *     API-key user.
 *  6. Upsert user/identity (+ wallets on first login) and issue a session.
 */
import type { StampedTurnkeyRequest, User } from "@zyropay/shared";
import { TurnkeyError, verifyWhoamiRequest } from "@zyropay/wallet";
import { and, eq, ne, sql } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { audit } from "./audit";
import { toUser } from "./mappers";
import type { SessionTokens } from "./sessions";
import { createSession } from "./sessions";
import { upsertWalletAccounts } from "./wallets";

const LOGIN_STAMP_TTL_MS = 2 * 60 * 60 * 1000;

export function mapTurnkeyError(
  error: unknown,
  onClientError: AppError,
  log?: { step: string; logger: { warn(event: string, fields?: Record<string, unknown>): void } },
): AppError {
  // Our own error kind, status and message only (TurnkeyError never carries Turnkey's body).
  log?.logger.warn("turnkey.call_failed", {
    step: log.step,
    kind: error instanceof TurnkeyError ? error.kind : "unknown",
    status: error instanceof TurnkeyError ? error.status : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof TurnkeyError) {
    if (
      error.kind === "http" &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500
    ) {
      return onClientError;
    }
    if (error.kind === "refused") return onClientError;
    return new AppError("UPSTREAM_UNAVAILABLE", "signing service unavailable");
  }
  return new AppError("UPSTREAM_UNAVAILABLE", "signing service unavailable");
}

export async function signIn(
  ctx: Ctx,
  input: {
    whoamiRequest: StampedTurnkeyRequest;
    email?: string | undefined;
    displayName?: string | undefined;
  },
  userAgent: string | null,
): Promise<{ user: User; isNewUser: boolean; session: SessionTokens }> {
  const { deps } = ctx;
  const unauthenticated = new AppError("UNAUTHENTICATED", "sign-in failed");
  const check = verifyWhoamiRequest(input.whoamiRequest, deps.config.turnkeyApiBaseUrl);
  if (!check.ok) {
    await audit(ctx, {
      actorType: "system",
      action: "security.login_rejected",
      metadata: { reason: check.code },
    });
    throw unauthenticated;
  }

  const now = deps.clock.now();
  const stampHash = sha256Hex(
    `${input.whoamiRequest.stamp.stampHeaderValue}\n${input.whoamiRequest.body}`,
  );
  const inserted = await deps.db
    .insert(t.loginStampReplays)
    .values({ stampHash, createdAt: now, expiresAt: new Date(now.getTime() + LOGIN_STAMP_TTL_MS) })
    .onConflictDoNothing()
    .returning({ stampHash: t.loginStampReplays.stampHash });
  if (inserted.length === 0) {
    await audit(ctx, { actorType: "system", action: "security.login_stamp_replayed" });
    throw unauthenticated;
  }

  let identity;
  try {
    identity = await deps.turnkey.whoami(input.whoamiRequest);
  } catch (error) {
    throw mapTurnkeyError(error, unauthenticated, { step: "whoami", logger: deps.logger });
  }
  const forbidden = new AppError("FORBIDDEN", "this Turnkey organization cannot sign in");
  if (
    deps.config.turnkey !== null &&
    identity.organizationId === deps.config.turnkey.organizationId
  ) {
    await audit(ctx, { actorType: "system", action: "security.parent_org_login_refused" });
    throw forbidden;
  }

  let quorum;
  try {
    quorum = await deps.turnkey.getRootQuorum(identity.organizationId);
  } catch (error) {
    throw mapTurnkeyError(error, forbidden, { step: "root_quorum", logger: deps.logger });
  }

  const [existing] = await deps.db
    .select()
    .from(t.users)
    .where(eq(t.users.turnkeySubOrganizationId, identity.organizationId));

  if (existing === undefined) {
    const exact =
      quorum.threshold === 1 &&
      quorum.userIds.length === 1 &&
      quorum.userIds[0] === identity.userId;
    if (!exact) {
      await audit(ctx, {
        actorType: "system",
        action: "security.root_quorum_rejected",
        metadata: { threshold: quorum.threshold, members: quorum.userIds.length },
      });
      throw new AppError(
        "FORBIDDEN",
        "wallet setup is not self-custodial (root quorum check failed)",
      );
    }
  } else {
    if (existing.deletedAt !== null) throw forbidden;
    const [delegated] = await deps.db
      .select({ id: t.delegatedSigners.id })
      .from(t.delegatedSigners)
      .where(
        and(
          eq(t.delegatedSigners.userId, existing.id),
          eq(t.delegatedSigners.turnkeyUserId, identity.userId),
        ),
      );
    if (!quorum.userIds.includes(identity.userId) || delegated !== undefined) {
      await audit(ctx, {
        actorType: "system",
        userId: existing.id,
        action: "security.non_root_login_refused",
      });
      throw forbidden;
    }
  }

  const accounts =
    existing === undefined
      ? await deps.turnkey.listWalletAccounts(identity.organizationId).catch((error: unknown) => {
          throw mapTurnkeyError(error, forbidden, {
            step: "list_wallet_accounts",
            logger: deps.logger,
          });
        })
      : [];

  const email = input.email?.toLowerCase() ?? null;
  if (existing === undefined && email !== null) {
    const [taken] = await deps.db
      .select({ id: t.users.id })
      .from(t.users)
      .where(
        and(
          sql`lower(${t.users.email}) = ${email}`,
          ne(t.users.turnkeySubOrganizationId, identity.organizationId),
        ),
      );
    if (taken !== undefined) throw new AppError("CONFLICT", "email is already registered");
  }

  const credential = check.value.stamp.credentialId;
  const result = await deps.db.transaction(async (tx) => {
    let userRow = existing;
    if (userRow === undefined) {
      [userRow] = await tx
        .insert(t.users)
        .values({
          id: deps.ids.newId(),
          email,
          displayName: input.displayName ?? null,
          turnkeySubOrganizationId: identity.organizationId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (userRow === undefined) throw new Error("user insert failed");
      await upsertWalletAccounts(ctx, tx, userRow.id, accounts);
    }
    const subject = credential ?? `turnkey-user:${identity.userId}`;
    await tx
      .insert(t.authIdentities)
      .values({
        id: deps.ids.newId(),
        userId: userRow.id,
        provider: "passkey",
        providerSubject: subject,
        turnkeyUserId: identity.userId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [t.authIdentities.provider, t.authIdentities.providerSubject],
        set: { lastUsedAt: now },
        setWhere: eq(t.authIdentities.userId, userRow.id),
      });
    const session = await createSession(ctx, tx, userRow.id, userAgent);
    return { userRow, session };
  });

  await audit(ctx, {
    actorType: "user",
    actorId: result.userRow.id,
    userId: result.userRow.id,
    action: existing === undefined ? "user.created" : "session.created",
    metadata: { credentialKind: check.value.stamp.kind === "passkey" ? "passkey" : "session_key" },
  });
  return {
    user: toUser(result.userRow),
    isNewUser: existing === undefined,
    session: result.session,
  };
}
