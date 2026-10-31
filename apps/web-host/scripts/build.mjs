#!/usr/bin/env node
/*
 * Build the ZyroPay web app (PWA) for static hosting: `expo export --platform web` of
 * apps/mobile into apps/web-host/dist, plus dist/_headers (security headers and caching).
 *
 *   node scripts/build.mjs --env staging      # testnets (ZYROPAY_MODE=development), https only
 *   node scripts/build.mjs --env production   # mainnets, https only
 *   node scripts/build.mjs --env local        # http://localhost API, for `pnpm preview`
 *
 * Public build-time values (EXPO_PUBLIC_*, inlined into the bundle, never secrets) come from
 * the process environment, then apps/web-host/.env.<env> (git-ignored), then for `local`
 * the repo-root .env.local's EXPO_PUBLIC_TURNKEY_* ids:
 *   EXPO_PUBLIC_API_URL, EXPO_PUBLIC_MCP_URL, EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID,
 *   EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID, EXPO_PUBLIC_PASSKEY_RP_ID
 *
 * After the export the bundle is scanned for every secret value found in the local env files
 * (Turnkey API private key, database URLs, provider keys...); a hit fails the build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(HOST_DIR, "../..");
const MOBILE_DIR = join(ROOT, "apps/mobile");
const DIST = join(HOST_DIR, "dist");

const args = process.argv.slice(2);
const envName = args[args.indexOf("--env") + 1];
if (!args.includes("--env") || !["staging", "production", "local"].includes(envName)) {
  console.error("usage: build.mjs --env staging|production|local");
  process.exit(1);
}

function readEnvFile(path) {
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

const rootLocal = readEnvFile(join(ROOT, ".env.local"));
const fileVars = readEnvFile(join(HOST_DIR, `.env.${envName}`));
const localDefaults =
  envName === "local"
    ? {
        EXPO_PUBLIC_API_URL: "http://localhost:8787",
        EXPO_PUBLIC_MCP_URL: "http://localhost:8788/mcp",
        EXPO_PUBLIC_PASSKEY_RP_ID: "localhost",
        EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: rootLocal.EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID,
        EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID:
          rootLocal.EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID,
      }
    : {};
const pick = (k) => process.env[k] || fileVars[k] || localDefaults[k] || "";

const publicEnv = {
  EXPO_PUBLIC_API_URL: pick("EXPO_PUBLIC_API_URL"),
  EXPO_PUBLIC_MCP_URL: pick("EXPO_PUBLIC_MCP_URL"),
  EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: pick("EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID"),
  EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: pick("EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID"),
  EXPO_PUBLIC_PASSKEY_RP_ID: pick("EXPO_PUBLIC_PASSKEY_RP_ID"),
  EXPO_PUBLIC_TURNKEY_API_BASE_URL:
    pick("EXPO_PUBLIC_TURNKEY_API_BASE_URL") || "https://api.turnkey.com",
  EXPO_PUBLIC_PASSKEY_RP_NAME: pick("EXPO_PUBLIC_PASSKEY_RP_NAME") || "ZyroPay",
};
const missing = Object.entries(publicEnv)
  .filter(([, v]) => v === "")
  .map(([k]) => k);
if (missing.length > 0) {
  console.error(`missing ${missing.join(", ")} (environment or apps/web-host/.env.${envName})`);
  process.exit(1);
}
if (envName !== "local") {
  for (const k of ["EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_MCP_URL"])
    if (!publicEnv[k].startsWith("https://")) {
      console.error(`${k} must be https:// for ${envName}`);
      process.exit(1);
    }
}

// --- framing allowlist ------------------------------------------------------------------
// The landing page shows the real app in an iframe on desktop (docs/SECURITY.md "Framing").
// These are the ONLY origins that may frame the app: CSP frame-ancestors enforces it, the
// Permissions-Policy delegates WebAuthn to it, and the bundle gets the same list
// (EXPO_PUBLIC_FRAME_PARENTS) so the app posts its two embed messages only to the parent's
// exact origin, and only when it is one of these. Production has no landing origin yet, so nothing may frame it.
const LANDING_STAGING = "https://zyropay.online";
const LANDING_DEV = "http://localhost:4321";
const FRAME_PARENTS = {
  staging: [LANDING_STAGING, LANDING_DEV],
  local: [LANDING_DEV],
  production: [],
}[envName];

// --- export -----------------------------------------------------------------------------
rmSync(DIST, { recursive: true, force: true });
const buildEnv = {
  ...process.env,
  ...publicEnv,
  EXPO_PUBLIC_ZYROPAY_MODE: envName === "production" ? "production" : "development",
  EXPO_PUBLIC_USE_MOCKS: "0",
  EXPO_PUBLIC_DEV_PASSKEY: "",
  EXPO_PUBLIC_FRAME_PARENTS: FRAME_PARENTS.join(" "),
  APP_VARIANT: envName === "production" ? "production" : "preview",
  NODE_ENV: "production",
};
console.log(`expo export --platform web (${envName}, mode ${buildEnv.EXPO_PUBLIC_ZYROPAY_MODE})`);
const res = spawnSync(
  "npx",
  ["expo", "export", "--platform", "web", "--output-dir", DIST, "--clear"],
  { cwd: MOBILE_DIR, env: buildEnv, stdio: "inherit" },
);
if (res.status !== 0) process.exit(res.status ?? 1);

// --- security headers -------------------------------------------------------------------
const origin = (u) => new URL(u).origin;
const connect = [
  "'self'",
  origin(publicEnv.EXPO_PUBLIC_API_URL),
  origin(publicEnv.EXPO_PUBLIC_TURNKEY_API_BASE_URL),
  "https://authproxy.turnkey.com",
];
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  // react-native-web injects <style> elements at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${[...new Set(connect)].join(" ")}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // Not 'self': the app never frames itself. With an allowlist, X-Frame-Options is not sent:
  // it cannot express one (DENY would block the landing page in browsers that check it).
  `frame-ancestors ${FRAME_PARENTS.length > 0 ? FRAME_PARENTS.join(" ") : "'none'"}`,
  ...(envName === "local" ? [] : ["upgrade-insecure-requests"]),
].join("; ");
// WebAuthn may run in this document and, when framed, only under an allowlisted parent
// (which must also delegate it: <iframe allow="publickey-credentials-get; ...">).
const webauthnAllow = ["self", ...FRAME_PARENTS.map((o) => `"${o}"`)].join(" ");
const permissions = [
  `publickey-credentials-get=(${webauthnAllow})`,
  `publickey-credentials-create=(${webauthnAllow})`,
  "camera=(self)",
  "microphone=()",
  "geolocation=()",
  "payment=()",
].join(", ");
const headers = `# Generated by apps/web-host/scripts/build.mjs (${envName}). Cloudflare Workers static assets.
/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
${FRAME_PARENTS.length === 0 ? "  X-Frame-Options: DENY\n" : ""}  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: ${permissions}
${envName === "local" ? "" : "  Strict-Transport-Security: max-age=63072000; includeSubDomains\n"}/_expo/static/*
  Cache-Control: public, max-age=31536000, immutable
/index.html
  Cache-Control: no-cache
/manifest.webmanifest
  Cache-Control: no-cache
`;
writeFileSync(join(DIST, "_headers"), headers);

// --- secret scan --------------------------------------------------------------------------
const secretSources = [
  readEnvFile(join(ROOT, ".env.local")),
  readEnvFile(join(ROOT, ".env")),
  readEnvFile(join(ROOT, "apps/api/.dev.vars")),
  readEnvFile(join(ROOT, "apps/mcp/.dev.vars")),
];
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|SALT|DATABASE_URL|BLOCKFROST_PROJECT_ID)/;
/** secret value -> variable name (only names are ever printed). */
const secrets = new Map();
for (const src of secretSources)
  for (const [k, v] of Object.entries(src))
    // "TURNKEY" itself ends in KEY: test the name without that prefix. The org id and the
    // Auth Proxy config id are public by design (they ship in the bundle).
    if (
      SECRET_NAME.test(k.replace(/^TURNKEY_/, "")) &&
      !k.startsWith("EXPO_PUBLIC_") &&
      v.length >= 12
    )
      secrets.set(v, k);
let scanned = 0;
const leaks = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|json|css|map|webmanifest)$/.test(name)) {
      scanned++;
      const text = readFileSync(p, "utf8");
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) leaks.push(`${p}: PEM private key`);
      for (const [value, name] of secrets)
        if (text.includes(value)) leaks.push(`${p}: contains the value of ${name}`);
    }
  }
};
walk(DIST);
if (leaks.length > 0) {
  console.error(`SECRET FOUND IN THE WEB BUNDLE, refusing:\n  ${leaks.join("\n  ")}`);
  rmSync(DIST, { recursive: true, force: true });
  process.exit(1);
}
console.log(
  `wrote ${DIST} (+ _headers). Secret scan: ${String(scanned)} files, ${String(secrets.size)} known secret values, 0 found.`,
);
