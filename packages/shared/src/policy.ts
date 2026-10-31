import { z } from "zod";
import { addressesEqual } from "./addresses";
import type { AgentPolicy } from "./domain/agents";
import type { UsdMinor } from "./money";
import { parseBaseUnits } from "./money";
import type { ChainFamily, NetworkId } from "./networks";
import { chainFamilyOf } from "./networks";
import type { PluginId } from "./plugins";
import type { McpToolName } from "./tools";
import { isValueMovingTool } from "./tools";

export const PolicyDecisionSchema = z.enum(["allow", "require_approval", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const POLICY_REASON_CODES = [
  "AGENT_REVOKED",
  "SESSION_EXPIRED",
  "TOOL_NOT_ALLOWED",
  "WALLET_NOT_ALLOWED",
  "NETWORK_NOT_ALLOWED",
  "SPENDING_DISABLED",
  "PROTOCOL_REQUIRED",
  "PROTOCOL_NOT_ALLOWED",
  "RECIPIENT_REQUIRED",
  "RECIPIENT_NOT_ALLOWED",
  "VALUATION_UNAVAILABLE",
  "PER_TRANSACTION_LIMIT_EXCEEDED",
  "DAILY_LIMIT_EXCEEDED",
  "MONTHLY_LIMIT_EXCEEDED",
  "AUTONOMY_NOT_SUPPORTED",
  "ALWAYS_ASK",
  "ESCROW_REQUIRED",
  "AGENT_NOT_REGISTERED",
  "AGENT_NOT_TRUSTED",
  // Auto-pay on Cardano (cardano-allowance.ts, docs/AUTOPAY.md).
  "AUTO_PAY_ALLOWANCE",
  "ALLOWANCE_PAYEE_NOT_LISTED",
  "ALLOWANCE_LIMIT_EXCEEDED",
  "ALLOWANCE_INSUFFICIENT",
  "ALLOWANCE_EXPIRED",
  "ALLOWANCE_BUSY",
  "ALLOWANCE_UNAVAILABLE",
] as const;
export const PolicyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export type PolicyReasonCode = z.infer<typeof PolicyReasonCodeSchema>;

export const PolicyReasonSchema = z.object({
  code: PolicyReasonCodeSchema,
  message: z.string(),
});
export type PolicyReason = z.infer<typeof PolicyReasonSchema>;

export const PolicyEvaluationSchema = z.object({
  decision: PolicyDecisionSchema,
  reasons: z.array(PolicyReasonSchema),
  policyVersion: z.number().int(),
});
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

/** What the agent is trying to do, already resolved by the API. */
export interface PolicyRequest {
  readonly tool: McpToolName;
  readonly walletId: string;
  readonly network: NetworkId;
  /** Third-party recipient (send: `to`; x402: `payTo`). Null for swaps into the own wallet. */
  readonly recipient: string | null;
  /** Plugin the request routes through; null for a plain transfer. */
  readonly protocol: PluginId | null;
  /** pay_x402: true when the payment is locked in Masumi escrow (method "masumi"). */
  readonly x402Escrow?: boolean;
  /**
   * pay_x402: the seller's Masumi registry identity, verified on chain when quoting.
   * Null/absent: the seller has none (it claims none; every direct payment).
   */
  readonly x402RegisteredAgent?: { readonly agentIdentifier: string } | null;
}

/** Already-committed USD cents within a window. */
export interface SpendWindow {
  /** Confirmed/broadcast spend in the window. */
  readonly spentUsdMinor: UsdMinor;
  /** Held by in-flight requests (approved/signing) that have not settled yet. */
  readonly reservedUsdMinor: UsdMinor;
}

export interface SpentWindows {
  readonly daily: SpendWindow;
  readonly monthly: SpendWindow;
}

export interface PolicyContext {
  readonly now: Date;
}

/** Tools whose request must name a protocol. */
const PROTOCOL_REQUIRED: ReadonlySet<McpToolName> = new Set<McpToolName>(["swap", "pay_x402"]);
/**
 * Tools that may ever execute without a human approval. Swaps are excluded: router
 * programs can move any token the transaction touches and Turnkey policies cannot
 * constrain downstream program behaviour (docs/ARCHITECTURE.md ADR-001).
 */
export const AUTONOMY_ELIGIBLE_TOOLS: readonly McpToolName[] = ["send", "pay_x402"];
/**
 * Chain families whose payments may ever be autonomous. Cardano is excluded: Turnkey signs
 * Cardano only through SIGN_RAW_PAYLOAD over the transaction body hash, and its policy
 * engine cannot parse Cardano transactions, so no Turnkey policy can bound what a
 * delegated key would sign (docs/ARCHITECTURE.md ADR-002).
 */
export const AUTONOMY_ELIGIBLE_FAMILIES: readonly ChainFamily[] = ["solana", "evm"];

/** Tools bound to one specific protocol. */
const FIXED_PROTOCOL: Partial<Record<McpToolName, PluginId>> = { pay_x402: "x402" };

/**
 * Pure policy evaluation for an agent request.
 *
 * Rules (in order; every triggered rule is reported in `reasons`):
 *  1. DENY if revoked, session expired, or the tool / wallet / network is not allowed.
 *     Read-only tools that pass these checks are ALLOWED (approval applies to value only).
 *  2. DENY a value-moving request if spending is disabled, the protocol is missing or
 *     not allowed, or the recipient is missing/not on the allowlist (when restricted).
 *     With `requireRegisteredAgent`, DENY a pay_x402 whose seller has no verified Masumi
 *     registry identity (AGENT_NOT_REGISTERED) or, when `trustedAgentIdentifiers` is
 *     non-empty, is not one of them (AGENT_NOT_TRUSTED).
 *  3. Limits. projected window spend = spent + reserved + this valuation (reserved covers
 *     concurrent in-flight requests, so parallel requests cannot jointly exceed a limit).
 *     A missing valuation counts as exceeding every limit (fail closed).
 *     If any limit is exceeded: overLimitBehavior "deny" => DENY (hard cap, any mode);
 *     "require_approval" => REQUIRE_APPROVAL.
 *     x402 escrow rule: with `x402EscrowAboveUsdMinor` set, a pay_x402 that is NOT escrowed
 *     and is valued above it (or unvalued) adds ESCROW_REQUIRED, handled like a limit.
 *  4. Mode always_ask, a tool outside AUTONOMY_ELIGIBLE_TOOLS (swap) or a network outside
 *     AUTONOMY_ELIGIBLE_FAMILIES (Cardano) => REQUIRE_APPROVAL.
 *     Otherwise (autonomous, eligible tool, within limits) => ALLOW.
 *
 * Throws on malformed amounts; callers must treat a throw as DENY.
 */
export function evaluatePolicy(
  policy: AgentPolicy,
  request: PolicyRequest,
  valuationUsdMinor: UsdMinor | null,
  spentWindows: SpentWindows,
  context: PolicyContext,
): PolicyEvaluation {
  const deny: PolicyReason[] = [];
  const result = (decision: PolicyDecision, reasons: PolicyReason[]): PolicyEvaluation => ({
    decision,
    reasons,
    policyVersion: policy.version,
  });

  if (policy.revoked) deny.push({ code: "AGENT_REVOKED", message: "agent access was revoked" });
  if (
    policy.sessionExpiresAt !== null &&
    Date.parse(policy.sessionExpiresAt) <= context.now.getTime()
  ) {
    deny.push({ code: "SESSION_EXPIRED", message: "agent session has expired" });
  }
  if (!policy.allowedTools.includes(request.tool)) {
    deny.push({ code: "TOOL_NOT_ALLOWED", message: `tool ${request.tool} is not allowed` });
  }
  if (!policy.allowedWalletIds.includes(request.walletId)) {
    deny.push({ code: "WALLET_NOT_ALLOWED", message: "wallet is not shared with this agent" });
  }
  if (!policy.allowedNetworks.includes(request.network)) {
    deny.push({
      code: "NETWORK_NOT_ALLOWED",
      message: `network ${request.network} is not allowed`,
    });
  }

  if (!isValueMovingTool(request.tool)) {
    return deny.length > 0 ? result("deny", deny) : result("allow", []);
  }

  if (!policy.spendingEnabled) {
    deny.push({ code: "SPENDING_DISABLED", message: "spending is disabled for this agent" });
  }

  const fixedProtocol = FIXED_PROTOCOL[request.tool];
  if (request.protocol === null) {
    if (PROTOCOL_REQUIRED.has(request.tool)) {
      deny.push({ code: "PROTOCOL_REQUIRED", message: `${request.tool} must name a protocol` });
    }
  } else if (
    (fixedProtocol !== undefined && request.protocol !== fixedProtocol) ||
    !policy.allowedProtocols.includes(request.protocol)
  ) {
    deny.push({
      code: "PROTOCOL_NOT_ALLOWED",
      message: `protocol ${request.protocol} is not allowed`,
    });
  }

  if (request.recipient === null) {
    if (request.tool !== "swap") {
      deny.push({ code: "RECIPIENT_REQUIRED", message: `${request.tool} must name a recipient` });
    }
  } else if (policy.restrictRecipients) {
    const family = chainFamilyOf(request.network);
    const recipient = request.recipient;
    const listed = policy.recipientAllowlist.some(
      (entry) => entry.family === family && addressesEqual(family, entry.address, recipient),
    );
    if (!listed) {
      deny.push({ code: "RECIPIENT_NOT_ALLOWED", message: "recipient is not on the allowlist" });
    }
  }

  if (request.tool === "pay_x402" && policy.requireRegisteredAgent === true) {
    const seller = request.x402RegisteredAgent ?? null;
    const trusted = policy.trustedAgentIdentifiers ?? [];
    if (seller === null) {
      deny.push({
        code: "AGENT_NOT_REGISTERED",
        message: "this agent may only pay registered Masumi agents (verified on chain)",
      });
    } else if (trusted.length > 0 && !trusted.includes(seller.agentIdentifier)) {
      deny.push({
        code: "AGENT_NOT_TRUSTED",
        message: "the seller is a registered Masumi agent, but not one this agent may pay",
      });
    }
  }

  if (deny.length > 0) return result("deny", deny);

  const limitReasons = [
    ...checkLimits(policy, valuationUsdMinor, spentWindows),
    ...checkEscrow(policy, request, valuationUsdMinor),
  ];
  if (limitReasons.length > 0 && policy.overLimitBehavior === "deny") {
    return result("deny", limitReasons);
  }

  const approvalReasons = [...limitReasons];
  if (policy.mode === "always_ask") {
    approvalReasons.push({ code: "ALWAYS_ASK", message: "agent is in Always Ask mode" });
  } else if (!AUTONOMY_ELIGIBLE_TOOLS.includes(request.tool)) {
    approvalReasons.push({
      code: "AUTONOMY_NOT_SUPPORTED",
      message: `${request.tool} always requires approval`,
    });
  } else if (!AUTONOMY_ELIGIBLE_FAMILIES.includes(chainFamilyOf(request.network))) {
    approvalReasons.push({
      code: "AUTONOMY_NOT_SUPPORTED",
      message: `${chainFamilyOf(request.network)} payments always require approval`,
    });
  }
  return approvalReasons.length > 0
    ? result("require_approval", approvalReasons)
    : result("allow", []);
}

/** ESCROW_REQUIRED for a direct (non-escrow) x402 payment above the policy's threshold. */
function checkEscrow(
  policy: AgentPolicy,
  request: PolicyRequest,
  valuationUsdMinor: UsdMinor | null,
): PolicyReason[] {
  const threshold = policy.x402EscrowAboveUsdMinor ?? null;
  if (threshold === null || request.tool !== "pay_x402" || request.x402Escrow === true) return [];
  if (valuationUsdMinor !== null && parseBaseUnits(valuationUsdMinor) <= parseBaseUnits(threshold))
    return [];
  return [
    {
      code: "ESCROW_REQUIRED",
      message:
        valuationUsdMinor === null
          ? "x402 payments without a valuation must use escrow under this policy"
          : "x402 payments above the escrow threshold must use escrow (Masumi)",
    },
  ];
}

function checkLimits(
  policy: AgentPolicy,
  valuationUsdMinor: UsdMinor | null,
  spent: SpentWindows,
): PolicyReason[] {
  if (valuationUsdMinor === null) {
    return [
      {
        code: "VALUATION_UNAVAILABLE",
        message: "no USD valuation available; treated as exceeding every limit",
      },
    ];
  }
  const value = parseBaseUnits(valuationUsdMinor);
  const reasons: PolicyReason[] = [];
  if (value > parseBaseUnits(policy.limits.perTransactionUsdMinor)) {
    reasons.push({
      code: "PER_TRANSACTION_LIMIT_EXCEEDED",
      message: "exceeds per-transaction limit",
    });
  }
  const projected = (w: SpendWindow) =>
    parseBaseUnits(w.spentUsdMinor) + parseBaseUnits(w.reservedUsdMinor) + value;
  if (projected(spent.daily) > parseBaseUnits(policy.limits.dailyUsdMinor)) {
    reasons.push({
      code: "DAILY_LIMIT_EXCEEDED",
      message: "exceeds daily limit (spent + reserved)",
    });
  }
  if (projected(spent.monthly) > parseBaseUnits(policy.limits.monthlyUsdMinor)) {
    reasons.push({
      code: "MONTHLY_LIMIT_EXCEEDED",
      message: "exceeds monthly limit (spent + reserved)",
    });
  }
  return reasons;
}
