#!/usr/bin/env node
/*
 * Live checks for real (non-mock) mode. Prints names, ids and outcomes, never a secret.
 *
 *   node scripts/verify-real.mjs                 # Turnkey parent-org whoami + API /health
 *   node scripts/verify-real.mjs --api http://localhost:8787
 *
 * 1. Turnkey: POST /public/v1/query/whoami for TURNKEY_ORGANIZATION_ID, stamped with the
 *    parent-org API key (TURNKEY_API_PUBLIC_KEY / _PRIVATE_KEY): proves the key pair is valid
 *    and belongs to that organization. Read-only; creates nothing.
 * 2. API: GET /health must answer ok with mocks:false (real adapters configured and the
 *    worker booted). Start it with `pnpm dev --web --no-mobile` first.
 *
 * Credentials: apps/api/.dev.vars, then the git-ignored repo-root .env.local for anything
 * left empty (the same merge `pnpm dev --web` does).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { readEnvFile, ROOT } from "./local-env.mjs";

const args = process.argv.slice(2);
const apiUrl = (() => {
  const i = args.indexOf("--api");
  return i === -1 ? "http://localhost:8787" : args[i + 1];
})();

const devVars = readEnvFile(join(ROOT, "apps/api/.dev.vars"));
const local = readEnvFile(join(ROOT, ".env.local"));
const pick = (k) => (devVars[k] ? devVars[k] : local[k]) ?? "";

// @turnkey/api-key-stamper is a dependency of @zyropay/wallet (pnpm keeps it out of the root).
const requireFromWallet = createRequire(join(ROOT, "packages/wallet/package.json"));
const { ApiKeyStamper } = requireFromWallet("@turnkey/api-key-stamper");

let failed = false;
const report = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

async function turnkeyWhoami() {
  const org = pick("TURNKEY_ORGANIZATION_ID");
  const pub = pick("TURNKEY_API_PUBLIC_KEY");
  const priv = pick("TURNKEY_API_PRIVATE_KEY");
  const base = pick("TURNKEY_API_BASE_URL") || "https://api.turnkey.com";
  if (!org || !pub || !priv) {
    report(false, "turnkey whoami", "TURNKEY_ORGANIZATION_ID / TURNKEY_API_* not set");
    return;
  }
  const body = JSON.stringify({ organizationId: org });
  const stamp = await new ApiKeyStamper({ apiPublicKey: pub, apiPrivateKey: priv }).stamp(body);
  const res = await fetch(`${base}/public/v1/query/whoami`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [stamp.stampHeaderName]: stamp.stampHeaderValue,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  const ok = res.ok && json.organizationId === org;
  report(
    ok,
    "turnkey whoami (parent-org API key)",
    ok
      ? `org=${json.organizationId} name="${json.organizationName}" user=${json.username} (${json.userId})`
      : `HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`,
  );
}

async function apiHealth() {
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    const json = await res.json();
    report(
      res.ok && json.ok === true && json.mocks === false,
      `api ${apiUrl}/health real mode`,
      JSON.stringify(json),
    );
  } catch (e) {
    report(
      false,
      `api ${apiUrl}/health`,
      `${e instanceof Error ? e.message : String(e)} (is \`pnpm dev --web\` running?)`,
    );
  }
}

await turnkeyWhoami();
await apiHealth();
process.exitCode = failed ? 1 : 0;
