import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ZyroPayModeSchema } from "@zyropay/shared";
import type { ZyroPayMode } from "@zyropay/shared";
import { z } from "zod";
import { isLoopbackHttpOrigin } from "./mcp/x402";

/**
 * Bindings and variables of the MCP worker. Secrets ([S]) come from `wrangler secret put`
 * (or `.dev.vars` locally); see `.env.example`. This worker has NO database URL and NO
 * Turnkey credential: its only credential toward ZyroPay is INTERNAL_SERVICE_TOKEN.
 */
export interface Env {
  ZYROPAY_MODE: string;
  /** Public origin of this worker, e.g. https://mcp.zyropay.com (OAuth issuer + resource). */
  MCP_PUBLIC_URL: string;
  /** [S] Bearer for /internal/v1/* on the API, and for the API's calls into this worker. */
  INTERNAL_SERVICE_TOKEN: string;
  /** [S] Previous internal token, accepted inbound during rotation. */
  INTERNAL_SERVICE_TOKEN_PREVIOUS?: string;
  /** [S] HMAC key for the authorize page's poll ticket (>= 32 chars). */
  MCP_OAUTH_COOKIE_SECRET: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string;
  /**
   * Base URL of the API for internal calls when there is no service binding (local dev,
   * tests). In deployed workers leave it unset and use the `API` service binding.
   */
  API_INTERNAL_URL?: string;
  /** Service binding to the zyropay-api worker (production path). */
  API?: Fetcher;
  /** Extra browser origins allowed to call /mcp (comma-separated). */
  MCP_ALLOWED_ORIGINS?: string;
  /** "log" (default) or "api": also forward audit events to the API (proposed contract). */
  MCP_AUDIT_SINK?: string;
  OAUTH_KV: KVNamespace;
  /** Per-access-token limiter for /mcp. */
  MCP_RATE_LIMITER?: RateLimit;
  /** Per-IP limiter for the browser-facing /authorize. */
  AUTH_RATE_LIMITER?: RateLimit;
  /** Per-IP abuse ceiling for /oauth/token and /oauth/register (shared client egress IPs). */
  OAUTH_ENDPOINT_RATE_LIMITER?: RateLimit;
  /** Injected by OAuthProvider before our handlers run. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Error monitoring (docs/MONITORING.md). Unset = Sentry off. */
  SENTRY_DSN_MCP?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  /**
   * TEST ONLY: loopback http origin that receives every x402 resource fetch (e2e tests).
   * Refused in production mode and for any non-loopback value. Never set it when deployed.
   */
  MCP_X402_TEST_UPSTREAM?: string;
}

/** Validated runtime configuration derived from Env. Fails closed on missing secrets. */
export interface Config {
  readonly mode: ZyroPayMode;
  /** Origin without trailing slash, e.g. https://mcp.zyropay.com */
  readonly publicOrigin: string;
  /** Canonical MCP resource URI (RFC 8707 / RFC 9728): `${publicOrigin}/mcp`. */
  readonly resource: string;
  readonly accessTokenTtlSeconds: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly auditSink: "log" | "api";
}

const MIN_SECRET_LENGTH = 32;

export class ConfigError extends Error {}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Origins of the hosted MCP clients we document (they connect server-side, but some UIs use fetch). */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
  "https://grok.com",
];

export function loadConfig(env: Env): Config {
  const mode = ZyroPayModeSchema.safeParse(env.ZYROPAY_MODE);
  if (!mode.success) throw new ConfigError("ZYROPAY_MODE must be development or production");

  let url: URL;
  try {
    url = new URL(env.MCP_PUBLIC_URL);
  } catch {
    throw new ConfigError("MCP_PUBLIC_URL must be an absolute URL");
  }
  const loopback = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new ConfigError("MCP_PUBLIC_URL must be https (http only on loopback)");
  }
  if (mode.data === "production" && url.protocol !== "https:") {
    throw new ConfigError("MCP_PUBLIC_URL must be https in production");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError("MCP_PUBLIC_URL must be a bare origin");
  }
  if (!env.INTERNAL_SERVICE_TOKEN || env.INTERNAL_SERVICE_TOKEN.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`INTERNAL_SERVICE_TOKEN must be set (>= ${MIN_SECRET_LENGTH} chars)`);
  }
  if (!env.MCP_OAUTH_COOKIE_SECRET || env.MCP_OAUTH_COOKIE_SECRET.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`MCP_OAUTH_COOKIE_SECRET must be set (>= ${MIN_SECRET_LENGTH} chars)`);
  }
  if (!env.API && !env.API_INTERNAL_URL) {
    throw new ConfigError("either the API service binding or API_INTERNAL_URL is required");
  }
  if (mode.data === "production" && env.API_INTERNAL_URL) {
    const api = new URL(env.API_INTERNAL_URL);
    if (api.protocol !== "https:")
      throw new ConfigError("API_INTERNAL_URL must be https in production");
  }

  if (env.MCP_X402_TEST_UPSTREAM) {
    if (mode.data === "production" || !isLoopbackHttpOrigin(env.MCP_X402_TEST_UPSTREAM)) {
      throw new ConfigError(
        "MCP_X402_TEST_UPSTREAM is test-only: a loopback http origin, never in production",
      );
    }
  }

  const ttl = z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900)
    .safeParse(env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS || undefined);
  if (!ttl.success) throw new ConfigError("MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS must be 60..3600");

  const origin = url.origin;
  const allowedOrigins = new Set<string>([origin, ...DEFAULT_ALLOWED_ORIGINS]);
  for (const extra of (env.MCP_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) allowedOrigins.add(trimmed);
  }

  return {
    mode: mode.data,
    publicOrigin: origin,
    resource: `${origin}/mcp`,
    accessTokenTtlSeconds: ttl.data,
    allowedOrigins,
    auditSink: env.MCP_AUDIT_SINK === "api" ? "api" : "log",
  };
}
