import { expect, type Page, test as base } from "@playwright/test";

/* Deterministic ids from src/api/mock/fixtures.ts (fakeId(kind, n)). */
export const fakeId = (kind: number, n: number): string =>
  `0192f3a1-${kind.toString(16).padStart(4, "0")}-7000-8000-${n.toString(16).padStart(12, "0")}`;
export const WALLET_MAIN = fakeId(2, 1);
export const AGENT_CLAUDE = fakeId(5, 1);
/** Autonomous, allowed on Cardano Preprod: the auto-pay demo agent. */
export const AGENT_CHATGPT = fakeId(5, 2);
export const APPROVAL_1 = fakeId(7, 1);
export const APPROVAL_2 = fakeId(7, 2);
/** The x402 Cardano preprod demo: Claude buys a report for 2 tADA. */
export const APPROVAL_X402_ADA = fakeId(7, 6);
/** x402 into Masumi escrow: pending (3 tADA) and approved earlier, locked (5 tADA). */
export const APPROVAL_ESCROW = fakeId(7, 7);
export const APPROVAL_ESCROW_LOCKED = fakeId(7, 8);

const SESSION = {
  accessToken: "simulated-access-e2e",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: "simulated-refresh-e2e",
  refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  user: {
    id: fakeId(1, 1),
    email: "demo@zyropay.dev",
    displayName: "Simulated user",
    turnkeySubOrganizationId: "simulated-suborg-0000",
    createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  },
  simulated: true,
};

export interface SeedOptions {
  readonly signedIn?: boolean;
  readonly onboardingComplete?: boolean;
  readonly prefs?: Record<string, unknown>;
  /** A first launch: no stored preferences at all (the app's defaults apply). */
  readonly freshInstall?: boolean;
}

/** Seed the web storage (src/state/storage.web.ts keys) before the app boots. */
export async function seed(page: Page, options: SeedOptions = {}): Promise<void> {
  const signedIn = options.signedIn ?? true;
  const prefs = JSON.stringify({
    state: {
      theme: "light",
      currency: "USD",
      hideBalances: false,
      preferredNetwork: null,
      onboardingComplete: options.onboardingComplete ?? signedIn,
      notificationsPrompted: true,
      analyticsOptIn: false,
      ...options.prefs,
    },
    version: 3,
  });
  await page.addInitScript(
    ({ session, prefsJson, signedIn: withSession }) => {
      // Also runs in every frame; a document without storage access (an error page) is skipped.
      try {
        if (window.sessionStorage.getItem("zp-seeded") === "1") return;
        window.localStorage.clear();
        if (withSession) window.sessionStorage.setItem("zyropay.session.v1", session);
        if (prefsJson !== null) window.localStorage.setItem("zyropay.prefs.v1", prefsJson);
        window.sessionStorage.setItem("zp-seeded", "1");
      } catch {
        // no storage here
      }
    },
    { session: JSON.stringify(SESSION), prefsJson: options.freshInstall ? null : prefs, signedIn },
  );
}

export const tid = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`).first();

/**
 * Elements that stick out of the viewport horizontally and are not inside a container that
 * clips or scrolls horizontally (chip rows and carousels are fine). Returns short labels.
 */
export async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const clipsX = (el: Element) => {
      const s = getComputedStyle(el);
      return s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden";
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (clipsX(p)) {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) clipped = true;
          break;
        }
      }
      if (clipped) continue;
      // Off-screen by design (animated-out sheets, translated cards).
      if (r.left >= vw || r.right <= 0) continue;
      const id = el.getAttribute("data-testid");
      const text = el.textContent.trim().slice(0, 40);
      out.push(
        `${el.tagName.toLowerCase()}${id ? `#${id}` : ""} [${String(Math.round(r.left))}..${String(Math.round(r.right))} of ${String(vw)}] ${text}`,
      );
    }
    // Report the innermost offenders only.
    return out.slice(-8);
  });
}

/** Interactive elements smaller than `min` CSS px in either dimension (WCAG 2.5.8: 24). */
export async function smallTouchTargets(page: Page, min = 24): Promise<string[]> {
  return page.evaluate((minPx) => {
    const out: string[] = [];
    const nodes = document.querySelectorAll(
      'button, a[href], input, textarea, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"]',
    );
    for (const el of Array.from(nodes)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.pointerEvents === "none") continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.width < minPx || r.height < minPx) {
        const label =
          el.getAttribute("aria-label") ??
          el.getAttribute("data-testid") ??
          el.textContent.trim().slice(0, 30);
        out.push(`${label} (${String(Math.round(r.width))}×${String(Math.round(r.height))})`);
      }
    }
    return out;
  }, min);
}

/**
 * Text inputs whose font size is under 16 px. iOS Safari zooms the whole page into such a
 * field on focus (and does not zoom back), which breaks the phone layout.
 */
export async function zoomingInputs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    !matchMedia("(pointer: coarse), (max-width: 600px)").matches
      ? [] // laptops and desktops: no focus zoom
      : Array.from(
          document.querySelectorAll(
            'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea',
          ),
        )
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              Number(getComputedStyle(el).fontSize.replace("px", "")) < 16
            );
          })
          .map(
            (el) =>
              `${el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? "input"} (${getComputedStyle(el).fontSize})`,
          ),
  );
}

/** Layout invariants every screen must keep at every viewport. */
export async function expectSoundLayout(page: Page, what: string): Promise<void> {
  const overflow = await horizontalOverflow(page);
  expect(overflow, `${what}: horizontal overflow`).toEqual([]);
  const small = await smallTouchTargets(page);
  expect(small, `${what}: touch targets under 24 px`).toEqual([]);
  const zooming = await zoomingInputs(page);
  expect(zooming, `${what}: inputs under 16 px (iOS Safari zooms on focus)`).toEqual([]);
}

/** Collects uncaught page errors; the fixture fails the test if any occurred. */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await use(errors);
      expect(errors, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
