import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  ApprovalStatus,
  X402Escrow,
  X402EscrowAction,
  NetworkId,
  PriceRange,
  TransactionRequestResult,
  TxRequestState,
} from "@zyropay/shared";
import { TERMINAL_STATES } from "@zyropay/shared";
import { allowancePollMs, type AllowanceAction } from "@/lib/allowance";
import { escrowPollMs } from "@/lib/escrow";
import { needsChainFollow, sendProgress } from "@/lib/send";
import { useSession } from "@/state";
import { apiClient } from "./index";
import type { CallBody, CallInput, CallQuery, CallResponse, EndpointKey } from "./client";

/*
 * TanStack Query hooks over the typed client. Query keys are namespaced by
 * endpoint name so invalidation stays explicit.
 */

export const qk = {
  portfolio: (walletId?: string, network?: NetworkId, currency = "USD") =>
    ["portfolio", walletId ?? null, network ?? null, currency] as const,
  transactions: (walletId?: string, network?: NetworkId) =>
    ["transactions", walletId ?? null, network ?? null] as const,
  transaction: (id: string) => ["transaction", id] as const,
  wallets: ["wallets"] as const,
  wallet: (id: string) => ["wallet", id] as const,
  receive: (walletId: string, network: NetworkId) => ["receive", walletId, network] as const,
  agents: ["agents"] as const,
  agent: (id: string) => ["agent", id] as const,
  agentPolicy: (id: string) => ["agentPolicy", id] as const,
  approvals: (status?: ApprovalStatus) => ["approvals", status ?? "all"] as const,
  approval: (id: string) => ["approval", id] as const,
  escrow: (requestId: string) => ["escrow", requestId] as const,
  plugins: ["plugins"] as const,
  priceHistory: (assetId: string, range: PriceRange) => ["priceHistory", assetId, range] as const,
  agentRequests: (agentId: string, state?: TxRequestState) =>
    ["agentRequests", agentId, state ?? "all"] as const,
  delegatedSigner: ["delegatedSigner"] as const,
  watchWallets: ["watchWallets"] as const,
  watchPortfolio: (id: string, currency = "USD") => ["watchPortfolio", id, currency] as const,
  me: ["me"] as const,
  masumiAgents: (query: CallQuery<"listMasumiAgents">) => ["masumiAgents", query] as const,
  masumiAgent: (agentIdentifier: string) => ["masumiAgent", agentIdentifier] as const,
  allowance: (agentId: string) => ["allowance", agentId] as const,
  allowanceSpends: (agentId: string) => ["allowanceSpends", agentId] as const,
};

function call<N extends EndpointKey>(name: N, input: CallInput<N>): Promise<CallResponse<N>> {
  return apiClient.call(name, input);
}

function useSignedIn(): boolean {
  return useSession((s) => s.status === "signedIn");
}

/** Approvals poll as a fallback when push is unavailable or delayed. */
const APPROVAL_POLL_MS = 15_000;

export function usePortfolio(
  opts: { walletId?: string; network?: NetworkId; currency?: string } = {},
) {
  const enabled = useSignedIn();
  const currency = opts.currency ?? "USD";
  return useQuery({
    queryKey: qk.portfolio(opts.walletId, opts.network, currency),
    enabled,
    queryFn: ({ signal }) =>
      call("getPortfolio", {
        query: { walletId: opts.walletId, network: opts.network, currency },
        signal,
      }).then((r) => r.portfolio),
    staleTime: 30_000,
  });
}

export function useTransactions(
  opts: { walletId?: string; network?: NetworkId; limit?: number } = {},
) {
  const enabled = useSignedIn();
  return useQuery({
    queryKey: qk.transactions(opts.walletId, opts.network),
    enabled,
    queryFn: ({ signal }) =>
      call("listTransactions", {
        query: { walletId: opts.walletId, network: opts.network, limit: opts.limit ?? 20 },
        signal,
      }),
  });
}

export function useTransaction(id: string) {
  return useQuery({
    queryKey: qk.transaction(id),
    enabled: useSignedIn() && id !== "",
    queryFn: ({ signal }) =>
      call("getTransaction", { params: { transactionId: id }, signal }).then((r) => r.transaction),
  });
}

export function useWallets() {
  return useQuery({
    queryKey: qk.wallets,
    enabled: useSignedIn(),
    queryFn: ({ signal }) => call("listWallets", { signal }).then((r) => r.wallets),
    staleTime: 60_000,
  });
}

export function useWallet(id: string) {
  return useQuery({
    queryKey: qk.wallet(id),
    enabled: useSignedIn() && id !== "",
    queryFn: ({ signal }) =>
      call("getWallet", { params: { walletId: id }, signal }).then((r) => r.wallet),
  });
}

export function useReceiveInfo(walletId: string, network: NetworkId | null) {
  return useQuery({
    queryKey: qk.receive(walletId, network ?? "solana-devnet"),
    enabled: useSignedIn() && walletId !== "" && network !== null,
    queryFn: ({ signal }) =>
      call("getReceiveInfo", { query: { walletId, network: network ?? "solana-devnet" }, signal }),
  });
}

export function useAgents() {
  return useQuery({
    queryKey: qk.agents,
    enabled: useSignedIn(),
    queryFn: ({ signal }) => call("listAgents", { signal }).then((r) => r.agents),
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: qk.agent(id),
    enabled: useSignedIn() && id !== "",
    queryFn: ({ signal }) =>
      call("getAgent", { params: { agentId: id }, signal }).then((r) => r.agent),
  });
}

export function useApprovals(status?: ApprovalStatus) {
  return useQuery({
    queryKey: qk.approvals(status),
    enabled: useSignedIn(),
    queryFn: ({ signal }) => call("listApprovals", { query: { status, limit: 50 }, signal }),
    refetchInterval: status === "pending" ? APPROVAL_POLL_MS : false,
  });
}

/** How often an approved request is re-read while it settles (signing -> chain). */
const SETTLE_POLL_MS = 4000;

export function useApproval(id: string) {
  return useQuery({
    queryKey: qk.approval(id),
    enabled: useSignedIn() && id !== "",
    queryFn: ({ signal }) => call("getApproval", { params: { approvalId: id }, signal }),
    refetchInterval: (q) => {
      const data = q.state.data;
      // The API rebuilds the unsigned Solana tx near blockhash expiry (ADR-001 D4): keep it fresh.
      if (data === undefined || data.approval.status === "pending") return 20_000;
      // Approved: follow the request until it settles (CONFIRMED / FAILED), then stop.
      if (
        data.approval.status === "approved" &&
        !TERMINAL_STATES.includes(data.review.request.state)
      )
        return SETTLE_POLL_MS;
      return false;
    },
  });
}

/**
 * Masumi escrow of a pay_x402 request, read live from the chain by the API. Seeded with the
 * escrow the approval already carried; polls while it can still change, stops once closed.
 */
export function useX402Escrow(requestId: string, initial: X402Escrow | null | undefined) {
  return useQuery({
    queryKey: qk.escrow(requestId),
    enabled: useSignedIn() && requestId !== "" && initial != null,
    queryFn: ({ signal }) =>
      call("getX402Escrow", { params: { requestId }, signal }).then((r) => r.escrow),
    ...(initial != null ? { placeholderData: initial } : {}),
    refetchInterval: (q) => escrowPollMs(q.state.data ?? initial),
  });
}

/** Build an escrow spend (refund request / withdrawal) for review. */
export function usePrepareEscrowAction() {
  return useMutation({
    mutationFn: ({ requestId, action }: { requestId: string; action: X402EscrowAction }) =>
      action === "request_refund"
        ? call("prepareX402RefundRequest", { params: { requestId } })
        : call("prepareX402RefundWithdrawal", { params: { requestId } }),
  });
}

/** Submit the passkey-stamped escrow spend; the escrow query takes the answer. */
export function useSubmitEscrowAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      action,
      body,
    }: {
      requestId: string;
      action: X402EscrowAction;
      body: CallBody<"submitX402RefundRequest">;
    }) =>
      action === "request_refund"
        ? call("submitX402RefundRequest", { params: { requestId }, body })
        : call("submitX402RefundWithdrawal", { params: { requestId }, body }),
    onSuccess: (res, { requestId }) => {
      qc.setQueryData(qk.escrow(requestId), res.escrow);
      void qc.invalidateQueries({ queryKey: ["approval"] });
    },
  });
}

/**
 * The agent's Cardano auto-pay allowance (null when none), read from the chain by the API on
 * every call: polls fast while the chain is about to change it, slowly while active.
 */
export function useAgentAllowance(agentId: string) {
  return useQuery({
    queryKey: qk.allowance(agentId),
    enabled: useSignedIn() && agentId !== "",
    queryFn: ({ signal }) =>
      call("getAgentAllowance", { params: { agentId }, signal }).then((r) => r.allowance),
    refetchInterval: (q) => allowancePollMs(q.state.data),
  });
}

/** Payments the agent made from its allowance, newest first. */
export function useAllowanceSpends(agentId: string, enabled = true) {
  return useQuery({
    queryKey: qk.allowanceSpends(agentId),
    enabled: useSignedIn() && agentId !== "" && enabled,
    queryFn: ({ signal }) =>
      call("listAgentAllowanceSpends", { params: { agentId }, query: { limit: 20 }, signal }).then(
        (r) => r.spends,
      ),
    refetchInterval: 30_000,
  });
}

/** Build an allowance transaction (create, top-up, revoke) for review. */
export function usePrepareAllowance(agentId: string) {
  return useMutation({
    mutationFn: (
      input:
        | { action: "create"; body: CallBody<"createAgentAllowance"> }
        | { action: "top_up"; body: CallBody<"topUpAgentAllowance"> }
        | { action: "revoke" },
    ) =>
      input.action === "create"
        ? call("createAgentAllowance", { params: { agentId }, body: input.body })
        : input.action === "top_up"
          ? call("topUpAgentAllowance", { params: { agentId }, body: input.body })
          : call("revokeAgentAllowance", { params: { agentId } }),
  });
}

/** Submit the passkey-stamped allowance transaction; the allowance query takes the answer. */
export function useSubmitAllowance(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: AllowanceAction; body: CallBody<"submitAgentAllowance"> }) =>
      call("submitAgentAllowance", { params: { agentId }, body: input.body }).then(
        (r) => r.allowance,
      ),
    onSuccess: async (allowance) => {
      qc.setQueryData(qk.allowance(agentId), allowance);
      await invalidateMoney(qc);
    },
  });
}

/** Every request an agent made, all states (approval-gated and autonomous executions). */
export function useAgentRequests(agentId: string, state?: TxRequestState) {
  return useQuery({
    queryKey: qk.agentRequests(agentId, state),
    enabled: useSignedIn() && agentId !== "",
    queryFn: ({ signal }) =>
      call("listAgentRequests", { params: { agentId }, query: { state, limit: 100 }, signal }),
    refetchInterval: APPROVAL_POLL_MS,
  });
}

/** Search the Masumi agent registry on Cardano (third-party listings). */
export function useMasumiAgents(query: CallQuery<"listMasumiAgents">) {
  return useQuery({
    queryKey: qk.masumiAgents(query),
    enabled: useSignedIn(),
    queryFn: ({ signal }) => call("listMasumiAgents", { query, signal }),
    staleTime: 60_000,
  });
}

export function usePlugins() {
  return useQuery({
    queryKey: qk.plugins,
    enabled: useSignedIn(),
    queryFn: ({ signal }) => call("listPlugins", { signal }).then((r) => r.plugins),
  });
}

export function usePriceHistory(assetId: string, range: PriceRange, currency = "USD") {
  return useQuery({
    queryKey: qk.priceHistory(assetId, range),
    enabled: useSignedIn() && assetId !== "",
    // The API answers status "unavailable" (with a reason) rather than inventing a series.
    queryFn: ({ signal }) =>
      call("getPriceHistory", { params: { assetId }, query: { range, currency }, signal }).then(
        (r) => r.history,
      ),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

function invalidateMoney(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["portfolio"] }),
    qc.invalidateQueries({ queryKey: ["transactions"] }),
  ]);
}

export function useQuoteSend() {
  return useMutation({
    mutationFn: (body: CallBody<"quoteSend">) => call("quoteSend", { body }).then((r) => r.review),
  });
}

/**
 * ADR-002: wallets created before Cardano support have no Cardano key. The user's own
 * Turnkey credential adds the account (ZyroPay cannot write to the sub-org), then the API
 * mirrors it with POST /v1/wallets/sync.
 */
export function useAddCardanoAccount(signer: {
  addCardanoAccount(input: { organizationId: string; turnkeyWalletId: string }): Promise<void>;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { organizationId: string; turnkeyWalletId: string }) => {
      await signer.addCardanoAccount(input);
      return call("syncWallets", {}).then((r) => r.wallets);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.wallets });
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      void qc.invalidateQueries({ queryKey: ["receive"] });
      void invalidateMoney(qc);
    },
  });
}

export function useSubmitSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; body: CallBody<"submitSend"> }) =>
      call("submitSend", { params: { requestId: input.requestId }, body: input.body }).then(
        (r) => r.request,
      ),
    onSuccess: () => invalidateMoney(qc),
  });
}

/** How often the send status screen re-reads history while a real send is unconfirmed. */
const SEND_FOLLOW_MS = 4000;

/**
 * Follow a submitted send until the chain settles it: polls the wallet's history on that
 * network while the result is BROADCAST, then refreshes the portfolio once it is final.
 */
export function useSendProgress(
  result: TransactionRequestResult | null,
  walletId: string,
  network: NetworkId,
): TxRequestState | null {
  const qc = useQueryClient();
  const follow = result !== null && needsChainFollow(result);
  const txs = useQuery({
    queryKey: [...qk.transactions(walletId, network), "follow", result?.txHash ?? ""],
    enabled: useSignedIn() && follow && walletId !== "",
    queryFn: ({ signal }) =>
      call("listTransactions", { query: { walletId, network, limit: 20 }, signal }),
    refetchInterval: (q) =>
      result && sendProgress(result, q.state.data?.transactions) === result.state
        ? SEND_FOLLOW_MS
        : false,
  });
  const state = result ? sendProgress(result, txs.data?.transactions) : null;
  const settled = follow && state !== null && state !== result.state;
  useEffect(() => {
    if (settled) void invalidateMoney(qc);
  }, [settled, qc]);
  return state;
}

export function useCancelRequest() {
  return useMutation({
    mutationFn: (requestId: string) =>
      call("cancelRequest", { params: { requestId } }).then((r) => r.request),
  });
}

export function useApproveApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { approvalId: string; body: CallBody<"approveApproval"> }) =>
      call("approveApproval", { params: { approvalId: input.approvalId }, body: input.body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["approvals"] });
      await qc.invalidateQueries({ queryKey: ["approval"] });
      await invalidateMoney(qc);
    },
  });
}

export function useRejectApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { approvalId: string; reason?: string }) =>
      call("rejectApproval", {
        params: { approvalId: input.approvalId },
        body: input.reason ? { reason: input.reason } : {},
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["approvals"] });
      await qc.invalidateQueries({ queryKey: ["approval"] });
    },
  });
}

export function useUpdateAgentPolicy(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CallBody<"updateAgentPolicy">) =>
      call("updateAgentPolicy", { params: { agentId }, body }).then((r) => r.policy),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.agent(agentId) });
      await qc.invalidateQueries({ queryKey: qk.agents });
      await qc.invalidateQueries({ queryKey: qk.delegatedSigner });
    },
  });
}

export function useRenameAgent(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      call("updateAgent", { params: { agentId }, body: { name } }).then((r) => r.agent),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.agent(agentId) });
      await qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
}

export function useRevokeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      call("revokeAgent", { params: { agentId } }).then((r) => r.agent),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agent"] });
      await qc.invalidateQueries({ queryKey: qk.agents });
      await qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useClaimConnection() {
  return useMutation({
    mutationFn: (userCode: string) =>
      call("claimAgentConnection", { body: { userCode } }).then((r) => r.connection),
  });
}

export function useApproveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; body: CallBody<"approveAgentConnection"> }) =>
      call("approveAgentConnection", {
        params: { connectionId: input.connectionId },
        body: input.body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents }),
  });
}

export function useRejectConnection() {
  return useMutation({
    mutationFn: (connectionId: string) =>
      call("rejectAgentConnection", { params: { connectionId } }).then((r) => r.connection),
  });
}

export function useSetPluginEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { pluginId: string; enabled: boolean }) =>
      call("setPluginEnabled", {
        params: { pluginId: input.pluginId },
        body: { enabled: input.enabled },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.plugins }),
  });
}

export function useQuoteOnramp() {
  return useMutation({
    mutationFn: (body: CallBody<"quoteOnramp">) =>
      call("quoteOnramp", { body }).then((r) => r.quote),
  });
}

export function useCreateOnrampSession() {
  return useMutation({
    mutationFn: (body: CallBody<"createOnrampSession">) => call("createOnrampSession", { body }),
  });
}

// --- wallet management (apiWallets) ------------------------------------------

/** Read-only (watch) addresses. They never sign, send, or appear to agents. */
export function useWatchWallets() {
  return useQuery({
    queryKey: qk.watchWallets,
    enabled: useSignedIn(),
    queryFn: ({ signal }) => call("listWatchWallets", { signal }).then((r) => r.watchWallets),
    staleTime: 60_000,
  });
}

export function useWatchWalletPortfolio(id: string, currency = "USD") {
  return useQuery({
    queryKey: qk.watchPortfolio(id, currency),
    enabled: useSignedIn() && id !== "",
    queryFn: ({ signal }) =>
      call("getWatchWalletPortfolio", {
        params: { watchWalletId: id },
        query: { currency },
        signal,
      }).then((r) => r.portfolio),
    staleTime: 30_000,
  });
}

function invalidateWallets(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.wallets }),
    qc.invalidateQueries({ queryKey: ["wallet"] }),
    qc.invalidateQueries({ queryKey: qk.watchWallets }),
    qc.invalidateQueries({ queryKey: ["watchPortfolio"] }),
    invalidateMoney(qc),
  ]);
}

/** Register a wallet the passkey just created in the user's Turnkey sub-organization. */
export function useCreateWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CallBody<"createWallet">) =>
      call("createWallet", { body }).then((r) => r.wallet),
    onSuccess: () => invalidateWallets(qc),
  });
}

export function useCreateWatchWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CallBody<"createWatchWallet">) =>
      call("createWatchWallet", { body }).then((r) => r.watchWallet),
    onSuccess: () => invalidateWallets(qc),
  });
}

export function useRenameWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: "wallet" | "watch"; id: string; name: string }) => {
      if (input.kind === "wallet") {
        await call("renameWallet", { params: { walletId: input.id }, body: { name: input.name } });
      } else {
        await call("renameWatchWallet", {
          params: { watchWalletId: input.id },
          body: { name: input.name },
        });
      }
    },
    onSuccess: () => invalidateWallets(qc),
  });
}

/** Unlink a wallet (keys stay in Turnkey) or stop watching an address. */
export function useRemoveWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: "wallet" | "watch"; id: string }) =>
      input.kind === "wallet"
        ? call("removeWallet", { params: { walletId: input.id } })
        : call("removeWatchWallet", { params: { watchWalletId: input.id } }),
    onSuccess: () => invalidateWallets(qc),
  });
}
