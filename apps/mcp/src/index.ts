/**
 * ZyroPay remote MCP server. Owner: MCP engineer.
 * Rules (docs/ARCHITECTURE.md): this worker NEVER signs and never touches the database.
 * Every tool call goes to the API's /internal/v1/* endpoints with INTERNAL_SERVICE_TOKEN.
 * Tool schemas come from `mcpTools` in @zyropay/shared. See docs/MCP.md.
 *
 *   /.well-known/oauth-protected-resource/mcp   RFC 9728 (provider)
 *   /.well-known/oauth-authorization-server     RFC 8414 (provider)
 *   /oauth/register                             RFC 7591 DCR (provider; CIMD preferred)
 *   /oauth/token                                code + refresh (rotating) + RFC 7009 revocation (provider)
 *   /authorize, /authorize/status               device-code-style consent (this app)
 *   /mcp                                        Streamable HTTP, bearer token bound to resource
 *   /internal/v1/agents/:id/revoke-grants       API -> MCP revocation push
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";
import { createApiClient } from "./api/factory";
import { auditForwarder, createAuditSink } from "./audit";
import type { AuditSink } from "./audit";
import type { Config, Env } from "./env";
import { ConfigError, loadConfig } from "./env";
import { handleRevokeGrants, REVOKE_PATH } from "./internal/revoke";
import { sentryOptions } from "./sentry";
import { createMcpApiHandler } from "./mcp/handler";
import {
  handleAuthorizeFinish,
  handleAuthorizeStart,
  handleAuthorizeStatus,
} from "./oauth/authorize";
import { REQUIRED_SCOPES, SCOPES_SUPPORTED } from "./oauth/scopes";
import { AUTHORIZE_PATH, MCP_PATH, REGISTER_PATH, TOKEN_PATH } from "./routes";
import {
  checkRateLimit,
  enforceBodyLimit,
  isOriginAllowed,
  jsonError,
  MAX_FORM_BODY_BYTES,
  MAX_MCP_BODY_BYTES,
} from "./security/limits";

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const REFRESH_TOKEN_IDLE_TTL_SECONDS = 7 * 24 * 3600;
const DCR_CLIENT_TTL_SECONDS = 90 * 24 * 3600;

function auditFor(env: Env, ctx: ExecutionContext, config: Config): AuditSink {
  let forward;
  if (config.auditSink === "api") {
    if (env.API_INTERNAL_URL) {
      forward = auditForwarder((r) => fetch(r), env.API_INTERNAL_URL, env.INTERNAL_SERVICE_TOKEN);
    } else if (env.API) {
      const binding = env.API;
      forward = auditForwarder(
        (r) => binding.fetch(r),
        "https://zyropay-api.internal",
        env.INTERNAL_SERVICE_TOKEN,
      );
    }
  }
  return createAuditSink({
    mode: config.auditSink,
    waitUntil: (p) => {
      ctx.waitUntil(p);
    },
    ...(forward ? { forward } : {}),
  });
}

/** Non-API routes: authorize UI, internal revocation push, health. Runs inside the provider. */
const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(request.url);
    const audit = auditFor(env, ctx, config);

    const revoke = REVOKE_PATH.exec(url.pathname);
    if (revoke?.[1]) return handleRevokeGrants(request, env, revoke[1], audit);

    const deps = { env, config, api: createApiClient(env), audit };
    if (url.pathname === AUTHORIZE_PATH) {
      if (request.method === "GET") return handleAuthorizeStart(request, deps);
      if (request.method === "POST") return handleAuthorizeFinish(request, deps);
      return jsonError(405, "BAD_REQUEST", "method not allowed", { Allow: "GET, POST" });
    }
    if (url.pathname === `${AUTHORIZE_PATH}/status` && request.method === "GET") {
      return handleAuthorizeStatus(request, deps);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "mcp", mode: config.mode });
    }
    return jsonError(404, "NOT_FOUND", "not found");
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(config: Config): OAuthProvider<Env> {
  const key = `${config.publicOrigin}|${config.accessTokenTtlSeconds}`;
  let provider = providers.get(key);
  if (provider) return provider;
  provider = new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler: createMcpApiHandler((env, ctx) => auditFor(env, ctx, loadConfig(env))),
    defaultHandler,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    accessTokenTTL: config.accessTokenTtlSeconds,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SECONDS,
    clientRegistrationTTL: DCR_CLIENT_TTL_SECONDS,
    scopesSupported: SCOPES_SUPPORTED,
    requiredScopes: REQUIRED_SCOPES,
    resourceMetadata: {
      resource: config.resource,
      authorization_servers: [config.publicOrigin],
      bearer_methods_supported: ["header"],
      resource_name: "ZyroPay",
    },
    clientIdMetadataDocumentEnabled: true,
    onError: ({ code, status, internal }) => {
      // Never log request bodies or tokens: only the error class and the internal reason.
      console.warn(JSON.stringify({ oauthError: { code, status, reason: internal.reason } }));
    },
  });
  providers.set(key, provider);
  return provider;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let config: Config;
    try {
      config = loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(JSON.stringify({ configError: error.message }));
        return jsonError(500, "INTERNAL_ERROR", "server misconfigured");
      }
      throw error;
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const isMcp = path === MCP_PATH || path.startsWith(`${MCP_PATH}/`);

    if (isMcp) {
      // Streamable HTTP: an Origin that is present and not allowed MUST get 403.
      if (
        !isOriginAllowed(
          request.headers.get("Origin"),
          config.allowedOrigins,
          config.mode === "development",
        )
      ) {
        return jsonError(403, "FORBIDDEN", "origin not allowed");
      }
    } else if (path === AUTHORIZE_PATH) {
      // Browser-facing: per end-user IP.
      const limited = await checkRateLimit(env.AUTH_RATE_LIMITER, `authorize:${clientIp(request)}`);
      if (limited) return limited;
    } else if (path === TOKEN_PATH || path === REGISTER_PATH) {
      // Called from MCP clients' backends, which share egress IPs across all their users
      // (e.g. Claude: 160.79.104.0/21), so this is an abuse ceiling, not a per-user limit.
      const limited = await checkRateLimit(
        env.OAUTH_ENDPOINT_RATE_LIMITER,
        `oauth:${clientIp(request)}`,
      );
      if (limited) return limited;
    }
    // /authorize/status is not IP-limited: it needs a valid HMAC ticket and is polled every 2 s.

    const sized = await enforceBodyLimit(request, isMcp ? MAX_MCP_BODY_BYTES : MAX_FORM_BODY_BYTES);
    if (sized instanceof Response) return sized;

    return providerFor(config).fetch(sized, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/** Sentry wraps fetch; disabled when SENTRY_DSN_MCP is unset (docs/MONITORING.md). */
export default Sentry.withSentry((env: Env) => sentryOptions(env.SENTRY_DSN_MCP, env), handler);
