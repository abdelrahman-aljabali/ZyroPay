import { nativeAsset, type PriceHistoryResult, type Transaction } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../../src/deps";
import { silentLogger } from "../../src/lib/logger";
import { priceNear, valueTransactionsAtTime } from "../../src/services/tx-valuation";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const series = (source: string, points: Array<[number, string]>): PriceHistoryResult => ({
  status: "available",
  points: points.map(([msAgo, price]) => ({ t: at(msAgo), price })),
  source,
  simulated: false,
});

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: "0199e7a0-0000-7000-8000-0000000000aa",
    walletId: "0199e7a0-0000-7000-8000-000000000001",
    network: "solana-devnet",
    txHash: "sig",
    direction: "in",
    status: "confirmed",
    from: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    asset: nativeAsset("solana-devnet"),
    amount: "2000000000",
    fee: null,
    valueAtTime: null,
    timestamp: at(60_000),
    blockNumber: null,
    transactionRequestId: null,
    explorerUrl: null,
    simulated: false,
    ...overrides,
  };
}

function ctx(history: (assetId: string) => PriceHistoryResult, useMocks = false): Ctx {
  return {
    deps: {
      config: { useMocks },
      clock: { now: () => NOW },
      logger: silentLogger,
      priceHistory: {
        getPriceHistory: ({ assetId }: { assetId: string }) => Promise.resolve(history(assetId)),
      },
    },
  } as unknown as Ctx;
}

describe("transaction value at the time", () => {
  it("picks the nearest point within the tolerance only", () => {
    const s = series("coingecko", [
      [3_600_000, "100"],
      [120_000, "150"],
    ]);
    expect(priceNear(s, NOW.getTime() - 60_000, 30 * 60_000)).toBe("150");
    expect(priceNear(s, NOW.getTime() - 20 * 3_600_000, 30 * 60_000)).toBeNull();
  });

  it("values testnet transfers at the mainnet series, labelled; fails closed otherwise", async () => {
    const c = ctx((assetId) =>
      assetId === "solana-devnet:native"
        ? series("coingecko+testnet-proxy", [
            [300_000, "149"],
            [60_000, "150"],
          ])
        : { status: "unavailable", reason: "TESTNET_ASSET" },
    );
    const [sol, unknown, failed] = await valueTransactionsAtTime(c, [
      tx({}),
      tx({
        asset: {
          ...nativeAsset("solana-devnet"),
          id: "solana-devnet:So11111111111111111111111111111111111111112",
          kind: "spl",
          address: "So11111111111111111111111111111111111111112",
          verified: false,
        },
      }),
      tx({ status: "failed" }),
    ]);
    expect(sol?.valueAtTime).toEqual({ value: "300.00", currency: "USD" });
    expect(sol?.priceBasis).toBe("mainnet_proxy");
    expect(unknown?.valueAtTime).toBeNull();
    expect(failed?.valueAtTime).toBeNull();
  });

  it("leaves mock mode untouched", async () => {
    const [t1] = await valueTransactionsAtTime(
      ctx(() => series("simulated", [[60_000, "1"]]), true),
      [tx({})],
    );
    expect(t1?.valueAtTime).toBeNull();
  });
});
