import { describe, expect, it } from "vitest";
import { darkColors, lightColors, radii, sizes, typography } from "./index";

/** WCAG relative luminance contrast for #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r = 0, g = 0, bl = 0] = channels.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens", () => {
  it("match the brand spec exactly", () => {
    expect(lightColors.background).toBe("#FFFFFF");
    expect(darkColors.background).toBe("#000000");
    expect(lightColors.surface).toBe("#F2F2F2");
    expect(darkColors.surface).toBe("#1C1C1E");
    expect(lightColors.text).toBe("#111111");
    expect(lightColors.textSecondary).toBe("#6E6E73");
    expect(darkColors.textSecondary).toBe("#8E8E93");
    expect([lightColors.primary, lightColors.onPrimary]).toEqual(["#111111", "#FFFFFF"]);
    expect([darkColors.primary, darkColors.onPrimary]).toEqual(["#FFFFFF", "#000000"]);
    expect([lightColors.success, darkColors.success]).toEqual(["#127548", "#30D158"]);
    expect([lightColors.danger, darkColors.danger]).toEqual(["#D93025", "#FF453A"]);
  });

  it("keeps text readable (WCAG AA)", () => {
    for (const c of [lightColors, darkColors]) {
      expect(contrast(c.text, c.background)).toBeGreaterThan(7);
      expect(contrast(c.textSecondary, c.background)).toBeGreaterThan(4.5);
      expect(contrast(c.onPrimary, c.primary)).toBeGreaterThan(7);
      expect(contrast(c.caution, c.cautionSoft)).toBeGreaterThan(4.5);
      // Secondary text and amber labels also sit on grouped (surface) cards.
      expect(contrast(c.textSecondary, c.surface)).toBeGreaterThan(4.5);
      expect(contrast(c.caution, c.surface)).toBeGreaterThan(4.5);
      // Incoming amounts are success-coloured 17-pt text: hold them to 4.5:1 too.
      expect(contrast(c.success, c.background)).toBeGreaterThan(4.5);
      expect(contrast(c.success, c.surface)).toBeGreaterThan(4.5);
      expect(contrast(c.danger, c.background)).toBeGreaterThan(4.5);
      expect(contrast(c.danger, c.dangerSoft)).toBeGreaterThan(3);
    }
  });

  it("uses the specified type scale and shapes", () => {
    expect(typography.balance.fontSize).toBe(64);
    expect(typography.title.fontSize).toBeGreaterThanOrEqual(34);
    expect(typography.display.fontSize).toBeLessThanOrEqual(40);
    expect(sizes.buttonHeight).toBe(56);
    expect(radii.card).toBeGreaterThanOrEqual(24);
    expect(radii.sheet).toBeLessThanOrEqual(28);
  });
});
