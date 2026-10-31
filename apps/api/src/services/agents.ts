import type { Agent, AgentPolicy, StampedTurnkeyRequest } from "@zyropay/shared";
import { assertNetworkAllowedInMode, isValidAddress, KNOWN_PLUGIN_IDS } from "@zyropay/shared";
import { verifyCreatePoliciesRequest } from "@zyropay/wallet";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import { audit } from "./audit";
import { mapTurnkeyError } from "./auth";
import { liveSigner, revokeDelegatedSignerTx } from "./delegated";
import { pushAgentRevocation } from "./mcp";
import type { AgentRow, PolicyRow, UserRow } from "./mappers";
import { toAgent, toPolicy } from "./mappers";
import { enqueueNotification } from "./notifications";
import { withdrawRequest } from "./tx-state";
import { loadWallets } from "./wallets";

export async function loadOwnedAgent(
  ctx: Ctx,
  userId: string,
  agentId: string,
): Promise<{ agent: AgentRow; policy: PolicyRow }> {
  const [row] = await ctx.deps.db
    .select()
    .from(t.agents)
    .innerJoin(t.agentPolicies, eq(t.agentPolicies.agentId, t.agents.id))
    .where(and(eq(t.agents.id, agentId), eq(t.agents.userId, userId)));
  if (row === undefined) throw notFound("agent");
  return { agent: row.agents, policy: row.agent_policies };
}

/**
 * Internal (MCP) calls: re-check on EVERY call that the agent exists, is not revoked,
 * its session has not expired and it still has a live OAuth grant. Unknown and inactive
 * agents get the same FORBIDDEN (no enumeration).
 */
export async function loadActiveAgent(
  ctx: Ctx,
  agentId: string,
): Promise<{ agent: AgentRow; policy: PolicyRow; user: UserRow }> {
  const forbidden = new AppError("FORBIDDEN", "agent is not active");
  const [row] = await ctx.deps.db
    .select()
    .from(t.agents)
    .innerJoin(t.agentPolicies, eq(t.agentPolicies.agentId, t.agents.id))
    .innerJoin(t.users, eq(t.users.id, t.agents.userId))
    .where(eq(t.agents.id, agentId));
  if (row === undefined) throw forbidden;
  const { agents: agent, agent_policies: policy, users: user } = row;
  const now = ctx.deps.clock.now();
  if (
    agent.revokedAt !== null ||
    policy.revoked ||
    user.deletedAt !== null ||
    (policy.sessionExpiresAt !== null && policy.sessionExpiresAt <= now)
  ) {
    throw forbidden;
  }
  if (agent.oauthClientId !== null) {
    const [grant] = await ctx.deps.db
      .select({ id: t.oauthGrants.id })
      .from(t.oauthGrants)
      .where(and(eq(t.oauthGrants.agentId, agent.id), isNull(t.oauthGrants.revokedAt)))
      .limit(1);
    if (grant === undefined) throw forbidden;
  }
  return { agent, policy, user };
}

export async function listAgents(ctx: Ctx, userId: string): Promise<Agent[]> {
  const rows = await ctx.deps.db
    .select()
    .from(t.agents)
    .innerJoin(t.agentPolicies, eq(t.agentPolicies.agentId, t.agents.id))
    .where(eq(t.agents.userId, userId))
    .orderBy(t.agents.createdAt);
  return rows.map((r) => toAgent(r.agents, r.agent_policies));
}

export async function renameAgent(
  ctx: Ctx,
  userId: string,
  agentId: string,
  name: string,
): Promise<Agent> {
  const { agent, policy } = await loadOwnedAgent(ctx, userId, agentId);
  const [updated] = await ctx.deps.db
    .update(t.agents)
    .set({ name, updatedAt: ctx.deps.clock.now() })
    .where(and(eq(t.agents.id, agent.id), eq(t.agents.userId, userId)))
    .returning();
  if (updated === undefined) throw notFound("agent");
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "agent.renamed",
    targetType: "agent",
    targetId: agentId,
  });
  return toAgent(updated, policy);
}

type PolicyInput = Omit<AgentPolicy, "version" | "revoked">;

async function validatePolicy(ctx: Ctx, userId: string, policy: PolicyInput): Promise<void> {
  const walletIds = [...new Set(policy.allowedWalletIds)];
  const { wallets } = await loadWallets(ctx.deps.db, userId, walletIds);
  if (wallets.length !== walletIds.length)
    throw new AppError("BAD_REQUEST", "unknown wallet in allowedWalletIds");
  for (const network of policy.allowedNetworks)
    assertNetworkAllowedInMode(network, ctx.deps.config.mode);
  for (const entry of policy.recipientAllowlist) {
    if (!isValidAddress(entry.family, entry.address))
      throw new AppError("INVALID_ADDRESS", `invalid ${entry.family} allowlist address`);
  }
  for (const p of policy.allowedProtocols) {
    if (!(KNOWN_PLUGIN_IDS as readonly string[]).includes(p))
      throw new AppError("BAD_REQUEST", `unknown protocol ${p}`);
  }
  if (
    policy.sessionExpiresAt !== null &&
    Date.parse(policy.sessionExpiresAt) <= ctx.deps.clock.now().getTime()
  ) {
    throw new AppError("BAD_REQUEST", "sessionExpiresAt must be in the future");
  }
}

export async function updatePolicy(
  ctx: Ctx,
  user: { userId: string; subOrganizationId: string },
  agentId: string,
  body: {
    expectedVersion: number;
    policy: PolicyInput;
    turnkeyPolicyRequest?: StampedTurnkeyRequest | undefined;
  },
): Promise<AgentPolicy> {
  const { deps } = ctx;
  const { agent } = await loadOwnedAgent(ctx, user.userId, agentId);
  if (agent.revokedAt !== null) throw new AppError("FORBIDDEN", "agent was revoked");
  await validatePolicy(ctx, user.userId, body.policy);

  if (body.policy.mode === "autonomous") {
    // ADR-001 D6: autonomy needs an active delegated signer bounded by Turnkey policies.
    const signer = await liveSigner(deps.db, user.userId);
    if (signer?.status !== "active") {
      throw new AppError("FORBIDDEN", "autonomous mode requires an active delegated signer");
    }
    let policyIds = signer.turnkeyPolicyIds;
    if (body.turnkeyPolicyRequest !== undefined) {
      const check = verifyCreatePoliciesRequest(body.turnkeyPolicyRequest, {
        turnkeyApiBaseUrl: deps.config.turnkeyApiBaseUrl,
        organizationId: user.subOrganizationId,
        delegatedTurnkeyUserId: signer.turnkeyUserId,
        now: deps.clock.now(),
      });
      if (!check.ok)
        throw new AppError("FORBIDDEN", "invalid Turnkey policy request", { reason: check.code });
      let created: string[];
      try {
        created = await deps.turnkey.forwardCreatePolicies(body.turnkeyPolicyRequest);
      } catch (error) {
        throw mapTurnkeyError(
          error,
          new AppError("FORBIDDEN", "Turnkey refused the policy request"),
        );
      }
      policyIds = [...new Set([...policyIds, ...created])];
      await deps.db
        .update(t.delegatedSigners)
        .set({ turnkeyPolicyIds: policyIds, updatedAt: deps.clock.now() })
        .where(eq(t.delegatedSigners.id, signer.id));
    }
    if (policyIds.length === 0) {
      throw new AppError(
        "FORBIDDEN",
        "autonomous mode requires the Turnkey policy envelope (turnkeyPolicyRequest)",
      );
    }
  }

  const now = deps.clock.now();
  const updated = await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(t.agentPolicies)
      .where(eq(t.agentPolicies.agentId, agent.id))
      .for("update");
    if (current === undefined) throw notFound("agent");
    if (current.revoked) throw new AppError("FORBIDDEN", "agent was revoked");
    if (current.version !== body.expectedVersion) {
      throw new AppError("VERSION_CONFLICT", "policy changed; reload and retry", {
        currentVersion: current.version,
      });
    }
    const p = body.policy;
    const [row] = await tx
      .update(t.agentPolicies)
      .set({
        mode: p.mode,
        spendingEnabled: p.spendingEnabled,
        allowedWalletIds: [...new Set(p.allowedWalletIds)],
        allowedNetworks: [...new Set(p.allowedNetworks)],
        allowedTools: [...new Set(p.allowedTools)],
        restrictRecipients: p.restrictRecipients,
        recipientAllowlist: p.recipientAllowlist,
        allowedProtocols: [...new Set(p.allowedProtocols)],
        perTransactionUsdMinor: p.limits.perTransactionUsdMinor,
        dailyUsdMinor: p.limits.dailyUsdMinor,
        monthlyUsdMinor: p.limits.monthlyUsdMinor,
        overLimitBehavior: p.overLimitBehavior,
        // Absent = unchanged (clients that predate the escrow rule keep it as set).
        ...(p.x402EscrowAboveUsdMinor !== undefined
          ? { x402EscrowAboveUsdMinor: p.x402EscrowAboveUsdMinor }
          : {}),
        ...(p.requireRegisteredAgent !== undefined
          ? { requireRegisteredAgent: p.requireRegisteredAgent }
          : {}),
        ...(p.trustedAgentIdentifiers !== undefined
          ? { trustedAgentIdentifiers: [...new Set(p.trustedAgentIdentifiers)] }
          : {}),
        sessionExpiresAt: p.sessionExpiresAt === null ? null : new Date(p.sessionExpiresAt),
        version: current.version + 1,
        updatedAt: now,
      })
      .where(
        and(eq(t.agentPolicies.agentId, agent.id), eq(t.agentPolicies.version, current.version)),
      )
      .returning();
    if (row === undefined)
      throw new AppError("VERSION_CONFLICT", "policy changed; reload and retry");
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: user.userId,
        userId: user.userId,
        action: "agent.policy.updated",
        targetType: "agent",
        targetId: agent.id,
        metadata: {
          version: row.version,
          mode: row.mode,
          spendingEnabled: row.spendingEnabled,
          limitsUsdMinor: {
            perTransaction: row.perTransactionUsdMinor,
            daily: row.dailyUsdMinor,
            monthly: row.monthlyUsdMinor,
          },
        },
      },
      tx,
    );
    return row;
  });
  return toPolicy(updated);
}

/**
 * Revoke (ADR-001 D8): policy.revoked + agent.revokedAt, OAuth grants and tokens revoked,
 * pre-signing requests cancelled with reservations released, all under the policy row
 * lock so no request of this agent can be evaluated concurrently. If no autonomous agent
 * remains, the delegated signer is revoked and its key destroyed. Idempotent.
 */
export async function revokeAgent(ctx: Ctx, userId: string, agentId: string): Promise<Agent> {
  const { deps } = ctx;
  await loadOwnedAgent(ctx, userId, agentId);
  const now = deps.clock.now();
  const result = await deps.db.transaction(async (tx) => {
    const [policy] = await tx
      .select()
      .from(t.agentPolicies)
      .where(eq(t.agentPolicies.agentId, agentId))
      .for("update");
    if (policy === undefined) throw notFound("agent");
    if (policy.revoked) return { changed: false, cancelled: 0, signerRevoked: false };
    await tx
      .update(t.agentPolicies)
      .set({ revoked: true, version: policy.version + 1, updatedAt: now })
      .where(eq(t.agentPolicies.agentId, agentId));
    await tx
      .update(t.agents)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(t.agents.id, agentId));
    const grants = await tx
      .update(t.oauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(t.oauthGrants.agentId, agentId), isNull(t.oauthGrants.revokedAt)))
      .returning({ id: t.oauthGrants.id });
    if (grants.length > 0) {
      await tx
        .update(t.tokenRecords)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(
              t.tokenRecords.grantId,
              grants.map((g) => g.id),
            ),
            isNull(t.tokenRecords.revokedAt),
          ),
        );
    }
    const pending = await tx
      .select()
      .from(t.transactionRequests)
      .where(
        and(
          eq(t.transactionRequests.agentId, agentId),
          inArray(t.transactionRequests.state, [
            "CREATED",
            "POLICY_CHECK",
            "PENDING_APPROVAL",
            "APPROVED",
          ]),
        ),
      );
    for (const row of pending) await withdrawRequest(tx, row, "CANCEL", now, "agent revoked");

    const [otherAutonomous] = await tx
      .select({ id: t.agents.id })
      .from(t.agents)
      .innerJoin(t.agentPolicies, eq(t.agentPolicies.agentId, t.agents.id))
      .where(
        and(
          eq(t.agents.userId, userId),
          eq(t.agentPolicies.mode, "autonomous"),
          eq(t.agentPolicies.revoked, false),
        ),
      )
      .limit(1);
    const signerRevoked =
      otherAutonomous === undefined
        ? (await revokeDelegatedSignerTx(tx, userId, now)) !== null
        : false;
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: userId,
        userId,
        action: "agent.revoked",
        targetType: "agent",
        targetId: agentId,
        metadata: { cancelledRequests: pending.length, delegatedSignerRevoked: signerRevoked },
      },
      tx,
    );
    return { changed: true, cancelled: pending.length, signerRevoked };
  });
  if (result.changed) {
    // Kill the agent's OAuth grants in the MCP worker now (ADR-001 D8).
    await pushAgentRevocation(deps, { agentId, userId });
    await enqueueNotification(ctx, {
      userId,
      event: "security_event",
      dedupeKey: `agent-revoked:${agentId}`,
      title: "Agent disconnected",
      body: "The agent's access was revoked and its pending requests were cancelled.",
      data: { agentId },
    });
  }
  const { agent, policy } = await loadOwnedAgent(ctx, userId, agentId);
  return toAgent(agent, policy);
}
