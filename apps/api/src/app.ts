import * as Sentry from "@sentry/cloudflare";
import type { EndpointContract } from "@zyropay/shared";
import { apiError } from "@zyropay/shared";
import { Hono } from "hono";
import { api, apiExt, apiWallets } from "./contracts";
import type { AppDeps } from "./deps";
import type { Env } from "./env";
import { ConfigError } from "./env";
import type { AppEnv } from "./http/context";
import { extHandlers, handlers, walletHandlers } from "./http/handlers";
import type { Handler } from "./http/route";
import { bind } from "./http/route";
import { toErrorResponse } from "./lib/errors";

export interface CreateAppOptions {
  /** Resolve dependencies for a request (lazily: /health never touches the DB). */
  readonly deps: (request: Request, env: Env) => AppDeps;
  /** Health metadata; throws when the configuration is invalid. */
  readonly health: (env: Env) => { mode: string; mocks: boolean };
}

function newRequestId(): string {
  return crypto.randomUUID();
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Correlation id + security headers on every response.
  app.use("*", async (c, next) => {
    const incoming = c.req.header("cf-ray");
    c.set(
      "requestId",
      incoming !== undefined && /^[A-Za-z0-9-]{1,64}$/.test(incoming) ? incoming : newRequestId(),
    );
    await next();
    c.header("X-Request-Id", c.get("requestId"));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  });

  app.get("/health", (c) => {
    try {
      const h = options.health(c.env);
      return c.json({ ok: true, service: "api", mode: h.mode, mocks: h.mocks });
    } catch (error) {
      // A ConfigError names what is missing (variable names only, never values).
      const reason = error instanceof ConfigError ? error.message : undefined;
      return c.json({ ok: false, service: "api", error: "misconfigured", reason }, 503);
    }
  });

  // CORS lockdown: the native app sends no Origin. Browser origins must be allow-listed,
  // and internal + webhook routes never answer cross-origin requests.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin === undefined) return next();
    const deps = options.deps(c.req.raw, c.env);
    const path = c.req.path;
    const corsEligible = path.startsWith("/v1/") && !path.startsWith("/v1/webhooks/");
    const allowed = corsEligible && deps.config.corsAllowedOrigins.includes(origin);
    if (c.req.method === "OPTIONS") {
      if (!allowed) return c.json(apiError("FORBIDDEN", "origin not allowed"), 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE");
      c.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }
    if (!allowed) return c.json(apiError("FORBIDDEN", "origin not allowed"), 403);
    await next();
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  });

  app.use("*", async (c, next) => {
    const deps = options.deps(c.req.raw, c.env);
    c.set("ctx", {
      deps,
      requestId: c.get("requestId"),
      ip: c.req.header("cf-connecting-ip") ?? null,
    });
    await next();
  });

  const register = <A extends Record<string, EndpointContract>>(
    contracts: A,
    impl: { [N in keyof A]: Handler<A[N]> },
  ) => {
    for (const name of Object.keys(contracts) as (keyof A & string)[]) {
      bind(app, contracts[name] as EndpointContract, impl[name] as Handler<EndpointContract>);
    }
  };
  register(api, handlers);
  register(apiExt, extHandlers);
  register(apiWallets, walletHandlers);

  app.notFound((c) => c.json(apiError("NOT_FOUND", "route not found"), 404));

  app.onError((error, c) => {
    const { status, body, expected } = toErrorResponse(error);
    const ctx = c.get("ctx") as AppEnv["Variables"]["ctx"] | undefined;
    if (!expected) {
      // Unexpected failures only; the event is scrubbed in beforeSend (lib/sentry.ts).
      Sentry.captureException(error);
      ctx?.deps.logger.error("request.failed", {
        requestId: c.get("requestId"),
        path: c.req.path,
        error,
      });
    }
    if (body.error.code === "RATE_LIMITED") {
      const retry = body.error.details?.retryAfterSeconds;
      if (typeof retry === "number") c.header("Retry-After", String(retry));
    }
    return c.json(body, status as 400);
  });

  return app;
}
