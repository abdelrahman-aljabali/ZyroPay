// Generates the app icon, adaptive icon layers, splash mark, Android notification icon,
// favicon and PWA icons from the ZyroPay mark. Run: pnpm --filter @zyropay/mobile icons
//
// Source of truth: assets/brand/zyropay-mark.svg (black petals on a white 100x100 rounded
// square). The petal path is read from that file, so every PNG matches it exactly; the UI
// component (packages/ui/src/icons/ZyroMark.tsx) carries the same path, and a unit test
// keeps the two identical.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MARK_SVG = join(appDir, "..", "..", "assets", "brand", "zyropay-mark.svg");

const source = readFileSync(MARK_SVG, "utf8");
const glyph = /<path[^>]*\sd="([^"]+)"/.exec(source)?.[1];
const tileRx = Number(/<rect[^>]*\srx="([\d.]+)"/.exec(source)?.[1] ?? Number.NaN);
if (!glyph || !Number.isFinite(tileRx))
  throw new Error(`${MARK_SVG}: expected one <rect rx> and one <path d>`);

const out = join(appDir, "assets", "images");
// PWA icons (web manifest + Apple touch icon), served from the web build's root.
const webOut = join(appDir, "public", "icons");
mkdirSync(out, { recursive: true });
mkdirSync(webOut, { recursive: true });

const INK = "#000000";
const WHITE = "#FFFFFF";

/**
 * The petals centred on a square canvas, scaled by `scale` (1 = as in the source SVG, where
 * they span about 70% of the tile). `bg`: "tile" = the rounded white square (transparent
 * corners), "square" = full-bleed white (for masks the OS applies), null = transparent.
 */
function svg({ size, fg = INK, bg, scale = 1 }) {
  const offset = (100 - 100 * scale) / 2;
  const back =
    bg === "tile"
      ? `<rect width="100" height="100" rx="${String(tileRx)}" fill="${WHITE}"/>`
      : bg === "square"
        ? `<rect width="100" height="100" fill="${WHITE}"/>`
        : "";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 100 100">${back}<g transform="translate(${String(offset)} ${String(offset)}) scale(${String(scale)})"><path d="${glyph}" fill="${fg}"/></g></svg>`,
  );
}

const jobs = [
  // iOS/universal icon: full-bleed white, black petals (iOS applies its own rounded mask).
  ["icon.png", svg({ size: 1024, bg: "square" })],
  // Android adaptive icon: the petals inside the 66% safe zone over a white background
  // layer (backgroundColor in app.config.ts). Monochrome (themed icons) uses only alpha.
  ["android-icon-foreground.png", svg({ size: 1024, bg: null, scale: 0.86 })],
  ["android-icon-monochrome.png", svg({ size: 1024, fg: WHITE, bg: null, scale: 0.86 })],
  // Splash mark on the white launch screen (light, whatever the OS setting).
  ["splash-icon.png", svg({ size: 512, bg: null, scale: 1.25 })],
  // Android notification icon: a white silhouette on transparent.
  ["notification-icon.png", svg({ size: 96, fg: WHITE, bg: null, scale: 1.25 })],
  // Browser tab: the white tile reads on light and dark tab strips.
  ["favicon.png", svg({ size: 48, bg: "tile" })],
];

const webJobs = [
  ["icon-192.png", svg({ size: 192, bg: "tile" })],
  ["icon-512.png", svg({ size: 512, bg: "tile" })],
  // Maskable: full-bleed white; the petals stay inside the 80% safe circle.
  ["icon-maskable-512.png", svg({ size: 512, bg: "square", scale: 0.9 })],
  // iOS ignores transparency (it would turn black): full-bleed white.
  ["apple-touch-icon.png", svg({ size: 180, bg: "square" })],
];

for (const [name, data] of jobs) {
  await sharp(data).png().toFile(join(out, name));
  console.log(`wrote assets/images/${name}`);
}
for (const [name, data] of webJobs) {
  await sharp(data).png().toFile(join(webOut, name));
  console.log(`wrote public/icons/${name}`);
}
// Scalable favicon for browsers that prefer SVG: the source file itself.
copyFileSync(MARK_SVG, join(webOut, "favicon.svg"));
console.log("wrote public/icons/favicon.svg");
