import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CanonicalTransactionPayload } from "./payload";
import {
  canonicalize,
  CanonicalizationError,
  createCanonicalPayload,
  payloadHash,
} from "./payload";
import { sha256Hex } from "./hash";

const base: CanonicalTransactionPayload = {
  version: 1,
  network: "base-sepolia",
  from: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  to: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  asset: { id: "base-sepolia:native", kind: "native", decimals: 18 },
  amount: "1000000000000000",
  feeCap: "50000000000000",
  plugin: null,
  tool: "send",
  pluginData: null,
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: "2026-10-30T12:00:00.000Z",
  idempotencyKey: "agent-req-00000001",
};

describe("canonicalize", () => {
  it("sorts keys recursively and is whitespace-free", () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("is independent of insertion order", () => {
    expect(canonicalize({ x: 1, y: "2" })).toBe(canonicalize({ y: "2", x: 1 }));
  });
  it("escapes strings like JSON", () => {
    expect(canonicalize({ s: 'a"b\né' })).toBe('{"s":"a\\"b\\né"}');
  });
  it.each([
    [{ a: undefined }],
    [{ a: 1n }],
    [{ a: Number.NaN }],
    [{ a: Infinity }],
    [{ a: new Date(0) }],
    [{ a: () => 1 }],
    [{ a: Symbol("x") }],
  ])("rejects non-JSON values %#", (value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });
});

describe("sha256Hex", () => {
  it("matches node:crypto", () => {
    for (const s of ["", "abc", "ZyroPay é\u{1F600}", canonicalize(base)]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});

describe("payloadHash", () => {
  it("is sha256 of the canonical JSON", () => {
    const expected = createHash("sha256").update(canonicalize(base), "utf8").digest("hex");
    expect(payloadHash(base)).toBe(expected);
    expect(payloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable regardless of key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as CanonicalTransactionPayload;
    expect(payloadHash(reordered)).toBe(payloadHash(base));
  });

  const mutations: Array<[string, Partial<CanonicalTransactionPayload>]> = [
    [
      "network",
      {
        network: "base-mainnet",
        asset: { id: "base-mainnet:native", kind: "native", decimals: 18 },
      },
    ],
    ["from", { from: "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB" }],
    ["to", { to: "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb" }],
    [
      "asset",
      {
        asset: {
          id: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          kind: "erc20",
          decimals: 6,
        },
      },
    ],
    ["amount", { amount: "1000000000000001" }],
    ["feeCap", { feeCap: "50000000000001" }],
    ["plugin", { plugin: "x402" }],
    ["tool", { tool: "pay_x402" }],
    ["pluginData", { pluginData: { minOut: "1" } }],
    ["nonce", { nonce: "f123456789abcdef0123456789abcdef" }],
    ["expiresAt", { expiresAt: "2026-10-30T12:00:01.000Z" }],
    ["idempotencyKey", { idempotencyKey: "agent-req-00000002" }],
  ];

  it("covers every payload field with a mutation", () => {
    const mutated = new Set(mutations.flatMap(([, m]) => Object.keys(m)));
    for (const key of Object.keys(base)) {
      if (key !== "version") expect(mutated, key).toContain(key);
    }
  });

  it.each(mutations)("changes when %s changes", (_, mutation) => {
    expect(payloadHash({ ...base, ...mutation })).not.toBe(payloadHash(base));
  });

  it("rejects non-checksummed EVM addresses (one payload, one hash)", () => {
    expect(() => payloadHash({ ...base, to: base.to.toLowerCase() })).toThrow();
  });

  it("createCanonicalPayload normalizes EVM case so equivalent inputs hash identically", () => {
    const lower = createCanonicalPayload({
      ...base,
      to: base.to.toLowerCase(),
      from: base.from.toLowerCase(),
    });
    expect(payloadHash(lower)).toBe(payloadHash(base));
  });

  it("rejects invalid payloads", () => {
    expect(() => payloadHash({ ...base, amount: "1.5" })).toThrow();
    expect(() =>
      payloadHash({ ...base, to: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }),
    ).toThrow();
    expect(() =>
      payloadHash({ ...base, asset: { id: "solana-devnet:native", kind: "native", decimals: 9 } }),
    ).toThrow();
    expect(() => payloadHash({ ...base, asset: { ...base.asset, decimals: 9 } })).toThrow();
    expect(() => payloadHash({ ...base, extra: 1 } as CanonicalTransactionPayload)).toThrow();
  });

  it("works for Solana payloads", () => {
    const sol: CanonicalTransactionPayload = {
      ...base,
      network: "solana-devnet",
      from: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      to: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      asset: { id: "solana-devnet:native", kind: "native", decimals: 9 },
      amount: "1000",
      feeCap: "5000",
    };
    expect(payloadHash(sol)).toMatch(/^[0-9a-f]{64}$/);
  });
});
