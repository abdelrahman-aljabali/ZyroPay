/*
 * Helpers shared by the local-development scripts (dev.mjs, dev-setup.mjs, local-db.mjs).
 * Node built-ins only; nothing here is used at runtime by any service.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Local Postgres for development (Docker). Override the port with ZYROPAY_DEV_PG_PORT. */
export const LOCAL_PG = {
  container: "zyropay-dev-pg",
  volume: "zyropay-dev-pg",
  port: Number(process.env.ZYROPAY_DEV_PG_PORT ?? 55432),
  get url() {
    return `postgres://zyropay:zyropay@127.0.0.1:${String(this.port)}/zyropay`;
  },
};

/** Minimal KEY=value parser (comments, blank lines, optional quotes). */
export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

export function dockerAvailable() {
  return docker(["info", "--format", "{{.ServerVersion}}"]).status === 0;
}

/** Start (or reuse) the dev Postgres container; resolves once it accepts connections. */
export async function ensureLocalPostgres(log = console.log) {
  if (!dockerAvailable())
    throw new Error("Docker is not running. Start it, or point DATABASE_URL at any Postgres.");
  const state = docker(["inspect", "-f", "{{.State.Running}}", LOCAL_PG.container]);
  if (state.status === 0 && state.stdout.trim() === "true") return LOCAL_PG.url;
  if (state.status === 0) {
    log(`starting existing container ${LOCAL_PG.container}`);
    docker(["start", LOCAL_PG.container]);
  } else {
    log(
      `creating container ${LOCAL_PG.container} (postgres:17, 127.0.0.1:${String(LOCAL_PG.port)})`,
    );
    const run = docker([
      "run",
      "-d",
      "--name",
      LOCAL_PG.container,
      "-e",
      "POSTGRES_USER=zyropay",
      "-e",
      "POSTGRES_PASSWORD=zyropay",
      "-e",
      "POSTGRES_DB=zyropay",
      "-v",
      `${LOCAL_PG.volume}:/var/lib/postgresql/data`,
      "-p",
      `127.0.0.1:${String(LOCAL_PG.port)}:5432`,
      "postgres:17",
    ]);
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  }
  for (let i = 0; i < 60; i++) {
    if (docker(["exec", LOCAL_PG.container, "pg_isready", "-U", "zyropay"]).status === 0)
      return LOCAL_PG.url;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("local Postgres did not become ready");
}

/** Apply every pending migration with drizzle-kit (the same tool used against Neon). */
export function migrate(databaseUrl) {
  const res = spawnSync("pnpm", ["--filter", "@zyropay/db", "db:migrate"], {
    cwd: ROOT,
    // Both set: drizzle.config prefers DATABASE_URL_UNPOOLED; an inherited one would win.
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl },
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`migrations failed:\n${res.stdout}\n${res.stderr}`);
}
