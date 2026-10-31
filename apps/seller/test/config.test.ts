import { describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { DEFAULT_FACILITATOR_URL, loadConfig } from "../src/config";
import { makeAddress, TEST_PAY_TO, TEST_PROJECT_ID } from "./helpers";

const valid: Env = { SELLER_ADDRESS: TEST_PAY_TO, BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID };

function problems(env: Env): string[] {
  const r = loadConfig(env);
  return r.ok ? [] : [...r.problems];
}

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const r = loadConfig(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual({
      payTo: TEST_PAY_TO,
      blockfrostProjectId: TEST_PROJECT_ID,
      facilitatorMode: "embedded",
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      blockfrostBaseUrl: "https://cardano-preprod.blockfrost.io/api/v0",
      priceLovelace: "2000000",
      l1Confirmations: 0,
    });
  });

  it("enforces preprod + key-hash payTo", () => {
    expect(problems({ ...valid, SELLER_ADDRESS: makeAddress(0, 1) })).toEqual([
      "SELLER_ADDRESS must be a preprod address (addr_test1...)",
    ]);
    expect(problems({ ...valid, SELLER_ADDRESS: makeAddress(1, 0) })).toEqual([
      "SELLER_ADDRESS must have a key-hash payment credential",
    ]);
    expect(problems({ ...valid, SELLER_ADDRESS: undefined })).toEqual([
      "SELLER_ADDRESS is not set",
    ]);
  });

  it("requires a preprod Blockfrost project id", () => {
    expect(problems({ ...valid, BLOCKFROST_PROJECT_ID: "" })).toEqual([
      "BLOCKFROST_PROJECT_ID is not set",
    ]);
    expect(
      problems({ ...valid, BLOCKFROST_PROJECT_ID: "mainnetABCDEFGHIJKLMNOPQRSTUVWXYZ12" })[0],
    ).toMatch(/preprod project id/);
  });

  it("enforces the min-UTxO price floor and an integer price", () => {
    expect(problems({ ...valid, PRICE_LOVELACE: "999999" })[0]).toMatch(/>= 1000000/);
    expect(problems({ ...valid, PRICE_LOVELACE: "1.5" })[0]).toMatch(/integer/);
    expect(problems({ ...valid, PRICE_LOVELACE: "100000001" })[0]).toMatch(/<= 100000000/);
    expect(loadConfig({ ...valid, PRICE_LOVELACE: "1000000" }).ok).toBe(true);
  });

  it("validates URLs and confirmations", () => {
    expect(problems({ ...valid, FACILITATOR_URL: "http://example.com" })[0]).toMatch(
      /FACILITATOR_URL/,
    );
    expect(problems({ ...valid, FACILITATOR_URL: "https://u:p@example.com" })[0]).toMatch(
      /credentials/,
    );
    expect(loadConfig({ ...valid, FACILITATOR_URL: "http://localhost:4022/" }).ok).toBe(true);
    expect(problems({ ...valid, FACILITATOR_MODE: "remote" })[0]).toMatch(/FACILITATOR_MODE/);
    expect(problems({ ...valid, BLOCKFROST_BASE_URL: "ftp://x" })[0]).toMatch(
      /BLOCKFROST_BASE_URL/,
    );
    expect(problems({ ...valid, L1_CONFIRMATIONS: "21" })[0]).toMatch(/L1_CONFIRMATIONS/);
    const r = loadConfig({ ...valid, L1_CONFIRMATIONS: "2" });
    expect(r.ok && r.config.l1Confirmations).toBe(2);
  });

  it("never echoes a value in a problem message", () => {
    const secret = "preprod-not-valid-secret-value";
    const out = problems({ SELLER_ADDRESS: "addr_test1secretish", BLOCKFROST_PROJECT_ID: secret });
    expect(out.length).toBe(2);
    for (const p of out) {
      expect(p).not.toContain(secret);
      expect(p).not.toContain("secretish");
    }
  });
});
