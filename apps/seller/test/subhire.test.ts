/*
 * Agents hiring agents, offline: the seller (hosted-facilitator mode, stubbed) sub-hires a
 * FAKE Cardano Token Intelligence (a tiny Hono app with the real receipt middleware and a
 * test key) through @x402/fetch, with a fake buyer signer. Nothing is paid, nothing touches
 * the network. TEST KEYS ONLY.
 */
import { Address, KeyHash, PrivateKey, VKey } from "@evolution-sdk/evolution";
import type { ClientCardanoSigner } from "@x402/cardano";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { loadReceiptSigner, receiptMiddleware, verifyDeliveryReceipt } from "../src/receipt";
import { loadSubhireConfig, topToken } from "../src/subhire";
import { blockfrostRoutes, FIXTURE_NOW } from "./fixtures";
import { SELLER_ADDRESS, SELLER_SEED } from "./escrow-fixtures";
import type { Route } from "./helpers";
import {
  BLOCKFROST,
  decodeHeader,
  encodeHeader,
  FACILITATOR,
  json,
  makeAddress,
  SUPPORTED_FIXTURE,
  TEST_BASE_ADDRESS,
  TEST_PROJECT_ID,
} from "./helpers";

/** TEST ONLY: the fake specialist's payTo key. */
const SPEC_SEED = "5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec";
const SPEC_ADDRESS = Address.toBech32(
  new Address.Address({
    networkId: 0,
    paymentCredential: KeyHash.fromVKey(VKey.fromPrivateKey(PrivateKey.fromHex(SPEC_SEED))),
  }),
);
const SPECIALIST = "https://specialist.test";
const TOP_UNIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa74657374746f6b656e";
const SPEC_URL = `${SPECIALIST}/v1/token-report?unit=${TOP_UNIT}`;
const SUB_TX = "5".repeat(64);
const MAIN_TX = "f".repeat(64);
const URL_OK = `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;
const TEST_MNEMONIC = Array.from({ length: 24 }, () => "abandon").join(" ");

const ENV: Env = {
  SELLER_ADDRESS,
  BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
  FACILITATOR_MODE: "hosted",
  FACILITATOR_URL: FACILITATOR,
  SELLER_SIGNING_KEY: SELLER_SEED,
  SUBHIRE_ENABLED: "true",
  SPECIALIST_URL: SPECIALIST,
  SPECIALIST_PAY_TO: SPEC_ADDRESS,
  SELLER_BUYER_MNEMONIC: TEST_MNEMONIC,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fake buyer wallet: returns dummy tx bytes (the fake specialist never decodes them). */
function fakeSigner() {
  const calls: unknown[] = [];
  const signer: ClientCardanoSigner = {
    getAddress: () => makeAddress(6, 0, 0x55),
    buildAndSignPaymentTransaction: (input) => {
      calls.push(input);
      return { transaction: "AAAA", nonce: `${"b".repeat(64)}#0` };
    },
  };
  return { signer, calls };
}

interface SpecOpts {
  amount?: string;
  payTo?: string;
  paidStatus?: number;
  tamper?: boolean;
}

/** A fake Token Intelligence: 402 without payment; with one, a report + receipt. */
function fakeSpecialist(opts: SpecOpts = {}) {
  const seen: { paid: boolean; payment?: any }[] = [];
  const signer = loadReceiptSigner(SPEC_SEED, SPEC_ADDRESS);
  if (!signer.ok) throw new Error(signer.problem);
  const app = new Hono();
  app.use("/v1/token-report", async (c, next) => {
    await next();
    if (opts.tamper !== true || c.res.status !== 200) return;
    const headers = new Headers(c.res.headers);
    c.res = undefined;
    c.res = new Response(JSON.stringify({ tampered: true }), { status: 200, headers });
  });
  // Inside the tamper layer: it signs the honest body, which the tamper layer then swaps.
  app.use(
    "/v1/token-report",
    receiptMiddleware(signer.signer, () => FIXTURE_NOW),
  );
  app.get("/v1/token-report", (c) => {
    const sig = c.req.header("PAYMENT-SIGNATURE");
    seen.push({ paid: sig !== undefined, ...(sig ? { payment: decodeHeader(sig) } : {}) });
    if (sig === undefined) {
      c.header(
        "PAYMENT-REQUIRED",
        encodeHeader({
          x402Version: 2,
          error: "Payment required",
          resource: { url: c.req.url, description: "token report", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network: "cardano:preprod",
              amount: opts.amount ?? "1500000",
              asset: "lovelace",
              payTo: opts.payTo ?? SPEC_ADDRESS,
              maxTimeoutSeconds: 600,
              extra: { confirmationPolicy: { l1Confirmations: 0 }, areFeesSponsored: false },
            },
          ],
        }),
      );
      return c.json({}, 402);
    }
    if (opts.paidStatus !== undefined && opts.paidStatus !== 200)
      return c.json({ error: "boom" }, opts.paidStatus as 500);
    c.header(
      "PAYMENT-RESPONSE",
      encodeHeader({
        success: true,
        transaction: SUB_TX,
        network: "cardano:preprod",
        payer: makeAddress(6, 0, 0x55),
      }),
    );
    return c.json({ unit: c.req.query("unit"), holders: { count: 3 }, riskScore: 10 });
  });
  return { app, seen };
}

function routes(spec: ReturnType<typeof fakeSpecialist>, extra: Record<string, Route> = {}) {
  return {
    ...blockfrostRoutes(),
    [`${FACILITATOR}/supported`]: () => json(SUPPORTED_FIXTURE),
    [`${FACILITATOR}/verify`]: () => json({ isValid: true, payer: makeAddress(6, 0, 0x44) }),
    [`${FACILITATOR}/settle`]: () =>
      json({ success: true, transaction: MAIN_TX, network: "cardano:preprod" }),
    [SPECIALIST]: (url: URL, init: RequestInit | undefined) => spec.app.request(url.href, init),
    ...extra,
  } satisfies Record<string, Route>;
}

/** stubFetch passes a Request through as `input`; forward its headers to the fake. */
function stubWithRequests(r: Record<string, Route>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.url);
    const key = Object.keys(r)
      .filter((k) => req.url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unexpected fetch in test: ${req.url}`);
    return r[key]!(new URL(req.url), { method: req.method, headers: req.headers });
  });
  return calls;
}

async function buy(env: Env, signer: ClientCardanoSigner) {
  const app = createApp(env, { now: () => FIXTURE_NOW, subhireSigner: signer });
  const first = await app.request(URL_OK);
  expect(first.status).toBe(402);
  const required = decodeHeader(first.headers.get("PAYMENT-REQUIRED"));
  const res = await app.request(URL_OK, {
    headers: {
      "PAYMENT-SIGNATURE": encodeHeader({
        x402Version: 2,
        resource: required.resource,
        accepted: required.accepts[0],
        payload: { transaction: "AAAA", nonce: `${"a".repeat(64)}#0` },
      }),
    },
  });
  return res;
}

describe("sub-hire config", () => {
  const bf = { blockfrostBaseUrl: BLOCKFROST, blockfrostProjectId: TEST_PROJECT_ID };
  it("is off by default and lists rule names (never values) when misconfigured", () => {
    expect(loadSubhireConfig({}, bf).enabled).toBe(false);
    const bad = loadSubhireConfig(
      {
        SUBHIRE_ENABLED: "true",
        SPECIALIST_URL: "http://evil.example",
        SUBHIRE_MAX_LOVELACE: "5000000",
        SELLER_BUYER_MNEMONIC: "secret words",
      },
      bf,
    );
    expect(bad.enabled).toBe(false);
    const problems = bad.enabled ? [] : bad.problems.join(" | ");
    expect(problems).toContain("SPECIALIST_URL");
    expect(problems).toContain("SUBHIRE_MAX_LOVELACE");
    expect(problems).toContain("SELLER_BUYER_MNEMONIC");
    expect(problems).not.toContain("secret");
    const ok = loadSubhireConfig(ENV, bf);
    expect(ok.enabled && ok.config.maxLovelace).toBe(3_000_000n);
  });

  it("picks the largest holding, ties by unit, ignoring lovelace", () => {
    expect(
      topToken([
        { unit: "lovelace", quantity: "99999999" },
        { unit: `${"b".repeat(56)}01`, quantity: "7" },
        { unit: `${"a".repeat(56)}02`, quantity: "7" },
        { unit: "c".repeat(56), quantity: "3" },
      ]),
    ).toBe(`${"a".repeat(56)}02`);
    expect(topToken([{ unit: "lovelace", quantity: "1" }])).toBeNull();
    expect(topToken(undefined)).toBeNull();
  });
});

describe("sub-hiring Cardano Token Intelligence", () => {
  it("pays the specialist, embeds its report + verified receipt + tx: a receipt chain", async () => {
    const spec = fakeSpecialist();
    stubWithRequests(routes(spec));
    const { signer, calls } = fakeSigner();
    const res = await buy(ENV, signer);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = JSON.parse(Buffer.from(bytes).toString());
    expect(body.subcontracted).toHaveLength(1);
    const sub = body.subcontracted[0];
    expect(sub).toMatchObject({
      status: "delivered",
      service: "Cardano Token Intelligence",
      unit: TOP_UNIT,
      resourceUrl: SPEC_URL,
      payTo: SPEC_ADDRESS,
      priceLovelace: "1500000",
      paymentTx: SUB_TX,
      receiptVerified: true,
      report: { unit: TOP_UNIT, holders: { count: 3 } },
    });
    expect(sub.receipt).toMatchObject({ payTo: SPEC_ADDRESS, paymentTx: SUB_TX });
    // One 402 + one paid retry; the wallet signed exactly one payment of the asked amount.
    expect(spec.seen.map((s) => s.paid)).toEqual([false, true]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ payTo: SPEC_ADDRESS, amount: "1500000", asset: "lovelace" });
    // The outer link: the seller's own receipt signs the body that contains the inner one.
    const outer = await verifyDeliveryReceipt(res.headers.get("X-Delivery-Receipt"), {
      resourceUrl: URL_OK,
      payTo: SELLER_ADDRESS,
      paymentTx: MAIN_TX,
      body: Uint8Array.from(bytes),
    });
    expect(outer.ok).toBe(true);
  });

  it("refuses a price above the per-job cap (no payment signed); the report still ships", async () => {
    const spec = fakeSpecialist({ amount: "3000001" });
    stubWithRequests(routes(spec));
    const { signer, calls } = fakeSigner();
    const res = await buy(ENV, signer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.riskScore).toBeTypeOf("number");
    expect(body.subcontracted[0]).toMatchObject({ status: "failed", unit: TOP_UNIT });
    expect(body.subcontracted[0].reason).toContain("sub-payment failed");
    expect(calls).toHaveLength(0);
    expect(spec.seen.map((s) => s.paid)).toEqual([false]);
  });

  it("refuses a payTo other than the pinned specialist", async () => {
    const spec = fakeSpecialist({ payTo: makeAddress(6, 0, 0x66) });
    stubWithRequests(routes(spec));
    const { signer, calls } = fakeSigner();
    const body = (await (await buy(ENV, signer)).json()) as any;
    expect(body.subcontracted[0].status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("fails soft when the specialist errors after payment", async () => {
    const spec = fakeSpecialist({ paidStatus: 500 });
    stubWithRequests(routes(spec));
    const res = await buy(ENV, fakeSigner().signer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.subcontracted[0]).toMatchObject({ status: "failed" });
    expect(body.subcontracted[0].reason).toContain("HTTP 500");
  });

  it("flags a specialist receipt that does not match the delivered bytes", async () => {
    const spec = fakeSpecialist({ tamper: true });
    stubWithRequests(routes(spec));
    const body = (await (await buy(ENV, fakeSigner().signer)).json()) as any;
    expect(body.subcontracted[0]).toMatchObject({
      status: "delivered",
      receiptVerified: false,
      receiptProblem: "receipt hash does not match the delivered bytes",
    });
  });

  it("fails soft when the specialist is unreachable", async () => {
    stubWithRequests({
      ...routes(fakeSpecialist()),
      [SPECIALIST]: () => {
        throw new TypeError("network down");
      },
    });
    const res = await buy(ENV, fakeSigner().signer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.subcontracted[0].status).toBe("failed");
  });

  it("hires nobody for an address without native tokens, and is absent when off", async () => {
    const spec = fakeSpecialist();
    const a = `${BLOCKFROST}/addresses/${TEST_BASE_ADDRESS}`;
    stubWithRequests(
      routes(spec, {
        [a]: () =>
          json({
            address: TEST_BASE_ADDRESS,
            amount: [{ unit: "lovelace", quantity: "5000000" }],
            stake_address: null,
            type: "shelley",
            script: false,
          }),
      }),
    );
    const body = (await (await buy(ENV, fakeSigner().signer)).json()) as any;
    expect(body.subcontracted).toEqual([]);
    expect(spec.seen).toHaveLength(0);

    const off = (await (
      await buy({ ...ENV, SUBHIRE_ENABLED: undefined }, fakeSigner().signer)
    ).json()) as any;
    expect(off.subcontracted).toBeUndefined();
  });

  it("the info route describes sub-hiring (and its problems by rule name)", async () => {
    stubWithRequests(routes(fakeSpecialist()));
    const on = (await (await createApp(ENV).request("https://seller.example/")).json()) as any;
    expect(on.subcontracting).toMatchObject({ enabled: true, maxLovelacePerJob: "3000000" });
    const bad = createApp({ ...ENV, SELLER_BUYER_MNEMONIC: undefined });
    const info = (await (await bad.request("https://seller.example/")).json()) as any;
    expect(info.subcontracting.enabled).toBe(false);
    expect(info.subcontracting.problems.join(" ")).toContain("SELLER_BUYER_MNEMONIC");
  });
});
