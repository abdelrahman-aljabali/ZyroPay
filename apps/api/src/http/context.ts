import type { Ctx } from "../deps";
import type { Env } from "../env";

export interface AppEnv {
  Bindings: Env;
  Variables: { ctx: Ctx; requestId: string };
}
