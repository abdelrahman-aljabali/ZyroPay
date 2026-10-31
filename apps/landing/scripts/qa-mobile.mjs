#!/usr/bin/env node
/* global document, window, getComputedStyle */
/*
 * Mobile QA: iPhone (WebKit) and Android (Chromium) emulation, touch enabled.
 *
 *   node scripts/qa-mobile.mjs [baseUrl]
 *
 * For every device it checks, and saves screenshots to qa/out/mobile/:
 *   - the approval card, "Hold to approve" and "Reject" are inside the first viewport;
 *   - no horizontal overflow anywhere on the page;
 *   - every link/button outside the phone mockup is at least 44 px tall and wide;
 *   - no text smaller than 12 px outside the phone mockup.
 * On Chromium it also drives real touch input (CDP): a touch hold approves without scrolling
 * the page, a horizontal touch drag on the card rejects, and a vertical drag still scrolls.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";

const base = (
  process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:8787"
).replace(/\/$/, "");
const OUT = fileURLToPath(new URL("../qa/out/mobile/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const iphone = devices["iPhone 15 Pro"];
const pixel = devices["Pixel 7"];
const DEVICES = [
  { name: "iphone-375x667", engine: webkit, ...iphone, viewport: { width: 375, height: 667 } },
  { name: "iphone-393x852", engine: webkit, ...iphone, viewport: { width: 393, height: 852 } },
  { name: "iphone-430x932", engine: webkit, ...iphone, viewport: { width: 430, height: 932 } },
  // Real Safari with its toolbars: what the visitor actually sees on an iPhone 15 Pro / Pro Max.
  { name: "iphone15pro-safari", engine: webkit, ...iphone },
  { name: "iphone15promax-safari", engine: webkit, ...devices["iPhone 15 Pro Max"] },
  { name: "android-375x667", engine: chromium, ...pixel, viewport: { width: 375, height: 667 } },
  { name: "android-393x852", engine: chromium, ...pixel, viewport: { width: 393, height: 852 } },
  { name: "android-430x932", engine: chromium, ...pixel, viewport: { width: 430, height: 932 } },
  { name: "android-pixel7", engine: chromium, ...pixel },
];

const problems = [];
const report = (d, msg) => problems.push(`${d}: ${msg}`);

async function audit(page) {
  return page.evaluate(() => {
    const out = { overflow: 0, small: [], tiny: [] };
    out.overflow = document.documentElement.scrollWidth - window.innerWidth;
    const inPhone = (el) => el.closest(".phone, .zp-app");
    for (const el of document.querySelectorAll("a, button")) {
      if (inPhone(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      // Pseudo-element hit areas count: measure the larger of the box and its ::after.
      const after = getComputedStyle(el, "::after");
      const grow =
        after.content !== "none" && after.position === "absolute"
          ? -(Number.parseInt(after.top || "0", 10) || 0) -
            (Number.parseInt(after.bottom || "0", 10) || 0)
          : 0;
      if (r.height + grow < 44 || r.width < 44)
        out.small.push(
          `${el.textContent.trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height + grow)}`,
        );
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent.trim() || inPhone(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.display === "none" || el.closest(".sr-only, [aria-hidden='true'] .s-slab")) continue;
      if (Number.parseInt(cs.fontSize, 10) < 12)
        out.tiny.push(`${n.textContent.trim().slice(0, 30)} ${cs.fontSize}`);
    }
    return out;
  });
}

for (const d of DEVICES) {
  const { name, engine, defaultBrowserType: _b, ...ctxOpts } = d;
  const browser = await engine.launch();
  const ctx = await browser.newContext({ ...ctxOpts, colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report(name, `page error ${e.message}`));
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.waitForSelector('.s-hero[data-phase="arrived"]', {
    state: "attached",
    timeout: 20000,
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `${name}-1-arrived.png`) });

  const fold = await page.evaluate(() => {
    const vh = window.innerHeight;
    const q = (s) => document.querySelector(s)?.getBoundingClientRect();
    const card = q(".s-fallback .zp-card");
    const hold = q(".s-fallback .zp-hold");
    const reject = q(".s-fallback .zp-reject");
    return {
      vh,
      card: card?.bottom,
      hold: hold?.bottom,
      reject: reject?.bottom,
      holdH: hold?.height,
    };
  });
  for (const k of ["hold", "reject", "card"]) {
    if (!(fold[k] <= fold.vh))
      report(name, `${k} below the fold (${Math.round(fold[k])} > ${fold.vh})`);
  }
  if (fold.holdH < 44) report(name, `hold button ${fold.holdH}px tall`);
  // The incoming message must never overlap the phone (frame, island, status bar).
  const overlap = await page.evaluate(() => {
    const m = document.querySelector(".s-mini")?.getBoundingClientRect();
    const ph = document.querySelector(".s-fallback .phone")?.getBoundingClientRect();
    return m && ph ? m.bottom - ph.top : null;
  });
  if (overlap === null || overlap > 0) report(name, `message overlaps the phone by ${overlap}px`);

  // The hijacked scenario fits the same way.
  await page.locator(".s-mbar .s-seg__btn").nth(1).tap();
  await page.waitForSelector('.s-hero[data-scenario="attack"][data-phase="arrived"]', {
    state: "attached",
    timeout: 20000,
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `${name}-2-attack.png`) });
  const rej = await page.evaluate(
    () => document.querySelector(".s-fallback .zp-reject")?.getBoundingClientRect().bottom,
  );
  if (!(rej <= fold.vh)) report(name, `attack: reject below the fold`);

  if (engine === chromium) {
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    // Swipe left on the card (touch).
    const card = await page.locator(".s-fallback .zp-card").first().boundingBox();
    const sx = card.x + card.width * 0.75;
    const sy = card.y + 30;
    await touch("touchStart", sx, sy);
    for (let i = 1; i <= 12; i++) {
      await touch("touchMove", sx - i * 18, sy + i * 0.5);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", 0, 0);
    await page.waitForTimeout(700);
    const afterSwipe = await page.locator(".s-hero").getAttribute("data-phase");
    if (afterSwipe !== "rejected") report(name, `touch swipe left -> ${afterSwipe}`);
    await page.screenshot({ path: join(OUT, `${name}-3-blocked.png`) });

    // Back to the honest request, then a touch hold.
    await page.locator(".s-mbar .s-seg__btn").nth(0).tap();
    await page.waitForSelector('.s-hero[data-scenario="honest"][data-phase="arrived"]', {
      state: "attached",
      timeout: 20000,
    });
    await page.waitForTimeout(500);
    const hold = await page.locator(".s-fallback .zp-hold").boundingBox();
    const y0 = await page.evaluate(() => window.scrollY);
    const hx = hold.x + hold.width / 2;
    const hy = hold.y + hold.height / 2;
    await touch("touchStart", hx, hy);
    // A finger that drifts while holding must not scroll the page.
    for (let i = 1; i <= 6; i++) {
      await page.waitForTimeout(200);
      await touch("touchMove", hx, hy - i * 4);
    }
    await page.waitForTimeout(200);
    await touch("touchEnd", 0, 0);
    await page.waitForTimeout(1300);
    const afterHold = await page.locator(".s-hero").getAttribute("data-phase");
    const y1 = await page.evaluate(() => window.scrollY);
    if (afterHold !== "paid") report(name, `touch hold -> ${afterHold}`);
    if (y1 !== y0) report(name, `page scrolled during hold (${y0} -> ${y1})`);
    await page.screenshot({ path: join(OUT, `${name}-4-paid.png`) });

    // A vertical drag starting on the card still scrolls the page.
    const c2 = await page.locator(".s-hero").boundingBox();
    await touch("touchStart", c2.x + c2.width / 2, 500);
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", c2.x + c2.width / 2, 500 - i * 25);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", 0, 0);
    await page.waitForTimeout(500);
    const y2 = await page.evaluate(() => window.scrollY);
    if (!(y2 > y1)) report(name, `vertical drag did not scroll (${y1} -> ${y2})`);
  } else {
    // WebKit: tap Reject (touch) on the hijacked request.
    await page.locator(".s-fallback .zp-reject").tap();
    await page.waitForTimeout(600);
    const after = await page.locator(".s-hero").getAttribute("data-phase");
    if (after !== "rejected") report(name, `tap reject -> ${after}`);
    await page.screenshot({ path: join(OUT, `${name}-3-blocked.png`) });
  }

  // Whole page: scroll through like a visitor, then audit and capture each section.
  for (const id of ["how", "hack", "stack", "proof"]) {
    await page.evaluate((id) => document.getElementById(id)?.scrollIntoView(), id);
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${name}-sec-${id}.png`) });
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${name}-sec-final.png`) });
  const a = await audit(page);
  if (a.overflow > 0) report(name, `horizontal overflow ${a.overflow}px`);
  for (const s of a.small) report(name, `small tap target: ${s}`);
  for (const t of a.tiny) report(name, `tiny text: ${t}`);

  await page.goto(`${base}/legal`, { waitUntil: "networkidle" });
  const legal = await audit(page);
  if (legal.overflow > 0) report(name, `/legal overflow ${legal.overflow}px`);
  for (const s of legal.small) report(name, `/legal small tap target: ${s}`);
  await page.screenshot({ path: join(OUT, `${name}-legal.png`) });

  console.log(
    `${name}: fold vh=${fold.vh} hold=${Math.round(fold.hold)} reject=${Math.round(fold.reject)}`,
  );
  await browser.close();
}

if (problems.length > 0) {
  console.error("\nProblems:");
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log("\nAll mobile checks passed.");
}
