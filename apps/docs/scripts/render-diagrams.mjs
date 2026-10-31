#!/usr/bin/env node
/* global document */
/*
 * Pre-renders every diagrams/*.mmd (Mermaid) to static SVG, once per colour scheme:
 *
 *   public/diagrams/<name>-light.svg
 *   public/diagrams/<name>-dark.svg
 *
 * The site shows them as plain <img> (src/components/Diagram.astro), so no Mermaid or other
 * diagram JavaScript reaches the browser. Rendering needs a headless Chromium (Playwright),
 * so it runs on demand and the SVGs are committed:
 *
 *   node scripts/render-diagrams.mjs            render all (or: ... <name> <name>)
 *   node scripts/render-diagrams.mjs --check    no browser: fail if any SVG is missing or stale
 *
 * Each SVG carries the SHA-256 of its inputs (source, diagram-theme.mjs, Mermaid version) in a
 * comment; --check (part of `pnpm build`) compares it, so a diagram can never silently
 * disagree with its source.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, SCHEME_CSS, THEMES, TOKENS, sequenceLanes } from "./diagram-theme.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "diagrams");
const OUT = join(ROOT, "public", "diagrams");
const require = createRequire(import.meta.url);
const MERMAID_JS = require.resolve("mermaid/dist/mermaid.min.js");
const MERMAID_VERSION = JSON.parse(
  readFileSync(join(MERMAID_JS, "..", "..", "package.json"), "utf8"),
).version;
const THEME_SOURCE = readFileSync(join(ROOT, "scripts", "diagram-theme.mjs"), "utf8");
const SCHEMES = /** @type {const} */ (["light", "dark"]);
/** Inter, embedded in every SVG (see FONT in diagram-theme.mjs). */
const INTER_FACE = `@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(
  join(ROOT, "public", "fonts", "inter-var-opsz.woff2"),
).toString("base64")}) format("woff2")}`;

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.filter((a) => !a.startsWith("--"));

const names = readdirSync(SRC)
  .filter((f) => f.endsWith(".mmd"))
  .map((f) => f.slice(0, -4))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

const inputHash = (source) =>
  createHash("sha256").update(`${MERMAID_VERSION}\n${THEME_SOURCE}\n${source}`).digest("hex");
const stamp = (hash) => `<!-- zyropay-diagram sha256:${hash} -->`;

if (check) {
  const stale = [];
  for (const name of names) {
    const hash = inputHash(readFileSync(join(SRC, `${name}.mmd`), "utf8"));
    for (const scheme of SCHEMES) {
      const file = join(OUT, `${name}-${scheme}.svg`);
      if (!existsSync(file) || !readFileSync(file, "utf8").includes(stamp(hash))) {
        stale.push(`${name}-${scheme}.svg`);
      }
    }
  }
  if (stale.length > 0) {
    console.error(
      `diagrams: ${stale.length} SVG(s) missing or stale: ${stale.join(", ")}\n` +
        "Run: pnpm --filter @zyropay/docs diagrams",
    );
    process.exit(1);
  }
  console.log(`diagrams: ${names.length} diagrams up to date (light + dark)`);
  process.exit(0);
}

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><head><style>${INTER_FACE}</style></head><body></body></html>`);
// Mermaid measures labels as it lays out, so Inter must be ready first.
await page.evaluate(() => Promise.all(["400", "600", "700"].map((w) => document.fonts.load(`${w} 14px Inter`))));
await page.addScriptTag({ path: MERMAID_JS });

let failed = false;
for (const name of names) {
  const source = readFileSync(join(SRC, `${name}.mmd`), "utf8");
  const hash = inputHash(source);
  const actors = (source.match(/^\s*(participant|actor)\s/gm) ?? []).length;
  const sequence = actors > 0 ? { ...CONFIG.sequence, ...sequenceLanes(actors) } : CONFIG.sequence;
  for (const scheme of SCHEMES) {
    const code = source.replace(/\{\{(\w+)\}\}/g, (m, key) => {
      const value = TOKENS[scheme][key];
      if (value === undefined) throw new Error(`${name}.mmd: unknown token ${m}`);
      return value;
    });
    try {
      const svg = await page.evaluate(
        async ({ code, config, themeVariables, id, interFace }) => {
          const mermaid = globalThis.mermaid;
          mermaid.initialize({ ...config, themeVariables });
          // Sequence messages that Mermaid wraps badly (self-messages, and words longer than
          // the room between two lanes) are wrapped here instead, between words only, measured
          // in the diagram font at the message size.
          if (/^\s*sequenceDiagram/m.test(code)) {
            const seq = config.sequence;
            const lane = seq.width + seq.actorMargin;
            const order = [...code.matchAll(/^\s*(?:participant|actor)\s+(\w+)/gm)].map(
              (m) => m[1],
            );
            const ctx = document.createElement("canvas").getContext("2d");
            ctx.font = `${String(seq.messageFontSize)}px ${themeVariables.fontFamily}`;
            const wrap = (text, max) => {
              const lines = [];
              let line = "";
              for (const word of text.split(/\s+/)) {
                const next = line ? `${line} ${word}` : word;
                if (line && ctx.measureText(next).width > max) {
                  lines.push(line);
                  line = word;
                } else line = next;
              }
              if (line) lines.push(line);
              return lines.join("<br/>");
            };
            code = code.replace(
              /^(\s*)(\w+)(\s*-{1,2}>>?|\s*-{1,2}[x)])(\s*)(\w+)(\s*):(.*)$/gm,
              (line, ind, from, arrow, sp, to, sp2, text) => {
                const span = Math.abs(order.indexOf(from) - order.indexOf(to));
                // A self-message has its loop on one side: about one lane of room.
                const max = span === 0 ? lane * 1.3 : lane * span - 36;
                const words = text.trim().split(/\s+/);
                // Mermaid wraps ordinary messages well; take over only where it would break
                // inside a word or stack a self-message one word per line.
                const ours = span === 0 || words.some((w) => ctx.measureText(w).width > max);
                return ours
                  ? `${ind}${from}${arrow}${sp}${to}${sp2}: nowrap:${wrap(text.trim(), max)}`
                  : line;
              },
            );
            // Notes: Mermaid sizes the box a little narrower than Inter sets the text, so the
            // lines are broken here to fit inside it with room to spare.
            const noteCtx = document.createElement("canvas").getContext("2d");
            noteCtx.font = `${String(seq.noteFontSize)}px ${themeVariables.fontFamily}`;
            code = code.replace(
              /^(\s*Note\s+(?:over|left of|right of)\s+)(\w+)(?:\s*,\s*(\w+))?(\s*):(.*)$/gm,
              (line, head, a, b, sp, text) => {
                const span = b ? Math.abs(order.indexOf(a) - order.indexOf(b)) : 0;
                const max = span === 0 ? seq.width * 1.1 : lane * span;
                const lines = [];
                let cur = "";
                for (const word of text.trim().split(/\s+/)) {
                  const next = cur ? `${cur} ${word}` : word;
                  if (cur && noteCtx.measureText(next).width > max) {
                    lines.push(cur);
                    cur = word;
                  } else cur = next;
                }
                if (cur) lines.push(cur);
                return `${head}${a}${b ? `,${b}` : ""}${sp}: nowrap:${lines.join("<br/>")}`;
              },
            );
          }
          const { svg } = await mermaid.render(id, code);
          const doc = new DOMParser().parseFromString(
            svg.replaceAll("&nbsp;", "&#160;"),
            "image/svg+xml",
          );
          if (doc.querySelector("parsererror")) throw new Error("output is not valid XML");
          const root = doc.documentElement;
          const [, , w, h] = (root.getAttribute("viewBox") ?? "0 0 0 0").split(/\s+/).map(Number);
          root.removeAttribute("style");
          root.setAttribute("width", String(Math.ceil(w)));
          root.setAttribute("height", String(Math.ceil(h)));
          root.setAttribute("role", "img");
          const face = doc.createElementNS("http://www.w3.org/2000/svg", "style");
          face.textContent = interFace;
          root.insertBefore(face, root.firstChild);
          return new XMLSerializer().serializeToString(doc);
        },
        {
          code,
          config: { ...CONFIG, sequence, themeCSS: CONFIG.themeCSS + SCHEME_CSS[scheme] },
          themeVariables: THEMES[scheme],
          id: `d-${name}-${scheme}`,
          interFace: INTER_FACE,
        },
      );
      writeFileSync(join(OUT, `${name}-${scheme}.svg`), `${stamp(hash)}\n${svg}\n`);
    } catch (error) {
      failed = true;
      console.error(`diagrams: ${name} (${scheme}) failed: ${String(error)}`);
    }
  }
  if (!failed) console.log(`diagrams: ${name} rendered`);
}
await browser.close();
if (failed) process.exit(1);
