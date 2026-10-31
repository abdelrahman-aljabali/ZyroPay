import type { Page } from "@playwright/test";
import { expect, seed, test, tid } from "./helpers";

/*
 * The landing page embeds the real web app in an iframe (docs/SECURITY.md "Framing"). The
 * mock build allowlists http://localhost:4321 (e2e-web/server.mjs), like a staging build.
 * Parent pages are served by Playwright on other origins; the app is the e2e server.
 */

// Playwright fulfils the parent pages without a real server, so Chromium cannot tell they
// are local and its Local Network Access checks refuse the loopback iframe. Real parents
// (the staging landing page, or the landing dev server on localhost) are not affected.
test.use({
  launchOptions: [
    async ({ browserName, launchOptions }, use) => {
      await use(
        browserName === "chromium"
          ? {
              ...launchOptions,
              args: [...(launchOptions.args ?? []), "--disable-features=LocalNetworkAccessChecks"],
            }
          : launchOptions,
      );
    },
    { scope: "worker" },
  ],
});

const LANDING = "http://localhost:4321";
const STRANGER = "http://localhost:4399";

async function parentPage(page: Page, origin: string, allow: string | null): Promise<void> {
  const app = new URL("/onboarding", test.info().project.use.baseURL ?? "").href;
  await page.route(`${origin}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body style="margin:0">
<script>window.received=[];addEventListener("message",e=>window.received.push({origin:e.origin,data:e.data}));</script>
<iframe id="app" src="${app}" ${allow === null ? "" : `allow="${allow}"`} style="width:420px;height:800px;border:0"></iframe>
</body></html>`,
    }),
  );
  await page.goto(`${origin}/`);
}

const received = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { received: { origin: string; data: unknown }[] }).received,
  );

test.beforeEach(async ({ page }) => {
  await seed(page, { signedIn: false });
});

test("framed by the landing origin: posts zyropay:ready to that exact origin", async ({ page }) => {
  await parentPage(page, LANDING, "publickey-credentials-get *; publickey-credentials-create *");
  const frame = page.frameLocator("#app");
  await expect(frame.locator('[data-testid="onboarding-welcome"]')).toBeVisible();
  await expect
    .poll(() => received(page))
    .toContainEqual({
      origin: new URL(test.info().project.use.baseURL ?? "").origin,
      data: { type: "zyropay:ready" },
    });
  // Minimal: nothing but the type.
  for (const m of await received(page)) expect(Object.keys(m.data as object)).toEqual(["type"]);
  await expect(frame.locator('[data-testid="embed-passkey-notice"]')).toHaveCount(0);
});

test("framed by any other origin: the app sends it nothing", async ({ page }) => {
  await parentPage(page, STRANGER, "publickey-credentials-get *; publickey-credentials-create *");
  await expect(
    page.frameLocator("#app").locator('[data-testid="onboarding-welcome"]'),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await received(page)).toEqual([]);
});

test("WebAuthn not delegated to the frame: full-screen link instead", async ({
  page,
  browserName,
}) => {
  // Only Chromium exposes the frame's Permissions Policy (document.featurePolicy) up front;
  // other engines report the refusal when a passkey prompt fails.
  test.skip(browserName !== "chromium", "document.featurePolicy is Chromium-only");
  await parentPage(page, LANDING, null);
  const frame = page.frameLocator("#app");
  await expect(frame.locator('[data-testid="embed-passkey-notice"]')).toBeVisible();
  const link = frame.locator('[data-testid="embed-open-full-screen"]');
  await expect(link).toHaveText("Open ZyroPay in full screen to use your passkey");
  await expect(link).toHaveAttribute("target", "_top");
  await expect
    .poll(() => received(page))
    .toContainEqual(expect.objectContaining({ data: { type: "zyropay:passkey-unavailable" } }));
  await link.click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(tid(page, "onboarding-welcome")).toBeVisible();
});
