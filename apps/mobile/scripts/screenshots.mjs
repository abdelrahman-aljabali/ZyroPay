#!/usr/bin/env node
/*
 * Visual QA: render the app with Expo web in mock mode (EXPO_PUBLIC_USE_MOCKS=1)
 * and screenshot every screen at iPhone 15 Pro size (393×852 @3x) in light and
 * dark mode.
 *
 *   node scripts/screenshots.mjs                      # export a web build, serve it, shoot everything
 *   node scripts/screenshots.mjs --url http://localhost:8081   # use a running `expo start --web`
 *   node scripts/screenshots.mjs --only home,wallets  # a subset (by screen name prefix)
 *   node scripts/screenshots.mjs --scheme dark        # one colour scheme
 *   node scripts/screenshots.mjs --width 375          # another viewport width (height 852)
 *
 * Output: apps/mobile/screenshots/<scheme>/<name>.png, or <scheme>-<width>/ with --width
 * (git-ignored).
 *
 * Web is a QA target only: native tabs, Liquid Glass, Skia, haptics and the
 * keychain degrade to web fallbacks, so these images show layout, type, colour
 * and copy, not native chrome. Needs Playwright's Chromium:
 * `npx playwright install chromium`.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(APP_DIR, "screenshots");
const BUILD_DIR = join(OUT_DIR, ".web-build");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const only = arg("only")?.split(",").filter(Boolean);
const schemes = arg("scheme") ? [arg("scheme")] : ["light", "dark"];
const width = arg("width") ? Number(arg("width")) : undefined;

/* Deterministic ids from src/api/mock/fixtures.ts (fakeId(kind, n)). */
const fakeId = (kind, n) =>
  `0192f3a1-${kind.toString(16).padStart(4, "0")}-7000-8000-${n.toString(16).padStart(12, "0")}`;
const USER_ID = fakeId(1, 1);
const WALLET_MAIN = fakeId(2, 1);
const WALLET_SAVINGS = fakeId(2, 2);
const APPROVAL_ADA = fakeId(7, 5);
const APPROVAL_X402_ADA = fakeId(7, 6);
const APPROVAL_ESCROW = fakeId(7, 7);
const APPROVAL_ESCROW_LOCKED = fakeId(7, 8);
const AGENT_CLAUDE = fakeId(5, 1);
const AGENT_CHATGPT = fakeId(5, 2);
/* ADDR.friendAda in src/api/mock/fixtures.ts (a preprod key address). */
const ADA_FRIEND = "addr_test1vr4z0l8rhm4htfydw97p6mngl4e2f32cw6fw0hj5s7typeshv7hz7";

const SESSION = {
  accessToken: "simulated-access-screenshots",
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: "simulated-refresh-screenshots",
  refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  user: {
    id: USER_ID,
    email: "demo@zyropay.dev",
    displayName: "Simulated user",
    turnkeySubOrganizationId: "simulated-suborg-0000",
    createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  },
  simulated: true,
};

const prefs = (extra = {}) =>
  JSON.stringify({
    state: {
      // "System" so each run's emulated colour scheme decides (the app's default is light).
      theme: "system",
      currency: "USD",
      hideBalances: false,
      preferredNetwork: null,
      onboardingComplete: true,
      notificationsPrompted: true,
      analyticsOptIn: false,
      ...extra,
    },
    version: 3,
  });

/**
 * Every screen. `signedIn: false` shows onboarding. `steps` run after the
 * page loads (click by testID or text) to reach states a URL cannot express.
 */
const SCREENS = [
  { name: "onboarding-welcome", path: "/onboarding", signedIn: false },
  { name: "onboarding-intro", path: "/onboarding/intro", signedIn: false },
  { name: "onboarding-passkey", path: "/onboarding/passkey", signedIn: false },
  { name: "onboarding-wallet", path: "/onboarding/wallet", onboarding: true },
  { name: "onboarding-recovery", path: "/onboarding/recovery", onboarding: true },
  { name: "onboarding-notifications", path: "/onboarding/notifications", onboarding: true },
  { name: "onboarding-done", path: "/onboarding/done", onboarding: true },
  { name: "home", path: "/" },
  { name: "home-loading", path: "/", loading: "home-screen" },
  { name: "wallets-loading", path: "/wallets", loading: "wallets-screen" },
  { name: "home-hidden", path: "/", prefs: { hideBalances: true } },
  { name: "home-scrolled", path: "/", scroll: 700 },
  { name: "activity", path: "/activity" },
  { name: "asset-sol", path: "/asset/solana-devnet:native" },
  { name: "asset-ada", path: "/asset/cardano-preprod:native" },
  { name: "tx-detail", path: "/", steps: [{ clickFirst: "tx-row" }] },
  { name: "tx-detail-escrow-lock", path: `/tx/${fakeId(4, 10)}` },
  { name: "tx-detail-escrow-refund", path: `/tx/${fakeId(4, 11)}` },
  { name: "wallets", path: "/wallets" },
  { name: "wallets-add", path: "/wallets/add" },
  { name: "wallets-add-create", path: "/wallets/add/create" },
  { name: "wallets-add-watch", path: "/wallets/add/watch" },
  {
    name: "wallets-add-create-cardano",
    path: "/wallets/add/create",
    steps: [{ click: "create-chain-cardano-preprod" }],
  },
  {
    name: "wallets-add-watch-cardano",
    path: "/wallets/add/watch",
    steps: [
      { click: "watch-chain-cardano-preprod" },
      {
        fill: "wallets-watch-address",
        value: "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz",
      },
    ],
  },
  {
    name: "wallets-add-created",
    path: "/wallets/add/create",
    steps: [
      { click: "create-chain-base-sepolia" },
      { fill: "wallets-create-name", value: "Travel" },
      { click: "wallets-create-submit", waitMs: 2400 },
    ],
  },
  // ADR-003 import (mock mode: public test vectors only; typing/pasting disabled).
  { name: "wallets-import", path: "/wallets/add/import" },
  {
    name: "wallets-import-filled",
    path: "/wallets/add/import",
    steps: [{ click: "import-fill-test" }],
  },
  {
    name: "wallets-import-review",
    path: "/wallets/add/import",
    steps: [{ click: "import-fill-test" }, { click: "import-continue", waitMs: 2600 }],
  },
  {
    name: "wallets-import-review-cardano",
    path: "/wallets/add/import",
    steps: [
      { click: "import-fill-test" },
      { click: "import-continue", waitMs: 2600 },
      { click: "import-toggle-cardano" },
    ],
    scroll: 500,
  },
  {
    name: "wallets-import-key",
    path: "/wallets/add/import",
    steps: [{ click: "import-kind-key" }, { click: "import-fill-test-evm" }],
  },
  {
    name: "wallets-import-key-review",
    path: "/wallets/add/import",
    steps: [
      { click: "import-kind-key" },
      { click: "import-fill-test-solana" },
      { click: "import-continue" },
    ],
  },
  {
    name: "wallets-import-done",
    path: "/wallets/add/import",
    steps: [
      { click: "import-fill-test" },
      { click: "import-continue", waitMs: 2600 },
      { click: "import-toggle-cardano" },
      { fill: "import-name", value: "Old phone" },
      { click: "import-submit", waitMs: 4000 },
    ],
  },
  {
    name: "wallets-add-watch-filled",
    path: "/wallets/add/watch",
    steps: [
      { click: "watch-chain-solana-devnet" },
      { fill: "wallets-watch-address", value: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" },
    ],
  },
  {
    name: "wallets-add-watch-invalid",
    path: "/wallets/add/watch",
    steps: [
      { click: "watch-chain-base-sepolia" },
      { fill: "wallets-watch-address", value: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" },
    ],
  },
  {
    name: "wallets-watch-added",
    path: "/wallets/add/watch",
    steps: [
      { click: "watch-chain-solana-devnet" },
      { fill: "wallets-watch-address", value: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" },
      { fill: "wallets-watch-name", value: "Cold storage" },
      { click: "wallets-watch-submit", waitMs: 2400 },
    ],
    scroll: 900,
  },
  {
    name: "wallet-actions-sheet",
    path: "/wallets",
    steps: [{ clickLabel: "More actions for Main wallet" }],
  },
  {
    name: "wallet-rename-sheet",
    path: "/wallets",
    steps: [
      { clickLabel: "More actions for Main wallet" },
      { click: "wallet-action-rename", waitMs: 900 },
    ],
  },
  {
    name: "wallet-remove-blocked",
    path: "/wallets",
    steps: [
      { clickLabel: "More actions for Main wallet" },
      { click: "wallet-action-remove", waitMs: 900 },
      { click: "wallet-remove-sheet-confirm", waitMs: 1400 },
    ],
  },
  { name: "wallet-detail", path: `/wallets/${WALLET_MAIN}` },
  // Holds no SOL or Base ETH: the zero-balance coins still list with their price.
  { name: "wallet-detail-savings", path: `/wallets/${WALLET_SAVINGS}`, scroll: 900 },
  { name: "wallet-receive", path: `/wallets/${WALLET_MAIN}/receive` },
  {
    name: "wallet-receive-cardano",
    path: `/wallets/${WALLET_MAIN}/receive?network=cardano-preprod`,
  },
  {
    name: "wallet-receive-add-cardano",
    path: `/wallets/${WALLET_SAVINGS}/receive?network=cardano-preprod`,
  },
  { name: "wallet-export", path: `/wallets/${WALLET_MAIN}/export` },
  { name: "agents", path: "/agents" },
  { name: "agents-connect", path: "/agents/connect" },
  // Masumi agent registry (Cardano): search, filter, detail sheet, empty and error states.
  { name: "agents-discover", path: "/agents/discover" },
  { name: "agents-discover-scrolled", path: "/agents/discover", scroll: 700 },
  { name: "agents-discover-loading", path: "/agents/discover", loading: "discover-screen" },
  {
    name: "agents-discover-filtered",
    path: "/agents/discover",
    steps: [{ click: "discover-tag-tokens" }],
  },
  {
    name: "agents-discover-detail",
    path: "/agents/discover",
    steps: [{ text: "Cardano Address Intelligence", waitMs: 1200 }],
  },
  {
    name: "agents-discover-empty",
    path: "/agents/discover",
    steps: [{ fill: "discover-search", value: "nothing like this", waitMs: 1600 }],
  },
  {
    name: "agents-discover-error",
    path: "/agents/discover",
    steps: [{ fill: "discover-search", value: "simulate-error", waitMs: 6500 }],
  },
  {
    // Empty state: disconnect the two active agents in-app (the mock keeps state per page).
    name: "agents-empty",
    path: "/agents",
    steps: [
      { click: "agent-card-Claude" },
      { click: "agent-revoke", waitMs: 900 },
      { click: "agent-revoke-sheet-confirm", waitMs: 1600 },
      { back: true },
      { click: "agent-card-ChatGPT" },
      { click: "agent-revoke", waitMs: 900 },
      { click: "agent-revoke-sheet-confirm", waitMs: 1600 },
      { back: true, waitMs: 1800 },
    ],
  },
  { name: "agents-connect-claude", path: "/agents/connect/claude" },
  { name: "agents-connect-chatgpt", path: "/agents/connect/chatgpt" },
  { name: "agents-connect-grok", path: "/agents/connect/grok" },
  { name: "agents-claim", path: "/agents/claim" },
  { name: "agent-detail", path: `/agents/${AGENT_CLAUDE}` },
  { name: "agent-policy", path: `/agents/${AGENT_CLAUDE}/policy` },
  {
    name: "agent-policy-masumi",
    path: `/agents/${AGENT_CLAUDE}/policy`,
    steps: [
      { click: "policy-require-registered" },
      { fill: "policy-trusted-input", value: "a".repeat(56) + "b".repeat(64) },
      { click: "policy-trusted-add" },
      { fill: "policy-trusted-input", value: "not-an-identifier" },
      { click: "policy-trusted-add" },
    ],
    scrollTo: "policy-require-registered",
  },
  // Escrow on, Cardano not allowed for the agent: the one-tap fix.
  {
    name: "agent-policy-escrow",
    path: `/agents/${AGENT_CLAUDE}/policy`,
    steps: [{ click: "policy-escrow" }],
    scrollTo: "policy-escrow",
  },
  // A pasted Cardano address while the picker is on Solana switches it to Cardano.
  {
    name: "agent-policy-recipient",
    path: `/agents/${AGENT_CLAUDE}/policy`,
    steps: [{ fill: "allowlist-address", value: ADA_FRIEND }],
    scrollTo: "allowlist-address",
  },
  { name: "agent-activity", path: `/agents/${AGENT_CLAUDE}/activity` },
  // Auto-pay on Cardano (docs/AUTOPAY.md): the card, the setup, the review, live.
  { name: "agent-allowance-empty", path: `/agents/${AGENT_CHATGPT}`, scrollTo: "allowance-card" },
  { name: "agent-autopay", path: `/agents/${AGENT_CHATGPT}/autopay` },
  { name: "agent-autopay-scrolled", path: `/agents/${AGENT_CHATGPT}/autopay`, scroll: 900 },
  {
    name: "agent-autopay-invalid",
    path: `/agents/${AGENT_CHATGPT}/autopay`,
    steps: [{ fill: "autopay-perPayment", value: "25" }],
    scrollTo: "autopay-perPayment",
  },
  {
    name: "agent-autopay-review",
    path: `/agents/${AGENT_CHATGPT}/autopay`,
    steps: [{ click: "autopay-continue", waitMs: 2500 }],
  },
  {
    name: "agent-allowance-active",
    path: `/agents/${AGENT_CHATGPT}`,
    steps: [
      { click: "allowance-setup", waitMs: 2000 },
      { click: "autopay-continue", waitMs: 2500 },
      { click: "allowance-sheet-confirm", waitMs: 14000 },
    ],
    scrollTo: "allowance-card",
  },
  {
    name: "agent-allowance-active-details",
    path: `/agents/${AGENT_CHATGPT}`,
    steps: [
      { click: "allowance-setup", waitMs: 2000 },
      { click: "autopay-continue", waitMs: 2500 },
      { click: "allowance-sheet-confirm", waitMs: 14000 },
    ],
    scrollTo: "allowance-spends",
  },
  {
    name: "agent-activity-autopaid",
    path: `/agents/${AGENT_CHATGPT}`,
    steps: [
      { click: "allowance-setup", waitMs: 2000 },
      { click: "autopay-continue", waitMs: 2500 },
      { click: "allowance-sheet-confirm", waitMs: 14000 },
      { click: "agent-activity", waitMs: 2500 },
    ],
  },
  {
    name: "agent-request-autopaid",
    path: `/agents/${AGENT_CHATGPT}`,
    steps: [
      { click: "allowance-setup", waitMs: 2000 },
      { click: "autopay-continue", waitMs: 2500 },
      { click: "allowance-sheet-confirm", waitMs: 14000 },
      { click: "agent-activity", waitMs: 2500 },
      { textIn: { testId: "agent-activity-screen", text: "Auto-paid · allowance" }, waitMs: 2500 },
    ],
  },
  { name: "approvals", path: "/approvals" },
  { name: "approval-detail", path: "/approvals", steps: [{ clickFirst: "pending-approval" }] },
  { name: "approval-detail-cardano", path: `/approvals/${APPROVAL_ADA}` },
  { name: "approval-detail-x402", path: `/approvals/${APPROVAL_X402_ADA}` },
  { name: "approval-detail-x402-details", path: `/approvals/${APPROVAL_X402_ADA}`, scroll: 900 },
  // After the hold: the mock walks SIGNING -> BROADCAST (~4 s) -> CONFIRMED (~10 s).
  {
    name: "approval-x402-signed",
    path: `/approvals/${APPROVAL_X402_ADA}`,
    steps: [{ hold: "approval-hold-to-approve", waitMs: 1200 }],
  },
  {
    name: "approval-x402-submitted",
    path: `/approvals/${APPROVAL_X402_ADA}`,
    steps: [{ hold: "approval-hold-to-approve", waitMs: 6500 }],
  },
  {
    name: "approval-x402-paid",
    path: `/approvals/${APPROVAL_X402_ADA}`,
    steps: [{ hold: "approval-hold-to-approve", waitMs: 14000 }],
  },
  // x402 into Masumi escrow: the protection block, then the escrow timeline and refund flow.
  { name: "approval-escrow", path: `/approvals/${APPROVAL_ESCROW}` },
  {
    name: "approval-escrow-locked",
    path: `/approvals/${APPROVAL_ESCROW}`,
    steps: [{ hold: "approval-hold-to-approve", waitMs: 14000 }],
  },
  {
    name: "approval-escrow-delivered",
    path: `/approvals/${APPROVAL_ESCROW}`,
    steps: [{ hold: "approval-hold-to-approve", waitMs: 42000 }],
    scroll: 600,
  },
  { name: "approval-escrow-funds-locked", path: `/approvals/${APPROVAL_ESCROW_LOCKED}` },
  {
    name: "approval-escrow-timeline",
    path: `/approvals/${APPROVAL_ESCROW_LOCKED}`,
    scroll: 900,
  },
  {
    name: "approval-escrow-refund-sheet",
    path: `/approvals/${APPROVAL_ESCROW_LOCKED}`,
    steps: [{ click: "escrow-request-refund", waitMs: 1500 }],
  },
  {
    name: "approval-escrow-refund-requested",
    path: `/approvals/${APPROVAL_ESCROW_LOCKED}`,
    steps: [
      { click: "escrow-request-refund", waitMs: 1500 },
      { click: "escrow-sheet-confirm", waitMs: 7000 },
    ],
  },
  { name: "approvals-history", path: "/approvals/history" },
  { name: "settings", path: "/settings" },
  { name: "settings-security", path: "/settings/security" },
  { name: "settings-appearance", path: "/settings/appearance" },
  { name: "plugins", path: "/plugins" },
  ...["x402", "jupiter", "kamino", "aave", "hyperliquid"].map((id) => ({
    name: `plugin-detail-${id}`,
    path: `/plugins/${id}`,
  })),
  { name: "send", path: "/send" },
  { name: "topup", path: "/topup" },
];

async function run(cmd, cmdArgs, env) {
  await new Promise((ok, fail) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: APP_DIR,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
  });
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Static server with SPA fallback (the export is a single-page app). */
function serve(root) {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
      let file = join(root, url);
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
        file = join(root, "index.html");
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      ok({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function shoot(browser, baseUrl, scheme, screen) {
  const context = await browser.newContext({
    viewport: { width: width ?? 393, height: 852 },
    deviceScaleFactor: width !== undefined && width > 600 ? 1 : 3,
    isMobile: width === undefined || width <= 600,
    hasTouch: width === undefined || width <= 600,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const signedIn = screen.signedIn !== false;
  // Signed in but onboarding unfinished: the post-passkey onboarding steps.
  const onboardingComplete = signedIn && screen.onboarding !== true;
  await context.addInitScript(
    ({ session, prefsJson, signedIn }) => {
      if (window.sessionStorage.getItem("zp-seeded") === "1") return;
      window.localStorage.clear();
      // The web build keeps the API session in sessionStorage (src/state/storage.web.ts).
      if (signedIn) window.sessionStorage.setItem("zyropay.session.v1", session);
      window.localStorage.setItem("zyropay.prefs.v1", prefsJson);
      window.sessionStorage.setItem("zp-seeded", "1");
    },
    {
      session: JSON.stringify(SESSION),
      prefsJson: prefs({ onboardingComplete, ...(screen.prefs ?? {}) }),
      signedIn,
    },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (screen.loading) {
    // Shoot the first painted frame of the screen, before the (simulated) API answers.
    await page.goto(`${baseUrl}${screen.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-testid="${screen.loading}"]`, { timeout: 60_000 });
    await page.waitForTimeout(60);
  } else {
    await page.goto(`${baseUrl}${screen.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(screen.settleMs ?? 1600);
  }
  for (const step of screen.steps ?? []) {
    if (step.click) {
      await page.locator(`[data-testid="${step.click}"]`).first().click();
    } else if (step.clickLabel) {
      await page.getByLabel(step.clickLabel, { exact: true }).first().click();
    } else if (step.fill) {
      const target = page.locator(`[data-testid="${step.fill}"]`).first();
      await target.click();
      await target.fill(step.value);
    } else if (step.clickFirst) {
      await page.locator(`[data-testid^="${step.clickFirst}"]`).first().click();
    } else if (step.textIn) {
      // Text inside one screen (stacked web screens keep hidden copies of the same text).
      await page
        .locator(`[data-testid="${step.textIn.testId}"]`)
        .getByText(step.textIn.text, { exact: false })
        .first()
        .click();
    } else if (step.back) {
      await page.goBack();
    } else if (step.text) {
      await page.getByText(step.text, { exact: false }).first().click();
    } else if (step.hold) {
      // Press-and-hold controls (HoldToConfirm): a click is not enough.
      const target = page.locator(`[data-testid="${step.hold}"]`).first();
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (box === null) throw new Error(`${step.hold} has no box`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(2500);
      await page.mouse.up();
    }
    await page.waitForTimeout(step.waitMs ?? 1400);
  }
  if (screen.scrollTo) {
    await page
      .locator(`[data-testid="${screen.scrollTo}"]`)
      .first()
      .evaluate((el) => {
        el.scrollIntoView({ block: "center" });
      });
    await page.waitForTimeout(500);
  }
  if (screen.scroll) {
    await page.mouse.move(196, 500);
    await page.mouse.wheel(0, screen.scroll);
    await page.waitForTimeout(500);
  }
  const dir = join(OUT_DIR, width === undefined ? scheme : `${scheme}-${String(width)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${screen.name}.png`);
  await page.screenshot({ path: file });
  await context.close();
  return { file, errors };
}

async function main() {
  let baseUrl = arg("url");
  let server = null;
  if (!baseUrl) {
    rmSync(BUILD_DIR, { recursive: true, force: true });
    // --clear: EXPO_PUBLIC_* values are inlined at transform time, and Metro's cache can
    // otherwise serve modules transformed for a real-mode build (EXPO_PUBLIC_USE_MOCKS=0).
    await run(
      "npx",
      ["expo", "export", "--platform", "web", "--output-dir", BUILD_DIR, "--clear"],
      {
        EXPO_PUBLIC_USE_MOCKS: "1",
        EXPO_PUBLIC_ZYROPAY_MODE: "development",
      },
    );
    ({ server, url: baseUrl } = await serve(BUILD_DIR));
  }
  const browser = await chromium.launch();
  const screens = only ? SCREENS.filter((s) => only.some((o) => s.name.startsWith(o))) : SCREENS;
  let failures = 0;
  for (const scheme of schemes) {
    for (const screen of screens) {
      try {
        const { file, errors } = await shoot(browser, baseUrl, scheme, screen);
        console.log(
          `✓ ${scheme}/${screen.name}${errors.length ? `  (page errors: ${errors.join(" | ")})` : ""}`,
        );
        if (errors.length) failures++;
        void file;
      } catch (e) {
        failures++;
        console.log(`✗ ${scheme}/${screen.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await browser.close();
  server?.close();
  console.log(`\n${String(screens.length * schemes.length)} screenshots in ${OUT_DIR}`);
  if (failures > 0) {
    console.log(`${String(failures)} screen(s) had errors`);
    process.exitCode = 1;
  }
}

await main();
