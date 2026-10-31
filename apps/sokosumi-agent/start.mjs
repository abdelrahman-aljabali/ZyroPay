// `npm start`: local preflight. The template starts an Eve model server here; this Coworker
// needs none, so start only checks the setup and says what is missing. No network, no writes.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPaidReady } from "./paid-task.mjs";
import { taskTarget } from "./task-target.mjs";

export const CLI_VERSION = "1.1.0";

export function preflight(
  env,
  { nodeVersion = process.versions.node, cliVersion, paidReady = false },
) {
  const checks = [];
  const add = (ok, required, text) => checks.push({ ok, required, text });
  add(Number(nodeVersion.split(".")[0]) >= 24, true, `Node.js ${nodeVersion} (24 or newer)`);
  add(
    cliVersion === CLI_VERSION,
    true,
    cliVersion
      ? `Sokosumi CLI ${cliVersion} (pinned ${CLI_VERSION})`
      : `Sokosumi CLI not found: export PATH="$PWD/apps/sokosumi-agent/.local/cli/node_modules/.bin:$PATH" (NEXT_STEPS.md step 1; CLI ${CLI_VERSION})`,
  );
  try {
    const t = taskTarget(env);
    add(
      true,
      true,
      `COWORKER_ID set; Workspace: ${t.organizationId ? "organization (TUM)" : "Personal"}`,
    );
  } catch (error) {
    add(false, true, error.message);
  }
  add(
    Boolean(env.BLOCKFROST_API_KEY_PREPROD?.trim()),
    true,
    "BLOCKFROST_API_KEY_PREPROD set (report data source)",
  );
  const model = Boolean(
    env.ZAI_API_KEY?.trim() && env.ZAI_BASE_URL?.trim() && env.ZAI_MODEL?.trim(),
  );
  add(
    true,
    false,
    model
      ? "Optional summary model configured (ZAI_*)"
      : "No summary model (ZAI_* blank): reports only",
  );
  const paid = env.PAID_TASKS_ENABLED === "true";
  add(
    !paid || paidReady,
    false,
    paid ? `Paid Tasks enabled; registration ready: ${paidReady}` : "Paid Tasks off",
  );
  return { ok: checks.every((c) => c.ok || !c.required), checks };
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
  const result = preflight(process.env, {
    cliVersion: installedCliVersion(),
    paidReady: isPaidReady(),
  });
  for (const c of result.checks)
    console.log(`${c.ok ? "ok  " : c.required ? "FAIL" : "warn"} ${c.text}`);
  console.log(
    result.ok
      ? "Ready. Start the worker: npm run worker"
      : "Fix the FAIL lines, then run npm start again.",
  );
  process.exitCode = result.ok ? 0 : 1;
}
