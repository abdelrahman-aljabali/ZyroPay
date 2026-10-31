#!/usr/bin/env node
/*
 * Lighthouse (mobile by default, simulated throttling) for the landing page.
 *
 *   node scripts/qa-lighthouse.mjs [baseUrl] [--runs 3] [--desktop] [--pages /,/legal]
 *
 * Runs Lighthouse 13.5.0 via npx against local Google Chrome, prints the median performance
 * score and core metrics per page, and saves the JSON reports in qa/out/lighthouse/.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "https://zyropay.online").replace(
  /\/$/,
  "",
);
const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 3;
const desktop = args.includes("--desktop");
const pages = args.includes("--pages") ? args[args.indexOf("--pages") + 1].split(",") : ["/"];
const OUT = fileURLToPath(new URL("../qa/out/lighthouse/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

for (const p of pages) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    const name = p === "/" ? "home" : p.replace(/\W/g, "");
    const file = join(OUT, `${name}-${desktop ? "desktop" : "mobile"}-${i}.json`);
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
      console.error(`lighthouse failed for ${p} (run ${i})`);
      continue;
    }
    const r = JSON.parse(readFileSync(file, "utf8"));
    const a = r.audits;
    results.push({
      perf: Math.round(r.categories.performance.score * 100),
      a11y: Math.round(r.categories.accessibility.score * 100),
      bp: Math.round(r.categories["best-practices"].score * 100),
      lcp: a["largest-contentful-paint"].numericValue,
      tbt: a["total-blocking-time"].numericValue,
      cls: a["cumulative-layout-shift"].numericValue,
      fcp: a["first-contentful-paint"].numericValue,
    });
  }
  if (results.length === 0) continue;
  const m = (k) => median(results.map((x) => x[k]));
  console.log(
    `${p} ${desktop ? "desktop" : "mobile"}: performance ${m("perf")} (runs: ${results
      .map((x) => x.perf)
      .join(", ")}), accessibility ${m("a11y")}, best practices ${m("bp")}, ` +
      `FCP ${(m("fcp") / 1000).toFixed(2)} s, LCP ${(m("lcp") / 1000).toFixed(2)} s, ` +
      `TBT ${Math.round(m("tbt"))} ms, CLS ${m("cls").toFixed(3)}`,
  );
}
