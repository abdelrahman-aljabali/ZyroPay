import { describe, expect, it } from "vitest";
import { BRAND_SVGS } from "./svgs.generated";

/* Freshness against src/brand/svg/*.svg is checked by `node scripts/brand-svgs.mjs --check` (part of `test`). */
describe("bundled brand SVGs", () => {
  it("are inert vectors: no scripts, raster images, external references or CSS classes", () => {
    for (const { xml } of Object.values(BRAND_SVGS)) {
      expect(xml).not.toMatch(/<script|<foreignObject|<image|<style|class=|on[a-z]+=/i);
      expect(xml).not.toMatch(/href="(?!#)|url\((?!#)/);
      expect(xml).toMatch(/viewBox="/);
      // BrandMark makes ids unique per instance by rewriting id="zp…" and url(#zp…) only, so a
      // <use href="#…"> would point at a stale id (inline such references at import time).
      expect(xml).not.toMatch(/<use|href="#/);
    }
  });

  it("keep gradient and clip ids unique across files (several marks share one web page)", () => {
    const ids = Object.values(BRAND_SVGS).flatMap(({ xml }) =>
      [...xml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(new Set(ids).size).toBe(ids.length);
    // BrandMark rewrites the "zp" prefix per instance; an unprefixed id would escape that.
    for (const id of ids) expect(id).toMatch(/^zp/);
  });
});
