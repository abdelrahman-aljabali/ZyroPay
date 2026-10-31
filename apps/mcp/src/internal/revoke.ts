import type { AuditSink } from "../audit";
import { EMPTY_AUDIT } from "../audit";
import { internalContracts } from "../contracts/internal";
import type { Env } from "../env";
import { timingSafeEqualStrings } from "../security/crypto";
import { jsonError } from "../security/limits";

/**
 * POST /internal/v1/agents/:agentId/revoke-grants  (API -> MCP, proposed contract)
 *
 * Called by the API when the user disconnects an agent in the app. Revokes every OAuth
 * grant (and so every access and refresh token) that maps to that agent. Independently of
 * this push, the API refuses every internal call for a revoked agent and the MCP worker
 * then revokes the grant itself, so revocation holds even if this call is lost.
 */
export const REVOKE_PATH = /^\/internal\/v1\/agents\/([^/]+)\/revoke-grants$/;

async function isInternalCaller(request: Request, env: Env): Promise<boolean> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  const presented = match?.[1];
  if (!presented) return false;
  const candidates = [env.INTERNAL_SERVICE_TOKEN, env.INTERNAL_SERVICE_TOKEN_PREVIOUS].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  let ok = false;
  for (const candidate of candidates) {
    // Evaluate all candidates (no early exit) to keep timing uniform.
    if (await timingSafeEqualStrings(presented, candidate)) ok = true;
  }
  return ok;
}

export async function handleRevokeGrants(
  request: Request,
  env: Env,
  agentIdRaw: string,
  audit: AuditSink,
): Promise<Response> {
  if (request.method !== "POST")
    return jsonError(405, "BAD_REQUEST", "method not allowed", { Allow: "POST" });
  if (!(await isInternalCaller(request, env)))
    return jsonError(401, "UNAUTHENTICATED", "unauthenticated");

  const contract = internalContracts.mcpRevokeAgentGrants;
  const params = contract.params.safeParse({ agentId: decodeURIComponent(agentIdRaw) });
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return jsonError(400, "BAD_REQUEST", "invalid JSON");
  }
  const body = contract.body.safeParse(bodyJson);
  if (!params.success || !body.success)
    return jsonError(422, "VALIDATION_FAILED", "invalid request");

  const { agentId } = params.data;
  const { userId } = body.data;
  const oauth = env.OAUTH_PROVIDER;
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(
      userId,
      cursor ? { cursor, limit: 1000 } : { limit: 1000 },
    );
    for (const grant of page.items) {
      const metadata = grant.metadata as { agentId?: unknown } | null | undefined;
      if (metadata?.agentId === agentId) {
        await oauth.revokeGrant(grant.id, userId);
        revoked++;
      }
    }
    cursor = page.cursor;
  } while (cursor);

  audit.record({
    ...EMPTY_AUDIT,
    type: "oauth.grant_revoked",
    userId,
    agentId,
    outcome: "revoked",
  });
  return Response.json(contract.response.parse({ revokedGrantCount: revoked }));
}
