import { createApp } from "./app";
import type { Env } from "./config";
import { loadConfig } from "./config";
import { escrowRuntime } from "./escrow/runtime";
import { sweep } from "./escrow/sweeper";

// Workers hand the same `env` object to every request of an isolate: build the app (and its
// x402 resource server, initialised once against the facilitator) once per env.
const apps = new WeakMap<Env, ReturnType<typeof createApp>>();

/** Cron (wrangler.jsonc `triggers.crons`): submit pending results, withdraw, authorize refunds. */
export async function runEscrowSweep(env: Env): Promise<void> {
  const config = loadConfig(env);
  if (!config.ok) return;
  const rt = escrowRuntime(env, config.config);
  if (!rt.enabled) return;
  const entries = await sweep(rt.sweepDeps());
  for (const e of entries) {
    if (e.action !== null || e.error !== undefined)
      console.log(
        `[seller] sweep ${e.escrow} ${e.state ?? "-"} ${e.action ?? "-"}: ${e.txHash ?? e.error ?? e.reason ?? ""}`,
      );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    let app = apps.get(env);
    if (app === undefined) {
      app = createApp(env);
      apps.set(env, app);
    }
    return app.fetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runEscrowSweep(env));
  },
} satisfies ExportedHandler<Env>;
