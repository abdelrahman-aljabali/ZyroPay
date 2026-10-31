#!/usr/bin/env node
/*
 * `pnpm dev`: the API and MCP workers (wrangler dev) plus the Expo dev server, together.
 *
 * Which backend the app talks to is decided from what is configured:
 *
 *  1. Local stack secrets exist (apps/api/.dev.vars with DATABASE_URL and
 *     INTERNAL_SERVICE_TOKEN, apps/mcp/.dev.vars with the same token; `pnpm dev:setup`
 *     writes them): the app uses the LOCAL API, no mock transport.
 *       - Turnkey configured on both sides (api TURNKEY_ORGANIZATION_ID and the app's
 *         EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID / _AUTH_PROXY_CONFIG_ID / EXPO_PUBLIC_PASSKEY_RP_ID):
 *         real passkeys (needs a development build).
 *       - Turnkey on neither side: the API runs MockTurnkey and the app signs with the
 *         development `dev-*` passkey stand-in (works in Expo Go). Testnets only.
 *  2. Otherwise: the app runs on the in-app mock transport (EXPO_PUBLIC_USE_MOCKS=1) and the
 *     workers are not started (they cannot run without their secrets).
 *
 * `pnpm dev --web`: REAL mode in the browser (PWA). The API runs with mocks off against the
 * configured database (Neon), real Turnkey (parent-org API key) and real Helius / Alchemy /
 * Blockfrost (testnets only: ZYROPAY_MODE stays development), CORS open to the web origin;
 * Expo serves the web app on http://localhost:8081 with real browser passkeys via the Turnkey
 * Auth Proxy (EXPO_PUBLIC_PASSKEY_RP_ID=localhost). Credentials come from apps/api/.dev.vars
 * plus, for any key that is empty there, the git-ignored repo-root .env.local; they are merged
 * into apps/api/.dev.vars.web (git-ignored, mode 600, regenerated on every run) and handed to
 * wrangler with --env-file, so apps/api/.dev.vars itself (and the Expo Go flow) is unchanged.
 *
 * Flags: --mocks (force the mock transport), --no-mobile, --localhost (bind the API to
 * localhost and point the app there: simulators only; the default uses your LAN address so
 * a phone can reach it), --tunnel (public Expo URL, for VPNs or isolated Wi-Fi), --dev-client
 * (force development-build mode; the default is Expo Go unless real passkeys are configured).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureLocalPostgres,
  lanAddress,
  LOCAL_PG,
  migrate,
  readEnvFile,
  ROOT,
} from "./local-env.mjs";

const args = new Set(process.argv.slice(2));
const COLORS = { api: "\x1b[36m", mcp: "\x1b[35m", web: "\x1b[32m", dev: "\x1b[33m" };
const say = (msg) => process.stdout.write(`${COLORS.dev}[dev]\x1b[0m ${msg}\n`);

const apiVars = readEnvFile(join(ROOT, "apps/api/.dev.vars"));
const mcpVars = readEnvFile(join(ROOT, "apps/mcp/.dev.vars"));
const appVars = {
  ...readEnvFile(join(ROOT, ".env")),
  ...readEnvFile(join(ROOT, "apps/mobile/.env")),
  ...readEnvFile(join(ROOT, "apps/mobile/.env.local")),
  ...process.env,
};
const set = (v) => typeof v === "string" && v !== "";

const missing = [];
if (!set(apiVars.DATABASE_URL)) missing.push("apps/api/.dev.vars DATABASE_URL");
if (!set(apiVars.INTERNAL_SERVICE_TOKEN)) missing.push("apps/api/.dev.vars INTERNAL_SERVICE_TOKEN");
if (!set(mcpVars.INTERNAL_SERVICE_TOKEN)) missing.push("apps/mcp/.dev.vars INTERNAL_SERVICE_TOKEN");
if (!set(mcpVars.MCP_OAUTH_COOKIE_SECRET))
  missing.push("apps/mcp/.dev.vars MCP_OAUTH_COOKIE_SECRET");
if (
  set(apiVars.INTERNAL_SERVICE_TOKEN) &&
  set(mcpVars.INTERNAL_SERVICE_TOKEN) &&
  apiVars.INTERNAL_SERVICE_TOKEN !== mcpVars.INTERNAL_SERVICE_TOKEN
)
  missing.push("the same INTERNAL_SERVICE_TOKEN in both .dev.vars");
const localStack = missing.length === 0 && !args.has("--mocks");
const web = args.has("--web");
if (web && args.has("--mocks")) {
  say("--web runs real mode; use `pnpm dev --mocks` for the mock transport");
  process.exit(1);
}
if (web && !localStack) {
  say(`--web needs the local stack secrets (${missing.join("; ")}). Run \`pnpm dev:setup\` first.`);
  process.exit(1);
}

const children = [];
function run(name, command, argv, options) {
  const child = spawn(command, argv, { cwd: ROOT, ...options });
  children.push(child);
  const prefix = `${COLORS[name] ?? ""}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream?.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n"))
        if (line !== "") out.write(prefix + line + "\n");
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    say(`${name} exited (${String(code)})`);
    shutdown(code ?? 0);
  });
  return child;
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const mobileEnv = { ...process.env, EXPO_PUBLIC_ZYROPAY_MODE: "development" };

/** Real-mode web: the browser origin, the rpId it implies, and the API's env file. */
// ZYROPAY_WEB_PORT moves the web server (e.g. when Expo Go's dev server already holds 8081);
// the origin must then also be in the Turnkey Auth Proxy's allowed origins.
const WEB_PORT = process.env.ZYROPAY_WEB_PORT ?? "8081";
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const WEB_RP_ID = "localhost";
const WEB_ENV_FILE = join(ROOT, "apps/api/.dev.vars.web");
/** Secrets taken from the repo-root .env.local when apps/api/.dev.vars leaves them empty. */
const REAL_KEYS = [
  "DATABASE_URL",
  "TURNKEY_ORGANIZATION_ID",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "HELIUS_API_KEY",
  "HELIUS_API_KEY_SECONDARY",
  "HELIUS_API_KEYS",
  "ALCHEMY_API_KEY",
  "BLOCKFROST_PROJECT_ID_PREPROD",
  "COINGECKO_API_KEY",
];

function startWeb() {
  const rootLocal = readEnvFile(join(ROOT, ".env.local"));
  const merged = { ...apiVars };
  const filled = [];
  for (const key of REAL_KEYS) {
    if (!set(merged[key]) && set(rootLocal[key])) {
      merged[key] = rootLocal[key];
      filled.push(key);
    }
  }
  const required = [
    "DATABASE_URL",
    "TURNKEY_ORGANIZATION_ID",
    "TURNKEY_API_PUBLIC_KEY",
    "TURNKEY_API_PRIVATE_KEY",
    "ALCHEMY_API_KEY",
  ].filter((k) => !set(merged[k]));
  if (!set(merged.HELIUS_API_KEY) && !set(merged.HELIUS_API_KEY_SECONDARY)) {
    required.push("HELIUS_API_KEY");
  }
  if (required.length > 0) {
    say(`--web: missing ${required.join(", ")} (apps/api/.dev.vars or .env.local)`);
    process.exit(1);
  }
  // Real adapters, testnets only (ZYROPAY_MODE=development), browser origin allowed.
  Object.assign(merged, {
    ZYROPAY_MODE: "development",
    ZYROPAY_USE_MOCK_ADAPTERS: "false",
    CORS_ALLOWED_ORIGINS: WEB_ORIGIN,
  });
  if (merged.DATABASE_DRIVER !== "pg") merged.DATABASE_DRIVER = "neon";
  const lines = [
    "# GENERATED by `pnpm dev --web` on every run (scripts/dev.mjs). Do not edit; git-ignored.",
    "# apps/api/.dev.vars, with empty secrets filled from the repo-root .env.local.",
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(WEB_ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  // Names only, never values.
  say(
    `real mode: mocks off, Turnkey + Helius + Alchemy${set(merged.BLOCKFROST_PROJECT_ID_PREPROD) ? " + Blockfrost preprod" : " (no Cardano: BLOCKFROST_PROJECT_ID_PREPROD unset)"}, CORS ${WEB_ORIGIN}`,
  );
  if (filled.length > 0) say(`from .env.local: ${filled.join(", ")}`);

  const org =
    appVars.EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID ??
    rootLocal.EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID ??
    merged.TURNKEY_ORGANIZATION_ID;
  const proxy =
    appVars.EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID ??
    rootLocal.EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID ??
    rootLocal.TURNKEY_AUTH_PROXY_CONFIG_ID;
  if (!set(proxy)) {
    say("--web: set EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID (Turnkey dashboard -> Auth Proxy)");
    process.exit(1);
  }
  if (org !== merged.TURNKEY_ORGANIZATION_ID) {
    say("--web: EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID must be the API's TURNKEY_ORGANIZATION_ID");
    process.exit(1);
  }

  run(
    "api",
    "pnpm",
    [
      "--filter",
      "@zyropay/api",
      "exec",
      "wrangler",
      "dev",
      "--env-file",
      WEB_ENV_FILE,
      "--inspector-port",
      "9229",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  run(
    "mcp",
    "pnpm",
    ["--filter", "@zyropay/mcp", "exec", "wrangler", "dev", "--inspector-port", "9230"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  say(`API http://localhost:8787  MCP http://localhost:8788/mcp  web ${WEB_ORIGIN}`);
  if (args.has("--no-mobile")) return;
  run(
    "web",
    "pnpm",
    ["--filter", "@zyropay/mobile", "exec", "expo", "start", "--web", "--port", WEB_PORT],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        EXPO_PUBLIC_ZYROPAY_MODE: "development",
        EXPO_PUBLIC_USE_MOCKS: "0",
        EXPO_PUBLIC_DEV_PASSKEY: "",
        EXPO_PUBLIC_API_URL: "http://localhost:8787",
        EXPO_PUBLIC_MCP_URL: "http://localhost:8788/mcp",
        EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: org,
        EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: proxy,
        EXPO_PUBLIC_PASSKEY_RP_ID: WEB_RP_ID,
        BROWSER: "none",
      },
    },
  );
}

if (web) {
  startWeb();
} else if (localStack) {
  const host = args.has("--localhost") ? "localhost" : (lanAddress() ?? "localhost");
  if (apiVars.DATABASE_DRIVER === "pg" && apiVars.DATABASE_URL === LOCAL_PG.url) {
    say("local Postgres (Docker): starting if needed and applying migrations");
    await ensureLocalPostgres(say);
    migrate(LOCAL_PG.url);
  }
  const bind = host === "localhost" ? [] : ["--ip", "0.0.0.0"];
  // Distinct inspector ports: two wrangler dev sessions would both default to 9229.
  run(
    "api",
    "pnpm",
    ["--filter", "@zyropay/api", "exec", "wrangler", "dev", "--inspector-port", "9229", ...bind],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  run(
    "mcp",
    "pnpm",
    ["--filter", "@zyropay/mcp", "exec", "wrangler", "dev", "--inspector-port", "9230"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const apiTurnkey = set(apiVars.TURNKEY_ORGANIZATION_ID);
  const appTurnkey =
    set(appVars.EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID) &&
    set(appVars.EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID) &&
    set(appVars.EXPO_PUBLIC_PASSKEY_RP_ID);
  Object.assign(mobileEnv, {
    EXPO_PUBLIC_USE_MOCKS: "0",
    EXPO_PUBLIC_API_URL: appVars.EXPO_PUBLIC_API_URL ?? `http://${host}:8787`,
    EXPO_PUBLIC_MCP_URL: appVars.EXPO_PUBLIC_MCP_URL ?? "http://localhost:8788/mcp",
  });
  if (apiTurnkey && appTurnkey) {
    say("app -> local API with real Turnkey passkeys (use a development build, not Expo Go)");
  } else if (!apiTurnkey) {
    if (appTurnkey)
      say(
        "the API has no Turnkey credentials (MockTurnkey): ignoring the app's EXPO_PUBLIC_TURNKEY_*",
      );
    say("app -> local API with the development dev-* passkey (MockTurnkey; Expo Go works)");
    Object.assign(mobileEnv, {
      EXPO_PUBLIC_DEV_PASSKEY: "mock-turnkey",
      EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: "",
      EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: "",
      EXPO_PUBLIC_PASSKEY_RP_ID: "",
    });
  } else {
    say(
      "the API uses real Turnkey but the app has no EXPO_PUBLIC_TURNKEY_* settings: the app\n" +
        "      cannot sign in to it, so it runs on the mock transport. Set them in apps/mobile/.env.",
    );
    mobileEnv.EXPO_PUBLIC_USE_MOCKS = "1";
  }
  say(`API http://${host}:8787  MCP http://localhost:8788/mcp`);
} else {
  if (!args.has("--mocks"))
    say(
      `local stack not configured (${missing.join("; ")}).\n      Run \`pnpm dev:setup\` to create local secrets. Starting the app on the mock transport.`,
    );
  else say("--mocks: the app runs on the in-app mock transport; workers not started");
  mobileEnv.EXPO_PUBLIC_USE_MOCKS = "1";
}

if (web) {
  // started above
} else if (!args.has("--no-mobile")) {
  // expo-dev-client is installed, so `expo start` would target a development build by default
  // and Expo Go could not open the QR code. Use Expo Go unless real passkeys need the dev build.
  const devBuild =
    args.has("--dev-client") ||
    (localStack &&
      mobileEnv.EXPO_PUBLIC_USE_MOCKS === "0" &&
      mobileEnv.EXPO_PUBLIC_DEV_PASSKEY === undefined);
  const expoArgs = [devBuild ? "--dev-client" : "--go"];
  // --tunnel: reach the dev server through a public URL (VPNs and isolated Wi-Fi block LAN access).
  if (args.has("--tunnel")) expoArgs.push("--tunnel");
  say(devBuild ? "Expo: development build mode" : "Expo: Expo Go mode");
  // Expo keeps its interactive terminal UI (QR code, key shortcuts).
  run("mobile", "pnpm", ["--filter", "@zyropay/mobile", "start", ...expoArgs], {
    stdio: "inherit",
    env: mobileEnv,
  });
} else if (children.length === 0) {
  say("nothing to start");
}
