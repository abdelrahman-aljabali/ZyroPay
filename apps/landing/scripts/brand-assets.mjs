#!/usr/bin/env node
/* global document */
/*
 * Regenerates the static brand assets in public/ from assets/brand/zyropay-mark.svg:
 *
 *   public/favicon.svg                 the canonical mark, copied
 *   public/favicon.ico                 16, 32 and 48 px PNGs in one ICO
 *   public/icons/apple-touch-icon.png  180 px, opaque (iOS adds its own mask)
 *   public/icons/icon-192.png, icon-512.png, icon-maskable-512.png   for site.webmanifest
 *   public/og.png                      1200x630 social card, drawn from the hero design
 *
 *   node scripts/brand-assets.mjs
 *
 * Run it by hand after the mark, the headline or the live receipt changes, and commit the
 * output: the build itself never needs a browser. Uses Playwright's Chromium and the Inter file
 * the site already ships.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const MARK_FILE = fileURLToPath(new URL("../../../assets/brand/zyropay-mark.svg", import.meta.url));
const MARK = readFileSync(MARK_FILE, "utf8");
const INTER = readFileSync(root("public/fonts/inter-var-opsz.woff2")).toString("base64");
const EVIDENCE = JSON.parse(readFileSync(root("src/lib/evidence.json"), "utf8"));

mkdirSync(root("public/icons"), { recursive: true });
copyFileSync(MARK_FILE, root("public/favicon.svg"));

const browser = await chromium.launch();
const page = await browser.newPage();

async function png(html, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ type: "png", omitBackground: true });
}

const markInner = MARK.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const markOnly = markInner.replace(/<rect[^>]*\/>/, "");

/** The mark at `size`, optionally on an opaque background with padding (touch/maskable icons). */
function iconHtml(size, { bg = null, pad = 0 } = {}) {
  const inner = size - pad * 2;
  const tile = bg
    ? `<svg viewBox="0 0 100 100" width="${inner}" height="${inner}"><path fill="#000" d="${/d="([^"]+)"/.exec(markOnly)?.[1] ?? ""}"/></svg>`
    : `<svg viewBox="0 0 100 100" width="${size}" height="${size}">${markInner}</svg>`;
  return `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${bg ?? "transparent"}">${tile}</body></html>`;
}

const sizes = { 16: null, 32: null, 48: null };
for (const s of Object.keys(sizes)) sizes[s] = await png(iconHtml(Number(s)), Number(s), Number(s));

// ICO with embedded PNGs (supported by every current browser).
{
  const entries = Object.entries(sizes);
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(([s, buf], i) => {
    const o = 6 + i * 16;
    header.writeUInt8(Number(s) % 256, o);
    header.writeUInt8(Number(s) % 256, o + 1);
    header.writeUInt8(0, o + 2);
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(buf.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  writeFileSync(root("public/favicon.ico"), Buffer.concat([header, ...entries.map(([, b]) => b)]));
}

// White tile, black mark, for platforms that apply their own corner mask.
writeFileSync(
  root("public/icons/apple-touch-icon.png"),
  await png(iconHtml(180, { bg: "#ffffff", pad: 22 }), 180, 180),
);
writeFileSync(root("public/icons/icon-192.png"), await png(iconHtml(192), 192, 192));
writeFileSync(root("public/icons/icon-512.png"), await png(iconHtml(512), 512, 512));
writeFileSync(
  root("public/icons/icon-maskable-512.png"),
  await png(iconHtml(512, { bg: "#ffffff", pad: 104 }), 512, 512),
);

// Open Graph card -------------------------------------------------------------------------
const r = EVIDENCE.receipt;
const byId = (id) => EVIDENCE.items.find((i) => i.id === id);
const short = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const grouped = (h) => `${h.slice(0, 4)} ${h.slice(4, 8)} … ${h.slice(-8, -4)} ${h.slice(-4)}`;
const lock = byId(r.lock)?.txHash ?? "";
const result = byId(r.result)?.txHash ?? "";
const live = /^[0-9a-f]{64}$/.test(lock) && /^[0-9a-f]{64}$/.test(result);

const og = `<!doctype html><html><head><style>
@font-face{font-family:Inter;src:url(data:font/woff2;base64,${INTER}) format("woff2");font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:Inter,sans-serif;color:#f3f4f6;-webkit-font-smoothing:antialiased;
background:radial-gradient(60% 70% at 85% -5%,rgba(255,241,222,.16),transparent 70%),radial-gradient(45% 60% at 0% 100%,rgba(120,140,190,.10),transparent 70%),#060709;position:relative}
.beam{position:absolute;top:-40px;left:640px;width:520px;height:760px;background:linear-gradient(180deg,rgba(255,241,222,.22),rgba(255,241,222,.03) 70%,transparent);clip-path:polygon(42% 0,58% 0,100% 100%,0 100%);filter:blur(30px);transform:rotate(-12deg);transform-origin:50% 0}
.brand{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:16px;font-size:30px;font-weight:600;letter-spacing:-.02em}
.brand svg{width:48px;height:48px}
h1{position:absolute;left:72px;top:172px;font-size:74px;font-weight:500;line-height:.98;letter-spacing:-.045em}
h1 span{display:block}
h1 span:nth-child(2){color:rgba(243,244,246,.72)}
.sub{position:absolute;left:72px;bottom:64px;color:#a9adb6;font-size:24px;letter-spacing:-.01em}
.sub b{color:#f3f4f6;font-weight:600}
.rc{position:absolute;right:70px;top:92px;width:350px;transform:rotate(-4deg);filter:drop-shadow(0 30px 40px rgba(0,0,0,.6))}
.paper{background:#fbfaf6;color:#16171b;border-radius:12px;padding:24px 24px 26px;font-size:15px}
.head{display:flex;justify-content:space-between;align-items:center;color:#5c5f66;font-size:12.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.tag{display:flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;background:#e7ecfb;color:#0033ad;letter-spacing:.04em}
.tag:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.item{margin-top:10px;font-size:23px;font-weight:650;letter-spacing:-.02em}
dl{display:grid;gap:8px;margin-top:16px}
dl div{display:grid;grid-template-columns:82px 1fr;gap:8px}
dt{color:#5c5f66}
dd{font-family:Menlo,monospace;font-size:13.5px;white-space:nowrap}
dd.l{color:#0033ad;font-weight:700}
.perf{margin:18px -24px 16px;border-top:2px dashed #d8d5cc}
.stamp{display:inline-block;padding:7px 14px;border:3px solid #0b7a45;border-radius:9px;box-shadow:inset 0 0 0 2px #fbfaf6,inset 0 0 0 3.5px #0b7a45;color:#0b7a45;font-size:22px;font-weight:800;transform:rotate(-4deg)}
.verdict{margin-top:12px;color:#0b7a45;font-size:14px;font-weight:600;line-height:1.35}
</style></head><body>
<span class="beam"></span>
<div class="brand"><svg viewBox="0 0 100 100">${markInner}</svg>ZyroPay</div>
<h1><span>Your AI asks.</span><span>Your passkey decides.</span><span>Cardano proves it.</span></h1>
<p class="sub">The permission layer for <b>Cardano’s agent economy</b></p>
<div class="rc"><div class="paper">
<p class="head"><span>Delivery receipt</span><span class="tag">${live ? "Live run" : "Example"}</span></p>
<p class="item">${r.item}</p>
<dl>
<div><dt>Paid</dt><dd style="font-family:Inter">${r.amount} · Masumi escrow</dd></div>
<div><dt>Received</dt><dd>${grouped(r.resultHash)}</dd></div>
<div><dt>On chain</dt><dd>${grouped(r.resultHash)}</dd></div>
${live ? `<div><dt>Lock</dt><dd class="l">${short(lock)} ↗</dd></div><div><dt>Result</dt><dd class="l">${short(result)} ↗</dd></div>` : ""}
</dl>
<div class="perf"></div>
<span class="stamp">Verified on Cardano ✓</span>
<p class="verdict">Proof verified on Cardano preprod.</p>
</div></div>
</body></html>`;
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(og, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
writeFileSync(root("public/og.png"), await page.screenshot({ type: "png" }));

await browser.close();
console.log("brand assets written: favicon.svg/.ico, icons/*, og.png");
