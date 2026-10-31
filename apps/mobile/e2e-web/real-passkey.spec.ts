import { expect, test } from "@playwright/test";

/*
 * REAL passkey sign-up and login against a real-mode stack (real Turnkey, real API on
 * testnets). Chromium only: it is the one engine with a WebAuthn virtual authenticator
 * (CDP `WebAuthn.*`). WebKit and Firefox have no automation API for WebAuthn, so there the
 * passkey path is covered by the mock journey plus manual checks on devices.
 *
 *   pnpm dev --web                                       # API (mocks off) + Expo web on :8081
 *   E2E_REAL_URL=http://localhost:8081 pnpm test:web:real
 *
 * Every run creates one real (test) sub-organization in the Turnkey org ("zyropay-pw-<date>")
 * whose passkey lives only in this run's virtual authenticator.
 */
const REAL_URL = process.env.E2E_REAL_URL;

test.skip(REAL_URL === undefined, "set E2E_REAL_URL to a real-mode web app (pnpm dev --web)");
test.setTimeout(240_000);

test("real passkey: sign up, onboard, sign out, log back in", async ({ page, context }) => {
  const base = (REAL_URL ?? "").replace(/\/+$/, "");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tid = (id: string) => page.locator(`[data-testid="${id}"]`).first();
  const session = () =>
    page.evaluate(() => {
      const raw = window.sessionStorage.getItem("zyropay.session.v1");
      return raw ? (JSON.parse(raw) as { user?: { turnkeySubOrganizationId?: string } }) : null;
    });

  // The Turnkey implementation is a lazy chunk: it must NOT be part of the first page.
  const scripts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(r.url());
  });
  await page.goto(`${base}/onboarding`);
  await expect(tid("onboarding-welcome")).toBeVisible({ timeout: 60_000 });
  expect(scripts.some((u) => /web-signer/.test(u))).toBe(false);

  // 1. sign-up (the passkey screen preloads the signer chunk)
  await page.goto(`${base}/onboarding/passkey?mode=signup`);
  await expect(tid("onboarding-passkey")).toBeVisible({ timeout: 60_000 });
  await tid("passkey-name").fill(`zyropay-pw-${new Date().toISOString().slice(0, 10)}`);
  await tid("passkey-continue").click();
  await expect(tid("onboarding-wallet")).toBeVisible({ timeout: 120_000 });
  const subOrg = (await session())?.user?.turnkeySubOrganizationId;
  expect(subOrg).toMatch(/^[0-9a-f-]{36}$/);
  console.log(`real passkey: created Turnkey sub-org ${String(subOrg)}`);
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1);

  // 2. onboarding -> Home
  await tid("wallet-continue").click();
  await expect(tid("onboarding-recovery")).toBeVisible({ timeout: 30_000 });
  if (await tid("recovery-understood").isVisible()) await tid("recovery-understood").click();
  await tid("recovery-continue").click();
  await tid("notifications-skip").click();
  await tid("done-open").click();
  await expect(tid("home-screen")).toBeVisible({ timeout: 60_000 });

  // 3. sign out, then log in with the same passkey into the same sub-org
  await page.goto(`${base}/settings`);
  await tid("settings-sign-out").click();
  await tid("sign-out-sheet-confirm").click();
  await expect(tid("onboarding-welcome")).toBeVisible({ timeout: 30_000 });
  expect(await session()).toBeNull();
  await page.goto(`${base}/onboarding/passkey?mode=login`);
  await expect(tid("onboarding-passkey")).toBeVisible({ timeout: 60_000 });
  await tid("passkey-continue").click();
  await expect(tid("home-screen")).toBeVisible({ timeout: 120_000 });
  expect((await session())?.user?.turnkeySubOrganizationId).toBe(subOrg);
  expect(errors).toEqual([]);
});
