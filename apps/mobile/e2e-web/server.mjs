#!/usr/bin/env node
/*
 * Web E2E server (Playwright `webServer`): exports the app for the web in MOCK mode
 * (EXPO_PUBLIC_USE_MOCKS=1, no Turnkey, no API) into e2e-web/.build when it is missing or
 * E2E_WEB_REBUILD=1, then serves it like the static host does: SPA fallback, long-lived
 * caching for hashed bundles.
 *
 *   node e2e-web/server.mjs [port]      # default 8790
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(APP_DIR, "e2e-web", ".build");
const port = Number(process.argv[2] ?? process.env.E2E_WEB_PORT ?? 8790);

if (process.env.E2E_WEB_REBUILD === "1" || !existsSync(join(BUILD, "index.html"))) {
  rmSync(BUILD, { recursive: true, force: true });
  console.log("e2e-web: expo export --platform web (mock mode)");
  const res = spawnSync(
    "npx",
    ["expo", "export", "--platform", "web", "--output-dir", BUILD, "--clear"],
    {
      cwd: APP_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        EXPO_PUBLIC_USE_MOCKS: "1",
        EXPO_PUBLIC_ZYROPAY_MODE: "development",
        EXPO_PUBLIC_DEV_PASSKEY: "",
        EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: "",
        EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: "",
        EXPO_PUBLIC_PASSKEY_RP_ID: "",
        // The landing page's dev origin, as in a real staging build (embed.spec.ts).
        EXPO_PUBLIC_FRAME_PARENTS: "http://localhost:4321",
        NODE_ENV: "production",
      },
    },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = normalize(join(BUILD, path));
  if (!file.startsWith(BUILD) || !existsSync(file) || statSync(file).isDirectory())
    file = join(BUILD, "index.html");
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": path.startsWith("/_expo/static/") ? "public, max-age=31536000" : "no-cache",
  });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`e2e-web: serving ${BUILD} on http://127.0.0.1:${String(port)}`);
});
