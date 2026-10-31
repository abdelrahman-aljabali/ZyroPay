import { z } from "zod";
import { AddressSchema } from "../addresses";
import { IsoDateTimeSchema } from "../common";
import { UsdMinorSchema } from "../money";
import { ChainFamilySchema, NetworkIdSchema } from "../networks";
import { MCP_TOOL_NAMES, McpToolNameSchema } from "../tools";
import { PluginIdSchema } from "../plugins";
import { MasumiAgentIdentifierSchema } from "./masumi";

/** Upper bound of `trustedAgentIdentifiers`. */
export const MAX_TRUSTED_AGENT_IDENTIFIERS = 50;

export const AgentModeSchema = z.enum(["always_ask", "autonomous"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const OverLimitBehaviorSchema = z.enum(["require_approval", "deny"]);
export type OverLimitBehavior = z.infer<typeof OverLimitBehaviorSchema>;

export const RecipientAllowlistEntrySchema = z.object({
  family: ChainFamilySchema,
  address: AddressSchema,
  label: z.string().max(64).nullable(),
});
export type RecipientAllowlistEntry = z.infer<typeof RecipientAllowlistEntrySchema>;

/**
 * Autonomy limits in USD cents. "0" means no autonomous spending in that window.
 * Limits gate AUTONOMOUS execution; what happens above them is `overLimitBehavior`.
 */
export const SpendingLimitsSchema = z.object({
  perTransactionUsdMinor: UsdMinorSchema,
  dailyUsdMinor: UsdMinorSchema,
  monthlyUsdMinor: UsdMinorSchema,
});
export type SpendingLimits = z.infer<typeof SpendingLimitsSchema>;

export const AgentPolicySchema = z.object({
  mode: AgentModeSchema,
  /** Master switch for value-moving tools. When false every send/swap/pay is denied. */
  spendingEnabled: z.boolean(),
  /** Empty list = no wallet access at all. */
  allowedWalletIds: z.array(z.uuid()),
  allowedNetworks: z.array(NetworkIdSchema),
  allowedTools: z.array(McpToolNameSchema),
  /** When true, value may only go to addresses in `recipientAllowlist`. */
  restrictRecipients: z.boolean(),
  recipientAllowlist: z.array(RecipientAllowlistEntrySchema).max(200),
  /** Plugins/protocols the agent may route through (swap, x402, ...). */
  allowedProtocols: z.array(PluginIdSchema),
  limits: SpendingLimitsSchema,
  overLimitBehavior: OverLimitBehaviorSchema,
  /**
   * x402 payments valued above this many USD cents must use Masumi escrow
   * (`assetTransferMethod: "masumi"`); a direct payment above it is handled like an
   * over-limit request (`overLimitBehavior`: approval or denial, reason ESCROW_REQUIRED).
   * An unvalued payment counts as above. Null or absent: no escrow requirement. "0" = every
   * x402 payment must be escrowed. On update, an absent field keeps the current value.
   */
  x402EscrowAboveUsdMinor: UsdMinorSchema.nullable().optional(),
  /**
   * "Only pay registered Masumi agents": when true, a pay_x402 is denied (reason
   * AGENT_NOT_REGISTERED) unless the seller's signed terms claim a Masumi registry identity
   * (`agentIdentifier`) that ZyroPay verified on chain (only Masumi escrow payments can).
   * Absent = false. On update, an absent field keeps the current value.
   */
  requireRegisteredAgent: z.boolean().optional(),
  /**
   * With `requireRegisteredAgent`: when non-empty, only these registered agents may be paid
   * (reason AGENT_NOT_TRUSTED otherwise). Ignored while `requireRegisteredAgent` is false.
   * Absent = []. On update, an absent field keeps the current value.
   */
  trustedAgentIdentifiers: z
    .array(MasumiAgentIdentifierSchema)
    .max(MAX_TRUSTED_AGENT_IDENTIFIERS)
    .optional(),
  /** The agent's access ends at this instant; null = until revoked. */
  sessionExpiresAt: IsoDateTimeSchema.nullable(),
  revoked: z.boolean(),
  /** Monotonic; incremented on every policy change (optimistic locking). */
  version: z.number().int().min(1),
});
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;

/**
 * Policy for a freshly connected agent: Always Ask, spending disabled, zero limits,
 * recipients restricted to an empty allowlist, no wallets, no protocols. The user must
 * explicitly widen every dimension.
 */
export function defaultAgentPolicy(): AgentPolicy {
  return {
    mode: "always_ask",
    spendingEnabled: false,
    allowedWalletIds: [],
    allowedNetworks: [],
    allowedTools: [...MCP_TOOL_NAMES],
    restrictRecipients: true,
    recipientAllowlist: [],
    allowedProtocols: [],
    limits: { perTransactionUsdMinor: "0", dailyUsdMinor: "0", monthlyUsdMinor: "0" },
    overLimitBehavior: "require_approval",
    x402EscrowAboveUsdMinor: null,
    requireRegisteredAgent: false,
    trustedAgentIdentifiers: [],
    sessionExpiresAt: null,
    revoked: false,
    version: 1,
  };
}

export const AgentSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string().min(1).max(64),
  /** OAuth client that represents this agent (null for agents created in-app). */
  oauthClientId: z.string().nullable(),
  policy: AgentPolicySchema,
  createdAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;
