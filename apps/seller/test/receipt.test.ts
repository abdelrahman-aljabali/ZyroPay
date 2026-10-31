/*
 * Delivery receipts through the real app and x402 middleware (fetch stubbed, nothing paid).
 * Receipts are checked with ZyroPay's own verifier (@zyropay/shared), so this also pins
 * the wire format both sides agree on. TEST-ONLY keys: fixed bytes and the public BIP-39
 * test mnemonic, never a funded wallet.
 */
import { PrivateKey, VKey } from "@evolution-sdk/evolution";
import { keysFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import {
  cardanoEnterpriseAddress,
  decodeX402Receipt,
  verifyX402Receipt,
  X402_RECEIPT_HEADER,
} from "@zyropay/shared";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { loadReceiptSigner, RECEIPT_HEADER } from "../src/receipt";
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
  TEST_PROJECT_ID,
} from "./helpers";

/** TEST-ONLY 32-byte Ed25519 seed. */
const TEST_SIGNING_KEY = "07".repeat(32);
const TEST_PUBLIC_KEY = VKey.toHex(VKey.fromPrivateKey(PrivateKey.fromHex(TEST_SIGNING_KEY)));
const PAY_TO = cardanoEnterpriseAddress(TEST_PUBLIC_KEY, "cardano-preprod");
const FAKE_TX = "f".repeat(64);
const URL_OK = `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;

const ENV: Env = {
  SELLER_ADDRESS: PAY_TO,
  BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
  FACILITATOR_MODE: "hosted",
  FACILITATOR_URL: FACILITATOR,
  SELLER_SIGNING_KEY: TEST_SIGNING_KEY,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function facilitatorRoutes(): Record<string, Route> {
  return {
    [`${FACILITATOR}/supported`]: () => json(SUPPORTED_FIXTURE),
    [`${FACILITATOR}/verify`]: () => json({ isValid: true, payer: makeAddress(6, 0, 0x44) }),
    [`${FACILITATOR}/settle`]: () =>
      json({
        success: true,
        transaction: FAKE_TX,
        network: "cardano:preprod",
        payer: makeAddress(6, 0, 0x44),
      }),
  };
}

async function paidRequest(env: Env, dataRoutes: Record<string, Route> = blockfrostRoutes()) {
  stubFetch({ ...facilitatorRoutes(), ...dataRoutes });
  const app = createApp(env, { now: () => FIXTURE_NOW });
  const first = await app.request(URL_OK);
  expect(first.status).toBe(402);
  expect(first.headers.get(RECEIPT_HEADER)).toBeNull();
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
  const body = new Uint8Array(await res.arrayBuffer());
  return { res, body, app };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function verify(header: string | null, body: Uint8Array, url = URL_OK) {
  const receipt = decodeX402Receipt(header ?? "");
  if (receipt === null) throw new Error("no receipt");
  return {
    receipt,
    check: verifyX402Receipt(receipt, {
      payTo: PAY_TO,
      sameResource: (u) => u === url,
      contentSha256: sha256(body),
      paymentTx: FAKE_TX,
    }),
  };
}

describe("delivery receipt", () => {
  it("a paid, settled response is signed by the payTo key over the exact body bytes", async () => {
    const { res, body } = await paidRequest(ENV);
    expect(res.status).toBe(200);
    expect(RECEIPT_HEADER).toBe(X402_RECEIPT_HEADER);
    const { receipt, check } = verify(res.headers.get(RECEIPT_HEADER), body);
    expect(check).toEqual({ ok: true });
    expect(receipt).toMatchObject({
      v: 1,
      resourceUrl: URL_OK,
      payTo: PAY_TO,
      paymentTx: FAKE_TX,
      publicKey: TEST_PUBLIC_KEY,
      contentSha256: sha256(body),
      signedAt: FIXTURE_NOW.toISOString(),
    });
    // The body is still the report, unchanged, next to the settlement header.
    expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({ txCount: 42 });
    expect(decodeHeader(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true });
  });

  it("the hash covers the exact bytes: one changed byte, another URL or payTo fail", async () => {
    const { res, body } = await paidRequest(ENV);
    const header = res.headers.get(RECEIPT_HEADER);
    const tampered = body.slice();
    const at = tampered.length - 2;
    tampered[at] = (tampered[at] ?? 0) ^ 0x01;
    expect(verify(header, tampered).check).toEqual({ ok: false, reason: "content_mismatch" });
    expect(verify(header, body, `${URL_OK}x`).check).toEqual({
      ok: false,
      reason: "wrong_resource",
    });
    const receipt = decodeX402Receipt(header ?? "")!;
    expect(
      verifyX402Receipt(receipt, {
        payTo: makeAddress(6, 0, 0x33),
        sameResource: () => true,
        contentSha256: sha256(body),
        paymentTx: null,
      }),
    ).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("accepts the 64-byte extended key that `receipt-key` writes", async () => {
    // Public BIP-39 test mnemonic: TEST ONLY.
    const mnemonic = `${"abandon ".repeat(23)}art`;
    const key = PrivateKey.fromBech32(keysFromSeed(mnemonic).paymentKey);
    const payTo = cardanoEnterpriseAddress(VKey.toHex(VKey.fromPrivateKey(key)), "cardano-preprod");
    const signer = loadReceiptSigner(PrivateKey.toHex(key), payTo);
    expect(signer.ok).toBe(true);
    const { res, body } = await paidRequest({
      ...ENV,
      SELLER_ADDRESS: payTo,
      SELLER_SIGNING_KEY: PrivateKey.toHex(key),
    });
    const receipt = decodeX402Receipt(res.headers.get(RECEIPT_HEADER) ?? "")!;
    expect(
      verifyX402Receipt(receipt, {
        payTo,
        sameResource: (u) => u === URL_OK,
        contentSha256: sha256(body),
        paymentTx: FAKE_TX,
      }),
    ).toEqual({ ok: true });
  });

  it("without a key the paid request is still served, without a receipt (warned once)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { res, body, app } = await paidRequest({ ...ENV, SELLER_SIGNING_KEY: undefined });
    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({ txCount: 42 });
    await app.request(URL_OK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("SELLER_SIGNING_KEY is not set");
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.deliveryReceipts).toEqual({ enabled: false });
  });

  it("a key that is not payTo's payment key is never used", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { res } = await paidRequest({ ...ENV, SELLER_SIGNING_KEY: "08".repeat(32) });
    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain("not the payment key of SELLER_ADDRESS");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("08".repeat(32));
    expect(loadReceiptSigner("zz", PAY_TO)).toEqual({
      ok: false,
      problem: "SELLER_SIGNING_KEY must be 32 or 64 bytes of hex",
    });
  });

  it("an unpaid or failed request carries no receipt", async () => {
    const { res } = await paidRequest(ENV, {
      [BLOCKFROST]: () => json({ status_code: 500, error: "x", message: "y" }, 500),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
  });

  it("GET / says receipts are on, never shows the key", async () => {
    stubFetch(facilitatorRoutes());
    const text = await (await createApp(ENV).request("https://seller.example/")).text();
    expect(JSON.parse(text).deliveryReceipts).toMatchObject({ enabled: true });
    expect(text).not.toContain(TEST_SIGNING_KEY);
  });
});
