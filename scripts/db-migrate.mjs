#!/usr/bin/env node
/*
 * `pnpm db:migrate`: apply pending Drizzle migrations to the Neon database configured by
 * `neon env pull` (.env.local, or .env). Uses the direct connection DATABASE_URL_UNPOOLED:
 * migrations must not go through Neon's pooled (PgBouncer, transaction-mode) endpoint.
 */
import { join } from "node:path";
import { migrate, readEnvFile, ROOT } from "./local-env.mjs";

const env = {
  ...readEnvFile(join(ROOT, ".env")),
  ...readEnvFile(join(ROOT, ".env.local")),
  ...process.env,
};
const direct = env.DATABASE_URL_UNPOOLED ?? "";
if (direct === "") {
  console.error("DATABASE_URL_UNPOOLED is not set. Run `neon env pull` (or set it in .env).");
  process.exit(1);
}
if (new URL(direct).hostname.split(".")[0]?.endsWith("-pooler")) {
  console.error("DATABASE_URL_UNPOOLED points at a -pooler host; migrations need the direct one.");
  process.exit(1);
}
console.log(`applying migrations to ${new URL(direct).hostname}${new URL(direct).pathname}`);
migrate(direct);
console.log("migrations applied");
