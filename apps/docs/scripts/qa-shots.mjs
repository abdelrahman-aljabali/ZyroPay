#!/usr/bin/env node
/* global document */
/*
 * Visual QA for the docs site.
 *
 *   node scripts/qa-shots.mjs [baseUrl]        default http://localhost:8788 (pnpm preview)
 *
 * Full-page screenshots of the key pages at 390 and 1440 px wide, light and dark, into
 * qa/out/<page>-<width>-<scheme>.png. Fails on console errors, CSP violations, failed
 * requests, or any page wider than its viewport (horizontal scroll).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = (
  process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:8788"
).replace(/\/$/, "");
const OUT = fileURLToPath(new URL("../qa/out/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["home", "/"],
  ["x402", "/how-it-works/x402/"],
  ["escrow", "/how-it-works/escrow/"],
  ["evidence", "/evidence/"],
  ["security", "/security/trust/"],
];
const WIDTHS = [390, 1440];
const SCHEMES = ["light", "dark"];

const problems = [];
const browser = await chromium.launch();
for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    const ctx = await browser.newContext({
      viewport: { width, height: width < 500 ? 844 : 900 },
      deviceScaleFactor: width < 500 ? 2 : 1,
      isMobile: width < 500,
      colorScheme: scheme,
    });
    for (const [name, path] of PAGES) {
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") problems.push(`${path} ${width} ${scheme}: console: ${m.text()}`);
      });
      page.on("requestfailed", (r) => problems.push(`${path}: request failed ${r.url()}`));
      page.on("response", (r) => {
        if (r.status() >= 400) problems.push(`${path}: HTTP ${r.status()} ${r.url()}`);
      });
      await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
      // Load every lazy diagram before the full-page shot.
      await page.evaluate(async () => {
        for (const img of document.querySelectorAll("img[loading=lazy]")) img.loading = "eager";
        await Promise.all(
          [...document.images].map((i) =>
            i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)),
          ),
        );
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1)
        problems.push(`${path} ${width} ${scheme}: horizontal overflow ${overflow}px`);
      await page.screenshot({ path: join(OUT, `${name}-${width}-${scheme}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
if (problems.length > 0) {
  console.error([...new Set(problems)].join("\n"));
  process.exit(1);
}
console.log(
  `qa-shots: ${PAGES.length * WIDTHS.length * SCHEMES.length} screenshots in qa/out, no errors`,
);
