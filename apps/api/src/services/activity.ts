/*
 * Read models for the app: an agent's activity feed and asset price history.
 */
import type {
  AgentActivityItem,
  AssetId,
  PriceHistory,
  PriceRange,
  TxRequestState,
} from "@zyropay/shared";
import { networksForMode, parseAssetId } from "@zyropay/shared";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../deps";
import * as t from "../db/tables";
import { AppError } from "../lib/errors";
import { loadOwnedAgent } from "./agents";
import { toTransactionRequest } from "./mappers";

/** Cursor = `<createdAt ISO>|<id>` of the last item (newest first; ties broken by id). */
const CursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = CursorSchema.safeParse(cursor.split("|"));
  if (!parsed.success) throw new AppError("BAD_REQUEST", "invalid cursor");
  return { createdAt: new Date(parsed.data[0]), id: parsed.data[1] };
}

export async function listAgentRequests(
  ctx: Ctx,
  userId: string,
  agentId: string,
  query: { state?: TxRequestState | undefined; limit: number; cursor?: string | undefined },
): Promise<{ items: AgentActivityItem[]; nextCursor: string | null }> {
  // Ownership first: another user's agent is NOT_FOUND, exactly like an unknown id.
  await loadOwnedAgent(ctx, userId, agentId);
  const conditions = [
    eq(t.transactionRequests.agentId, agentId),
    eq(t.transactionRequests.userId, userId),
  ];
  if (query.state !== undefined) conditions.push(eq(t.transactionRequests.state, query.state));
  if (query.cursor !== undefined) {
    const c = decodeCursor(query.cursor);
    const older = or(
      lt(t.transactionRequests.createdAt, c.createdAt),
      and(eq(t.transactionRequests.createdAt, c.createdAt), lt(t.transactionRequests.id, c.id)),
    );
    if (older !== undefined) conditions.push(older);
  }
  const rows = await ctx.deps.db
    .select()
    .from(t.transactionRequests)
    .where(and(...conditions))
    .orderBy(desc(t.transactionRequests.createdAt), desc(t.transactionRequests.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const approvals =
    page.length === 0
      ? []
      : await ctx.deps.db
          .select({
            id: t.approvalRequests.id,
            requestId: t.approvalRequests.transactionRequestId,
          })
          .from(t.approvalRequests)
          .where(
            inArray(
              t.approvalRequests.transactionRequestId,
              page.map((r) => r.id),
            ),
          );
  const approvalOf = new Map(approvals.map((a) => [a.requestId, a.id]));
  const last = page[page.length - 1];
  return {
    items: page.map((row) => {
      const approvalId = approvalOf.get(row.id) ?? null;
      return {
        request: toTransactionRequest(row),
        approvalId,
        // Executed without asking: the policy allowed it outright (autonomous, within limits).
        autonomous: approvalId === null && row.policyDecision === "allow",
      };
    }),
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? `${last.createdAt.toISOString()}|${last.id}`
        : null,
  };
}

export async function getPriceHistory(
  ctx: Ctx,
  input: { assetId: AssetId; range: PriceRange; currency: string },
): Promise<PriceHistory> {
  const { network } = parseAssetId(input.assetId);
  if (!networksForMode(ctx.deps.config.mode).includes(network))
    throw new AppError("NETWORK_MODE_MISMATCH", `${network} is not available in this mode`);
  const base = {
    assetId: input.assetId,
    currency: input.currency,
    range: input.range,
  };
  let result;
  try {
    result = await ctx.deps.priceHistory.getPriceHistory(input);
  } catch (error) {
    // The port promises not to throw; if an adapter does anyway, fail closed.
    ctx.deps.logger.warn("price_history.failed", { error });
    return { status: "unavailable", ...base, reason: "PROVIDER_UNAVAILABLE", simulated: false };
  }
  if (result.status === "unavailable")
    return {
      status: "unavailable",
      ...base,
      reason: result.reason,
      simulated: ctx.deps.config.useMocks,
    };
  // A simulated series is only acceptable while mock adapters are on (never in real mode).
  if (result.simulated && !ctx.deps.config.useMocks)
    return { status: "unavailable", ...base, reason: "PROVIDER_UNAVAILABLE", simulated: false };
  return {
    status: "available",
    ...base,
    points: [...result.points],
    source: result.source,
    simulated: result.simulated,
  };
}
