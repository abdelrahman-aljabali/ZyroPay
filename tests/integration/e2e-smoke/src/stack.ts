/*
 * Local stack for the smoke test: a fresh Postgres database with every migration applied
 * (drizzle-kit, the same tool used against Neon), then the API and MCP workers under
 * `wrangler dev` on free ports with throwaway secrets. Nothing is written into the repo
 * (state and env files live in a temp directory) and everything is torn down at the end.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

export function log(message: string): void {
  process.stdout.write(`[smoke] ${message}\n`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export interface Stack {
  /** Directory with api.log / mcp.log (kept when the smoke fails). */
  readonly logDir: string;
  readonly apiUrl: string;
  readonly mcpOrigin: string;
  readonly internalToken: string;
  readonly logs: { api: string; mcp: string };
  stop(keepLogs?: boolean): Promise<void>;
}

interface Cleanup {
  (): Promise<void> | void;
}

/** Admin URL of a Postgres the smoke may CREATE DATABASE on: SMOKE_DATABASE_URL or Docker. */
async function adminDatabase(cleanups: Cleanup[]): Promise<string> {
  const given = process.env.SMOKE_DATABASE_URL;
  if (given !== undefined && given !== "") {
    log("using SMOKE_DATABASE_URL");
    return given;
  }
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  });
  if (docker.status !== 0)
    throw new Error(
      "No database: set SMOKE_DATABASE_URL (a Postgres role with CREATEDB) or start Docker.",
    );
  const port = await freePort();
  const name = `zyropay-smoke-pg-${randomBytes(3).toString("hex")}`;
  log(`starting Postgres 17 in Docker (${name}, 127.0.0.1:${String(port)})`);
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=smoke",
      "-e",
      "POSTGRES_USER=smoke",
      "-e",
      "POSTGRES_DB=smoke",
      "-p",
      `127.0.0.1:${String(port)}:5432`,
      "postgres:17",
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  cleanups.push(() => {
    spawnSync("docker", ["stop", name], { encoding: "utf8" });
  });
  const url = `postgres://smoke:smoke@127.0.0.1:${String(port)}/smoke`;
  await waitFor(
    "Postgres",
    async () => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.end();
      return true;
    },
    60_000,
  );
  return url;
}

function startWorker(
  app: "api" | "mcp",
  envFile: string,
  port: number,
  stateDir: string,
  logFile: string,
): { child: ChildProcess; output: () => string } {
  let output = "";
  const inspector = String(port + 1000 > 65_000 ? port - 1000 : port + 1000);
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--env-file",
      envFile,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      inspector,
      "--persist-to",
      stateDir,
      "--show-interactive-dev-session=false",
      ...(app === "api" ? ["--test-scheduled"] : []),
    ],
    {
      cwd: join(REPO, "apps", app),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const append = (chunk: Buffer) => {
    appendFileSync(logFile, chunk);
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, output: () => output };
}

export async function startStack(): Promise<Stack> {
  const cleanups: Cleanup[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "zyropay-smoke-"));
  const logDir = mkdtempSync(join(tmpdir(), "zyropay-smoke-logs-"));
  const stop = async (keepLogs = false) => {
    for (const c of cleanups.reverse()) await c();
    rmSync(tmp, { recursive: true, force: true });
    if (!keepLogs) rmSync(logDir, { recursive: true, force: true });
  };
  try {
    // --- database -----------------------------------------------------------------------
    const admin = await adminDatabase(cleanups);
    const dbName = `zyropay_smoke_${Date.now().toString()}`;
    const adminClient = new pg.Client({ connectionString: admin });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${dbName}`);
    await adminClient.end();
    cleanups.push(async () => {
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    });
    const dbUrl = new URL(admin);
    dbUrl.pathname = `/${dbName}`;
    // SMOKE_DATABASE_DRIVER=neon runs the API on the production driver (@neondatabase/serverless)
    // instead of node-postgres. Migrations keep the direct URL; the worker gets the pooled
    // endpoint (`-pooler` host), which is what Neon recommends for application traffic.
    const driver = process.env.SMOKE_DATABASE_DRIVER === "neon" ? "neon" : "pg";
    const appDbUrl = new URL(dbUrl.toString());
    if (driver === "neon") {
      const [endpoint, ...rest] = appDbUrl.hostname.split(".");
      if (endpoint !== undefined && !endpoint.endsWith("-pooler") && rest.includes("neon"))
        appDbUrl.hostname = [`${endpoint}-pooler`, ...rest].join(".");
    }
    log(`API database driver: ${driver}`);
    log(`created database ${dbName}; applying migrations with drizzle-kit`);
    const migrate = spawnSync("pnpm", ["--filter", "@zyropay/db", "db:migrate"], {
      cwd: REPO,
      // Both set: drizzle.config prefers DATABASE_URL_UNPOOLED, and an inherited one would
      // point the migration at the wrong database.
      env: {
        ...process.env,
        DATABASE_URL: dbUrl.toString(),
        DATABASE_URL_UNPOOLED: dbUrl.toString(),
      },
      encoding: "utf8",
    });
    if (migrate.status !== 0)
      throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);

    // --- workers ------------------------------------------------------------------------
    const [apiPort, mcpPort] = [await freePort(), await freePort()];
    const apiUrl = `http://127.0.0.1:${String(apiPort)}`;
    const mcpOrigin = `http://127.0.0.1:${String(mcpPort)}`;
    const internalToken = randomBytes(32).toString("hex");
    const apiEnv = join(tmp, "api.env");
    const mcpEnv = join(tmp, "mcp.env");
    writeFileSync(
      apiEnv,
      [
        "ZYROPAY_MODE=development",
        "ZYROPAY_USE_MOCK_ADAPTERS=true",
        `DATABASE_URL=${appDbUrl.toString()}`,
        `DATABASE_DRIVER=${driver}`,
        `API_PUBLIC_URL=${apiUrl}`,
        `INTERNAL_SERVICE_TOKEN=${internalToken}`,
        `DELEGATED_KEY_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
        `AUDIT_IP_HASH_SALT=${randomBytes(16).toString("hex")}`,
        `MCP_INTERNAL_URL=${mcpOrigin}`,
        // Turnkey left empty on purpose: development mode then uses MockTurnkey (dev-* ids).
        "TURNKEY_ORGANIZATION_ID=",
        "",
      ].join("\n"),
    );
    writeFileSync(
      mcpEnv,
      [
        "ZYROPAY_MODE=development",
        `MCP_PUBLIC_URL=${mcpOrigin}`,
        `API_INTERNAL_URL=${apiUrl}`,
        `INTERNAL_SERVICE_TOKEN=${internalToken}`,
        `MCP_OAUTH_COOKIE_SECRET=${randomBytes(32).toString("hex")}`,
        "",
      ].join("\n"),
    );
    log(`starting API (${apiUrl}) and MCP (${mcpOrigin}) with wrangler dev`);
    const api = startWorker(
      "api",
      apiEnv,
      apiPort,
      join(tmp, "api-state"),
      join(logDir, "api.log"),
    );
    const mcp = startWorker(
      "mcp",
      mcpEnv,
      mcpPort,
      join(tmp, "mcp-state"),
      join(logDir, "mcp.log"),
    );
    const kill = (child: ChildProcess) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => {
          resolve();
        });
        child.kill("SIGINT");
        setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000).unref();
      });
    cleanups.push(() => kill(api.child));
    cleanups.push(() => kill(mcp.child));
    const healthy = (url: string) => async () => (await fetch(url)).ok;
    try {
      await waitFor("API /health", healthy(`${apiUrl}/health`), 120_000);
      await waitFor(
        "MCP metadata",
        healthy(`${mcpOrigin}/.well-known/oauth-authorization-server`),
        120_000,
      );
    } catch (error) {
      log(`API output:\n${api.output().slice(-3000)}`);
      log(`MCP output:\n${mcp.output().slice(-3000)}`);
      throw error;
    }
    return {
      logDir,
      apiUrl,
      mcpOrigin,
      internalToken,
      get logs() {
        return { api: api.output(), mcp: mcp.output() };
      },
      stop,
    };
  } catch (error) {
    log(`worker logs kept in ${logDir}`);
    await stop(true);
    throw error;
  }
}
