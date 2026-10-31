import { useEffect } from "react";
import type { ColorScheme, ThemePreference } from "@zyropay/ui";

const BACKGROUND: Readonly<Record<ColorScheme, string>> = { light: "#FFFFFF", dark: "#000000" };

/**
 * Web: keeps the document in step with the in-app theme. public/theme-boot.js sets the same
 * attributes before the bundle runs (so a dark choice does not flash white); this hook takes
 * over once React renders: page background, form controls and scrollbars (color-scheme),
 * and the browser chrome colour (theme-color).
 */
export function useApplyColorScheme(_preference: ThemePreference, scheme: ColorScheme): void {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = scheme;
    root.style.colorScheme = scheme;
    for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) {
      meta.setAttribute("content", BACKGROUND[scheme]);
    }
  }, [scheme]);
}
