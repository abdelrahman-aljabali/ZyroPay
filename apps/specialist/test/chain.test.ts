/*
 * The receipt chain, offline: buyer -> Address Intelligence (apps/seller) -> Token
 * Intelligence (this app). Both REAL apps, each with a fake facilitator; the seller's
 * sub-hire wallet is a fake signer; Blockfrost is fixture data. TEST KEYS ONLY.
 */
import { Address, KeyHash, PrivateKey, VKey } from "@evolution-sdk/evolution";
import type { ClientCardanoSigner } from "@x402/cardano";
import { createApp as createSeller } from "@zyropay/seller/app";
import { verifyDeliveryReceipt } from "@zyropay/seller/receipt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp as createSpecialist, REPORT_PATH } from "../src/app";
import type { Route } from "./support";
import {
  BLOCKFROST,
  blockfrostRoutes,
  decodeHeader,
  enterpriseAddress,
  fakeFacilitator,
  json,
  NOW,
  paymentFor,
  SPEC_ADDRESS,
  SPEC_SEED,
  stubFetch,
  TEST_PROJECT_ID,
  UNIT,
} from "./support";

/** TEST ONLY: the Address Intelligence seller's payTo key. */
const SELLER_SEED = "5e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11";
const SELLER_ADDRESS = enterpriseAddress(SELLER_SEED);
const SPECIALIST = "https://token-intel.example";
const QUERIED = enterpriseAddress("77".repeat(32));
const MAIN_TX = "a".repeat(64);
const SUB_TX = "b".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Blockfrost for the queried address: 9 ADA and 1000 of UNIT. */
function addressRoutes(): Record<string, Route> {
  const a = `${BLOCKFROST}/addresses/${QUERIED}`;
  return {
    [a]: () =>
      json({
        address: QUERIED,
        amount: [
          { unit: "lovelace", quantity: "9000000" },
          { unit: UNIT, quantity: "1000" },
        ],
        stake_address: null,
        type: "shelley",
        script: false,
      }),
    [`${a}/total`]: () => json({ address: QUERIED, received_sum: [], sent_sum: [], tx_count: 1 }),
    [`${a}/transactions?order=desc&count=20`]: () =>
      json([{ tx_hash: "9".repeat(64), tx_index: 0, block_height: 1, block_time: 1_793_318_400 }]),
    [`${a}/utxos?count=100`]: () => json([]),
  };
}

describe("agents hiring agents", () => {
  it("Claude -> Address Intelligence -> Token Intelligence: every hop paid and receipted", async () => {
    const spec = fakeFacilitator(SUB_TX);
    const specialist = createSpecialist(
      {
        SELLER_ADDRESS: SPEC_ADDRESS,
        BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
        SELLER_SIGNING_KEY: SPEC_SEED,
      },
      { facilitator: spec.facilitator, now: () => NOW },
    );
    stubFetch({
      ...blockfrostRoutes(),
      ...addressRoutes(),
      [`${SPECIALIST}/`]: (req) => specialist.fetch(req),
    });
    const signed: unknown[] = [];
    const wallet: ClientCardanoSigner = {
      getAddress: () =>
        Address.toBech32(
          new Address.Address({
            networkId: 0,
            paymentCredential: KeyHash.fromVKey(
              VKey.fromPrivateKey(PrivateKey.fromHex("66".repeat(32))),
            ),
          }),
        ),
      buildAndSignPaymentTransaction: (input) => {
        signed.push(input);
        return { transaction: "AAAA", nonce: `${"c".repeat(64)}#0` };
      },
    };
    const main = fakeFacilitator(MAIN_TX);
    const seller = createSeller(
      {
        SELLER_ADDRESS,
        BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
        SELLER_SIGNING_KEY: SELLER_SEED,
        SUBHIRE_ENABLED: "true",
        SPECIALIST_URL: SPECIALIST,
        SPECIALIST_PAY_TO: SPEC_ADDRESS,
        SELLER_BUYER_MNEMONIC: Array.from({ length: 24 }, () => "abandon").join(" "),
      },
      { facilitator: main.facilitator, now: () => NOW, subhireSigner: wallet },
    );

    const url = `https://address-intel.example/v1/address-report?address=${QUERIED}`;
    const required = decodeHeader((await seller.request(url)).headers.get("PAYMENT-REQUIRED"));
    const res = await seller.request(url, {
      headers: { "PAYMENT-SIGNATURE": paymentFor(required) },
    });
    expect(res.status).toBe(200);
    const bytes = Uint8Array.from(new Uint8Array(await res.arrayBuffer()));
    const report = JSON.parse(Buffer.from(bytes).toString());

    // Hop 1: the buyer's receipt from Address Intelligence covers the whole body...
    const outer = await verifyDeliveryReceipt(res.headers.get("X-Delivery-Receipt"), {
      resourceUrl: url,
      payTo: SELLER_ADDRESS,
      paymentTx: MAIN_TX,
      body: bytes,
    });
    expect(outer.ok).toBe(true);
    // ...which embeds hop 2: the specialist's report, receipt and the sub-payment tx.
    const sub = report.subcontracted[0];
    expect(sub).toMatchObject({
      status: "delivered",
      payTo: SPEC_ADDRESS,
      priceLovelace: "1500000",
      paymentTx: SUB_TX,
      receiptVerified: true,
      resourceUrl: `${SPECIALIST}${REPORT_PATH}?unit=${UNIT}`,
      report: { query: UNIT, found: true },
    });
    // Anyone can re-check hop 2 from the embedded data alone (c.json re-serialises the
    // specialist's JSON byte-identically: same key order, no whitespace).
    const inner = await verifyDeliveryReceipt(
      Buffer.from(JSON.stringify(sub.receipt)).toString("base64"),
      {
        resourceUrl: sub.resourceUrl,
        payTo: SPEC_ADDRESS,
        paymentTx: SUB_TX,
        body: Uint8Array.from(Buffer.from(JSON.stringify(sub.report))),
      },
    );
    expect(inner.ok).toBe(true);
    expect(signed).toHaveLength(1);
    expect(spec.calls).toEqual({ verify: 1, settle: 1 });
    expect(main.calls).toEqual({ verify: 1, settle: 1 });
  });
});
