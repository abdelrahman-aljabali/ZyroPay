import type { Context } from "hono";
import type { Ctx } from "../deps";
import { timingSafeEqualString } from "../lib/crypto";
import { AppError } from "../lib/errors";
import type { UserPrincipal } from "../services/sessions";
import { authenticateAccessToken } from "../services/sessions";
import type { AppEnv } from "./context";

function bearer(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/.exec(header);
  return match?.[1] ?? null;
}

/** App session (opaque access token). */
export async function requireUser(c: Context<AppEnv>, ctx: Ctx): Promise<UserPrincipal> {
  const token = bearer(c);
  if (token === null) throw new AppError("UNAUTHENTICATED", "missing bearer token");
  const principal = await authenticateAccessToken(ctx, token);
  if (principal === null) throw new AppError("UNAUTHENTICATED", "invalid or expired session");
  return principal;
}

/**
 * MCP -> API: only INTERNAL_SERVICE_TOKEN (current or previous, for rotation), compared in
 * constant time. No token configured => every internal call is refused (fail closed).
 * Agent status is re-checked per call by the handlers (loadActiveAgent).
 */
export function requireInternal(c: Context<AppEnv>, ctx: Ctx): void {
  const token = bearer(c);
  const tokens = ctx.deps.config.internalTokens;
  let ok = false;
  for (const expected of tokens) {
    // Evaluate every candidate (no early exit) to keep timing independent of which matched.
    if (token !== null && timingSafeEqualString(token, expected)) ok = true;
  }
  if (!ok) throw new AppError("UNAUTHENTICATED", "invalid service token");
}
