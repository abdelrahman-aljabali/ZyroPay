#!/usr/bin/env node
/*
 * One-time local setup: writes apps/api/.dev.vars and apps/mcp/.dev.vars (git-ignored) from
 * their .dev.vars.example templates with freshly generated local secrets and a database:
 * the Neon database from `neon env pull` (.env.local / .env DATABASE_URL, pooled, driver
 * `neon`) when present, otherwise the local Docker Postgres (driver `pg`). Existing files are never overwritten. Third-party keys stay empty, so the
 * API runs with Mock adapters and MockTurnkey until you add real credentials.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_PG, readEnvFile, ROOT } from "./local-env.mjs";

const rootEnv = { ...readEnvFile(join(ROOT, ".env")), ...readEnvFile(join(ROOT, ".env.local")) };
const neonUrl = rootEnv.DATABASE_URL ?? "";
const database =
  neonUrl !== ""
    ? { DATABASE_URL: neonUrl, DATABASE_DRIVER: "neon" }
    : { DATABASE_URL: LOCAL_PG.url, DATABASE_DRIVER: "pg" };
console.log(
  neonUrl !== ""
    ? "database: Neon (DATABASE_URL from .env.local/.env, driver neon). Apply migrations: pnpm db:migrate"
    : "database: local Docker Postgres (driver pg)",
);

const internalToken = randomBytes(32).toString("hex");

function render(template, values) {
  const seen = new Set();
  const lines = readFileSync(template, "utf8")
    .split("\n")
    .map((line) => {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m || !(m[1] in values)) return line;
      seen.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    });
  for (const [key, value] of Object.entries(values))
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  return lines.join("\n");
}

const files = [
  {
    path: join(ROOT, "apps/api/.dev.vars"),
    template: join(ROOT, "apps/api/.dev.vars.example"),
    values: {
      ...database,
      INTERNAL_SERVICE_TOKEN: internalToken,
      DELEGATED_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      AUDIT_IP_HASH_SALT: randomBytes(16).toString("hex"),
      MCP_INTERNAL_URL: "http://localhost:8788",
    },
  },
  {
    path: join(ROOT, "apps/mcp/.dev.vars"),
    template: join(ROOT, "apps/mcp/.dev.vars.example"),
    values: {
      INTERNAL_SERVICE_TOKEN: internalToken,
      MCP_OAUTH_COOKIE_SECRET: randomBytes(32).toString("hex"),
      API_INTERNAL_URL: "http://localhost:8787",
    },
  },
];

if (files.some((f) => existsSync(f.path)) && !files.every((f) => existsSync(f.path))) {
  console.error(
    "Only one of apps/api/.dev.vars and apps/mcp/.dev.vars exists. They must share\n" +
      "INTERNAL_SERVICE_TOKEN: delete the existing one or create the other by hand.",
  );
  process.exit(1);
}
for (const f of files) {
  if (existsSync(f.path)) {
    console.log(`kept ${f.path} (already exists)`);
    continue;
  }
  writeFileSync(f.path, render(f.template, f.values), { mode: 0o600 });
  console.log(`wrote ${f.path}`);
}
console.log("Next: pnpm dev");
