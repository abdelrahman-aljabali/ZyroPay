import { describe, expect, it } from "vitest";
import { parseShelleyAddress } from "../src/address";
import type { AddressData } from "../src/blockfrost";
import { computeReport, formatAda } from "../src/report";
import { ACTIVE_DATA, FIXTURE_NOW, fx, UNUSED_DATA } from "./fixtures";
import { makeAddress, TEST_BASE_ADDRESS } from "./helpers";

const addr = parseShelleyAddress(TEST_BASE_ADDRESS)!;
const codes = (data: AddressData, a = addr) =>
  computeReport(a, data, FIXTURE_NOW).riskFlags.map((f) => f.code);

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

describe("computeReport (from Blockfrost fixtures)", () => {
  it("summarises an active address", () => {
    const r = computeReport(addr, ACTIVE_DATA, FIXTURE_NOW);
    expect(r).toMatchObject({
      address: TEST_BASE_ADDRESS,
      network: "cardano:preprod",
      addressKind: "base",
      paymentCredential: "key",
      isScript: false,
      seenOnChain: true,
      balanceLovelace: "1520000000",
      balanceAda: "1520",
      tokenCount: 3,
      utxoCount: 2,
      utxoCountIsLowerBound: false,
      txCount: 42,
      receivedLovelace: "5000000000",
      sentLovelace: "3480000000",
      firstSeen: "2026-03-01T08:30:00.000Z",
      lastSeen: "2026-10-29T12:00:00.000Z",
      recentActivity: { last24h: 1, last7d: 3, last30d: 10 },
      stake: {
        stakeAddress: fx.address.stake_address,
        registered: true,
        delegatedToPool: fx.account.pool_id,
        delegatedToDrep: null,
      },
      riskFlags: [],
      riskScore: 0,
      generatedAt: FIXTURE_NOW.toISOString(),
      dataSource: "blockfrost-preprod",
    });
    expect(r.recentTxs).toHaveLength(5);
    expect(r.recentTxs[0]).toEqual({
      txHash: fx.txsDesc[0]!.tx_hash,
      time: "2026-10-29T12:00:00.000Z",
    });
  });

  it("treats a never-used address (Blockfrost 404) as a valid, flagged result", () => {
    const r = computeReport(addr, UNUSED_DATA, FIXTURE_NOW);
    expect(r).toMatchObject({
      seenOnChain: false,
      balanceLovelace: "0",
      txCount: 0,
      firstSeen: null,
      lastSeen: null,
      stake: null,
      riskScore: 30,
    });
    expect(r.riskFlags).toEqual([
      { code: "NO_HISTORY", severity: "high", weight: 30, message: expect.any(String) },
    ]);
  });

  it("raises NEW_ADDRESS and LOW_ACTIVITY for a fresh address", () => {
    const t = FIXTURE_NOW.getTime() / 1000 - 2 * 86_400;
    const tx = { ...fx.txsDesc[0]!, block_time: t };
    const data: AddressData = {
      ...ACTIVE_DATA,
      total: { ...fx.total, tx_count: 1 },
      recentTxs: [tx],
      firstTx: tx,
    };
    expect(codes(data)).toEqual(["NEW_ADDRESS", "LOW_ACTIVITY"]);
    expect(computeReport(addr, data, FIXTURE_NOW).riskScore).toBe(30);
  });

  it("raises DORMANT when the last transaction is over 90 days old", () => {
    const old = fx.txsDesc.map((t) => ({ ...t, block_time: t.block_time - 200 * 86_400 }));
    expect(codes({ ...ACTIVE_DATA, recentTxs: old })).toEqual(["DORMANT"]);
  });

  it("raises SCRIPT_ADDRESS from Blockfrost's script flag or the credential", () => {
    expect(codes({ ...ACTIVE_DATA, address: { ...fx.address, script: true } })).toEqual([
      "SCRIPT_ADDRESS",
    ]);
    expect(codes(UNUSED_DATA, parseShelleyAddress(makeAddress(7, 0))!)).toEqual([
      "NO_HISTORY",
      "SCRIPT_ADDRESS",
    ]);
  });

  it("raises MANY_TOKENS, DRAINED and BURST_ACTIVITY", () => {
    const tokens = Array.from({ length: 60 }, (_, i) => ({
      unit: `${"cc".repeat(28)}${i.toString(16).padStart(2, "0")}`,
      quantity: "1",
    }));
    const spam = {
      ...ACTIVE_DATA,
      address: { ...fx.address, amount: [...fx.address.amount, ...tokens] },
    };
    expect(codes(spam)).toEqual(["MANY_TOKENS"]);

    const drained = {
      ...ACTIVE_DATA,
      address: { ...fx.address, amount: [{ unit: "lovelace", quantity: "400000" }] },
    };
    expect(codes(drained)).toEqual(["DRAINED"]);

    const base = FIXTURE_NOW.getTime() / 1000;
    const burst = fx.txsDesc.map((t, i) => ({ ...t, block_time: base - 600 * (i + 1) }));
    expect(codes({ ...ACTIVE_DATA, recentTxs: burst })).toEqual(["BURST_ACTIVITY"]);
  });

  it("sums the weights of every raised flag (and never exceeds 100)", () => {
    const tokens = Array.from({ length: 60 }, (_, i) => ({
      unit: `${"dd".repeat(28)}${i}`,
      quantity: "1",
    }));
    const t = FIXTURE_NOW.getTime() / 1000 - 3600;
    const recent = fx.txsDesc.map((x, i) => ({ ...x, block_time: t - i }));
    const r = computeReport(
      addr,
      {
        ...ACTIVE_DATA,
        address: {
          ...fx.address,
          script: true,
          amount: [{ unit: "lovelace", quantity: "1" }, ...tokens],
        },
        total: { ...fx.total, tx_count: 4 },
        recentTxs: recent,
        firstTx: recent[recent.length - 1]!,
      },
      FIXTURE_NOW,
    );
    expect(r.riskFlags.map((f) => f.code)).toEqual([
      "NEW_ADDRESS",
      "LOW_ACTIVITY",
      "SCRIPT_ADDRESS",
      "MANY_TOKENS",
      "DRAINED",
      "BURST_ACTIVITY",
    ]);
    expect(r.riskScore).toBe(85);
    expect(r.riskScore).toBeLessThanOrEqual(100);
  });

  it("stays compact: every string < 200 chars and the JSON < 4 KB", () => {
    const tokens = Array.from({ length: 60 }, (_, i) => ({
      unit: `${"ee".repeat(28)}${i}`,
      quantity: "1",
    }));
    const r = computeReport(
      addr,
      { ...ACTIVE_DATA, address: { ...fx.address, script: true, amount: tokens } },
      FIXTURE_NOW,
    );
    for (const s of allStrings(r)) expect(s.length).toBeLessThan(200);
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThan(4096);
  });

  it("is deterministic for the same data and clock (safe to run twice per payment)", () => {
    expect(computeReport(addr, ACTIVE_DATA, FIXTURE_NOW)).toEqual(
      computeReport(addr, ACTIVE_DATA, FIXTURE_NOW),
    );
  });
});

describe("formatAda", () => {
  it("formats lovelace with integer math", () => {
    expect(formatAda(0n)).toBe("0");
    expect(formatAda(1n)).toBe("0.000001");
    expect(formatAda(2_000_000n)).toBe("2");
    expect(formatAda(1_234_567n)).toBe("1.234567");
    expect(formatAda(12_345_678_900_000_001n)).toBe("12345678900.000001");
  });
});
