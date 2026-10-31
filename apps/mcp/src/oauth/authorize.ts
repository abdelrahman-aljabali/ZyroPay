import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { InternalApiClient } from "../api/client";
import type { AuditSink } from "../audit";
import { EMPTY_AUDIT } from "../audit";
import type { Config, Env } from "../env";
import { hmacSha256, randomNonce, sha256Hex, timingSafeEqualStrings } from "../security/crypto";
import { jsonError } from "../security/limits";
import { pageHeaders, renderMessagePage, renderWaitingPage } from "./page";
import { scopesToGrant } from "./scopes";
import type { GrantProps } from "./scopes";

/*
 * Device-code-style consent (docs/ARCHITECTURE.md §2.4):
 *   GET  /authorize          validate the OAuth request (client, exact redirect URI, PKCE
 *                            S256, resource), create a pending agent connection through the
 *                            API, show the user code; the page polls.
 *   GET  /authorize/status   poll ticket (HMAC-bound to the connection) -> {status}
 *   POST /authorize          the page's form (CSRF-safe: the provider's one-time handle is
 *                            bound to this browser by a __Host- cookie). Approved in the app
 *                            -> grant {userId, agentId}; rejected/expired -> access_denied.
 */

const CONSENT_KEY_PREFIX = "zyropay:consent:";

const PendingConsentSchema = z.object({
  connectionId: z.uuid(),
  userCode: z.string(),
  expiresAt: z.iso.datetime(),
  redirectUri: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  clientDomain: z.string().nullable(),
  redirectHost: z.string(),
  redirectIsLoopback: z.boolean(),
});
type PendingConsent = z.infer<typeof PendingConsentSchema>;

export interface AuthorizeDeps {
  readonly env: Env;
  readonly config: Config;
  readonly api: InternalApiClient;
  readonly audit: AuditSink;
}

/**
 * Adds the provider's consent headers (binding cookie, anti-framing) to ours: every
 * Set-Cookie is kept, other headers only fill gaps (our page policy is the stricter one).
 */
function mergeHeaders(ours: Headers, theirs?: Headers): Headers {
  if (!theirs) return ours;
  for (const cookie of theirs.getSetCookie()) ours.append("Set-Cookie", cookie);
  theirs.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" || ours.has(key)) return;
    ours.set(key, value);
  });
  return ours;
}

function htmlResponse(status: number, title: string, message: string): Response {
  const nonce = randomNonce();
  return new Response(renderMessagePage(nonce, title, message), {
    status,
    headers: pageHeaders(nonce),
  });
}

function redirect(location: string, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
}

function originOf(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function isUrl(value: string | undefined): value is string {
  return value !== undefined && z.url().safeParse(value).success;
}

/** Name shown in the app. CIMD clients get their verified domain, others are marked. */
function displayName(details: ConsentDescription): string {
  const base = details.clientName.trim() || details.clientId;
  const suffix = details.clientDomain ? ` · ${details.clientDomain}` : " (unverified)";
  return (base.slice(0, 128 - suffix.length) + suffix).slice(0, 128);
}

async function pollTicket(secret: string, connectionId: string): Promise<string> {
  return `${connectionId}.${await hmacSha256(secret, `poll:${connectionId}`)}`;
}

async function verifyTicket(secret: string, ticket: string): Promise<string | null> {
  const [connectionId, mac] = ticket.split(".");
  if (!connectionId || !mac || !z.uuid().safeParse(connectionId).success) return null;
  const expected = await hmacSha256(secret, `poll:${connectionId}`);
  return (await timingSafeEqualStrings(mac, expected)) ? connectionId : null;
}

function secondsUntil(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / 1000);
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return redirect(error.redirectTo);
  }
  if (error instanceof AuthorizationError) {
    return htmlResponse(400, "This sign-in request is invalid", error.description);
  }
  if (error instanceof CimdFetchError) {
    return htmlResponse(
      400,
      "This app could not be verified",
      "Its client metadata document could not be loaded.",
    );
  }
  throw error;
}

export async function handleAuthorizeStart(
  request: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  const oauth = deps.env.OAUTH_PROVIDER;
  let authRequest: AuthRequest;
  let details: ConsentDescription;
  try {
    authRequest = await oauth.parseAuthRequest(request);
    details = await oauth.describeConsent(authRequest);
  } catch (error) {
    return authErrorResponse(error);
  }

  // OAuth 2.1 + MCP: PKCE with S256 for EVERY client, confidential ones included.
  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== "S256") {
    return redirect(
      authorizationErrorRedirect(
        authRequest,
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required",
      ),
    );
  }

  const scopes = scopesToGrant(authRequest.scope);
  const created = await deps.api.call("internalCreateAgentConnection", {
    body: {
      oauthClientId: authRequest.clientId,
      clientName: displayName(details),
      clientUri: isUrl(details.clientUri) ? details.clientUri : null,
      redirectUri: authRequest.redirectUri,
      scopes,
    },
  });
  if (!created.ok) {
    console.warn(JSON.stringify({ authorizeStartFailed: created.error.code }));
    return htmlResponse(
      502,
      "ZyroPay is unavailable",
      "We could not start the connection. Please try again in a moment.",
    );
  }
  const connection = created.data.connection;
  const ttl = secondsUntil(connection.expiresAt);
  if (connection.status !== "pending" || ttl <= 0) {
    return htmlResponse(
      502,
      "ZyroPay is unavailable",
      "The connection could not be started. Please try again.",
    );
  }

  const consent = await oauth.beginConsent(authRequest);
  const pending: PendingConsent = {
    connectionId: connection.id,
    userCode: connection.userCode,
    expiresAt: connection.expiresAt,
    redirectUri: authRequest.redirectUri,
    clientId: authRequest.clientId,
    clientName: details.clientName,
    clientDomain: details.clientDomain ?? null,
    redirectHost: details.redirectHost,
    redirectIsLoopback: details.redirectIsLoopback,
  };
  await deps.env.OAUTH_KV.put(
    CONSENT_KEY_PREFIX + (await sha256Hex(consent.handle)),
    JSON.stringify(pending),
    { expirationTtl: Math.max(60, ttl) },
  );

  deps.audit.record({
    ...EMPTY_AUDIT,
    type: "oauth.connection_started",
    clientId: authRequest.clientId.slice(0, 512),
    connectionId: connection.id,
    outcome: "ok",
  });

  return waitingPage(deps, pending, consent.handle, consent.headers);
}

async function waitingPage(
  deps: AuthorizeDeps,
  pending: PendingConsent,
  handle: string,
  extraHeaders?: Headers,
): Promise<Response> {
  const nonce = randomNonce();
  const redirectOrigin = originOf(pending.redirectUri);
  const headers = mergeHeaders(
    pageHeaders(nonce, redirectOrigin ? [redirectOrigin] : []),
    extraHeaders,
  );
  const html = renderWaitingPage({
    nonce,
    clientName: pending.clientName,
    clientDomain: pending.clientDomain,
    redirectHost: pending.redirectHost,
    redirectIsLoopback: pending.redirectIsLoopback,
    userCode: pending.userCode,
    expiresAt: pending.expiresAt,
    handle,
    ticket: await pollTicket(deps.env.MCP_OAUTH_COOKIE_SECRET, pending.connectionId),
  });
  return new Response(html, { status: 200, headers });
}

export async function handleAuthorizeStatus(
  request: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
  const connectionId = await verifyTicket(deps.env.MCP_OAUTH_COOKIE_SECRET, ticket);
  if (!connectionId) return jsonError(400, "BAD_REQUEST", "invalid ticket");
  const result = await deps.api.call("internalGetAgentConnection", { params: { connectionId } });
  if (!result.ok) return jsonError(502, "UPSTREAM_UNAVAILABLE", "status unavailable");
  return new Response(JSON.stringify({ status: result.data.connection.status }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleAuthorizeFinish(
  request: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return htmlResponse(415, "Unsupported request", "Submit the form on the connection page.");
  }
  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string" || handle.length === 0 || handle.length > 512) {
    return htmlResponse(400, "This sign-in request is invalid", "The form was incomplete.");
  }

  const key = CONSENT_KEY_PREFIX + (await sha256Hex(handle));
  const stored = PendingConsentSchema.safeParse(await deps.env.OAUTH_KV.get(key, "json"));
  if (!stored.success) {
    return htmlResponse(
      400,
      "This connection page expired",
      "Start connecting again from your AI app.",
    );
  }
  const pending = stored.data;
  const oauth = deps.env.OAUTH_PROVIDER;

  const result = await deps.api.call("internalGetAgentConnection", {
    params: { connectionId: pending.connectionId },
  });
  if (!result.ok) {
    return htmlResponse(
      502,
      "ZyroPay is unavailable",
      "We could not check the connection. Please try again.",
    );
  }
  const { connection, userId } = result.data;
  const auditBase = {
    ...EMPTY_AUDIT,
    clientId: pending.clientId.slice(0, 512),
    connectionId: pending.connectionId,
  };

  try {
    switch (connection.status) {
      case "pending":
        return await waitingPage(deps, pending, handle);
      case "rejected": {
        const denied = await oauth.denyConsent(request, handle, {
          description: "The user declined the connection in the ZyroPay app.",
        });
        await deps.env.OAUTH_KV.delete(key);
        deps.audit.record({ ...auditBase, type: "oauth.grant_denied", outcome: "denied" });
        return redirect(denied.redirectTo, denied.headers);
      }
      case "expired": {
        const denied = await oauth.denyConsent(request, handle, {
          description: "The connection code expired before it was approved.",
        });
        await deps.env.OAUTH_KV.delete(key);
        deps.audit.record({ ...auditBase, type: "oauth.grant_expired", outcome: "expired" });
        return redirect(denied.redirectTo, denied.headers);
      }
      case "approved": {
        if (!userId || !connection.agentId || connection.redirectUri !== pending.redirectUri) {
          // Contract violation or tampering: never complete a grant on inconsistent data.
          console.error(JSON.stringify({ authorizeFinishInconsistent: pending.connectionId }));
          return htmlResponse(
            502,
            "ZyroPay is unavailable",
            "The connection could not be completed.",
          );
        }
        const approved = await oauth.approveConsent(request, handle, {
          scope: scopesToGrant(connection.scopes),
        });
        const props: GrantProps = {
          userId,
          agentId: connection.agentId,
          connectionId: connection.id,
        };
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId,
          metadata: { agentId: connection.agentId, connectionId: connection.id },
          scope: approved.request.scope,
          props,
          // Each grant is its own agent; never let a new connection silently revoke another.
          revokeExistingGrants: false,
        });
        await deps.env.OAUTH_KV.delete(key);
        deps.audit.record({
          ...auditBase,
          type: "oauth.grant_created",
          userId,
          agentId: connection.agentId,
          outcome: "ok",
        });
        return redirect(redirectTo, approved.headers);
      }
    }
  } catch (error) {
    if (error instanceof AuthorizationError && !error.redirectTo) {
      return htmlResponse(
        400,
        "This connection page expired",
        "It was already used, opened in another browser, or timed out. Start connecting again from your AI app.",
      );
    }
    return authErrorResponse(error);
  }
}
