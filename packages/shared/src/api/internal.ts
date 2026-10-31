/*
 * Service-to-service contracts between the API worker and the MCP worker. Both directions
 * authenticate with `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (the previous token
 * is accepted during rotation) and never carry user credentials.
 *
 *  - `mcpInternal`: endpoints SERVED BY THE MCP WORKER and called by the API.
 *  - `AuditEventSchema`: body of `internalRecordAuditEvent` (served by the API, see ext.ts),
 *    which the MCP worker calls when MCP_AUDIT_SINK=api.
 */
import { z } from "zod";
import { IsoDateTimeSchema } from "../common";
import type { EndpointContract } from "./contracts";

function internalEndpoint<const T extends EndpointContract>(contract: T): T {
  return contract;
}

export const AUDIT_EVENT_TYPES = [
  "oauth.connection_started",
  "oauth.grant_created",
  "oauth.grant_denied",
  "oauth.grant_expired",
  "oauth.grant_revoked",
  "mcp.tool_call",
] as const;
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

/**
 * MCP audit event. Never contains tokens, secrets, addresses or amounts: only ids, the tool
 * name, the outcome and an error code.
 */
export const AuditEventSchema = z.strictObject({
  type: AuditEventTypeSchema,
  at: IsoDateTimeSchema,
  userId: z.uuid().nullable(),
  agentId: z.uuid().nullable(),
  /** OAuth client id (DCR id or CIMD URL). */
  clientId: z.string().max(512).nullable(),
  connectionId: z.uuid().nullable(),
  tool: z.string().max(64).nullable(),
  outcome: z.enum(["ok", "error", "denied", "expired", "revoked"]),
  /** Error code from the closed API set, or a local code (e.g. VALIDATION_FAILED). */
  errorCode: z.string().max(64).nullable(),
  /** Transaction request id returned by the API, for value-moving tools. */
  requestId: z.uuid().nullable(),
  idempotencyKey: z.string().max(128).nullable(),
  durationMs: z.number().int().min(0).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Endpoints served by apps/mcp for the API (auth: internal). */
export const mcpInternal = {
  mcpRevokeAgentGrants: internalEndpoint({
    method: "POST",
    path: "/internal/v1/agents/:agentId/revoke-grants",
    auth: "internal",
    summary:
      "Served by the MCP worker. Called by the API when a user revokes an agent: revokes every OAuth grant (and so every access and refresh token) that maps to the agent. Revocation also holds without this call, because the API refuses every internal call for a revoked agent.",
    params: z.object({ agentId: z.uuid() }),
    body: z.object({ userId: z.uuid() }),
    response: z.object({ revokedGrantCount: z.number().int().min(0) }),
  }),
} as const;
export type McpInternal = typeof mcpInternal;
