import { Address } from "@evolution-sdk/evolution";
import { addressFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import { isValidCardanoPaymentAddress } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { checkPayToAddress, checkQueryAddress, parseShelleyAddress } from "../src/address";
import { makeAddress, TEST_BASE_ADDRESS, TEST_PAY_TO, TEST_STAKE_ADDRESS } from "./helpers";

// BIP-39 test vector mnemonic (public, holds nothing): used only to derive a real-shaped address.
const TEST_VECTOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("parseShelleyAddress", () => {
  it("reads kind, network and payment credential from the CIP-19 header", () => {
    expect(parseShelleyAddress(makeAddress(0, 0))).toMatchObject({
      kind: "base",
      networkId: 0,
      paymentCredential: "key",
    });
    expect(parseShelleyAddress(makeAddress(1, 0))?.paymentCredential).toBe("script");
    expect(parseShelleyAddress(makeAddress(4, 0))?.kind).toBe("pointer");
    expect(parseShelleyAddress(makeAddress(6, 0))?.kind).toBe("enterprise");
    expect(parseShelleyAddress(makeAddress(7, 0))?.paymentCredential).toBe("script");
  });

  it("rejects reward addresses, bad checksums, mixed case and a wrong prefix", () => {
    expect(parseShelleyAddress(TEST_STAKE_ADDRESS)).toBeNull();
    const a = TEST_BASE_ADDRESS;
    const flipped = a.slice(0, -1) + (a.endsWith("q") ? "p" : "q");
    expect(parseShelleyAddress(flipped)).toBeNull();
    expect(parseShelleyAddress(a.slice(0, 20) + a.slice(20).toUpperCase())).toBeNull();
    expect(parseShelleyAddress(a.toUpperCase())?.bech32).toBe(a);
    expect(parseShelleyAddress("addr_test1")).toBeNull();
    expect(parseShelleyAddress("")).toBeNull();
  });
});

describe("checkQueryAddress (what a buyer may ask about)", () => {
  it("accepts any testnet payment address, including script addresses", () => {
    for (const type of [0, 1, 2, 3, 4, 5, 6, 7])
      expect(checkQueryAddress(makeAddress(type, 0)).ok).toBe(true);
  });

  it("rejects missing, mainnet, stake and garbage input with a short reason", () => {
    const cases = [
      undefined,
      "",
      makeAddress(0, 1),
      TEST_STAKE_ADDRESS,
      "addr_test1garbage",
      "x".repeat(500),
    ];
    for (const input of cases) {
      const r = checkQueryAddress(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeLessThan(200);
    }
    const mainnet = checkQueryAddress(makeAddress(0, 1));
    expect(!mainnet.ok && mainnet.reason).toMatch(/mainnet/);
  });
});

describe("checkPayToAddress (SELLER_ADDRESS)", () => {
  it("accepts testnet key-credential addresses, as ZyroPay does", () => {
    for (const a of [makeAddress(0, 0), makeAddress(2, 0), makeAddress(4, 0), TEST_PAY_TO]) {
      expect(checkPayToAddress(a).ok).toBe(true);
      expect(isValidCardanoPaymentAddress("cardano-preprod", a)).toBe(true);
    }
  });

  it("rejects script credentials, mainnet and unset, as ZyroPay does", () => {
    for (const a of [makeAddress(1, 0), makeAddress(3, 0), makeAddress(7, 0), makeAddress(0, 1)]) {
      expect(checkPayToAddress(a).ok).toBe(false);
      expect(isValidCardanoPaymentAddress("cardano-preprod", a)).toBe(false);
    }
    const script = checkPayToAddress(makeAddress(7, 0));
    expect(!script.ok && script.reason).toMatch(/key-hash payment credential/);
    expect(checkPayToAddress(undefined).ok).toBe(false);
  });

  it("accepts the address the wallet script derives (Evolution SDK, base address)", () => {
    const derived = Address.toBech32(
      addressFromSeed(TEST_VECTOR_MNEMONIC, { networkId: 0 }).address,
    );
    expect(derived.startsWith("addr_test1q")).toBe(true);
    expect(checkPayToAddress(derived).ok).toBe(true);
    expect(isValidCardanoPaymentAddress("cardano-preprod", derived)).toBe(true);
  });
});
