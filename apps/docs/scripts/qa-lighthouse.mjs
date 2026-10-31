#!/usr/bin/env node
/*
 * Lighthouse (mobile, simulated throttling) for the docs site's key pages.
 *
 *   node scripts/qa-lighthouse.mjs [baseUrl] [--desktop]
 *
 * Runs Lighthouse 13.5.0 via npx against local Google Chrome (CHROME_PATH to override) and
 * fails when performance or accessibility is below 95 on any page.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "http://localhost:8788").replace(/\/$/, "");
const desktop = args.includes("--desktop");
const PAGES = ["/", "/how-it-works/x402/", "/evidence/", "/security/trust/"];
const OUT = fileURLToPath(new URL("../qa/out/lighthouse/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failed = false;
for (const p of PAGES) {
  const file = join(
    OUT,
    `${p === "/" ? "home" : p.replace(/\W/g, "")}-${desktop ? "desktop" : "mobile"}.json`,
  );
  const res = spawnSync(
    "npx",
    [
      "-y",
      "lighthouse@13.5.0",
      `${base}${p}`,
      "--only-categories=performance,accessibility,best-practices",
      "--output=json",
      `--output-path=${file}`,
      "--quiet",
      "--chrome-flags=--headless=new --no-first-run",
      ...(desktop ? ["--preset=desktop"] : []),
    ],
    { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CHROME_PATH: CHROME } },
  );
  if (res.status !== 0) {
    console.error(`lighthouse failed for ${p}`);
    failed = true;
    continue;
  }
  const r = JSON.parse(readFileSync(file, "utf8"));
  const score = (k) => Math.round(r.categories[k].score * 100);
  const line = `${p}: performance ${score("performance")}, accessibility ${score("accessibility")}, best practices ${score("best-practices")}`;
  console.log(line);
  if (score("performance") < 95 || score("accessibility") < 95) failed = true;
}
if (failed) process.exit(1);
