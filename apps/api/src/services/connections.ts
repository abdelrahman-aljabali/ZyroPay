/*
 * Agent connection (ARCHITECTURE.md §2.4): device-code style consent. MCP creates a
 * pending connection with a user code; the user claims it in the app, reviews and
 * approves; MCP polls and completes OAuth with {userId, agentId}.
 */
import type { NetworkId } from "@zyropay/shared";
import { assertNetworkAllowedInMode, defaultAgentPolicy } from "@zyropay/shared";
import { and, eq, isNull, or } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { newUserCode } from "../lib/crypto";
import { AppError, isUniqueViolation, notFound } from "../lib/errors";
import { audit } from "./audit";
import type { ConnectionRow } from "./mappers";
import { iso, toAgent } from "./mappers";
import { enqueueNotification } from "./notifications";
import { loadWallets } from "./wallets";

function toConnection(row: ConnectionRow, now: Date) {
  const expired = row.status === "pending" && row.expiresAt <= now;
  return {
    id: row.id,
    userCode: row.userCode,
    clientName: row.clientName,
    clientUri: row.clientUri,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
    status: expired ? ("expired" as const) : row.status,
    agentId: row.agentId,
    expiresAt: iso(row.expiresAt),
  };
}

export async function internalCreateConnection(
  ctx: Ctx,
  body: {
    oauthClientId: string;
    clientName: string;
    clientUri: string | null;
    redirectUri: string;
    scopes: string[];
  },
) {
  const { deps } = ctx;
  const now = deps.clock.now();
  await deps.db
    .insert(t.oauthClients)
    .values({
      id: body.oauthClientId,
      clientName: body.clientName,
      clientUri: body.clientUri,
      redirectUris: [body.redirectUri],
      tokenEndpointAuthMethod: "none",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: t.oauthClients.id,
      set: { clientName: body.clientName, clientUri: body.clientUri, updatedAt: now },
    });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await deps.db
        .insert(t.agentConnections)
        .values({
          id: deps.ids.newId(),
          userCode: newUserCode(),
          oauthClientId: body.oauthClientId,
          clientName: body.clientName,
          clientUri: body.clientUri,
          redirectUri: body.redirectUri,
          scopes: body.scopes,
          status: "pending",
          expiresAt: new Date(now.getTime() + deps.config.connectionCodeTtlSeconds * 1000),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) throw new Error("insert failed");
      await audit(ctx, {
        actorType: "mcp",
        action: "agent_connection.created",
        targetType: "agent_connection",
        targetId: row.id,
        metadata: { clientName: body.clientName },
      });
      return toConnection(row, now);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // user-code collision: try another code
    }
  }
  throw new AppError("CONFLICT", "could not allocate a user code");
}

export async function internalGetConnection(ctx: Ctx, connectionId: string) {
  const [row] = await ctx.deps.db
    .select()
    .from(t.agentConnections)
    .where(eq(t.agentConnections.id, connectionId));
  if (row === undefined) throw notFound("connection");
  const connection = toConnection(row, ctx.deps.clock.now());
  return { connection, userId: connection.status === "approved" ? row.userId : null };
}

export async function claimConnection(ctx: Ctx, userId: string, userCode: string) {
  const now = ctx.deps.clock.now();
  const [row] = await ctx.deps.db
    .update(t.agentConnections)
    .set({ userId, updatedAt: now })
    .where(
      and(
        eq(t.agentConnections.userCode, userCode),
        eq(t.agentConnections.status, "pending"),
        or(isNull(t.agentConnections.userId), eq(t.agentConnections.userId, userId)),
      ),
    )
    .returning();
  if (row === undefined || row.expiresAt <= now) {
    await audit(ctx, {
      actorType: "user",
      actorId: userId,
      userId,
      action: "agent_connection.claim_failed",
    });
    throw notFound("connection");
  }
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "agent_connection.claimed",
    targetType: "agent_connection",
    targetId: row.id,
  });
  return toConnection(row, now);
}

async function loadClaimed(ctx: Ctx, userId: string, connectionId: string): Promise<ConnectionRow> {
  const [row] = await ctx.deps.db
    .select()
    .from(t.agentConnections)
    .where(and(eq(t.agentConnections.id, connectionId), eq(t.agentConnections.userId, userId)));
  if (row === undefined) throw notFound("connection");
  if (row.status !== "pending") throw new AppError("CONFLICT", `connection is ${row.status}`);
  if (row.expiresAt <= ctx.deps.clock.now())
    throw new AppError("REQUEST_EXPIRED", "connection code expired");
  return row;
}

export async function approveConnection(
  ctx: Ctx,
  userId: string,
  connectionId: string,
  body: { name: string; walletIds: string[]; networks: NetworkId[] },
) {
  const { deps } = ctx;
  const connection = await loadClaimed(ctx, userId, connectionId);
  const walletIds = [...new Set(body.walletIds)];
  const { wallets } = await loadWallets(deps.db, userId, walletIds);
  if (wallets.length !== walletIds.length) throw new AppError("BAD_REQUEST", "unknown wallet");
  const networks = [...new Set(body.networks)];
  for (const n of networks) assertNetworkAllowedInMode(n, deps.config.mode);

  const now = deps.clock.now();
  const result = await deps.db.transaction(async (tx) => {
    const agentId = deps.ids.newId();
    const [agent] = await tx
      .insert(t.agents)
      .values({
        id: agentId,
        userId,
        name: body.name,
        oauthClientId: connection.oauthClientId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const base = defaultAgentPolicy();
    const [policy] = await tx
      .insert(t.agentPolicies)
      .values({
        agentId,
        mode: base.mode,
        spendingEnabled: base.spendingEnabled,
        allowedWalletIds: walletIds,
        allowedNetworks: networks,
        allowedTools: base.allowedTools,
        restrictRecipients: base.restrictRecipients,
        recipientAllowlist: base.recipientAllowlist,
        allowedProtocols: base.allowedProtocols,
        perTransactionUsdMinor: base.limits.perTransactionUsdMinor,
        dailyUsdMinor: base.limits.dailyUsdMinor,
        monthlyUsdMinor: base.limits.monthlyUsdMinor,
        overLimitBehavior: base.overLimitBehavior,
        x402EscrowAboveUsdMinor: base.x402EscrowAboveUsdMinor ?? null,
        requireRegisteredAgent: base.requireRegisteredAgent ?? false,
        trustedAgentIdentifiers: [...(base.trustedAgentIdentifiers ?? [])],
        sessionExpiresAt: null,
        revoked: false,
        version: 1,
        updatedAt: now,
      })
      .returning();
    await tx.insert(t.oauthGrants).values({
      id: deps.ids.newId(),
      userId,
      agentId,
      oauthClientId: connection.oauthClientId,
      scopes: connection.scopes,
      createdAt: now,
    });
    const [updated] = await tx
      .update(t.agentConnections)
      .set({ status: "approved", agentId, updatedAt: now })
      .where(
        and(
          eq(t.agentConnections.id, connection.id),
          eq(t.agentConnections.status, "pending"),
          eq(t.agentConnections.userId, userId),
        ),
      )
      .returning();
    if (agent === undefined || policy === undefined || updated === undefined)
      throw new AppError("CONFLICT", "connection changed concurrently");
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: userId,
        userId,
        action: "agent.connected",
        targetType: "agent",
        targetId: agentId,
        metadata: { connectionId: connection.id, networks },
      },
      tx,
    );
    return { agent, policy, updated };
  });
  await enqueueNotification(ctx, {
    userId,
    event: "agent_connected",
    dedupeKey: `agent-connected:${result.agent.id}`,
    title: "Agent connected",
    body: `${body.name} can now read your selected wallets. Spending is off until you enable it.`,
    data: { agentId: result.agent.id },
  });
  return {
    connection: toConnection(result.updated, now),
    agent: toAgent(result.agent, result.policy),
  };
}

export async function rejectConnection(ctx: Ctx, userId: string, connectionId: string) {
  const connection = await loadClaimed(ctx, userId, connectionId);
  const now = ctx.deps.clock.now();
  const [row] = await ctx.deps.db
    .update(t.agentConnections)
    .set({ status: "rejected", updatedAt: now })
    .where(and(eq(t.agentConnections.id, connection.id), eq(t.agentConnections.status, "pending")))
    .returning();
  if (row === undefined) throw new AppError("CONFLICT", "connection changed concurrently");
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "agent_connection.rejected",
    targetType: "agent_connection",
    targetId: row.id,
  });
  return toConnection(row, now);
}
