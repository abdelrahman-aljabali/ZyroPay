/*
 * The real Hono app + @x402/hono + @x402/cardano's server scheme, with a FAKE facilitator
 * and fixture Blockfrost. Nothing touches the network and nothing is paid.
 */
import { verifyDeliveryReceipt } from "@zyropay/seller/receipt";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/app";
import { createApp, REPORT_PATH } from "../src/app";
import {
  BLOCKFROST,
  blockfrostRoutes,
  decodeHeader,
  fakeFacilitator,
  json,
  NOW,
  paymentFor,
  POLICY,
  SPEC_ADDRESS,
  SPEC_SEED,
  stubFetch,
  TEST_PROJECT_ID,
  UNIT,
} from "./support";

const TX = "e".repeat(64);
const ENV: Env = {
  SELLER_ADDRESS: SPEC_ADDRESS,
  BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
  SELLER_SIGNING_KEY: SPEC_SEED,
};
const URL_OK = `https://token-intel.example${REPORT_PATH}?unit=${UNIT}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("free routes", () => {
  it("describes the service; a bad config is reported by rule name and never asks for payment", async () => {
    const app = createApp(ENV, { facilitator: fakeFacilitator(TX).facilitator });
    const info = (await (await app.request("https://token-intel.example/")).json()) as any;
    expect(info).toMatchObject({
      name: "Cardano Token Intelligence",
      paidRoute: { priceLovelace: "1500000", payTo: SPEC_ADDRESS, network: "cardano:preprod" },
      config: { ok: true },
      deliveryReceipts: { enabled: true },
    });
    const bad = createApp({ ...ENV, SELLER_ADDRESS: "addr_test1_REPLACE_WITH_SPECIALIST_ADDRESS" });
    const badInfo = (await (await bad.request("https://token-intel.example/")).json()) as any;
    expect(badInfo.config.ok).toBe(false);
    expect(badInfo.config.problems.join(" ")).toContain("SELLER_ADDRESS");
    expect((await bad.request(URL_OK)).status).toBe(503);
  });
});

describe("the paid route", () => {
  it("400s an invalid unit before any 402 or facilitator call", async () => {
    const { facilitator, calls } = fakeFacilitator(TX);
    const app = createApp(ENV, { facilitator });
    for (const q of ["", "?unit=xyz", `?unit=${UNIT}&unit=${UNIT}`])
      expect((await app.request(`https://token-intel.example${REPORT_PATH}${q}`)).status).toBe(400);
    expect(calls).toEqual({ verify: 0, settle: 0 });
  });

  it("402 -> paid 200 with settlement and a verifiable delivery receipt", async () => {
    const bf = stubFetch(blockfrostRoutes());
    const { facilitator, calls } = fakeFacilitator(TX);
    const app = createApp(ENV, { facilitator, now: () => NOW });
    const first = await app.request(URL_OK);
    expect(first.status).toBe(402);
    const required = decodeHeader(first.headers.get("PAYMENT-REQUIRED"));
    expect(required.resource.url).toBe(URL_OK);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "cardano:preprod",
      amount: "1500000",
      asset: "lovelace",
      payTo: SPEC_ADDRESS,
    });
    expect(bf).toHaveLength(0);

    const paid = await app.request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": paymentFor(required) },
    });
    expect(paid.status).toBe(200);
    expect(calls).toEqual({ verify: 1, settle: 1 });
    expect(decodeHeader(paid.headers.get("PAYMENT-RESPONSE"))).toMatchObject({
      success: true,
      transaction: TX,
    });
    const bytes = Uint8Array.from(new Uint8Array(await paid.arrayBuffer()));
    const report = JSON.parse(Buffer.from(bytes).toString());
    expect(report).toMatchObject({ query: UNIT, queryKind: "asset", found: true, riskScore: 70 });
    const check = await verifyDeliveryReceipt(paid.headers.get("X-Delivery-Receipt"), {
      resourceUrl: URL_OK,
      payTo: SPEC_ADDRESS,
      paymentTx: TX,
      body: bytes,
    });
    expect(check.ok).toBe(true);
  });

  it("a policy id reports the policy's largest asset", async () => {
    stubFetch(blockfrostRoutes());
    const { facilitator } = fakeFacilitator(TX);
    const app = createApp(ENV, { facilitator, now: () => NOW });
    const url = `https://token-intel.example${REPORT_PATH}?unit=${POLICY}`;
    const required = decodeHeader((await app.request(url)).headers.get("PAYMENT-REQUIRED"));
    const paid = await app.request(url, { headers: { "PAYMENT-SIGNATURE": paymentFor(required) } });
    expect(paid.status).toBe(200);
    const report = (await paid.json()) as any;
    expect(report).toMatchObject({
      queryKind: "policy",
      policy: { assetCount: 2 },
      asset: { unit: UNIT },
    });
  });

  it("a Blockfrost outage is a 503 and the payment is NOT settled", async () => {
    stubFetch({ [`${BLOCKFROST}/`]: () => json({ error: "rate limited" }, 429) });
    const { facilitator, calls } = fakeFacilitator(TX);
    const app = createApp(ENV, { facilitator, now: () => NOW });
    const required = decodeHeader((await app.request(URL_OK)).headers.get("PAYMENT-REQUIRED"));
    const res = await app.request(URL_OK, {
      headers: { "PAYMENT-SIGNATURE": paymentFor(required) },
    });
    expect(res.status).toBe(503);
    expect(calls.settle).toBe(0);
  });
});
