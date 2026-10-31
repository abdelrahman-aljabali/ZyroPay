import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

/*
 * Cross-browser web E2E (`pnpm test:web`): the full UI journey in MOCK mode (simulated
 * data and signer, no Turnkey, no API) on Chromium, WebKit (Safari's engine) and Firefox at
 * a phone (iPhone 15/16 Pro, 393×852), a large Android phone (412×915) and a laptop
 * (1440×900). The REAL passkey path runs only on Chromium (CDP virtual authenticator) and
 * only when E2E_REAL_URL points at a real-mode stack (see real-passkey.spec.ts).
 */
const PORT = Number(process.env.E2E_WEB_PORT ?? 8790);
const BASE_URL = process.env.E2E_WEB_URL ?? `http://127.0.0.1:${String(PORT)}`;

type Use = NonNullable<PlaywrightTestConfig["use"]>;
const VIEWPORTS: Record<string, Use> = {
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true },
  android: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false },
};
const BROWSERS = ["chromium", "webkit", "firefox"] as const;

export default defineConfig({
  testDir: ".",
  outputDir: "./.results",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI !== undefined ? 1 : 0,
  workers: process.env.CI !== undefined ? 3 : 4,
  reporter: process.env.CI !== undefined ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    ...BROWSERS.flatMap((browserName) =>
      Object.entries(VIEWPORTS).map(([device, use]) => ({
        name: `${browserName}-${device}`,
        testMatch: /(journey|embed)\.spec\.ts/,
        use: {
          browserName,
          ...use,
          // Firefox does not support `isMobile` (meta viewport emulation).
          isMobile: browserName !== "firefox" && device !== "desktop",
        },
      })),
    ),
    {
      name: "chromium-real-passkey",
      testMatch: /real-passkey\.spec\.ts/,
      use: { browserName: "chromium", ...VIEWPORTS.iphone, isMobile: true },
    },
  ],
  ...(process.env.E2E_WEB_URL === undefined
    ? {
        webServer: {
          command: `node e2e-web/server.mjs ${String(PORT)}`,
          cwd: "..",
          url: BASE_URL,
          // The first run exports the web build (a few minutes on a cold Metro cache).
          timeout: 600_000,
          reuseExistingServer: process.env.CI === undefined,
          stdout: "pipe",
        },
      }
    : {}),
});
