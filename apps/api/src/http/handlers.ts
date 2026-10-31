/*
 * One handler per contract. `handlers` is keyed by every name in `api` (`extHandlers` by
 * every name in `apiExt`, `walletHandlers` by every name in `apiWallets`): adding a
 * contract without implementing it, or returning a
 * shape that drifts from the contract, fails `tsc`.
 */
import type { Api, EndpointContract } from "@zyropay/shared";
import { and, eq } from "drizzle-orm";
import type { ApiExt, ApiWallets } from "../contracts";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import {
  loadActiveAgent,
  listAgents,
  loadOwnedAgent,
  renameAgent,
  revokeAgent,
  updatePolicy,
} from "../services/agents";
import {
  approveApproval,
  cancelRequest,
  getApproval,
  listApprovals,
  rejectApproval,
  submitSend,
} from "../services/approvals";
import { getPriceHistory, listAgentRequests } from "../services/activity";
import { getX402Escrow, prepareEscrowSpend, submitEscrowSpend } from "../services/escrow";
import {
  createAllowance,
  getAgentAllowance,
  listAllowanceSpends,
  revokeAllowance,
  submitAllowance,
  topUpAllowance,
} from "../services/allowances";
import { audit, recordMcpAuditEvent } from "../services/audit";
import { mapTurnkeyError, signIn } from "../services/auth";
import {
  approveConnection,
  claimConnection,
  internalCreateConnection,
  internalGetConnection,
  rejectConnection,
} from "../services/connections";
import {
  activateDelegatedSigner,
  createDelegatedSigner,
  deleteDelegatedSigner,
  getDelegatedSigner,
} from "../services/delegated";
import { toAgent, toPolicy, toUser, toWallet } from "../services/mappers";
import { createOnrampSession, quoteOnramp, receiveOnrampWebhook } from "../services/onramp";
import { listPlugins, setPluginEnabled } from "../services/plugins";
import {
  getPortfolio,
  getReceiveInfo,
  getTransaction,
  listTransactions,
} from "../services/portfolio";
import { valueTransactionsAtTime } from "../services/tx-valuation";
import { enforceRateLimit } from "../services/rate-limit";
import { createAgentRequest, quoteSend } from "../services/requests";
import { agentRequestResult, getX402Payment, reportX402Delivery } from "../services/x402";
import { refreshSession, revokeSession } from "../services/sessions";
import {
  createWallet,
  createWatchWallet,
  getWatchWalletPortfolio,
  listWatchWallets,
  removeWallet,
  removeWatchWallet,
  renameWallet,
  renameWatchWallet,
} from "../services/wallet-management";
import { resolveMasumiAgent, searchMasumiAgents, verifyMasumiAgent } from "../services/masumi";
import { receiveChainWebhook } from "../services/webhooks";
import { getOwnedWallet, listWalletsFor, upsertWalletAccounts } from "../services/wallets";
import type { Handler } from "./route";

type Handlers<A> = { [N in keyof A]: A[N] extends EndpointContract ? Handler<A[N]> : never };

async function ownedWalletScope(
  ctx: Ctx,
  userId: string,
  walletId: string | undefined,
): Promise<string[] | undefined> {
  if (walletId === undefined) return undefined;
  await getOwnedWallet(ctx, userId, walletId);
  return [walletId];
}

/** Agent read scope: requested wallet/network must be inside the policy. */
function agentScope(
  policy: { allowedWalletIds: string[]; allowedNetworks: string[]; allowedTools: string[] },
  tool: string,
  walletId: string | undefined,
  network: string | undefined,
) {
  if (!policy.allowedTools.includes(tool))
    throw new AppError("FORBIDDEN", `tool ${tool} is not allowed`);
  if (walletId !== undefined && !policy.allowedWalletIds.includes(walletId))
    throw new AppError("FORBIDDEN", "wallet is not shared with this agent");
  if (network !== undefined && !policy.allowedNetworks.includes(network))
    throw new AppError("FORBIDDEN", "network is not allowed");
  return {
    walletIds: walletId === undefined ? policy.allowedWalletIds : [walletId],
    networks: (network === undefined ? policy.allowedNetworks : [network]) as never[],
  };
}

export const handlers: Handlers<Api> = {
  // --- auth / session ---------------------------------------------------------
  createSession: async ({ ctx, body, c }) => signIn(ctx, body, c.req.header("user-agent") ?? null),
  refreshSession: async ({ ctx, body, c }) => ({
    session: await refreshSession(ctx, body.refreshToken, c.req.header("user-agent") ?? null),
  }),
  deleteSession: async ({ ctx, principal }) => {
    await revokeSession(ctx, principal);
    return { ok: true as const };
  },

  // --- me / wallets -------------------------------------------------------------
  getMe: async ({ ctx, principal }) => {
    const [user] = await ctx.deps.db.select().from(t.users).where(eq(t.users.id, principal.userId));
    if (user === undefined) throw notFound("user");
    return { user: toUser(user) };
  },
  listWallets: async ({ ctx, principal }) => ({
    wallets: await listWalletsFor(ctx, principal.userId, principal.subOrganizationId),
  }),
  syncWallets: async ({ ctx, principal }) => {
    let accounts;
    try {
      accounts = await ctx.deps.turnkey.listWalletAccounts(principal.subOrganizationId);
    } catch (error) {
      throw mapTurnkeyError(error, new AppError("UPSTREAM_UNAVAILABLE", "wallet sync failed"));
    }
    await ctx.deps.db.transaction((tx) =>
      upsertWalletAccounts(ctx, tx, principal.userId, accounts),
    );
    await audit(ctx, {
      actorType: "user",
      actorId: principal.userId,
      userId: principal.userId,
      action: "wallets.synced",
      metadata: { accounts: accounts.length },
    });
    return { wallets: await listWalletsFor(ctx, principal.userId, principal.subOrganizationId) };
  },
  getWallet: async ({ ctx, principal, params }) => {
    const { wallet, addresses } = await getOwnedWallet(ctx, principal.userId, params.walletId);
    return { wallet: toWallet(wallet, addresses, principal.subOrganizationId) };
  },
  getPortfolio: async ({ ctx, principal, query }) => {
    const walletIds = await ownedWalletScope(ctx, principal.userId, query.walletId);
    return {
      portfolio: await getPortfolio(
        ctx,
        principal.userId,
        {
          ...(walletIds ? { walletIds } : {}),
          ...(query.network ? { networks: [query.network] } : {}),
        },
        query.currency,
      ),
    };
  },
  listTransactions: async ({ ctx, principal, query }) => {
    const walletIds = await ownedWalletScope(ctx, principal.userId, query.walletId);
    const page = await listTransactions(
      ctx,
      principal.userId,
      {
        ...(walletIds ? { walletIds } : {}),
        ...(query.network ? { networks: [query.network] } : {}),
      },
      query.limit,
      query.cursor,
    );
    return { ...page, transactions: await valueTransactionsAtTime(ctx, page.transactions) };
  },
  getTransaction: async ({ ctx, principal, params }) => {
    const tx = await getTransaction(ctx, principal.userId, params.transactionId);
    const [valued] = await valueTransactionsAtTime(ctx, [tx]);
    return { transaction: valued ?? tx };
  },

  // --- send / receive -------------------------------------------------------------
  quoteSend: async ({ ctx, principal, body }) => ({
    review: await quoteSend(ctx, principal.userId, body),
  }),
  submitSend: async ({ ctx, principal, params, body }) => ({
    request: await submitSend(ctx, principal, params.requestId, body),
  }),
  cancelRequest: async ({ ctx, principal, params }) => ({
    request: await cancelRequest(ctx, principal, params.requestId),
  }),
  // --- x402 Masumi escrow ------------------------------------------------------------
  getX402Escrow: async ({ ctx, principal, params }) => ({
    escrow: await getX402Escrow(ctx, principal.userId, params.requestId),
  }),
  prepareX402RefundRequest: async ({ ctx, principal, params }) =>
    prepareEscrowSpend(ctx, principal, params.requestId, "request_refund"),
  submitX402RefundRequest: async ({ ctx, principal, params, body }) => ({
    escrow: await submitEscrowSpend(ctx, principal, params.requestId, "request_refund", body),
  }),
  prepareX402RefundWithdrawal: async ({ ctx, principal, params }) =>
    prepareEscrowSpend(ctx, principal, params.requestId, "withdraw_refund"),
  submitX402RefundWithdrawal: async ({ ctx, principal, params, body }) => ({
    escrow: await submitEscrowSpend(ctx, principal, params.requestId, "withdraw_refund", body),
  }),
  getReceiveInfo: async ({ ctx, principal, query }) =>
    getReceiveInfo(ctx, principal.userId, query.walletId, query.network),

  // --- agents -------------------------------------------------------------------------
  listAgents: async ({ ctx, principal }) => ({ agents: await listAgents(ctx, principal.userId) }),
  getAgentAllowance: async ({ ctx, principal, params }) => ({
    allowance: await getAgentAllowance(ctx, principal.userId, params.agentId),
  }),
  createAgentAllowance: async ({ ctx, principal, params, body }) =>
    createAllowance(ctx, principal.userId, params.agentId, body),
  topUpAgentAllowance: async ({ ctx, principal, params, body }) =>
    topUpAllowance(ctx, principal.userId, params.agentId, body.budget),
  revokeAgentAllowance: async ({ ctx, principal, params }) =>
    revokeAllowance(ctx, principal.userId, params.agentId),
  submitAgentAllowance: async ({ ctx, principal, params, body }) => ({
    allowance: await submitAllowance(ctx, principal.userId, params.agentId, body),
  }),
  listAgentAllowanceSpends: async ({ ctx, principal, params, query }) => ({
    spends: await listAllowanceSpends(ctx, principal.userId, params.agentId, query.limit ?? 20),
  }),
  getAgent: async ({ ctx, principal, params }) => {
    const { agent, policy } = await loadOwnedAgent(ctx, principal.userId, params.agentId);
    return { agent: toAgent(agent, policy) };
  },
  updateAgent: async ({ ctx, principal, params, body }) => ({
    agent: await renameAgent(ctx, principal.userId, params.agentId, body.name),
  }),
  revokeAgent: async ({ ctx, principal, params }) => ({
    agent: await revokeAgent(ctx, principal.userId, params.agentId),
  }),
  getAgentPolicy: async ({ ctx, principal, params }) => {
    const { policy } = await loadOwnedAgent(ctx, principal.userId, params.agentId);
    return { policy: toPolicy(policy) };
  },
  updateAgentPolicy: async ({ ctx, principal, params, body }) => ({
    policy: await updatePolicy(ctx, principal, params.agentId, body),
  }),

  // --- agent connections ---------------------------------------------------------
  claimAgentConnection: async ({ ctx, principal, body }) => {
    await enforceRateLimit(
      ctx,
      "connection-claim",
      principal.userId,
      ctx.deps.config.rateLimits.connectionClaim,
    );
    return { connection: await claimConnection(ctx, principal.userId, body.userCode) };
  },
  approveAgentConnection: async ({ ctx, principal, params, body }) =>
    approveConnection(ctx, principal.userId, params.connectionId, body),
  rejectAgentConnection: async ({ ctx, principal, params }) => ({
    connection: await rejectConnection(ctx, principal.userId, params.connectionId),
  }),

  // --- approvals -------------------------------------------------------------------
  listApprovals: async ({ ctx, principal, query }) => listApprovals(ctx, principal.userId, query),
  getApproval: async ({ ctx, principal, params }) =>
    getApproval(ctx, principal.userId, params.approvalId),
  approveApproval: async ({ ctx, principal, params, body }) =>
    approveApproval(ctx, principal, params.approvalId, body),
  rejectApproval: async ({ ctx, principal, params, body }) =>
    rejectApproval(ctx, principal, params.approvalId, body.reason),

  // --- Masumi registry ----------------------------------------------------------
  listMasumiAgents: async ({ ctx, query }) => searchMasumiAgents(ctx, query),
  getMasumiAgent: async ({ ctx, params }) => resolveMasumiAgent(ctx, params.agentIdentifier),

  // --- plugins ----------------------------------------------------------------------
  listPlugins: async ({ ctx, principal }) => ({
    plugins: await listPlugins(ctx, principal.userId),
  }),
  setPluginEnabled: async ({ ctx, principal, params, body }) =>
    setPluginEnabled(ctx, principal.userId, params.pluginId, body.enabled),

  // --- on-ramp -----------------------------------------------------------------------
  quoteOnramp: async ({ ctx, principal, body }) => ({
    quote: await quoteOnramp(ctx, principal.userId, body),
  }),
  createOnrampSession: async ({ ctx, principal, body }) =>
    createOnrampSession(ctx, principal.userId, body),
  onrampWebhook: async ({ ctx, params, rawBody, c }) => {
    await receiveOnrampWebhook(ctx, params.provider, rawBody, c.req.raw.headers);
    return { ok: true as const };
  },

  // --- notifications -----------------------------------------------------------------
  registerDevice: async ({ ctx, principal, body }) => {
    const now = ctx.deps.clock.now();
    const [row] = await ctx.deps.db
      .insert(t.notificationDevices)
      .values({
        id: ctx.deps.ids.newId(),
        userId: principal.userId,
        expoPushToken: body.expoPushToken,
        platform: body.platform,
        deviceName: body.deviceName ?? null,
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        // The token identifies the device install; re-registering moves it to this user.
        target: t.notificationDevices.expoPushToken,
        set: {
          userId: principal.userId,
          platform: body.platform,
          deviceName: body.deviceName ?? null,
          lastSeenAt: now,
          disabledAt: null,
        },
      })
      .returning({ id: t.notificationDevices.id });
    if (row === undefined) throw new Error("device upsert failed");
    await audit(ctx, {
      actorType: "user",
      actorId: principal.userId,
      userId: principal.userId,
      action: "device.registered",
      targetType: "notification_device",
      targetId: row.id,
      metadata: { platform: body.platform },
    });
    return { deviceId: row.id };
  },
  unregisterDevice: async ({ ctx, principal, params }) => {
    const [row] = await ctx.deps.db
      .update(t.notificationDevices)
      .set({ disabledAt: ctx.deps.clock.now() })
      .where(
        and(
          eq(t.notificationDevices.id, params.deviceId),
          eq(t.notificationDevices.userId, principal.userId),
        ),
      )
      .returning({ id: t.notificationDevices.id });
    if (row === undefined) throw notFound("device");
    await audit(ctx, {
      actorType: "user",
      actorId: principal.userId,
      userId: principal.userId,
      action: "device.unregistered",
      targetType: "notification_device",
      targetId: row.id,
    });
    return { ok: true as const };
  },

  // --- internal (MCP) -------------------------------------------------------------------
  internalCreateAgentConnection: async ({ ctx, body }) => ({
    connection: await internalCreateConnection(ctx, body),
  }),
  internalGetAgentConnection: async ({ ctx, params }) =>
    internalGetConnection(ctx, params.connectionId),
  internalGetAgentContext: async ({ ctx, params }) => {
    const { agent, policy, user } = await loadActiveAgent(ctx, params.agentId);
    return {
      agent: toAgent(agent, policy),
      wallets: await listWalletsFor(
        ctx,
        user.id,
        user.turnkeySubOrganizationId,
        policy.allowedWalletIds,
      ),
    };
  },
  internalGetAgentPortfolio: async ({ ctx, params, query }) => {
    const { policy, user } = await loadActiveAgent(ctx, params.agentId);
    const scope = agentScope(policy, "get_balance", query.walletId, query.network);
    return { portfolio: await getPortfolio(ctx, user.id, scope, query.currency) };
  },
  internalListAgentTransactions: async ({ ctx, params, query }) => {
    const { policy, user } = await loadActiveAgent(ctx, params.agentId);
    const scope = agentScope(policy, "get_transactions", query.walletId, query.network);
    return listTransactions(ctx, user.id, scope, query.limit, query.cursor);
  },
  internalCreateTransactionRequest: async ({ ctx, params, body }) => {
    const { agent, user } = await loadActiveAgent(ctx, params.agentId);
    const request = await createAgentRequest(ctx, agent, user, body);
    if (body.tool !== "pay_x402") return { request };
    const [row] = await ctx.deps.db
      .select()
      .from(t.transactionRequests)
      .where(eq(t.transactionRequests.id, request.requestId));
    return { request: row === undefined ? request : await agentRequestResult(ctx, row) };
  },
  internalGetTransactionRequest: async ({ ctx, params }) => {
    const { agent, policy } = await loadActiveAgent(ctx, params.agentId);
    if (!policy.allowedTools.includes("get_approval_status"))
      throw new AppError("FORBIDDEN", "tool get_approval_status is not allowed");
    const [row] = await ctx.deps.db
      .select()
      .from(t.transactionRequests)
      .where(
        and(
          eq(t.transactionRequests.id, params.requestId),
          eq(t.transactionRequests.agentId, agent.id),
        ),
      );
    if (row === undefined) throw notFound("transaction request");
    return { request: await agentRequestResult(ctx, row) };
  },
  internalFindMasumiAgents: async ({ ctx, params, query }) => {
    await loadActiveAgent(ctx, params.agentId);
    return searchMasumiAgents(ctx, query);
  },
  internalVerifyMasumiAgent: async ({ ctx, params, body }) => {
    await loadActiveAgent(ctx, params.agentId);
    return verifyMasumiAgent(ctx, body);
  },
  internalGetX402Payment: async ({ ctx, params }) => ({
    payment: await getX402Payment(ctx, params.agentId, params.requestId),
  }),
  internalReportX402Delivery: async ({ ctx, params, body }) => ({
    request: await reportX402Delivery(ctx, params.agentId, params.requestId, body),
  }),
};

export const extHandlers: Handlers<ApiExt> = {
  getDelegatedSigner: async ({ ctx, principal }) => ({
    signer: await getDelegatedSigner(ctx, principal.userId),
  }),
  createDelegatedSigner: async ({ ctx, principal }) => ({
    signer: await createDelegatedSigner(ctx, principal.userId),
  }),
  activateDelegatedSigner: async ({ ctx, principal, body }) => ({
    signer: await activateDelegatedSigner(
      ctx,
      principal.userId,
      principal.subOrganizationId,
      body.turnkeyUserId,
    ),
  }),
  deleteDelegatedSigner: async ({ ctx, principal }) => {
    await deleteDelegatedSigner(ctx, principal.userId);
    return { ok: true as const };
  },
  chainWebhook: async ({ ctx, params, rawBody, c }) => {
    await receiveChainWebhook(ctx, params.provider, rawBody, c.req.raw.headers);
    return { ok: true as const };
  },
  getPriceHistory: async ({ ctx, params, query }) => ({
    history: await getPriceHistory(ctx, {
      assetId: params.assetId,
      range: query.range,
      currency: query.currency,
    }),
  }),
  listAgentRequests: async ({ ctx, principal, params, query }) =>
    listAgentRequests(ctx, principal.userId, params.agentId, query),
  internalRecordAuditEvent: async ({ ctx, body }) => {
    await recordMcpAuditEvent(ctx, body);
    return { ok: true as const };
  },
};

export const walletHandlers: Handlers<ApiWallets> = {
  createWallet: async ({ ctx, principal, body }) => ({
    wallet: await createWallet(ctx, principal, body),
  }),
  renameWallet: async ({ ctx, principal, params, body }) => ({
    wallet: await renameWallet(ctx, principal, params.walletId, body.name),
  }),
  removeWallet: async ({ ctx, principal, params }) => {
    await removeWallet(ctx, principal, params.walletId);
    return { ok: true as const };
  },
  listWatchWallets: async ({ ctx, principal }) => ({
    watchWallets: await listWatchWallets(ctx, principal.userId),
  }),
  createWatchWallet: async ({ ctx, principal, body }) => ({
    watchWallet: await createWatchWallet(ctx, principal.userId, body),
  }),
  renameWatchWallet: async ({ ctx, principal, params, body }) => ({
    watchWallet: await renameWatchWallet(ctx, principal.userId, params.watchWalletId, body.name),
  }),
  removeWatchWallet: async ({ ctx, principal, params }) => {
    await removeWatchWallet(ctx, principal.userId, params.watchWalletId);
    return { ok: true as const };
  },
  getWatchWalletPortfolio: async ({ ctx, principal, params, query }) => ({
    portfolio: await getWatchWalletPortfolio(
      ctx,
      principal.userId,
      params.watchWalletId,
      query.currency,
    ),
  }),
};
