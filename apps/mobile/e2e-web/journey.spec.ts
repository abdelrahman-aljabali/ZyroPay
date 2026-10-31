import type { Page } from "@playwright/test";
import {
  AGENT_CHATGPT,
  AGENT_CLAUDE,
  fakeId,
  APPROVAL_1,
  APPROVAL_2,
  APPROVAL_ESCROW,
  APPROVAL_ESCROW_LOCKED,
  APPROVAL_X402_ADA,
  expect,
  expectSoundLayout,
  seed,
  test,
  tid,
  WALLET_MAIN,
} from "./helpers";

/*
 * The full UI journey in mock mode (simulated data, simulated signer): what a user does on
 * a phone or a laptop, plus layout invariants (no horizontal overflow, touch targets) on
 * every screen it passes. Runs once per browser × viewport project.
 */

async function open(page: Page, path: string, screen: string): Promise<void> {
  await page.goto(path);
  await expect(tid(page, screen)).toBeVisible();
  await expect(tid(page, "simulated-banner")).toBeVisible();
}

/** Relative luminance (0 black .. 1 white) of the first opaque background behind `id`. */
async function luminanceBehind(page: Page, id: string): Promise<number> {
  return page.evaluate((testId) => {
    let el: Element | null = document.querySelector(`[data-testid="${testId}"]`);
    for (; el; el = el.parentElement) {
      const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(
        getComputedStyle(el).backgroundColor,
      );
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
        const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255) as [
          number,
          number,
          number,
        ];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
    }
    return 1; // nothing opaque: the default white canvas
  }, id);
}

/** Type into a React Native Web TextInput the way a user does (focus, then keys). */
async function typeInto(page: Page, id: string, text: string, shown = text): Promise<void> {
  const input = tid(page, id);
  await input.click();
  await input.fill(text);
  await expect(input).toHaveValue(shown);
}

test("onboarding: create an account with the simulated passkey and land on Home", async ({
  page,
}) => {
  await seed(page, { signedIn: false });
  await open(page, "/onboarding", "onboarding-welcome");
  await expectSoundLayout(page, "welcome");
  await tid(page, "welcome-create").click();
  await expect(tid(page, "onboarding-intro")).toBeVisible();
  await expectSoundLayout(page, "intro");
  await tid(page, "intro-continue").click();
  await expect(tid(page, "onboarding-passkey")).toBeVisible();
  await typeInto(page, "passkey-name", "Playwright");
  await expectSoundLayout(page, "passkey");
  await tid(page, "passkey-continue").click();
  await expect(tid(page, "onboarding-wallet")).toBeVisible();
  await expect(page.getByText("Main wallet").first()).toBeVisible();
  await tid(page, "wallet-continue").click();
  await expect(tid(page, "onboarding-recovery")).toBeVisible();
  await tid(page, "recovery-understood").click();
  await tid(page, "recovery-continue").click();
  await expect(tid(page, "onboarding-notifications")).toBeVisible();
  await tid(page, "notifications-skip").click();
  await expect(tid(page, "onboarding-done")).toBeVisible();
  await tid(page, "done-open").click();
  await expect(tid(page, "home-screen")).toBeVisible();
});

test("home: balance, actions, assets and activity", async ({ page }) => {
  await seed(page);
  await open(page, "/", "home-screen");
  await expect(tid(page, "home-balance")).toBeVisible();
  await expect(tid(page, "action-send")).toBeVisible();
  await expect(tid(page, "action-receive")).toBeVisible();
  await expect(page.locator('[data-testid^="asset-row-"]').first()).toBeVisible();
  await expectSoundLayout(page, "home");
  // The list scrolls inside the app's scroll view (body never scrolls on the web).
  await page.locator('[data-testid^="tx-row-"]').first().scrollIntoViewIfNeeded();
  await expect(page.locator('[data-testid^="tx-row-"]').first()).toBeInViewport();
  await page.locator('[data-testid^="tx-row-"]').first().click();
  await expect(page.getByText("Transaction", { exact: false }).first()).toBeVisible();
});

test("wallets: create a wallet with the passkey", async ({ page }) => {
  await seed(page);
  await open(page, "/wallets", "wallets-screen");
  await expectSoundLayout(page, "wallets");
  await tid(page, "wallets-add").click();
  await tid(page, "add-wallet-create").click();
  await tid(page, "create-chain-base-sepolia").click();
  await typeInto(page, "wallets-create-name", "Travel");
  await expectSoundLayout(page, "create wallet");
  await tid(page, "wallets-create-submit").click();
  await expect(page.getByText("Wallet created with your passkey")).toBeVisible();
});

test("wallets: watch an address (validated per chain)", async ({ page }) => {
  await seed(page);
  await open(page, "/wallets/add/watch", "wallets-watch-screen");
  await tid(page, "watch-chain-base-sepolia").click();
  await typeInto(page, "wallets-watch-address", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  await expect(page.getByText(/not a valid|isn't a valid|valid .*address/i).first()).toBeVisible();
  await tid(page, "watch-chain-solana-devnet").click();
  await typeInto(page, "wallets-watch-name", "Cold storage");
  await expectSoundLayout(page, "watch");
  await tid(page, "wallets-watch-submit").click();
  await expect(page.getByText("Cold storage").first()).toBeVisible();
  await expect(page.getByText("Watch only").first()).toBeVisible();
});

test("wallets: import a recovery phrase (public test vector)", async ({ page }) => {
  await seed(page);
  await page.goto("/wallets/add/import");
  await tid(page, "import-fill-test").click();
  await expectSoundLayout(page, "import phrase");
  await tid(page, "import-continue").click();
  await expect(tid(page, "import-name")).toBeVisible({ timeout: 20_000 });
  await typeInto(page, "import-name", "Old phone");
  await tid(page, "import-submit").click();
  await expect(page.getByText(/imported/i).first()).toBeVisible({ timeout: 20_000 });
});

test("send: asset, recipient, amount, review, confirm", async ({ page }) => {
  await seed(page);
  await open(page, "/send", "send-choose-asset");
  await expectSoundLayout(page, "send asset");
  await page.locator('[data-testid^="send-asset-SOL-"]').first().click();
  await expect(tid(page, "send-recipient")).toBeVisible();
  await typeInto(page, "send-recipient-input", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  await tid(page, "send-recipient-continue").click();
  await expect(tid(page, "send-amount")).toBeVisible();
  await typeInto(page, "send-amount-input", "0.01");
  await expectSoundLayout(page, "send amount");
  await tid(page, "send-amount-continue").click();
  await expect(tid(page, "send-review")).toBeVisible();
  await expect(tid(page, "send-confirm")).toBeEnabled();
  await expectSoundLayout(page, "send review");
  await tid(page, "send-confirm").click();
  await expect(tid(page, "send-status")).toBeVisible({ timeout: 20_000 });
  await tid(page, "send-done").click();
});

test("receive: address and QR code", async ({ page }) => {
  await seed(page);
  await open(page, `/wallets/${WALLET_MAIN}/receive`, "receive-screen");
  await expect(tid(page, "receive-address")).toBeVisible();
  await expect(page.locator("svg").first()).toBeVisible();
  await expect(tid(page, "receive-copy")).toBeVisible();
  await expectSoundLayout(page, "receive");
});

test("approvals: approve with press-and-hold", async ({ page }) => {
  await seed(page);
  await open(page, `/approvals/${APPROVAL_1}`, "approval-detail");
  await expectSoundLayout(page, "approval");
  const hold = tid(page, "approval-hold-to-approve");
  await hold.scrollIntoViewIfNeeded();
  const box = await hold.boundingBox();
  if (box === null) throw new Error("hold button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2_500);
  await page.mouse.up();
  await expect(tid(page, "approval-approved")).toBeVisible({ timeout: 20_000 });
  await tid(page, "approval-done").click();
});

test("approvals: an x402 Cardano payment says what it buys and follows it to Paid", async ({
  page,
}) => {
  await seed(page);
  await open(page, `/approvals/${APPROVAL_X402_ADA}`, "approval-detail");
  const what = tid(page, "approval-x402-resource");
  await expect(what).toContainText("What you're paying for");
  await expect(what).toContainText("Cardano address intelligence report");
  await expect(what).toContainText("address-intel.zyropay.online");
  const card = tid(page, "approval-card");
  await expect(card).toContainText("2 ADA");
  await expect(card).toContainText("Seller");
  await expect(card).toContainText("Cardano Preprod");
  await expect(card).toContainText("Testnet");
  await expect(card).toContainText("Cardano payments always ask for your passkey");
  // The full URL stays available under Details.
  await expect(tid(page, "approval-resource-url")).toContainText(
    "https://address-intel.zyropay.online/v1/reports/address/addr_test1",
  );
  await expectSoundLayout(page, "approval-x402");
  const hold = tid(page, "approval-hold-to-approve");
  await hold.scrollIntoViewIfNeeded();
  const box = await hold.boundingBox();
  if (box === null) throw new Error("hold button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2_500);
  await page.mouse.up();
  await expect(tid(page, "approval-approved")).toBeVisible({ timeout: 20_000 });
  await expect(tid(page, "approval-status")).toBeVisible();
  await expect(tid(page, "approval-step-approved-done")).toBeVisible();
  // The mock walks SIGNING -> BROADCAST -> CONFIRMED in about ten seconds.
  await expect(tid(page, "approval-step-confirmed-done")).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, "approval-status-message")).toContainText("Confirmed on Cardano");
  await expect(tid(page, "approval-tx-hash")).toBeVisible();
  await expect(tid(page, "approval-explorer-link")).toBeVisible();
  await expectSoundLayout(page, "approval-x402-paid");
  await tid(page, "approval-done").click();
});

test("approvals: an escrow payment says it is protected and follows the escrow", async ({
  page,
}) => {
  await seed(page);
  await open(page, `/approvals/${APPROVAL_ESCROW}`, "approval-detail");
  const block = tid(page, "approval-escrow");
  await expect(block).toContainText("Protected by Escrow (Masumi)");
  await expect(block).toContainText("until the seller delivers");
  await expect(block).toContainText("If it isn't delivered by");
  // The seller, not the escrow script, is who the card names.
  await expect(tid(page, "approval-escrow-seller")).toContainText("addr_test1");
  await expect(tid(page, "approval-escrow-seller")).not.toContainText("addr_test1wzs4e6");
  await expectSoundLayout(page, "approval-escrow");
  const hold = tid(page, "approval-hold-to-approve");
  await hold.scrollIntoViewIfNeeded();
  const box = await hold.boundingBox();
  if (box === null) throw new Error("hold button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2_500);
  await page.mouse.up();
  await expect(tid(page, "approval-approved")).toBeVisible({ timeout: 20_000 });
  await expect(tid(page, "approval-step-confirmed-done")).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, "approval-status-message")).toContainText("locked in escrow");
  await expect(tid(page, "escrow-step-locked-done")).toBeVisible({ timeout: 20_000 });
  // The simulated seller delivers ~15 s after the lock confirms.
  await expect(tid(page, "escrow-step-delivered-done")).toBeVisible({ timeout: 40_000 });
  await expect(tid(page, "escrow-title")).toHaveText("Result delivered");
  await expectSoundLayout(page, "approval-escrow-delivered");
});

test("approvals: refund an escrow payment with the passkey", async ({ page }) => {
  await seed(page);
  await open(page, `/approvals/${APPROVAL_ESCROW_LOCKED}`, "approval-detail");
  await expect(tid(page, "escrow-state-funds_locked")).toBeVisible();
  await expect(tid(page, "escrow-withdraw-countdown")).toBeVisible();
  await expect(tid(page, "escrow-simulated")).toBeVisible();
  await tid(page, "escrow-request-refund").click();
  const sheet = tid(page, "escrow-sheet");
  await expect(sheet).toContainText("Request a refund");
  await expect(sheet).toContainText("Refund to");
  await expect(sheet).toContainText("Valid until");
  await expectSoundLayout(page, "escrow-refund-sheet");
  await tid(page, "escrow-sheet-confirm").click();
  await expect(tid(page, "escrow-step-refund-requested-done")).toBeVisible({ timeout: 30_000 });
  // The simulated seller authorizes the refund a few seconds later.
  await expect(tid(page, "escrow-withdraw-refund")).toBeVisible({ timeout: 40_000 });
  await tid(page, "escrow-withdraw-refund").click();
  await expect(tid(page, "escrow-sheet")).toContainText("Withdraw your refund");
  await tid(page, "escrow-sheet-confirm").click();
  await expect(tid(page, "escrow-state-refunded")).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, "escrow-title")).toHaveText("Refunded");
  await expectSoundLayout(page, "escrow-refunded");
});

test("auto-pay: set up an on-chain allowance, verified on the device, and see it pay", async ({
  page,
}) => {
  await seed(page);
  await open(page, `/agents/${AGENT_CHATGPT}`, "agent-detail");
  await expect(tid(page, "allowance-empty")).toBeVisible();
  await tid(page, "allowance-setup").click();
  await expect(tid(page, "autopay-setup")).toBeVisible();
  await expect(tid(page, "autopay-intro")).toContainText("Cardano itself enforces the limits");
  // Defaults: €10 per payment, previewed in ADA at the live price; the seller is listed.
  await expect(tid(page, "autopay-perPayment")).toHaveValue("10");
  await expect(page.getByText(/≈ 20\.83 ADA/).first()).toBeVisible();
  await expectSoundLayout(page, "autopay setup");
  // Validation: max per payment above max per day blocks.
  await typeInto(page, "autopay-perPayment", "25");
  await expect(page.getByText("Max per payment can't be more than max per day.")).toBeVisible();
  await typeInto(page, "autopay-perPayment", "10");
  await tid(page, "autopay-continue").click();
  const sheet = tid(page, "allowance-sheet");
  await expect(sheet).toContainText("Turn on auto-pay");
  await expect(sheet).toContainText("Max per day");
  // The app decoded the real transaction itself before offering the passkey.
  await expect(tid(page, "allowance-device-verified")).toContainText(
    "Verified on this device: locks 62.5 ADA in your allowance (max ≈ 20.83 ADA per payment, ≈ 41.66 ADA per day) and sends 5 ADA to the agent for fees.",
  );
  await expectSoundLayout(page, "autopay review sheet");
  await tid(page, "allowance-sheet-confirm").click();
  await expect(tid(page, "agent-detail")).toBeVisible();
  await expect(tid(page, "allowance-state-active")).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, "allowance-balance")).toBeVisible();
  // The simulated agent pays the seller from the allowance, without a tap.
  await expect(tid(page, "allowance-spends")).toBeVisible({ timeout: 45_000 });
  await expect(tid(page, "allowance-today")).toContainText("2 ADA of ≈ 41.66 ADA");
  await expectSoundLayout(page, "allowance card");
  await tid(page, "agent-activity").click();
  await expect(tid(page, "agent-activity-screen")).toBeVisible();
  const row = tid(page, "agent-activity-screen")
    .getByText(/^Auto-paid · allowance · /)
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(tid(page, "request-auto-paid-note")).toHaveText(
    "Paid automatically from your on-chain allowance — no approval needed.",
  );
  await expect(tid(page, "request-remaining-today")).toContainText("left today");
});

test("approvals: reject with the explicit button", async ({ page }) => {
  await seed(page);
  await open(page, `/approvals/${APPROVAL_2}`, "approval-detail");
  await tid(page, "approval-reject").click();
  await expect(tid(page, "approval-rejected")).toBeVisible({ timeout: 20_000 });
});

test("agents: connect Claude with a code and approve", async ({ page }) => {
  await seed(page);
  await open(page, "/agents", "agents-screen");
  await expectSoundLayout(page, "agents");
  await tid(page, "agents-connect").click();
  await tid(page, "connect-client-claude").click();
  await expect(tid(page, "mcp-url")).toBeVisible();
  await expectSoundLayout(page, "connect instructions");
  await tid(page, "instructions-enter-code").click();
  await typeInto(page, "claim-code-input", "ABCD1234", "ABCD-1234");
  await tid(page, "claim-continue").click();
  await expect(tid(page, "claim-review")).toBeVisible();
  await expectSoundLayout(page, "claim review");
  await tid(page, "claim-approve").click();
  await expect(tid(page, "claim-success")).toBeVisible();
  await tid(page, "claim-done").click();
  await expect(tid(page, "agent-detail")).toBeVisible();
});

test("back from a directly opened agent lands on the agents list, not home", async ({ page }) => {
  await seed(page);
  await open(page, `/agents/${AGENT_CLAUDE}`, "agent-detail");
  await tid(page, "agent-detail").getByRole("button", { name: "Back" }).first().click();
  await expect(tid(page, "agents-screen")).toBeVisible();
});

test("agents: detail and policy editor", async ({ page }) => {
  await seed(page);
  await open(page, `/agents/${AGENT_CLAUDE}`, "agent-detail");
  await expectSoundLayout(page, "agent detail");
  await page.goto(`/agents/${AGENT_CLAUDE}/policy`);
  await expect(tid(page, "policy-editor").getByText(/always ask/i).first()).toBeVisible();
  await expectSoundLayout(page, "policy");
});

test("plugins: catalogue and detail", async ({ page }) => {
  await seed(page);
  await open(page, "/plugins", "plugins-screen");
  await expectSoundLayout(page, "plugins");
  await tid(page, "plugin-card-x402").click();
  await expect(tid(page, "plugin-detail")).toBeVisible();
  await expectSoundLayout(page, "plugin detail");
});

test("agents: discover registered Masumi agents and read how to hire one", async ({ page }) => {
  await seed(page);
  await open(page, "/agents", "agents-screen");
  await tid(page, "agents-discover").click();
  await expect(tid(page, "discover-screen")).toBeVisible();
  const results = tid(page, "discover-results");
  await expect(results).toContainText("Cardano Address Intelligence");
  await expect(results).toContainText("Cardano Token Intelligence");
  await expect(results).toContainText("2 ADA");
  await expect(results).toContainText("1.5 tUSDM");
  await expect(results).toContainText("Escrow-protected");
  await expect(results).toContainText("address-intel.zyropay.online");
  // Third-party listings never render as links.
  expect(await results.locator("a").count()).toBe(0);
  await expectSoundLayout(page, "discover");

  // Filter by tag, then search.
  await tid(page, "discover-tag-tokens").click();
  await expect(results).not.toContainText("Cardano Address Intelligence");
  await expect(results).toContainText("Cardano Token Intelligence");
  await tid(page, "discover-filter-all").click();
  await tid(page, "discover-search").fill("governance");
  await expect(results).toContainText("Governance Digest");
  await expect(results).not.toContainText("Cardano Token Intelligence");
  await tid(page, "discover-search").fill("nothing like this");
  await expect(page.getByText("No agents found")).toBeVisible();
  await tid(page, "discover-search").fill("simulate-error");
  await expect(page.getByText("Couldn't reach the registry")).toBeVisible();
  await tid(page, "discover-search").fill("");

  // Detail sheet: identifier, endpoint host, how your agent hires it.
  await results.getByText("Cardano Address Intelligence").click();
  const sheet = tid(page, "discover-detail");
  await expect(sheet).toBeVisible();
  await expect(tid(page, "discover-detail-id")).toHaveText(/^[0-9a-f]{120}$/);
  await expect(sheet).toContainText("address-intel.zyropay.online");
  await expect(tid(page, "discover-detail-hire")).toContainText("Masumi Escrow");
  await expectSoundLayout(page, "discover detail");
});

test("approvals: an escrow payment names the registered Masumi seller", async ({ page }) => {
  await seed(page);
  await open(page, `/approvals/${APPROVAL_ESCROW}`, "approval-detail");
  await expect(tid(page, "approval-seller-registered")).toContainText(
    "Registered Masumi agent · Cardano Address Intelligence",
  );
  await expect(tid(page, "approval-seller-registered")).toContainText("registry NFT on Cardano");
});

test("policy: only pay registered Masumi agents, with a trusted agent", async ({ page }) => {
  await seed(page);
  await open(page, `/agents/${AGENT_CLAUDE}/policy`, "policy-editor");
  await tid(page, "policy-require-registered").click();
  await expect(tid(page, "policy-trusted-agents")).toBeVisible();
  await tid(page, "policy-trusted-input").fill("abc");
  await tid(page, "policy-trusted-add").click();
  await expect(page.getByText("An agent identifier is 120 hex characters")).toBeVisible();
  await tid(page, "policy-trusted-input").fill("a".repeat(56) + "b".repeat(64));
  await tid(page, "policy-trusted-add").click();
  await expect(tid(page, "policy-trusted-agents")).toContainText("aaaaaaaaaaaa…bbbbbbbb");
  await expectSoundLayout(page, "policy masumi");
  // No dead ends: registered-only needs Escrow, and Escrow needs a Cardano network.
  await expect(tid(page, "policy-registered-needs-escrow")).toBeVisible();
  await tid(page, "policy-registered-escrow-fix").click();
  await expect(tid(page, "policy-registered-needs-escrow")).toHaveCount(0);
  await expect(tid(page, "policy-escrow-needs-cardano")).toBeVisible();
  await tid(page, "policy-allow-cardano").click();
  await expect(tid(page, "policy-escrow-needs-cardano")).toHaveCount(0);
});

test("policy: the recipient picker takes Cardano addresses", async ({ page }) => {
  await seed(page);
  await open(page, `/agents/${AGENT_CLAUDE}/policy`, "policy-editor");
  await tid(page, "allowlist-family").getByText("Cardano", { exact: true }).click();
  await tid(page, "allowlist-address").fill("addr_test1-not-an-address");
  await expect(page.getByText("Not a valid Cardano address.", { exact: false })).toBeVisible();
  // A full Cardano address is readable in the field: it grows instead of scrolling.
  const fullyVisible = () =>
    tid(page, "allowlist-address").evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  await tid(page, "allowlist-address").fill(
    "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae",
  );
  await expect.poll(fullyVisible).toBe(true);
  await tid(page, "allowlist-address").fill(
    "addr_test1vr4z0l8rhm4htfydw97p6mngl4e2f32cw6fw0hj5s7typeshv7hz7",
  );
  await expect.poll(fullyVisible).toBe(true);
  await tid(page, "allowlist-add").click();
  await expect(page.getByLabel(/^Remove addr_test1vr4z0l8/)).toBeVisible();
});

test("activity: an escrow lock reads as one, with its explorer link", async ({ page }) => {
  await seed(page);
  await open(page, `/tx/${fakeId(4, 10)}`, "tx-detail");
  await expect(tid(page, "tx-detail-kind")).toHaveText("Escrow lock");
  await expect(tid(page, "tx-detail-kind-note")).toContainText("Masumi Escrow");
  await expect(tid(page, "tx-detail-explorer")).toBeVisible();
  await open(page, `/tx/${fakeId(4, 11)}`, "tx-detail");
  await expect(tid(page, "tx-detail-kind")).toHaveText("Refund");
});

test("settings: dark mode from Appearance, sign-out sheet", async ({ page }) => {
  await seed(page, { prefs: { theme: "light" } });
  await open(page, "/settings", "settings-screen");
  await expectSoundLayout(page, "settings");
  await tid(page, "settings-appearance").click();
  await expect(tid(page, "theme-picker")).toBeVisible();
  expect(await luminanceBehind(page, "theme-picker")).toBeGreaterThan(0.8);
  await tid(page, "theme-picker").getByText("Dark", { exact: true }).click();
  await expect.poll(() => luminanceBehind(page, "theme-picker")).toBeLessThan(0.2);
  await page.goto("/settings");
  // The choice is persisted.
  await expect(tid(page, "settings-screen")).toBeVisible();
  expect(await luminanceBehind(page, "settings-screen")).toBeLessThan(0.2);
  await tid(page, "settings-sign-out").click();
  await expect(tid(page, "sign-out-sheet")).toBeVisible();
});

test("first launch is light even when the OS is in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await seed(page, { signedIn: false, freshInstall: true });
  await open(page, "/onboarding", "onboarding-welcome");
  expect(await luminanceBehind(page, "onboarding-welcome")).toBeGreaterThan(0.8);
  // The page itself (behind the app, and the browser chrome colour) is light too.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
  ).toBe("rgb(255, 255, 255)");
  expect(
    await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    ),
  ).toBe("#FFFFFF");
});

test("Appearance > System follows a dark OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await seed(page, { prefs: { theme: "system" } });
  await open(page, "/", "home-screen");
  await expect(tid(page, "home-balance")).toBeVisible();
  expect(await luminanceBehind(page, "home-balance")).toBeLessThan(0.2);
  await expectSoundLayout(page, "home dark");
});

test("a stored Dark choice paints dark before the app renders", async ({ page }) => {
  await seed(page, { prefs: { theme: "dark" } });
  await page.goto("/");
  // theme-boot.js runs before the bundle: no white flash for someone who chose Dark.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
  ).toBe("rgb(0, 0, 0)");
  await expect(tid(page, "home-balance")).toBeVisible();
  expect(await luminanceBehind(page, "home-balance")).toBeLessThan(0.2);
});

test("keyboard: Tab reaches the welcome actions with a visible focus ring", async ({
  page,
  browserName,
}) => {
  await seed(page, { signedIn: false });
  await open(page, "/onboarding", "onboarding-welcome");
  // macOS WebKit moves focus to buttons with Tab only when "Press Tab to highlight each
  // item" is on (off by default); Alt+Tab always does, like Safari's Option+Tab.
  const key = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const reached: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(key);
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring =
        (s.outlineStyle !== "none" && Number(s.outlineWidth.replace("px", "")) > 0) ||
        s.boxShadow !== "none";
      return { id: el.getAttribute("data-testid") ?? el.tagName, ring };
    });
    if (focused === null) continue;
    reached.push(focused.id);
    if (focused.id === "welcome-create" || focused.id === "welcome-login")
      expect(focused.ring, `${focused.id} has a visible focus indicator`).toBe(true);
  }
  expect(reached).toContain("welcome-create");
  expect(reached).toContain("welcome-login");
  await tid(page, "welcome-create").focus();
  await page.keyboard.press("Enter");
  await expect(tid(page, "onboarding-intro")).toBeVisible();
});

test("desktop: the app is a centred phone-width column", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.endsWith("desktop"), "desktop viewport only");
  await seed(page);
  await open(page, "/", "home-screen");
  const box = await tid(page, "home-screen").boundingBox();
  if (box === null) throw new Error("no home box");
  expect(box.width).toBeLessThanOrEqual(480);
  const vw = page.viewportSize()?.width ?? 0;
  expect(Math.abs(box.x + box.width / 2 - vw / 2)).toBeLessThan(2);
});

test("formatting: amounts and dates render the same way in every engine", async ({ page }) => {
  await seed(page);
  await open(page, "/", "home-screen");
  // USD with grouping and two decimals, e.g. "$12,345.67" (Intl.NumberFormat en-US).
  await expect(tid(page, "home-balance")).toHaveText(/\$\d{1,3}(,\d{3})*\.\d{2}/);
  await page.locator('[data-testid^="tx-row-"]').first().click();
  // No "Invalid Date" / "NaN" anywhere on the transaction detail.
  await expect(page.getByText(/Invalid Date|NaN/)).toHaveCount(0);
  await expect(page.getByText(/\b20\d\d\b/).first()).toBeVisible();
});
