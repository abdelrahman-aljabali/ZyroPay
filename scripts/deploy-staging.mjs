#!/usr/bin/env node
/*
 * `pnpm deploy:staging`: redeploy the whole STAGING stack, the testnet deployment on
 * zyropay.online (docs/DEPLOY.md §6).
 *
 *   1. migrations on the Neon project `zyropay-online` (direct URL from the `neon` CLI, never
 *      .env.local);
 *   2. API worker, then MCP worker (`wrangler deploy --env staging`);
 *   3. web app: build with the staging public values, then deploy the static assets.
 *
 *   pnpm deploy:staging                  # everything
 *   pnpm deploy:staging --skip-migrate   # code only
 *   pnpm deploy:staging --only web       # one of: api, mcp, web
 *
 * Staging only: there is deliberately no production counterpart here. Secrets are already on the
 * workers (`wrangler secret put --env staging`); this script never reads or prints them. The
 * Turnkey ids for the web build are public (they ship in the bundle) and come from the
 * environment or .env.local's EXPO_PUBLIC_TURNKEY_*.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readEnvFile, ROOT } from "./local-env.mjs";

const NEON_PROJECT = "icy-hill-73941166"; // zyropay-online
const NEON_BRANCH = "main";
const STAGING = {
  api: "https://api.zyropay.online",
  mcp: "https://mcp.zyropay.online",
  web: "https://app.zyropay.online",
};
/** Passkey rpId: the registrable domain, so passkeys work on app., the landing page and beyond. */
const PASSKEY_RP_ID = "zyropay.online";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
if (only !== null && !["api", "mcp", "web"].includes(only)) {
  console.error("usage: deploy-staging.mjs [--skip-migrate] [--only api|mcp|web]");
  process.exit(1);
}
const want = (part) => only === null || only === part;

function run(label, cmd, cmdArgs, env = {}) {
  console.log(`\n== ${label}`);
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(`${label} failed (exit ${String(res.status)})`);
    process.exit(res.status ?? 1);
  }
}

if (only === null && !args.includes("--skip-migrate")) {
  console.log(`\n== migrations on Neon branch "${NEON_BRANCH}"`);
  const cs = spawnSync("neon", ["connection-string", NEON_BRANCH, "--project-id", NEON_PROJECT], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const direct = (cs.stdout ?? "").trim();
  if (cs.status !== 0 || !direct.startsWith("postgres")) {
    console.error("could not get the staging connection string (`neon auth`?)");
    process.exit(1);
  }
  // db-migrate.mjs lets the process environment override .env.local (the production branch).
  run("pnpm db:migrate (staging)", "pnpm", ["db:migrate"], { DATABASE_URL_UNPOOLED: direct });
}

if (want("api")) run("API", "pnpm", ["--filter", "@zyropay/api", "deploy:staging"]);
if (want("mcp")) run("MCP", "pnpm", ["--filter", "@zyropay/mcp", "deploy:staging"]);

if (want("web")) {
  const local = readEnvFile(join(ROOT, ".env.local"));
  const fromEnv = (k) => process.env[k] || local[k] || "";
  run(
    "web build",
    "pnpm",
    ["--filter", "@zyropay/web-host", "build:web", "--", "--env", "staging"],
    {
      EXPO_PUBLIC_API_URL: STAGING.api,
      EXPO_PUBLIC_MCP_URL: `${STAGING.mcp}/mcp`,
      EXPO_PUBLIC_PASSKEY_RP_ID: PASSKEY_RP_ID,
      EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: fromEnv("EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID"),
      EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: fromEnv("EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID"),
    },
  );
  run("web deploy", "pnpm", ["--filter", "@zyropay/web-host", "deploy:staging"]);
}

console.log(
  `\nstaging deployed:\n  web ${STAGING.web}\n  api ${STAGING.api}/health\n  mcp ${STAGING.mcp}/health`,
);
