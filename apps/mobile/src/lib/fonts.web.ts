/**
 * Web: the Inter faces are declared with @font-face in public/index.html (Latin WOFF2
 * subsets from scripts/subset-fonts.mjs, preloaded in parallel with the JS). Nothing to wait
 * for here, so the first screen renders as soon as the JS has run, and the 4 full TTFs
 * (~1.3 MB) are not part of the web export.
 */
export function useAppFonts(): readonly [loaded: boolean, error: Error | null] {
  return [true, null];
}
