import type { AuditEvent, JsonObject } from "@zyropay/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { sha256Hex } from "../lib/crypto";
import { redact } from "../lib/logger";

export type ActorType = "user" | "agent" | "system" | "mcp" | "webhook";

export interface AuditEntry {
  readonly actorType: ActorType;
  readonly actorId?: string | null;
  readonly userId?: string | null;
  /** Dotted verb, e.g. "session.created", "tx_request.approved". */
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  /** Never secrets, tokens, stamps or full payloads (redacted defensively anyway). */
  readonly metadata?: JsonObject;
}

/** Append an audit row. Pass `db` = the transaction when the action is transactional. */
export async function audit(ctx: Ctx, entry: AuditEntry, db: Db = ctx.deps.db): Promise<void> {
  await db.insert(t.auditLogs).values({
    id: ctx.deps.ids.newId(),
    occurredAt: ctx.deps.clock.now(),
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    userId: entry.userId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    requestId: ctx.requestId,
    ipHash: ctx.ip === null ? null : sha256Hex(`${ctx.deps.config.auditIpSalt}:${ctx.ip}`),
    metadata: redact(entry.metadata ?? {}, 0, true) as JsonObject,
  });
}

/**
 * MCP audit sink (`internalRecordAuditEvent`). The event carries ids, a tool name, an
 * outcome and an error code only. A user id is kept only when it names an existing user
 * that owns the given agent (if any), so the MCP worker cannot attach events to arbitrary
 * users' audit trails.
 */
export async function recordMcpAuditEvent(ctx: Ctx, event: AuditEvent): Promise<void> {
  let userId: string | null = null;
  if (event.userId !== null) {
    const conditions = [eq(t.users.id, event.userId)];
    const [owner] =
      event.agentId === null
        ? await ctx.deps.db
            .select({ id: t.users.id })
            .from(t.users)
            .where(and(...conditions))
        : await ctx.deps.db
            .select({ id: t.users.id })
            .from(t.users)
            .innerJoin(t.agents, eq(t.agents.userId, t.users.id))
            .where(and(...conditions, eq(t.agents.id, event.agentId)));
    userId = owner?.id ?? null;
  }
  const occurredAt = Date.parse(event.at);
  await audit(ctx, {
    actorType: "mcp",
    actorId: event.agentId ?? event.clientId,
    userId,
    action: `mcp.${event.type}`,
    targetType:
      event.requestId !== null ? "transaction_request" : event.agentId !== null ? "agent" : null,
    targetId: event.requestId ?? event.agentId,
    metadata: {
      outcome: event.outcome,
      tool: event.tool,
      errorCode: event.errorCode,
      connectionId: event.connectionId,
      clientId: event.clientId,
      idempotencyKey: event.idempotencyKey,
      durationMs: event.durationMs,
      reportedAt: Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : null,
      userIdUnverified: event.userId !== null && userId === null,
    },
  });
}
