// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

/*
 * Static marketing site. Every page is prerendered; the hero stories hydrate as React islands.
 * Styles are always emitted as files (never inline) so the CSP can stay strict; the few inline
 * scripts Astro needs for island hydration are hashed into the CSP by scripts/postbuild.mjs.
 */
export default defineConfig({
  site: "https://zyropay.online",
  output: "static",
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "never", assets: "_assets" },
  integrations: [react()],
  devToolbar: { enabled: false },
  prefetch: false,
  vite: {
    build: { assetsInlineLimit: 0, cssCodeSplit: true },
  },
});
