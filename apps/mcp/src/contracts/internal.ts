/*
 * Service-to-service contracts, now owned by @zyropay/shared (src/api/internal.ts and the
 * `internalRecordAuditEvent` entry of src/api/ext.ts):
 *  - `mcpRevokeAgentGrants` is SERVED by this worker (the API calls it on agent revoke).
 *  - `internalRecordAuditEvent` is CALLED by this worker only when MCP_AUDIT_SINK=api;
 *    by default audit events are written to the Workers log (structured JSON).
 */
import { apiExt, mcpInternal } from "@zyropay/shared";

export { AuditEventSchema } from "@zyropay/shared";
export type { AuditEvent, AuditEventType } from "@zyropay/shared";

export const internalContracts = {
  mcpRevokeAgentGrants: mcpInternal.mcpRevokeAgentGrants,
  internalRecordAuditEvent: apiExt.internalRecordAuditEvent,
} as const;
