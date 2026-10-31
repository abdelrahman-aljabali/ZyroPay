#!/usr/bin/env node
/*
 * Local development Postgres in Docker.
 *   pnpm db:local          start (or reuse) it and apply every migration
 *   pnpm db:local down     stop it (data is kept in the zyropay-dev-pg volume)
 *   pnpm db:local reset    delete container and volume
 */
import { spawnSync } from "node:child_process";
import { ensureLocalPostgres, LOCAL_PG, migrate } from "./local-env.mjs";

const command = process.argv[2] ?? "up";
if (command === "down") {
  spawnSync("docker", ["stop", LOCAL_PG.container], { stdio: "inherit" });
} else if (command === "reset") {
  spawnSync("docker", ["rm", "-f", LOCAL_PG.container], { stdio: "inherit" });
  spawnSync("docker", ["volume", "rm", LOCAL_PG.volume], { stdio: "inherit" });
} else {
  const url = await ensureLocalPostgres();
  migrate(url);
  console.log(`local Postgres ready, migrations applied.\nDATABASE_URL=${url}\nDATABASE_DRIVER=pg`);
}
