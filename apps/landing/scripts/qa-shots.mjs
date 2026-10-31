#!/usr/bin/env node
/* global document, window */
/*
 * Visual QA for the landing page.
 *
 *   node scripts/qa-shots.mjs [baseUrl] [--quick] [--frames] [--video]
 *
 * For each viewport (1920x1080, 1440x900, 1280x800, 768x1024, 393x852) it saves to qa/out/:
 *   hero-<w>x<h>-<scheme>-honest-arrived.png   approval card on screen
 *   hero-<w>x<h>-<scheme>-honest-paid.png      after an automatic hold (?autohold=1), stamp landed
 *   hero-<w>x<h>-<scheme>-attack-arrived.png   the hijacked request with red risk badges
 *   hero-<w>x<h>-<scheme>-attack-blocked.png   after an automatic reject (?autoreject=1)
 *   full-<w>x<h>-<scheme>.png                  the whole page, scrolled through once
 * Schemes: dark everywhere, plus light at 1440x900 (the phone's app follows the system).
 * --quick: 1440x900 dark only. --frames: a 400 ms frame sequence of the hero (1440x900).
 * --video: a .webm of the same. Console errors and CSP violations fail the run.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "http://localhost:8787").replace(/\/$/, "");
const quick = args.includes("--quick");
const wantFrames = args.includes("--frames");
const wantVideo = args.includes("--video");
const OUT = fileURLToPath(new URL("../qa/out/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = quick
  ? [{ width: 1440, height: 900 }]
  : [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 393, height: 852 },
    ];

const errors = [];
const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=metal"] });

function context(vp, scheme, extra = {}) {
  const small = vp.width < 1100;
  return browser.newContext({
    viewport: vp,
    deviceScaleFactor: small ? 2 : 1,
    isMobile: vp.width < 500,
    hasTouch: small,
    colorScheme: scheme,
    ...extra,
  });
}

async function open(ctx, url) {
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${url}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`${url}: ${err.message}`));
  await page.goto(url, { waitUntil: "networkidle" });
  return page;
}

const phase = (page, p) =>
  page.waitForSelector(`.s-hero[data-phase="${p}"]`, { timeout: 20000, state: "attached" });

for (const vp of VIEWPORTS) {
  const schemes = vp.width === 1440 && !quick ? ["dark", "light"] : ["dark"];
  for (const scheme of schemes) {
    const tag = `${vp.width}x${vp.height}-${scheme}`;

    // Honest request, then hold to approve.
    let ctx = await context(vp, scheme);
    let page = await open(ctx, `${base}/?autohold=1`);
    await phase(page, "arrived");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, `hero-${tag}-honest-arrived.png`) });
    await phase(page, "paid");
    // The receipt slides in, then the stamp lands ~1.1 s later (story.css): wait for both.
    await page.waitForSelector('.s-hero__receipt[data-stamped="true"]', { timeout: 5000 });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: join(OUT, `hero-${tag}-honest-paid.png`) });
    if (scheme === "dark") {
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 300) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 140));
        }
        await new Promise((r) => setTimeout(r, 1500));
      });
      // CSS pixels on 2x (small) screens: the long page would pass Chromium's capture size limit.
      await page.screenshot({
        path: join(OUT, `full-${tag}.png`),
        fullPage: true,
        ...(vp.width < 1100 ? { scale: "css" } : {}),
      });
    }
    await ctx.close();

    // Hijacked assistant, then reject.
    ctx = await context(vp, scheme);
    page = await open(ctx, `${base}/?scenario=attack&autoreject=1`);
    await phase(page, "arrived");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, `hero-${tag}-attack-arrived.png`) });
    await phase(page, "rejected");
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `hero-${tag}-attack-blocked.png`) });
    await ctx.close();
    console.log(`shot ${tag}`);
  }
}

if (wantFrames || wantVideo) {
  const vp = { width: 1440, height: 900 };
  const ctx = await context(
    vp,
    "dark",
    wantVideo ? { recordVideo: { dir: join(OUT, "video"), size: vp } } : {},
  );
  const page = await open(ctx, `${base}/?autohold=1`);
  if (wantFrames) {
    for (let i = 0; i < 26; i++) {
      await page.screenshot({ path: join(OUT, `frame-${String(i).padStart(2, "0")}.png`) });
      await page.waitForTimeout(400);
    }
  } else {
    await page.waitForTimeout(10500);
  }
  await ctx.close();
  console.log("sequence done");
}

await browser.close();
if (errors.length > 0) {
  console.error("\nConsole errors:");
  for (const e of [...new Set(errors)]) console.error(`  - ${e}`);
  process.exitCode = 1;
}
