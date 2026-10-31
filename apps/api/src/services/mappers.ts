import type {
  Agent,
  AgentPolicy,
  ApprovalRequest,
  FiatValue,
  TransactionRequest,
  TransactionRequestResult,
  User,
  Wallet,
} from "@zyropay/shared";
import { AgentPolicySchema, explorerTxUrl, minorUnitsToDecimal } from "@zyropay/shared";
import type * as t from "../db/tables";

export type UserRow = typeof t.users.$inferSelect;
export type WalletRow = typeof t.wallets.$inferSelect;
export type WalletAddressRow = typeof t.walletAddresses.$inferSelect;
export type AgentRow = typeof t.agents.$inferSelect;
export type PolicyRow = typeof t.agentPolicies.$inferSelect;
export type TxRequestRow = typeof t.transactionRequests.$inferSelect;
export type ApprovalRow = typeof t.approvalRequests.$inferSelect;
export type ConnectionRow = typeof t.agentConnections.$inferSelect;
export type DelegatedSignerRow = typeof t.delegatedSigners.$inferSelect;

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    turnkeySubOrganizationId: row.turnkeySubOrganizationId,
    createdAt: iso(row.createdAt),
  };
}

export function toWallet(
  row: WalletRow,
  addresses: readonly WalletAddressRow[],
  subOrganizationId: string,
): Wallet {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    turnkeySubOrganizationId: subOrganizationId,
    turnkeyWalletId: row.turnkeyWalletId,
    addresses: addresses
      .filter((a) => a.walletId === row.id)
      .map((a) => ({
        id: a.id,
        walletId: a.walletId,
        family: a.family,
        address: a.address,
        derivationPath: a.derivationPath,
        createdAt: iso(a.createdAt),
      })),
    createdAt: iso(row.createdAt),
  };
}

/** Policy rows are validated against the contract on every read (fail closed on drift). */
export function toPolicy(row: PolicyRow): AgentPolicy {
  return AgentPolicySchema.parse({
    mode: row.mode,
    spendingEnabled: row.spendingEnabled,
    allowedWalletIds: row.allowedWalletIds,
    allowedNetworks: row.allowedNetworks,
    allowedTools: row.allowedTools,
    restrictRecipients: row.restrictRecipients,
    recipientAllowlist: row.recipientAllowlist,
    allowedProtocols: row.allowedProtocols,
    limits: {
      perTransactionUsdMinor: row.perTransactionUsdMinor,
      dailyUsdMinor: row.dailyUsdMinor,
      monthlyUsdMinor: row.monthlyUsdMinor,
    },
    overLimitBehavior: row.overLimitBehavior,
    x402EscrowAboveUsdMinor: row.x402EscrowAboveUsdMinor,
    requireRegisteredAgent: row.requireRegisteredAgent,
    trustedAgentIdentifiers: row.trustedAgentIdentifiers,
    sessionExpiresAt: isoOrNull(row.sessionExpiresAt),
    revoked: row.revoked,
    version: row.version,
  });
}

export function toAgent(row: AgentRow, policy: PolicyRow): Agent {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    oauthClientId: row.oauthClientId,
    policy: toPolicy(policy),
    createdAt: iso(row.createdAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

export function usdValue(minor: string | null): FiatValue | null {
  return minor === null ? null : { value: minorUnitsToDecimal(minor), currency: "USD" };
}

export function toTransactionRequest(row: TxRequestRow): TransactionRequest {
  return {
    id: row.id,
    walletId: row.walletId,
    requester:
      row.agentId === null
        ? { type: "user", userId: row.userId }
        : { type: "agent", agentId: row.agentId, userId: row.userId },
    source: row.source,
    state: row.state,
    payload: row.payload,
    payloadHash: row.payloadHash,
    valuationUsdMinor: row.valuationUsdMinor,
    value: usdValue(row.valuationUsdMinor),
    policyDecision: row.policyDecision,
    policyReasons: row.policyReasons,
    txHash: row.txHash,
    failureReason: row.failureReason,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    simulated: row.simulated,
  };
}

export function toApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    transactionRequestId: row.transactionRequestId,
    userId: row.userId,
    agentId: row.agentId,
    status: row.status,
    payloadHash: row.payloadHash,
    expiresAt: iso(row.expiresAt),
    decidedAt: isoOrNull(row.decidedAt),
    createdAt: iso(row.createdAt),
  };
}

export function toRequestResult(
  row: TxRequestRow,
  approval: ApprovalRow | null,
  deepLinkScheme: string,
): TransactionRequestResult {
  return {
    requestId: row.id,
    state: row.state,
    decision: row.policyDecision,
    reasons: row.policyReasons,
    payloadHash: row.payloadHash,
    approvalUrl:
      approval !== null && approval.status === "pending"
        ? `${deepLinkScheme}://approvals/${approval.id}`
        : null,
    txHash: row.txHash,
    explorerUrl: row.txHash === null ? null : explorerTxUrl(row.network, row.txHash),
    expiresAt: iso(row.expiresAt),
    simulated: row.simulated,
    failureReason: row.failureReason,
  };
}
