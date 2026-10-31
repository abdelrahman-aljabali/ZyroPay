/*
 * Additive REST endpoints implemented by apps/api, next to `api` in contracts.ts. Nothing
 * in contracts.ts is changed by these.
 *
 *  - Delegated signer lifecycle for autonomous mode (ADR-001 D6): the API generates the
 *    key, the app (passkey) creates the Turnkey user + policies, the API verifies.
 *  - Chain webhooks (Helius / Alchemy) for incoming transfers and confirmations.
 *  - The MCP worker's audit sink (`internalRecordAuditEvent`, MCP_AUDIT_SINK=api).
 *  - Price history for the asset chart (`getPriceHistory`), fail closed.
 *  - An agent's activity: every transaction request it made, in every state
 *    (`listAgentRequests`), including autonomous executions that never needed an approval.
 *  - Notification event kinds richer than the `Notification.kind` port union; adapters
 *    receive the closest port kind plus `data.event` with the precise event.
 */
import { z } from "zod";
import { CursorSchema, IsoDateTimeSchema, PageLimitSchema } from "../common";
import { AssetIdSchema } from "../domain/assets";
import { TransactionRequestSchema } from "../domain/requests";
import { DecimalStringSchema, FiatCurrencySchema } from "../money";
import { TxRequestStateSchema } from "../state-machine";
import type { EndpointContract } from "./contracts";
import { AuditEventSchema } from "./internal";

function extEndpoint<const T extends EndpointContract>(contract: T): T {
  return contract;
}

export const DelegatedSignerSchema = z.object({
  id: z.uuid(),
  status: z.enum(["pending", "active", "revoked"]),
  /** Compressed P-256 public key (hex) the app registers as the delegated API-key user. */
  apiPublicKey: z.string().regex(/^0[23][0-9a-f]{64}$/),
  /** Turnkey user id of the delegated non-root user once activated. */
  turnkeyUserId: z.string().nullable(),
  turnkeyPolicyIds: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type DelegatedSigner = z.infer<typeof DelegatedSignerSchema>;

const OkSchema = z.object({ ok: z.literal(true) });

export const PriceRangeSchema = z.enum(["1D", "1W", "1M", "1Y"]);
export type PriceRange = z.infer<typeof PriceRangeSchema>;

export const PriceHistoryUnavailableReasonSchema = z.enum([
  /** The provider does not track this asset. */
  "UNSUPPORTED_ASSET",
  /** Testnet assets have no market price (outside the development testnet proxy). */
  "TESTNET_ASSET",
  /** Only USD history is offered. */
  "CURRENCY_UNSUPPORTED",
  /** The price source failed or is not configured. */
  "PROVIDER_UNAVAILABLE",
]);
export type PriceHistoryUnavailableReason = z.infer<typeof PriceHistoryUnavailableReasonSchema>;

export const PricePointSchema = z.object({
  t: IsoDateTimeSchema,
  /** Price of ONE whole unit as a decimal string (never a float). */
  price: DecimalStringSchema,
});
export type PricePoint = z.infer<typeof PricePointSchema>;

const PriceHistoryBase = {
  assetId: AssetIdSchema,
  currency: FiatCurrencySchema,
  range: PriceRangeSchema,
  simulated: z.boolean(),
};

/**
 * Price history for one asset. Fails closed: when no trustworthy series exists the API
 * answers `status: "unavailable"` with a reason, never an invented or partial series.
 */
export const PriceHistorySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    ...PriceHistoryBase,
    /** Oldest first. */
    points: z.array(PricePointSchema).min(2).max(1000),
    source: z.string().min(1).max(64),
  }),
  z.object({
    status: z.literal("unavailable"),
    ...PriceHistoryBase,
    reason: PriceHistoryUnavailableReasonSchema,
  }),
]);
export type PriceHistory = z.infer<typeof PriceHistorySchema>;

/** One entry of an agent's activity: the request plus its approval, if it needed one. */
export const AgentActivityItemSchema = z.object({
  request: TransactionRequestSchema,
  /** Approval id when the request needed (or needs) the user's decision; null otherwise. */
  approvalId: z.uuid().nullable(),
  /** True when the request was executed without asking (autonomous mode, within limits). */
  autonomous: z.boolean(),
});
export type AgentActivityItem = z.infer<typeof AgentActivityItemSchema>;

export const apiExt = {
  getDelegatedSigner: extEndpoint({
    method: "GET",
    path: "/v1/delegated-signer",
    auth: "user",
    summary: "The user's delegated signer (autonomous mode), or null.",
    response: z.object({ signer: DelegatedSignerSchema.nullable() }),
  }),
  createDelegatedSigner: extEndpoint({
    method: "POST",
    path: "/v1/delegated-signer",
    auth: "user",
    summary:
      "Get or create a pending delegated signer: the API generates a P-256 key pair, stores the private key AES-256-GCM encrypted, and returns the public key for the app to register with its passkey (fetchOrCreateP256ApiKeyUser).",
    response: z.object({ signer: DelegatedSignerSchema }),
  }),
  activateDelegatedSigner: extEndpoint({
    method: "POST",
    path: "/v1/delegated-signer/activate",
    auth: "user",
    summary:
      "After the app created the delegated user in Turnkey: the API reads the sub-org (parent-org read key), checks the user holds exactly our public key and is NOT in the root quorum, then activates.",
    body: z.object({ turnkeyUserId: z.string().min(1).max(128) }),
    response: z.object({ signer: DelegatedSignerSchema }),
  }),
  deleteDelegatedSigner: extEndpoint({
    method: "DELETE",
    path: "/v1/delegated-signer",
    auth: "user",
    summary:
      "Revoke the delegated signer server-side (the encrypted key is destroyed at once) and switch every autonomous agent back to always_ask. The app should also delete the Turnkey user with its passkey.",
    response: OkSchema,
  }),
  chainWebhook: extEndpoint({
    method: "POST",
    path: "/v1/webhooks/chain/:provider",
    auth: "webhook",
    summary:
      "Helius (Solana) / Alchemy Notify (EVM) address-activity webhooks. Authenticated on the raw body, deduplicated by (provider, event_id), reconciled with RPC before any state change.",
    params: z.object({ provider: z.enum(["helius", "alchemy"]) }),
    body: z.unknown(),
    response: OkSchema,
  }),
  getPriceHistory: extEndpoint({
    method: "GET",
    path: "/v1/prices/:assetId/history",
    auth: "user",
    summary:
      'Price history for one asset (asset detail chart). USD only. Fails closed: status "unavailable" with a reason when no trustworthy series exists (testnet assets, unknown tokens, provider down).',
    params: z.object({ assetId: AssetIdSchema }),
    query: z.object({
      range: PriceRangeSchema.default("1W"),
      currency: FiatCurrencySchema.default("USD"),
    }),
    response: z.object({ history: PriceHistorySchema }),
  }),
  listAgentRequests: extEndpoint({
    method: "GET",
    path: "/v1/agents/:agentId/requests",
    auth: "user",
    summary:
      "Every transaction request one of the user's agents made, newest first, in all states (pending, approved, autonomous executions, rejected, expired, confirmed, failed).",
    params: z.object({ agentId: z.uuid() }),
    query: z.object({
      state: TxRequestStateSchema.optional(),
      limit: PageLimitSchema,
      cursor: CursorSchema.optional(),
    }),
    response: z.object({
      items: z.array(AgentActivityItemSchema),
      nextCursor: CursorSchema.nullable(),
    }),
  }),
  internalRecordAuditEvent: extEndpoint({
    method: "POST",
    path: "/internal/v1/audit-events",
    auth: "internal",
    summary:
      "Audit sink for the MCP worker (MCP_AUDIT_SINK=api): stores one OAuth or tool-call audit event in audit_logs (actor type mcp). Events carry ids, tool name, outcome and error code only.",
    body: AuditEventSchema,
    response: OkSchema,
  }),
} as const;

export type ApiExt = typeof apiExt;

/** Precise push events. `Notification.kind` (ports.ts) is the closest coarse kind. */
export const NOTIFICATION_EVENTS = [
  "approval_requested",
  "approval_expired",
  "transaction_executed",
  "transaction_confirmed",
  "transaction_failed",
  "incoming_payment",
  "agent_connected",
  "onramp_completed",
  "security_event",
] as const;
export const NotificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
