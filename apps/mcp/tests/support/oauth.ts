/** Raw OAuth helpers for negative-path tests (no SDK in the way). */
import { createHash, randomBytes } from "node:crypto";
import type { Harness } from "./harness";
import { openAuthorize, REDIRECT_URI, submitConsent } from "./harness";
import type { ConsentPage } from "./harness";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function registerClient(
  h: Harness,
  metadata: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown>; clientId: string }> {
  const res = await fetch(`${h.origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Raw Test Client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...metadata,
    }),
  });
  const body = await res.json<Record<string, unknown>>();
  return {
    status: res.status,
    body,
    clientId: typeof body.client_id === "string" ? body.client_id : "",
  };
}

export function authorizeUrl(h: Harness, params: Record<string, string | undefined>): string {
  const url = new URL(`${h.origin}/authorize`);
  const defaults: Record<string, string> = {
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    state: "state-123",
    scope: "wallet:read payments:request offline_access",
    resource: h.mcpUrl,
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function tokenRequest(
  h: Harness,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Registers a client, runs the consent with approval, and returns an unexchanged code. */
export async function approvedCode(h: Harness): Promise<{
  clientId: string;
  verifier: string;
  code: string;
  page: ConsentPage;
  agentId: string;
}> {
  const { clientId } = await registerClient(h);
  const { verifier, challenge } = pkcePair();
  const page = await openAuthorize(
    authorizeUrl(h, { client_id: clientId, code_challenge: challenge }),
  );
  if (page.status !== 200) throw new Error(`authorize ${page.status}: ${page.html.slice(0, 200)}`);
  const agent = h.api.approve(page.userCode);
  const res = await submitConsent(h.origin, page);
  const location = res.headers.get("Location") ?? "";
  const code = new URL(location).searchParams.get("code") ?? "";
  return { clientId, verifier, code, page, agentId: agent.id };
}

export async function exchange(
  h: Harness,
  args: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri?: string;
    resource?: string;
  },
) {
  return tokenRequest(h, {
    grant_type: "authorization_code",
    client_id: args.clientId,
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: args.redirectUri ?? REDIRECT_URI,
    resource: args.resource ?? h.mcpUrl,
  });
}

/** Minimal JSON-RPC tools/call over Streamable HTTP with a raw bearer token. */
export async function rawMcp(
  h: Harness,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(h.mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export const LIST_TOOLS = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
