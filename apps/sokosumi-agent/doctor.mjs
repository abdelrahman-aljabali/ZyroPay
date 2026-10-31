// `pnpm --filter @zyropay/sokosumi-agent run doctor` (`run` is required: `pnpm doctor` is a
// pnpm built-in): one preflight for the whole Sokosumi + Masumi
// path. Read-only: it runs CLI read commands and HTTP GETs, never creates, imports or spends.
//
//   doctor              local + Sokosumi account + Masumi (if infrastructure/masumi/.env exists)
//   doctor --offline    local checks only (same as `npm start`)
//
// Each line is ok / warn / FAIL with the exact next command. Exit code 1 if any FAIL.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { CLI_VERSION, preflight } from "./start.mjs";
import { isPaidReady } from "./paid-task.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MASUMI_ENV = resolve(here, "../../infrastructure/masumi/.env");
const DEFAULT_WORKER_URL = "https://masumi-agent.zyropay.online";

function parseCliJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} io  injected for tests
 * @param {(args:string[])=>string} io.cli      runs `sokosumi --preprod <args> --json`, throws on failure
 * @param {(url:string, init?:object)=>Promise<Response>} io.fetch
 * @param {(cmd:string, args:string[])=>string} io.exec   other binaries (docker)
 */
export async function doctor({
  env,
  masumiEnv = null,
  offline = false,
  nodeVersion = process.versions.node,
  cliVersion,
  paidReady = false,
  envFileMode = null,
  io,
}) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });

  add("head", "Local");
  for (const c of preflight(env, { nodeVersion, cliVersion, paidReady }).checks)
    add(c.ok ? "ok" : c.required ? "fail" : "warn", c.text);
  if (envFileMode !== null && (envFileMode & 0o077) !== 0)
    add("warn", ".env is readable by other users: chmod 600 .env");
  if (offline) return checks;

  const key = env.BLOCKFROST_API_KEY_PREPROD?.trim();
  if (key) {
    const base = env.BLOCKFROST_BASE_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0";
    const r = await io
      .fetch(`${base}/blocks/latest`, { headers: { project_id: key } })
      .catch(() => null);
    if (r?.ok) add("ok", "Blockfrost preprod key works");
    else
      add(
        "fail",
        `Blockfrost rejected the key (${r ? `HTTP ${r.status}` : "unreachable"}): use a PREPROD project id from https://blockfrost.io`,
      );
  }

  add("head", "Sokosumi (preprod)");
  if (cliVersion !== CLI_VERSION) {
    add(
      "fail",
      `skipped: install the CLI first (npm install --prefix apps/sokosumi-agent/.local/cli @masumi_network/sokosumi@${CLI_VERSION}, then put its node_modules/.bin on PATH: NEXT_STEPS.md step 1)`,
    );
  } else {
    let signedIn = false;
    try {
      const me = parseCliJson(io.cli(["auth", "whoami"]));
      signedIn = Boolean(me?.user);
      if (signedIn)
        add("ok", `signed in as ${me.user.email ?? me.user.id} (${me.target ?? "preprod"})`);
      else add("fail", "not signed in: sokosumi --preprod auth login");
    } catch {
      add("fail", "not signed in: sokosumi --preprod auth login");
    }
    if (signedIn) {
      try {
        const vendors = parseCliJson(io.cli(["vendors", "me"]))?.vendors ?? [];
        add(
          vendors.length > 0 ? "ok" : "warn",
          vendors.length > 0
            ? `Vendor ${vendors[0].name ?? ""} [${vendors[0].id}] (role ${vendors[0].role ?? "?"})`
            : 'no Vendor yet: sokosumi --preprod vendors create --name "ZyroPay" --slug zyropay --json',
        );
      } catch {
        add(
          "warn",
          "no Vendor yet (or you are not in an organization): join the TUM Workspace, then vendors create",
        );
      }
      const coworkerId = env.COWORKER_ID?.trim();
      try {
        const owned =
          parseCliJson(io.cli(["coworkers", "list", "--scope", "owned"]))?.coworkers ?? [];
        const mine = owned.find((c) => c?.id === coworkerId);
        if (mine) add("ok", `Coworker ${coworkerId} is yours (${mine.name ?? "unnamed"})`);
        else if (coworkerId)
          add(
            "fail",
            `COWORKER_ID ${coworkerId} is not one of your Coworkers: check sokosumi --preprod coworkers list --scope owned --json`,
          );
        else add("fail", "register the Coworker (README step 2.5) and set COWORKER_ID in .env");
      } catch {
        add(
          "fail",
          "could not list your Coworkers: sokosumi --preprod coworkers list --scope owned --json",
        );
      }
      const orgId = env.SOKOSUMI_ORGANIZATION_ID?.trim();
      if (orgId) {
        try {
          const seat = parseCliJson(io.cli(["workspaces", "check", orgId]));
          add(
            seat?.taskSeatEligible ? "ok" : "fail",
            seat?.taskSeatEligible
              ? "TUM Workspace: your account may create Tasks"
              : "TUM Workspace: no Task Seat. Ask a Workspace admin to assign one",
          );
        } catch {
          add(
            "fail",
            `workspaces check ${orgId} failed: is SOKOSUMI_ORGANIZATION_ID the TUM organization id?`,
          );
        }
      } else {
        try {
          const personal = parseCliJson(io.cli(["workspaces", "list", "--personal"]));
          add(
            personal?.hasPersonalWorkspace ? "ok" : "fail",
            personal?.hasPersonalWorkspace
              ? "Personal Workspace exists (Task target)"
              : "no Personal Workspace: coworkers connect COWORKER_ID --vendor-id VENDOR_ID --personal --json",
          );
        } catch {
          add("warn", "could not read the Personal Workspace");
        }
      }
      add(
        "warn",
        "the runtime key import is checked when the worker starts (the doctor never reads the vault)",
      );
    }
  }

  add("head", "Masumi (paid path, optional)");
  if (!masumiEnv) {
    add(
      "warn",
      "infrastructure/masumi/.env not found: paid path not set up (infrastructure/masumi/README.md)",
    );
    return checks;
  }
  try {
    const ps = io.exec("docker", [
      "ps",
      "--filter",
      "name=zyropay-masumi",
      "--format",
      "{{.Names}} {{.Status}}",
    ]);
    const up = (name) => new RegExp(`${name} Up`, "u").test(ps);
    for (const name of [
      "zyropay-masumi-payment-service",
      "zyropay-masumi-gateway",
      "zyropay-masumi-tunnel",
    ])
      add(
        up(name) ? "ok" : "fail",
        up(name)
          ? `${name} running`
          : `${name} not running: cd infrastructure/masumi && docker compose up -d`,
      );
  } catch {
    add("fail", "docker is not running: start Docker Desktop");
  }
  const mpsUrl = (
    masumiEnv.MPS_URL?.trim() || `http://127.0.0.1:${masumiEnv.MPS_PORT?.trim() || "3001"}`
  ).replace(/\/+$/u, "");
  const health = await io.fetch(`${mpsUrl}/api/v1/health`).catch(() => null);
  add(
    health?.ok ? "ok" : "fail",
    health?.ok
      ? `Payment Service healthy at ${mpsUrl}`
      : `Payment Service not reachable at ${mpsUrl}`,
  );
  add(
    paidReady ? "ok" : "warn",
    paidReady
      ? "registration confirmed and runtime key saved (docs/registration-state.json, .local/mps-runtime.env)"
      : "not registered yet: pnpm --filter @zyropay/sokosumi-agent masumi:register",
  );
  if (env.PAID_TASKS_ENABLED === "true" && !paidReady)
    add(
      "fail",
      "PAID_TASKS_ENABLED=true but registration is not ready: set it to false or finish masumi:register",
    );
  if (masumiEnv.COLLECTION_WALLET_PREPROD_ADDRESS?.trim())
    add(
      "fail",
      "COLLECTION_WALLET_PREPROD_ADDRESS is set: paid Coworker Tasks refuse a sellerReturnAddress. Leave it blank",
    );
  const workerUrl = (masumiEnv.AGENT_API_BASE_URL?.trim() || DEFAULT_WORKER_URL).replace(
    /\/+$/u,
    "",
  );
  const availability = await io
    .fetch(`${workerUrl}/availability`, { redirect: "manual" })
    .then(async (r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (availability?.type !== "masumi-agent")
    add(
      "fail",
      `MIP-003 Worker not answering at ${workerUrl}: pnpm --filter @zyropay/sokosumi-agent mip003:deploy`,
    );
  else
    add(
      availability.status === "available" ? "ok" : "warn",
      `MIP-003 Worker ${workerUrl}: ${availability.status}${availability.message ? ` (${availability.message})` : ""}`,
    );
  return checks;
}

function installedCliVersion() {
  try {
    return execFileSync("sokosumi", ["--version"], { encoding: "utf8", timeout: 15000 })
      .trim()
      .match(/\d+\.\d+\.\d+/u)?.[0];
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const run = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const checks = await doctor({
    env: process.env,
    masumiEnv: existsSync(MASUMI_ENV) ? parseEnv(readFileSync(MASUMI_ENV, "utf8")) : null,
    offline: process.argv.includes("--offline"),
    cliVersion: installedCliVersion(),
    paidReady: isPaidReady(),
    envFileMode: existsSync(join(here, ".env")) ? statSync(join(here, ".env")).mode : null,
    io: {
      cli: (args) => run("sokosumi", ["--preprod", ...args, "--json"]),
      exec: run,
      fetch: (url, init = {}) => fetch(url, { signal: AbortSignal.timeout(15000), ...init }),
    },
  });
  let failed = 0;
  for (const c of checks) {
    if (c.level === "head") console.log(`\n== ${c.text}`);
    else
      console.log(`${c.level === "ok" ? "ok  " : c.level === "warn" ? "warn" : "FAIL"} ${c.text}`);
    if (c.level === "fail") failed++;
  }
  console.log(failed ? `\n${failed} FAIL line(s). Fix them in order, then rerun.` : "\nReady.");
  process.exitCode = failed ? 1 : 0;
}
