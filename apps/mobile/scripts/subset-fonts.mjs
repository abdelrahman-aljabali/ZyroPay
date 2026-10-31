#!/usr/bin/env node
/*
 * Web fonts: subset the four Inter weights the app uses to Latin (+ the symbols the UI
 * prints) as WOFF2 in public/fonts/, so the web app can preload them from index.html.
 *
 * The full TTFs from @expo-google-fonts/inter are ~335 KB each (~128 KB brotli) and were only
 * requested after the whole JS bundle had run; the subsets are a fraction of that and load in
 * parallel with the JS. Native builds keep using the full TTFs through expo-font.
 *
 * Needs fonttools with brotli (`pip install fonttools brotli`); run after bumping
 * @expo-google-fonts/inter and commit the output. The package version is in the file names, so
 * the files can be cached as immutable (docs/IMPLEMENTATION_STATUS.md, web host headers).
 *
 *   node scripts/subset-fonts.mjs [--pyftsubset /path/to/pyftsubset]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(APP, "package.json"));
const pkgDir = dirname(require.resolve("@expo-google-fonts/inter/package.json"));
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const out = join(APP, "public", "fonts");
mkdirSync(out, { recursive: true });

const args = process.argv.slice(2);
const tool = args.includes("--pyftsubset") ? args[args.indexOf("--pyftsubset") + 1] : "pyftsubset";

// Basic Latin, Latin-1, Latin Extended-A bits, punctuation, currency, arrows, math the UI uses.
const UNICODES = [
  "U+0020-007E",
  "U+00A0-00FF",
  "U+0131",
  "U+0152-0153",
  "U+02C6",
  "U+02DA",
  "U+02DC",
  "U+03A3",
  "U+2000-206F",
  "U+20AC",
  "U+20B9",
  "U+20BD",
  "U+2122",
  "U+2190-2199",
  "U+2212",
  "U+2248",
  "U+2260",
  "U+2264-2265",
  "U+2713",
].join(",");

for (const [weight, dir, file] of [
  [400, "400Regular", "Inter_400Regular.ttf"],
  [500, "500Medium", "Inter_500Medium.ttf"],
  [600, "600SemiBold", "Inter_600SemiBold.ttf"],
  [700, "700Bold", "Inter_700Bold.ttf"],
]) {
  const target = join(out, `inter-${version}-${String(weight)}.woff2`);
  const res = spawnSync(
    tool,
    [
      join(pkgDir, dir, file),
      `--unicodes=${UNICODES}`,
      "--flavor=woff2",
      "--layout-features+=tnum,case",
      "--no-hinting",
      "--desubroutinize",
      `--output-file=${target}`,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) {
    console.error(`${tool} failed (pip install fonttools brotli)`);
    process.exit(1);
  }
  console.log(`${target}: ${(statSync(target).size / 1024).toFixed(1)} KB`);
}
