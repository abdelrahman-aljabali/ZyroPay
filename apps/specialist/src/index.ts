import type { Env } from "./app";
import { createApp } from "./app";

// One app (and x402 resource server, initialised once) per env object, as in apps/seller.
const apps = new WeakMap<Env, ReturnType<typeof createApp>>();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    let app = apps.get(env);
    if (app === undefined) {
      app = createApp(env);
      apps.set(env, app);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
