import { describe, expect, it } from "vitest";
import {
  addressesEqual,
  base58Decode,
  isChecksummedEvmAddress,
  isValidAddressForNetwork,
  isValidEvmAddress,
  isValidSolanaAddress,
  normalizeAddress,
  toChecksumAddress,
} from "./addresses";

// Test vectors from EIP-55.
const EIP55_VECTORS = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("EVM addresses (EIP-55)", () => {
  it.each(EIP55_VECTORS)("checksums %s", (addr) => {
    expect(toChecksumAddress(addr.toLowerCase())).toBe(addr);
    expect(isValidEvmAddress(addr)).toBe(true);
    expect(isChecksummedEvmAddress(addr)).toBe(true);
  });
  it("accepts single-case addresses (no checksum present)", () => {
    expect(isValidEvmAddress(EIP55_VECTORS[0]!.toLowerCase())).toBe(true);
    expect(isValidEvmAddress("0x" + EIP55_VECTORS[0]!.slice(2).toUpperCase())).toBe(true);
    expect(isChecksummedEvmAddress(EIP55_VECTORS[0]!.toLowerCase())).toBe(false);
  });
  it("rejects a mixed-case address with a wrong checksum", () => {
    const bad = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"; // last char case flipped
    expect(isValidEvmAddress(bad)).toBe(false);
  });
  it.each([
    "",
    "0x",
    "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe",
    "0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  ])("rejects malformed %j", (addr) => expect(isValidEvmAddress(addr)).toBe(false));
  it("compares case-insensitively", () => {
    expect(addressesEqual("evm", EIP55_VECTORS[0]!, EIP55_VECTORS[0]!.toLowerCase())).toBe(true);
  });
  it("normalizes to checksum form", () => {
    expect(normalizeAddress("evm", EIP55_VECTORS[1]!.toLowerCase())).toBe(EIP55_VECTORS[1]);
    expect(() => normalizeAddress("evm", "0x123")).toThrow();
  });
});

describe("Solana addresses", () => {
  it.each([
    "11111111111111111111111111111111", // system program: 32 zero bytes
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
    "So11111111111111111111111111111111111111112", // wrapped SOL
  ])("accepts %s", (addr) => expect(isValidSolanaAddress(addr)).toBe(true));

  it.each([
    "",
    "1111111111111111111111111111111", // 31 bytes
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O", // 'O' not in alphabet
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vEPjFWdd5", // too long
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "3yZe7d", // too short
  ])("rejects %j", (addr) => expect(isValidSolanaAddress(addr)).toBe(false));

  it("decodes base58 with leading zeros", () => {
    expect(Array.from(base58Decode("1112")!)).toEqual([0, 0, 0, 1]);
    expect(base58Decode("0")).toBeNull();
  });
  it("is case-sensitive", () => {
    const a = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(addressesEqual("solana", a, a.toLowerCase())).toBe(false);
  });
});

describe("network-aware validation", () => {
  it("does not mix families", () => {
    expect(isValidAddressForNetwork("solana-mainnet", EIP55_VECTORS[0]!)).toBe(false);
    expect(
      isValidAddressForNetwork("base-mainnet", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    ).toBe(false);
    expect(isValidAddressForNetwork("base-sepolia", EIP55_VECTORS[0]!)).toBe(true);
  });
});
