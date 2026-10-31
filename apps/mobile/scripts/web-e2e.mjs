#!/usr/bin/env node
/*
 * REAL end-to-end check of the web app (PWA) against real Turnkey, testnets only.
 *
 *   pnpm dev --web                                   # API (mocks off) + MCP + Expo web
 *   node scripts/web-e2e.mjs --url http://localhost:8081 [--api http://localhost:8787]
 *
 * Chromium with a CDP WebAuthn VIRTUAL AUTHENTICATOR (platform, resident keys, user
 * verification) stands in for Touch ID / Face ID. Everything else is real:
 *   1. sign-up: the browser creates a passkey, the Turnkey Auth Proxy creates a NEW
 *      sub-organization in your Turnkey org (user "zyropay-e2e-<date>") with the default
 *      Solana + EVM + Cardano wallet, @turnkey/core stamps whoami, POST /v1/auth/session;
 *   2. the onboarding screens and the signed-in app (screenshots);
 *   3. real testnet reads through the API: GET /v1/portfolio and a watch-wallet portfolio
 *      of a known public Sepolia / devnet address;
 *   4. sign-out, then passkey LOGIN with the same virtual credential into the same sub-org.
 *
 * Each run creates one real (test) sub-organization in the Turnkey org; its id is printed.
 * If Turnkey refuses the origin (Auth Proxy "Allowed Origins"), the run stops and prints the
 * exact request that failed. Tokens and stamps are never printed.
 *
 * Screenshots: apps/mobile/screenshots/real-web/<step>.png (git-ignored).
 *
 * PERSISTENT PASSKEY (--persist <file>), for repeat runs as the same user:
 *   - <file> missing: the sign-up run above; right after sign-up the virtual credential is
 *     exported (CDP WebAuthn.getCredentials: credentialId, rpId, privateKey, userHandle,
 *     signCount) and written to <file> (mode 600, its directory 700). Watch wallets are
 *     not created, so the user's account stays clean.
 *   - <file> present: LOGIN ONLY. A fresh browser context gets a new virtual authenticator,
 *     the saved credential is re-imported (WebAuthn.addCredential), the app logs in with it
 *     and the run checks that the session is the saved Turnkey sub-org, then reads
 *     GET /v1/wallets and GET /v1/portfolio. The file is refused if its rpId is not the
 *     --url host. --keep-open <seconds> keeps the signed-in page open for manual steps.
 *   After every run the credential is exported again, so the stored signCount stays current.
 *   --tour (login runs) screenshots home, the first wallet and Base Sepolia ETH in light and
 *   dark (t-<theme>-*.png).
 *   The private key is never printed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP_DIR, "screenshots", "real-web");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const BASE = arg("url", "http://localhost:8081").replace(/\/+$/, "");
const API = arg("api", "http://localhost:8787").replace(/\/+$/, "");
const LABEL = arg("name", `zyropay-e2e-${new Date().toISOString().slice(0, 10)}`);
const PERSIST = arg("persist", undefined) ? resolve(arg("persist", undefined)) : undefined;
const KEEP_OPEN_S = Number(arg("keep-open", "0")) || 0;
/** --tour: after login, screenshot home, wallet detail and an asset in light and dark. */
const TOUR = args.includes("--tour");
/**
 * --send <network> --to <address> --amount <decimal> [--symbol <SYM>]: a REAL testnet send of
 * the network's native asset through the UI (login runs only), e.g. --send solana-devnet.
 */
const SEND_NETWORK = arg("send", undefined);
const SEND_TO = arg("to", undefined);
const SEND_AMOUNT = arg("amount", undefined);
const NATIVE_SYMBOL = { "solana-devnet": "SOL", "ethereum-sepolia": "ETH", "base-sepolia": "ETH" };
const SEND_SYMBOL = arg("symbol", NATIVE_SYMBOL[SEND_NETWORK ?? ""]);
if (SEND_NETWORK && (!SEND_TO || !SEND_AMOUNT || !SEND_SYMBOL)) {
  console.log("FAILED: --send needs --to, --amount and a known network (or --symbol)");
  process.exit(1);
}
const RP_HOST = new URL(BASE).hostname;
/** Saved credential (login mode) or undefined (sign-up mode). */
const saved =
  PERSIST && existsSync(PERSIST) ? JSON.parse(readFileSync(PERSIST, "utf8")) : undefined;
if (saved && saved.credential?.rpId !== RP_HOST) {
  console.log(
    `FAILED: ${PERSIST} is for rpId ${saved.credential?.rpId}, not ${RP_HOST}; passkeys are bound to the rpId`,
  );
  process.exit(1);
}
/** Known public testnet addresses (read-only balance reads; nothing is sent). */
const WATCH = [
  // vitalik.eth (EIP-55) holds Sepolia ETH; a devnet-active account on Solana.
  { network: "ethereum-sepolia", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  { network: "solana-devnet", address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" },
];

mkdirSync(OUT, { recursive: true });
const log = (msg) => console.log(msg);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
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

/**
 * Export the virtual authenticator's credential to PERSIST (mode 600). Only metadata is
 * logged; the private key goes to the file and nowhere else.
 */
async function saveCredential(meta) {
  if (!PERSIST) return;
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  const credential = credentials.find((c) => c.rpId === RP_HOST) ?? credentials[0];
  if (!credential) throw new Error("virtual authenticator holds no credential to save");
  mkdirSync(dirname(PERSIST), { recursive: true, mode: 0o700 });
  const prior = existsSync(PERSIST) ? JSON.parse(readFileSync(PERSIST, "utf8")) : {};
  const record = {
    note: "TEST passkey for ZyroPay staging (testnets). Private key: never commit, never print.",
    baseUrl: BASE,
    api: API,
    savedAt: new Date().toISOString(),
    ...prior,
    ...meta,
    updatedAt: new Date().toISOString(),
    credential,
  };
  writeFileSync(PERSIST, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(PERSIST, 0o600);
  log(
    `  saved credential ${credential.credentialId.slice(0, 12)}… rpId=${credential.rpId} signCount=${String(credential.signCount)} -> ${PERSIST}`,
  );
}
if (saved) {
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: saved.credential });
  log(
    `imported saved credential ${saved.credential.credentialId.slice(0, 12)}… rpId=${saved.credential.rpId} signCount=${String(saved.credential.signCount)} (sub-org ${saved.subOrganizationId})`,
  );
}

/** Turnkey / Auth Proxy traffic, for diagnosing an origin or rpId refusal. */
const turnkeyCalls = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!/turnkey\.com/.test(url)) return;
  const entry = { method: res.request().method(), url, status: res.status() };
  if (res.status() >= 400) entry.body = (await res.text().catch(() => "")).slice(0, 500);
  turnkeyCalls.push(entry);
});
page.on("requestfailed", (req) => {
  if (/turnkey\.com|localhost:8787/.test(req.url()))
    turnkeyCalls.push({
      method: req.method(),
      url: req.url(),
      status: "FAILED",
      body: req.failure()?.errorText,
    });
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text().slice(0, 300));
});

const tid = (id) => page.locator(`[data-testid="${id}"]`).first();
async function shot(name) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  log(`  screenshot ${join("screenshots/real-web", `${name}.png`)}`);
}
function dumpTurnkey() {
  for (const c of turnkeyCalls)
    log(`  ${c.method} ${c.url} -> ${c.status}${c.body ? `  ${c.body}` : ""}`);
}
async function session() {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem("zyropay.session.v1");
    return raw ? JSON.parse(raw) : null;
  });
}
/** Wait for one of several testIDs, or the passkey screen's error card. */
async function waitForAny(ids, timeout = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const id of ids)
      if (
        await tid(id)
          .isVisible()
          .catch(() => false)
      )
        return id;
    const err = page.getByText("That didn't work", { exact: false }).first();
    if (await err.isVisible().catch(() => false)) {
      const card = await err
        .locator("xpath=..")
        .innerText()
        .catch(() => "");
      return `error: ${card.replace(/\s+/g, " ")}`;
    }
    await page.waitForTimeout(500);
  }
  return "timeout";
}
async function apiCall(path, init = {}) {
  return page.evaluate(
    async ({ api, path, init }) => {
      const raw = window.sessionStorage.getItem("zyropay.session.v1");
      const token = raw ? JSON.parse(raw).accessToken : "";
      const res = await fetch(`${api}${path}`, {
        method: init.method,
        body: init.body,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        },
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { api: API, path, init },
  );
}
function summarize(json) {
  const p = json?.portfolio;
  if (!p) return JSON.stringify(json).slice(0, 300);
  const rows = p.balances.map(
    (b) =>
      `${b.network}:${b.asset?.symbol ?? b.asset?.id}=${b.amount}${b.asset?.decimals !== undefined ? `e-${b.asset.decimals}` : ""}`,
  );
  const more = rows.length > 8 ? `  (+${String(rows.length - 8)} more)` : "";
  return `stale=${p.stale} simulated=${p.simulated} networks=[${p.networks.join(",")}] ${rows.slice(0, 8).join("  ")}${more}`;
}

/** From the onboarding wallet screen to the app (recovery note, notifications, done). */
async function completeOnboarding(prefix) {
  await tid("wallet-continue").click();
  if ((await waitForAny(["onboarding-recovery"], 20_000)) === "onboarding-recovery") {
    await shot(`${prefix}03-onboarding-recovery`);
    if (
      await tid("recovery-understood")
        .isVisible()
        .catch(() => false)
    )
      await tid("recovery-understood").click();
    await tid("recovery-continue").click();
  }
  if ((await waitForAny(["onboarding-notifications"], 20_000)) === "onboarding-notifications")
    await tid("notifications-skip").click();
  if ((await waitForAny(["onboarding-done"], 20_000)) === "onboarding-done") {
    await shot(`${prefix}04-onboarding-done`);
    await tid("done-open").click();
  }
}

async function logWallets() {
  const wallets = await apiCall("/v1/wallets");
  log(`  GET /v1/wallets -> ${wallets.status}`);
  for (const w of wallets.json?.wallets ?? [])
    log(
      `  wallet "${w.name}": ${(w.addresses ?? []).map((a) => `${a.family}:${a.address}`).join("  ")}`,
    );
  return wallets;
}

/**
 * Send -> SOL on solana-devnet -> recipient -> amount -> review (fee quote) -> passkey ->
 * status, then follow the transaction in GET /v1/transactions and the activity screen.
 * Checks that the submitted sign request carries a passkey stamp (X-Stamp-Webauthn).
 */
async function sendNative(network, symbol, to, amount) {
  const assetTid = `send-asset-${symbol}-${network}`;
  log(`3. REAL send: ${amount} ${symbol} on ${network} to ${to}`);
  const seen = {};
  const onRequest = (req) => {
    if (req.method() === "POST" && /\/v1\/send\/[^/]+\/submit$/.test(req.url())) {
      const body = JSON.parse(req.postData() ?? "{}");
      seen.stampHeaderName = body.signRequest?.stamp?.stampHeaderName;
      seen.stampUrl = body.signRequest?.url;
    }
  };
  const onResponse = async (res) => {
    if (!/\/v1\/send\//.test(res.url()) || res.request().method() !== "POST") return;
    const json = await res.json().catch(() => null);
    if (/\/quote$/.test(res.url())) seen.quote = { status: res.status(), json };
    else seen.submit = { status: res.status(), json };
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  await page.goto(`${BASE}/send`, { waitUntil: "domcontentloaded" });
  if ((await waitForAny([assetTid], 60_000)) !== assetTid) {
    await shot("s01-no-sol");
    throw new Error(`no ${symbol} balance on ${network} to send`);
  }
  await shot("s01-choose-asset");
  await tid(assetTid).click();
  await waitForAny(["send-recipient-input"], 20_000);
  await tid("send-recipient-input").fill(to);
  await shot("s02-recipient");
  await tid("send-recipient-continue").click();
  await waitForAny(["send-amount-input"], 20_000);
  await tid("send-amount-input").fill(amount);
  await shot("s03-amount");
  await tid("send-amount-continue").click();
  if ((await waitForAny(["send-confirm"], 60_000)) !== "send-confirm") {
    await shot("s04-review-failed");
    log(`  quote: ${JSON.stringify(seen.quote ?? null).slice(0, 800)}`);
    throw new Error("fee quote / review did not load");
  }
  const review = seen.quote?.json?.review;
  log(
    `  POST /v1/send/quote -> ${String(seen.quote?.status)} request ${review?.request?.id} fee ${review?.estimatedFee?.amount} (base units), from ${review?.payload?.from} to ${review?.payload?.to} amount ${review?.payload?.amount}`,
  );
  await shot("s04-review");
  const reviewText = (await tid("send-review").innerText()).replace(/\s+/g, " ");
  log(`  review screen: ${reviewText.slice(0, 400)}`);
  await tid("send-confirm").click();
  const after = await waitForAny(["send-status"], 120_000);
  await shot("s05-status");
  log(
    `  submit: stamp header ${String(seen.stampHeaderName)} to ${String(seen.stampUrl)} -> ${String(seen.submit?.status)} ${JSON.stringify(seen.submit?.json ?? null).slice(0, 800)}`,
  );
  if (after !== "send-status") {
    const err = await tid("send-review")
      .innerText()
      .catch(() => "");
    throw new Error(
      `send did not reach the status screen: ${after} ${err.replace(/\s+/g, " ").slice(-300)}`,
    );
  }
  if (seen.stampHeaderName !== "X-Stamp-Webauthn")
    throw new Error(`sign request was not passkey-stamped (${String(seen.stampHeaderName)})`);
  const result = seen.submit?.json?.request;
  log(
    `  status screen: ${(await tid("send-status").innerText()).replace(/\s+/g, " ").slice(0, 300)}`,
  );
  if (!result?.txHash) throw new Error(`no tx hash (state ${String(result?.state)})`);
  log(`  tx ${result.txHash}  ${String(result.explorerUrl)}`);
  // The status screen follows the chain (useSendProgress): wait for "Payment confirmed".
  const confirmedInUi = await page
    .getByText("Payment confirmed", { exact: true })
    .first()
    .waitFor({ timeout: 180_000 })
    .then(() => true)
    .catch(() => false);
  await shot("s05b-status-final");
  log(
    `  status screen ${confirmedInUi ? "CONFIRMED" : "NOT confirmed within 3 min"}: ${(await tid("send-status").innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
  );
  if (!confirmedInUi) exitCode = 1;
  // Follow it in the API's transaction history until CONFIRMED (or 3 min).
  const start = Date.now();
  let tx;
  while (Date.now() - start < 180_000) {
    const txs = await apiCall("/v1/transactions?limit=20");
    tx = (txs.json?.transactions ?? []).find((t) => t.txHash === result.txHash);
    if (tx && /confirmed|failed/i.test(String(tx.status))) break;
    await page.waitForTimeout(5000);
  }
  log(
    `  GET /v1/transactions: ${tx ? JSON.stringify(tx).slice(0, 600) : "transaction NOT listed"}`,
  );
  await page.goto(`${BASE}/activity`, { waitUntil: "domcontentloaded" });
  await waitForAny(["activity-screen"], 30_000);
  await shot("s06-activity");
  log(
    `  activity screen: ${(await tid("activity-screen").innerText()).replace(/\s+/g, " ").slice(0, 300)}`,
  );
  const portfolio = await apiCall("/v1/portfolio");
  log(`  GET /v1/portfolio -> ${portfolio.status}  ${summarize(portfolio.json)}`);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await waitForAny(["home-screen"], 30_000);
  await shot("s07-home");
  page.off("request", onRequest);
  page.off("response", onResponse);
  if (!tx || !/confirmed/i.test(String(tx.status))) {
    exitCode = 1;
    log("  NOT CONFIRMED in the app within 3 min");
  }
}

/** Theme preference in the persisted prefs (localStorage), then a reload. */
async function setTheme(theme) {
  await page.evaluate((t) => {
    const raw = window.localStorage.getItem("zyropay.prefs.v1");
    const prefs = raw ? JSON.parse(raw) : { state: {}, version: 3 };
    prefs.state.theme = t;
    window.localStorage.setItem("zyropay.prefs.v1", JSON.stringify(prefs));
  }, theme);
}

async function scrollBy(px) {
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, px);
  await page.waitForTimeout(600);
}

async function tour(walletId, portfolio) {
  log("3. tour: home, wallet detail and asset detail in light and dark");
  const assetId =
    portfolio?.balances?.find((b) => b.asset?.id === "base-sepolia:native")?.asset.id ??
    portfolio?.balances?.[0]?.asset?.id;
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForAny(["home-screen"], 30_000);
    await shot(`t-${theme}-home`);
    await scrollBy(600);
    await shot(`t-${theme}-home-assets`);
    if (walletId) {
      await page.goto(`${BASE}/wallets/${walletId}`, { waitUntil: "domcontentloaded" });
      await waitForAny(["wallet-detail"], 30_000);
      await shot(`t-${theme}-wallet`);
      await scrollBy(900);
      await shot(`t-${theme}-wallet-holdings`);
    }
    if (assetId) {
      await page.goto(`${BASE}/asset/${encodeURIComponent(assetId)}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAny(["asset-detail"], 30_000);
      await shot(`t-${theme}-asset`);
    }
  }
}

/** --persist with an existing file: log in with the saved credential, nothing else. */
async function loginWithSavedCredential() {
  log(`1. passkey LOGIN at ${BASE} with the saved credential (fresh browser context)`);
  await page.goto(`${BASE}/onboarding/passkey?mode=login`, { waitUntil: "domcontentloaded" });
  const first = await waitForAny(["onboarding-passkey", "onboarding-passkey-unavailable"], 60_000);
  if (first !== "onboarding-passkey") {
    await shot("p01-passkey-unavailable");
    throw new Error(`passkey screen not available (${first})`);
  }
  await shot("p01-login");
  await tid("passkey-continue").click();
  const afterLogin = await waitForAny(["home-screen", "onboarding-wallet"], 90_000);
  const s = await session();
  if (!s || s.user?.turnkeySubOrganizationId !== saved.subOrganizationId) {
    await shot("p02-login-failed");
    log(
      `  login did not complete: ${afterLogin} (session sub-org ${String(s?.user?.turnkeySubOrganizationId)})`,
    );
    dumpTurnkey();
    throw new Error("login with the saved credential failed");
  }
  log(
    `  OK: logged in as ZyroPay user ${s.user.id}, Turnkey sub-org ${s.user.turnkeySubOrganizationId} (${afterLogin}, simulated=${String(s.simulated)})`,
  );
  if (afterLogin === "onboarding-wallet") {
    // Onboarding progress lives in this browser's localStorage, so a fresh context shows it again.
    log("  fresh browser: walking the onboarding screens again");
    await completeOnboarding("p");
    if ((await waitForAny(["home-screen"], 30_000)) !== "home-screen") {
      await shot("p02-not-home");
      throw new Error("did not reach the home screen after onboarding");
    }
  }
  await shot("p02-home");
  log("2. reads through the API");
  const wallets = await logWallets();
  if (wallets.status !== 200) exitCode = 1;
  const portfolio = await apiCall("/v1/portfolio");
  log(`  GET /v1/portfolio -> ${portfolio.status}  ${summarize(portfolio.json)}`);
  if (portfolio.status !== 200) exitCode = 1;
  await saveCredential({});
  if (TOUR) await tour(wallets.json?.wallets?.[0]?.id, portfolio.json?.portfolio);
  if (SEND_NETWORK) await sendNative(SEND_NETWORK, SEND_SYMBOL, SEND_TO, SEND_AMOUNT);
  if (KEEP_OPEN_S > 0) {
    log(`  keeping the page open for ${String(KEEP_OPEN_S)} s`);
    await page.waitForTimeout(KEEP_OPEN_S * 1000);
  }
}

let exitCode = 0;

/** Default run (and --persist with no file yet): sign-up, onboarding, reads, sign-out, login. */
async function signUpRun() {
  // ---- 1. sign-up ---------------------------------------------------------------------
  log(`1. passkey sign-up at ${BASE} as "${LABEL}"`);
  await page.goto(`${BASE}/onboarding/passkey?mode=signup`, { waitUntil: "domcontentloaded" });
  const first = await waitForAny(["onboarding-passkey", "onboarding-passkey-unavailable"], 60_000);
  if (first !== "onboarding-passkey") {
    await shot("01-passkey-unavailable");
    throw new Error(`passkey screen not available (${first})`);
  }
  await tid("passkey-name").click();
  await page.keyboard.type(LABEL);
  await shot("01-signup");
  await tid("passkey-continue").click();
  const afterSignup = await waitForAny(["onboarding-wallet"]);
  if (afterSignup !== "onboarding-wallet") {
    await shot("02-signup-failed");
    log(`  sign-up did not complete: ${afterSignup}`);
    dumpTurnkey();
    throw new Error("sign-up failed");
  }
  const s1 = await session();
  const subOrg = s1?.user?.turnkeySubOrganizationId;
  log(
    `  OK: ZyroPay user ${s1?.user?.id}, Turnkey sub-org ${subOrg} (simulated=${String(s1?.simulated)})`,
  );
  const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  log(
    `  virtual authenticator holds ${creds.credentials.length} credential(s), rpId=${creds.credentials[0]?.rpId}`,
  );
  // Save before anything else can fail: without the key the new sub-org is unreachable.
  await saveCredential({
    userName: LABEL,
    userId: s1?.user?.id,
    subOrganizationId: subOrg,
    createdAt: new Date().toISOString(),
  });
  await shot("02-onboarding-wallet");

  // ---- 2. onboarding -> app -------------------------------------------------------------
  log("2. onboarding");
  await completeOnboarding("");
  await page.waitForTimeout(4000);
  await shot("05-home");

  // ---- 3. real reads through the API ------------------------------------------------------
  log("3. real testnet reads through the API");
  const wallets = await logWallets();
  if (PERSIST) {
    const addresses = (wallets.json?.wallets ?? []).flatMap((w) =>
      (w.addresses ?? []).map((a) => ({ wallet: w.name, family: a.family, address: a.address })),
    );
    await saveCredential({ addresses });
  }
  const portfolio = await apiCall("/v1/portfolio");
  log(`  GET /v1/portfolio -> ${portfolio.status}  ${summarize(portfolio.json)}`);
  const txs = await apiCall("/v1/transactions");
  log(
    `  GET /v1/transactions -> ${txs.status}${txs.status >= 400 ? ` ${JSON.stringify(txs.json)}` : ""}`,
  );
  if (portfolio.status !== 200) exitCode = 1;
  // A persisted user is reused for real tests: keep its account free of watch wallets.
  for (const w of PERSIST ? [] : WATCH) {
    const key = `e2e-watch-${w.network}-${String(Date.now())}`;
    const created = await apiCall("/v1/watch-wallets", {
      method: "POST",
      body: JSON.stringify({
        network: w.network,
        address: w.address,
        name: `e2e ${w.network}`,
        idempotencyKey: key,
      }),
      idempotencyKey: key,
    });
    const id = created.json?.watchWallet?.id;
    log(
      `  POST /v1/watch-wallets ${w.network} ${w.address} -> ${created.status}${created.status >= 400 ? ` ${JSON.stringify(created.json)}` : ""}`,
    );
    if (!id) {
      exitCode = 1;
      continue;
    }
    const wp = await apiCall(`/v1/watch-wallets/${id}/portfolio`);
    log(`  GET watch portfolio -> ${wp.status}  ${summarize(wp.json)}`);
    if (wp.status !== 200) exitCode = 1;
  }
  await page.goto(`${BASE}/wallets`, { waitUntil: "domcontentloaded" });
  await shot("06-wallets");
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await shot("07-settings");

  // ---- 4. sign out, then passkey login -------------------------------------------------
  log("4. sign out, then passkey login");
  await tid("settings-sign-out").click();
  await page.waitForTimeout(800);
  await tid("sign-out-sheet-confirm").click();
  await waitForAny(["onboarding-welcome"], 30_000);
  log(`  signed out: session=${(await session()) === null ? "cleared" : "STILL PRESENT"}`);
  await shot("08-signed-out");
  turnkeyCalls.length = 0;
  await page.goto(`${BASE}/onboarding/passkey?mode=login`, { waitUntil: "domcontentloaded" });
  await waitForAny(["onboarding-passkey"], 30_000);
  await shot("09-login");
  await tid("passkey-continue").click();
  const afterLogin = await waitForAny(["home-screen", "onboarding-wallet"], 90_000);
  const s2 = await session();
  if (!s2 || s2.user?.turnkeySubOrganizationId !== subOrg) {
    log(`  login did not complete: ${afterLogin}`);
    dumpTurnkey();
    throw new Error("login failed");
  }
  log(`  OK: logged back in to sub-org ${s2.user.turnkeySubOrganizationId} (${afterLogin})`);
  await saveCredential({});
  await shot("10-home-after-login");
  // Desktop: the phone-width column is centred (WebFrame.web.tsx).
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot("11-home-desktop");
}

try {
  if (saved) await loginWithSavedCredential();
  else await signUpRun();
} catch (e) {
  exitCode = 1;
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (pageErrors.length)
    log(`page errors:\n  ${[...new Set(pageErrors)].slice(0, 10).join("\n  ")}`);
  await browser.close();
}
process.exitCode = exitCode;
