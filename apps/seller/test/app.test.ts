/*
 * End-to-end through the real Hono app, @x402/hono middleware and @x402/core
 * HTTPFacilitatorClient. Only global fetch is stubbed: the facilitator and Blockfrost are
 * local fakes, so nothing touches the network and nothing is paid.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, REPORT_DESCRIPTION, REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { blockfrostRoutes, FIXTURE_NOW } from "./fixtures";
import type { Route } from "./helpers";
import {
  BLOCKFROST,
  decodeHeader,
  encodeHeader,
  FACILITATOR,
  json,
  makeAddress,
  stubFetch,
  SUPPORTED_FIXTURE,
  TEST_BASE_ADDRESS,
  TEST_PAY_TO,
  TEST_PROJECT_ID,
} from "./helpers";

const ENV: Env = {
  SELLER_ADDRESS: TEST_PAY_TO,
  BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
  // The suite drives the hosted path through a stubbed HTTP facilitator.
  FACILITATOR_MODE: "hosted",
  FACILITATOR_URL: FACILITATOR,
};
const URL_OK = `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;
/** Synthetic settle tx id returned by the FAKE facilitator. */
const FAKE_TX = "f".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function facilitatorRoutes(opts: { verify?: Route; settle?: Route } = {}): Record<string, Route> {
  return {
    [`${FACILITATOR}/supported`]: () => json(SUPPORTED_FIXTURE),
    [`${FACILITATOR}/verify`]:
      opts.verify ?? (() => json({ isValid: true, payer: makeAddress(6, 0, 0x44) })),
    [`${FACILITATOR}/settle`]:
      opts.settle ??
      (() =>
        json({
          success: true,
          transaction: FAKE_TX,
          network: "cardano:preprod",
          payer: makeAddress(6, 0, 0x44),
          extra: { status: "confirmed", confirmations: 0 },
        })),
  };
}

async function get402(app: ReturnType<typeof createApp>, url = URL_OK) {
  const res = await app.request(url, { headers: { accept: "application/json" } });
  expect(res.status).toBe(402);
  return decodeHeader(res.headers.get("PAYMENT-REQUIRED"));
}

/** A PAYMENT-SIGNATURE shaped like ZyroPay's / @x402/fetch's (tx bytes are dummies). */
function paymentHeader(required: any) {
  return encodeHeader({
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { transaction: "AAAA", nonce: `${"a".repeat(64)}#0` },
  });
}

const blockfrostCalls = (calls: { url: string }[]) =>
  calls.filter((c) => c.url.startsWith(BLOCKFROST));
const facilitatorCalls = <T extends { url: string }>(calls: T[], op: string) =>
  calls.filter((c) => c.url === `${FACILITATOR}/${op}`);

describe("free routes", () => {
  it("GET / describes the service without secrets", async () => {
    stubFetch({});
    const res = await createApp(ENV).request("https://seller.example/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      name: "Cardano Address Intelligence",
      simulated: false,
      paidRoute: {
        network: "cardano:preprod",
        asset: "lovelace",
        priceLovelace: "2000000",
        payTo: TEST_PAY_TO,
        maxTimeoutSeconds: 600,
        confirmationPolicy: { l1Confirmations: 0 },
      },
      facilitator: FACILITATOR,
      config: { ok: true },
    });
    expect(JSON.stringify(body)).not.toContain(TEST_PROJECT_ID);
  });

  it("GET /health reports misconfiguration by rule, not value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetch({});
    const res = await createApp({ SELLER_ADDRESS: makeAddress(7, 0) }).request(
      "https://seller.example/health",
    );
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.config.problems).toEqual([
      "SELLER_ADDRESS must have a key-hash payment credential",
      "BLOCKFROST_PROJECT_ID is not set",
    ]);
    expect(body.paidRoute.payTo).toBeNull();
  });
});

describe("402 Payment Required", () => {
  it("advertises x402 v2 exact on cardano:preprod in lovelace", async () => {
    const calls = stubFetch(facilitatorRoutes());
    const required = await get402(createApp(ENV));
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    const accept = required.accepts[0];
    expect(accept).toEqual({
      scheme: "exact",
      network: "cardano:preprod",
      amount: "2000000",
      asset: "lovelace",
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { confirmationPolicy: { l1Confirmations: 0 }, areFeesSponsored: false },
    });
    expect(accept.amount).toMatch(/^[1-9][0-9]*$/);
    expect(required.resource.description).toBe(REPORT_DESCRIPTION);
    expect(required.resource.mimeType).toBe("application/json");
    // No handler, no data source: an unpaid request costs the seller nothing.
    expect(blockfrostCalls(calls)).toHaveLength(0);
  });

  it("binds resource.url to the exact requested URL, query string included", async () => {
    stubFetch(facilitatorRoutes());
    const app = createApp(ENV);
    for (const url of [
      URL_OK,
      `https://seller.example${REPORT_PATH}?address=${makeAddress(6, 0, 0x55)}&format=compact`,
      `http://localhost:8790${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`,
    ]) {
      const required = await get402(app, url);
      expect(required.resource.url).toBe(url);
    }
  });

  it("honours PRICE_LOVELACE and L1_CONFIRMATIONS", async () => {
    stubFetch(facilitatorRoutes());
    const required = await get402(
      createApp({ ...ENV, PRICE_LOVELACE: "1500000", L1_CONFIRMATIONS: "1" }),
    );
    expect(required.accepts[0].amount).toBe("1500000");
    expect(required.accepts[0].extra.confirmationPolicy).toEqual({ l1Confirmations: 1 });
  });

  it("returns 503 (not a 402) when the facilitator is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch({ [FACILITATOR]: () => json({ error: "down" }, 500) });
    const res = await createApp(ENV).request(URL_OK);
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });
});

describe("address validation happens before payment", () => {
  it.each([
    ["missing", `https://seller.example${REPORT_PATH}`],
    ["mainnet", `https://seller.example${REPORT_PATH}?address=${makeAddress(0, 1)}`],
    ["garbage", `https://seller.example${REPORT_PATH}?address=hello`],
    ["stake", `https://seller.example${REPORT_PATH}?address=${makeAddress(14, 0)}`],
    ["twice", `${URL_OK}&address=${TEST_BASE_ADDRESS}`],
  ])("%s address -> 400 with no PAYMENT-REQUIRED and no facilitator call", async (_name, url) => {
    const calls = stubFetch(facilitatorRoutes());
    const res = await createApp(ENV).request(url);
    expect(res.status).toBe(400);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(((await res.json()) as any).error).toEqual(expect.any(String));
    expect(calls).toHaveLength(0);
  });

  it("a misconfigured seller answers 503 instead of asking for payment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = stubFetch(facilitatorRoutes());
    const res = await createApp({ ...ENV, SELLER_ADDRESS: makeAddress(1, 0) }).request(URL_OK);
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("paid requests", () => {
  it("a garbage PAYMENT-SIGNATURE is a fresh 402: no verify, no handler, no settle", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = stubFetch({ ...facilitatorRoutes(), ...blockfrostRoutes() });
    const res = await createApp(ENV).request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": "%%%not-base64" },
    });
    expect(res.status).toBe(402);
    expect(facilitatorCalls(calls, "verify")).toHaveLength(0);
    expect(facilitatorCalls(calls, "settle")).toHaveLength(0);
    expect(blockfrostCalls(calls)).toHaveLength(0);
  });

  it("a payment the facilitator rejects never reaches the handler", async () => {
    const calls = stubFetch({
      ...facilitatorRoutes({
        verify: () =>
          json({ isValid: false, invalidReason: "invalid_exact_cardano_signature", payer: "" }),
      }),
      ...blockfrostRoutes(),
    });
    const app = createApp(ENV);
    const required = await get402(app);
    const res = await app.request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader(required) },
    });
    expect(res.status).toBe(402);
    expect(decodeHeader(res.headers.get("PAYMENT-REQUIRED")).error).toBe(
      "invalid_exact_cardano_signature",
    );
    expect(facilitatorCalls(calls, "verify")).toHaveLength(1);
    expect(facilitatorCalls(calls, "settle")).toHaveLength(0);
    expect(blockfrostCalls(calls)).toHaveLength(0);
  });

  it("a payment for different requirements (e.g. a tampered amount) is refused before verify", async () => {
    const calls = stubFetch({ ...facilitatorRoutes(), ...blockfrostRoutes() });
    const app = createApp(ENV);
    const required = await get402(app);
    required.accepts[0].amount = "1000000";
    const res = await app.request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader(required) },
    });
    expect(res.status).toBe(402);
    expect(facilitatorCalls(calls, "verify")).toHaveLength(0);
    expect(blockfrostCalls(calls)).toHaveLength(0);
  });

  it("verify -> handler -> settle: 200 with the report and a PAYMENT-RESPONSE receipt", async () => {
    const calls = stubFetch({ ...facilitatorRoutes(), ...blockfrostRoutes() });
    const app = createApp(ENV, { now: () => FIXTURE_NOW });
    const required = await get402(app);
    const res = await app.request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader(required) },
    });
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report).toMatchObject({ address: TEST_BASE_ADDRESS, txCount: 42, riskScore: 0 });
    const receipt = decodeHeader(res.headers.get("PAYMENT-RESPONSE"));
    expect(receipt).toMatchObject({
      success: true,
      transaction: FAKE_TX,
      network: "cardano:preprod",
    });

    const settle = facilitatorCalls(calls, "settle");
    expect(settle).toHaveLength(1);
    const body = JSON.parse(settle[0]!.body!);
    expect(body.paymentRequirements).toEqual(required.accepts[0]);
    // Settlement is requested only after the handler fetched its data.
    const lastBlockfrost = calls.map((c) => c.url.startsWith(BLOCKFROST)).lastIndexOf(true);
    expect(calls.findIndex((c) => c.url === `${FACILITATOR}/settle`)).toBeGreaterThan(
      lastBlockfrost,
    );
  });

  it.each([429, 402, 500])(
    "Blockfrost %i -> 503 and the payment is NOT settled",
    async (bfStatus) => {
      const calls = stubFetch({
        ...facilitatorRoutes(),
        [BLOCKFROST]: () => json({ status_code: bfStatus, error: "x", message: "y" }, bfStatus),
      });
      const app = createApp(ENV);
      const required = await get402(app);
      const res = await app.request(URL_OK, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader(required) },
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toMatch(/data source/);
      expect(facilitatorCalls(calls, "verify")).toHaveLength(1);
      expect(facilitatorCalls(calls, "settle")).toHaveLength(0);
    },
  );

  it("a failed settlement withholds the report", async () => {
    const calls = stubFetch({
      ...facilitatorRoutes({
        settle: () =>
          json({
            success: false,
            errorReason: "transaction_failed",
            transaction: "",
            network: "cardano:preprod",
          }),
      }),
      ...blockfrostRoutes(),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApp(ENV, { now: () => FIXTURE_NOW });
    const required = await get402(app);
    const res = await app.request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader(required) },
    });
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("riskScore");
    expect(facilitatorCalls(calls, "settle").length).toBeGreaterThanOrEqual(1);
  });
});
