/**
 * ZyroPay API worker (Cloudflare Workers, Hono). Owner: API engineer.
 * fetch     -> REST API (contracts in @zyropay/shared `api` + ext proposal)
 * queue     -> async stages (signing/broadcast, confirmations, push, webhook processing)
 * scheduled -> expiry sweeper + straggler re-polls (cron)
 */
import * as Sentry from "@sentry/cloudflare";
import { apiError } from "@zyropay/shared";
import { createApp } from "./app";
import type { Env } from "./env";
import { ConfigError } from "./env";
import { sentryOptions } from "./lib/sentry";
import type { BuiltDeps } from "./providers";
import { buildDeps, loadRuntimeConfig } from "./providers";
import type { QueueMessage } from "./queue/messages";
import { consumeBatch } from "./queue/consumer";
import { sweep } from "./services/execution";

const perRequest = new WeakMap<Request, { env: Env; built: BuiltDeps | null }>();

const app = createApp({
  deps: (request) => {
    const slot = perRequest.get(request);
    if (slot === undefined) throw new Error("request context missing");
    slot.built ??= buildDeps({ env: slot.env });
    return slot.built.deps;
  },
  health: (env) => {
    const config = loadRuntimeConfig(env);
    return { mode: config.mode, mocks: config.useMocks };
  },
});

/**
 * Refuse to serve a misconfigured deployment (fail closed): production with mocks, or real
 * adapters without their credentials. Logged once per isolate with the missing names.
 */
const configProblems = new WeakMap<object, string | null>();
function configProblem(env: Env): string | null {
  const cached = configProblems.get(env);
  if (cached !== undefined) return cached;
  let problem: string | null = null;
  try {
    loadRuntimeConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problem = error.message;
    console.error(
      JSON.stringify({ level: "fatal", msg: "api.refusing_to_start", reason: problem }),
    );
  }
  configProblems.set(env, problem);
  return problem;
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (configProblem(env) !== null && new URL(request.url).pathname !== "/health") {
      return Response.json(apiError("INTERNAL_ERROR", "service is misconfigured"), {
        status: 503,
      });
    }
    const slot: { env: Env; built: BuiltDeps | null } = { env, built: null };
    perRequest.set(request, slot);
    try {
      return await app.fetch(request, env, ctx);
    } finally {
      if (slot.built !== null) ctx.waitUntil(slot.built.dispose());
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const built = buildDeps({ env });
    try {
      await consumeBatch(built.deps, batch.messages);
    } finally {
      ctx.waitUntil(built.dispose());
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const built = buildDeps({ env });
    try {
      const result = await sweep(built.deps);
      built.deps.logger.info("cron.sweep", result);
    } finally {
      ctx.waitUntil(built.dispose());
    }
  },
} satisfies ExportedHandler<Env, QueueMessage>;

/** Sentry wraps fetch, queue and scheduled; disabled when SENTRY_DSN_API is unset. */
export default Sentry.withSentry((env: Env) => sentryOptions(env.SENTRY_DSN_API, env), handler);
