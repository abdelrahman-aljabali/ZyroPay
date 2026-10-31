/*
 * Fixed-window rate limiting backed by Postgres (rate_limit_counters). One atomic
 * INSERT … ON CONFLICT DO UPDATE … RETURNING per request, so it is exact across isolates
 * and works identically under `wrangler dev`, PGlite tests and production. (The Workers
 * rate-limit binding is per-location and approximate; it can be layered in front later.)
 */
import { sql } from "drizzle-orm";
import type { RateLimitRule } from "../env";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/errors";

export async function enforceRateLimit(
  ctx: Ctx,
  bucket: string,
  subject: string,
  rule: RateLimitRule,
): Promise<void> {
  const now = ctx.deps.clock.now().getTime();
  const windowStart = new Date(now - (now % (rule.windowSeconds * 1000)));
  // Subjects may be IPs: store a hash, never the raw value.
  const key = `${bucket}:${sha256Hex(`${ctx.deps.config.auditIpSalt}:${subject}`).slice(0, 32)}`;
  const [row] = await ctx.deps.db
    .insert(t.rateLimitCounters)
    .values({ bucketKey: key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [t.rateLimitCounters.bucketKey, t.rateLimitCounters.windowStart],
      set: { count: sql`${t.rateLimitCounters.count} + 1` },
    })
    .returning({ count: t.rateLimitCounters.count });
  if (row !== undefined && row.count > rule.limit) {
    const retryAfter = Math.ceil((windowStart.getTime() + rule.windowSeconds * 1000 - now) / 1000);
    throw new AppError("RATE_LIMITED", "too many requests", { retryAfterSeconds: retryAfter });
  }
}
