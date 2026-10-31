#!/usr/bin/env node
/*
 * Uptime / health check for a ZyroPay deployment (docs/MONITORING.md). Dependency-free, so
 * it can run from cron, a GitHub Actions schedule or any uptime runner.
 *
 *   node scripts/health-check.mjs --api https://api.example --mcp https://mcp.example --web https://app.example
 *   node scripts/health-check.mjs --api http://localhost:8787 --json
 *
 * Checks (each only when its URL is given):
 *   api  GET /health -> 200 with {"ok":true}; reports mode and mocks (production must not run mocks)
 *   mcp  GET /.well-known/oauth-authorization-server -> 200 JSON with an issuer
 *   web  GET / -> 200 HTML that loads the app bundle
 * Exit code 0 when everything passed, 1 otherwise. Prints no secrets (nothing secret is sent).
 */

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const TIMEOUT_MS = Number(arg("timeout") ?? 10_000);
const RETRIES = Number(arg("retries") ?? 1);
const asJson = args.includes("--json");
const trim = (u) => u?.replace(/\/+$/, "");
const targets = { api: trim(arg("api")), mcp: trim(arg("mcp")), web: trim(arg("web")) };

if (!targets.api && !targets.mcp && !targets.web) {
  console.error(
    "usage: health-check.mjs [--api URL] [--mcp URL] [--web URL] [--json] [--timeout ms]",
  );
  process.exit(2);
}

async function get(url) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "zyropay-health-check/1" },
        redirect: "follow",
      });
      const body = await res.text();
      return { status: res.status, body, ms: Date.now() - started, headers: res.headers };
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

const checks = {
  async api(base) {
    const r = await get(`${base}/health`);
    let json = null;
    try {
      json = JSON.parse(r.body);
    } catch {
      /* not JSON */
    }
    const ok = r.status === 200 && json?.ok === true;
    const prodMocks = json?.mode === "production" && json?.mocks === true;
    return {
      ok: ok && !prodMocks,
      ms: r.ms,
      detail: ok
        ? `mode=${json.mode} mocks=${json.mocks}${prodMocks ? " (MOCKS IN PRODUCTION)" : ""}`
        : `HTTP ${r.status} ${json?.reason ?? json?.error ?? ""}`.trim(),
    };
  },
  async mcp(base) {
    const r = await get(`${base}/.well-known/oauth-authorization-server`);
    let issuer = null;
    try {
      issuer = JSON.parse(r.body).issuer ?? null;
    } catch {
      /* not JSON */
    }
    return {
      ok: r.status === 200 && typeof issuer === "string",
      ms: r.ms,
      detail: r.status === 200 ? `issuer=${issuer}` : `HTTP ${r.status}`,
    };
  },
  async web(base) {
    const r = await get(`${base}/`);
    const html = (r.headers.get("content-type") ?? "").includes("text/html");
    const bundle = /\/_expo\/static\/js\/web\/[^"']+\.js/.test(r.body);
    return {
      ok: r.status === 200 && html && bundle,
      ms: r.ms,
      detail: `HTTP ${r.status}${bundle ? "" : " (no app bundle in index.html)"}${r.headers.get("content-security-policy") ? "" : " (no CSP header)"}`,
    };
  },
};

const results = {};
for (const [name, base] of Object.entries(targets)) {
  if (!base) continue;
  try {
    results[name] = { url: base, ...(await checks[name](base)) };
  } catch (error) {
    results[name] = {
      url: base,
      ok: false,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
const allOk = Object.values(results).every((r) => r.ok);
if (asJson) {
  console.log(JSON.stringify({ ok: allOk, checkedAt: new Date().toISOString(), results }));
} else {
  for (const [name, r] of Object.entries(results))
    console.log(
      `${r.ok ? "OK  " : "FAIL"} ${name.padEnd(3)} ${r.url}  ${r.detail}${r.ms !== undefined ? `  ${String(r.ms)} ms` : ""}`,
    );
}
process.exit(allOk ? 0 : 1);
