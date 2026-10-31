import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { cardanoEnterpriseAddress } from "./cardano";
import type { X402Receipt } from "./x402-receipt";
import {
  decodeX402Receipt,
  verifyX402Receipt,
  X402_RECEIPT_MAX_HEADER_BYTES,
  x402ReceiptMessage,
} from "./x402-receipt";

/** TEST-ONLY key (fixed bytes). */
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUBLIC_KEY = bytesToHex(ed25519.getPublicKey(SECRET));
const PAY_TO = cardanoEnterpriseAddress(PUBLIC_KEY, "cardano-preprod");
const URL = "https://address-intel.zyropay.online/v1/report?address=addr_test1vabc";
const SHA = "ab".repeat(32);
const TX = "cd".repeat(32);

function receipt(overrides: Partial<X402Receipt> = {}, secret = SECRET): X402Receipt {
  const unsigned = {
    resourceUrl: URL,
    payTo: PAY_TO,
    paymentTx: TX,
    contentSha256: SHA,
    signedAt: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
  return {
    v: 1,
    ...unsigned,
    publicKey: bytesToHex(ed25519.getPublicKey(secret)),
    signature: bytesToHex(ed25519.sign(utf8ToBytes(x402ReceiptMessage(unsigned)), secret)),
  };
}

const expected = {
  payTo: PAY_TO,
  sameResource: (u: string) => u === URL,
  contentSha256: SHA,
  paymentTx: TX,
};
const header = (value: unknown) => btoa(JSON.stringify(value));

describe("x402 delivery receipt", () => {
  it("round-trips the header and verifies", () => {
    const decoded = decodeX402Receipt(header(receipt()));
    expect(decoded).not.toBeNull();
    expect(verifyX402Receipt(decoded!, expected)).toEqual({ ok: true });
    expect(verifyX402Receipt(receipt({ paymentTx: null }), expected)).toEqual({ ok: true });
  });

  it("names why a receipt fails", () => {
    const other = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
    expect(verifyX402Receipt(receipt({}, other), expected)).toMatchObject({
      reason: "wrong_signer",
    });
    expect(verifyX402Receipt(receipt({ resourceUrl: `${URL}x` }), expected)).toMatchObject({
      reason: "wrong_resource",
    });
    expect(verifyX402Receipt(receipt({ paymentTx: "ee".repeat(32) }), expected)).toMatchObject({
      reason: "wrong_payment",
    });
    expect(verifyX402Receipt(receipt(), { ...expected, contentSha256: "00".repeat(32) })).toEqual({
      ok: false,
      reason: "content_mismatch",
    });
    expect(verifyX402Receipt(receipt(), { ...expected, contentSha256: null })).toEqual({
      ok: false,
      reason: "body_unavailable",
    });
    const forged = { ...receipt(), signedAt: "2026-10-30T12:00:01.000Z" };
    expect(verifyX402Receipt(forged, expected)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects anything that is not a bounded v1 receipt", () => {
    expect(decodeX402Receipt("")).toBeNull();
    expect(decodeX402Receipt("not base64!")).toBeNull();
    expect(decodeX402Receipt(header({ ...receipt(), v: 2 }))).toBeNull();
    expect(decodeX402Receipt(header({ ...receipt(), extra: 1 }))).toBeNull();
    expect(decodeX402Receipt("A".repeat(X402_RECEIPT_MAX_HEADER_BYTES + 4))).toBeNull();
  });
});
