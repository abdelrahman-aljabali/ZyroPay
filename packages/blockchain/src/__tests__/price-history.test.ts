import { describe, expect, it } from "vitest";
import { createPriceHistoryProvider } from "../price-history";
import { fixtureFetch, HttpReply, noSleep } from "../testing";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const chart = (n: number, start = 140) => ({
  prices: Array.from({ length: n }, (_, i) => [
    NOW.getTime() - (n - i) * 3_600_000,
    start + i * 0.5,
  ]),
  market_caps: [],
  total_volumes: [],
});

function provider(rest: Record<string, unknown>, extra = {}) {
  const fetch = fixtureFetch({ rest });
  return {
    fetch,
    p: createPriceHistoryProvider({
      fetch,
      sleep: noSleep,
      now: () => NOW,
      coingeckoApiKey: "cg_test",
      maxRetries: 0,
      ...extra,
    }),
  };
}

describe("PriceHistoryProvider (CoinGecko market_chart)", () => {
  it("returns a native series as decimal strings, oldest first, with the key header", async () => {
    const { p, fetch } = provider({ "/coins/solana/market_chart": chart(24) });
    const r = await p.getPriceHistory({
      assetId: "solana-mainnet:native",
      range: "1D",
      currency: "USD",
    });
    expect(r.status).toBe("available");
    if (r.status !== "available") return;
    expect(r.points).toHaveLength(24);
    expect(r.points[0]).toEqual({ t: "2026-10-30T12:00:00.000Z", price: "140" });
    expect(r.points[1]?.price).toBe("140.5");
    expect(r.source).toBe("coingecko");
    expect(r.simulated).toBe(false);
    expect(fetch.calls[0]?.url).toContain("vs_currency=usd&days=1");
    expect(fetch.calls[0]?.headers["x-cg-demo-api-key"]).toBe("cg_test");
  });

  it("uses the contract endpoint per platform for tokens (EVM lowercased, SPL as is)", async () => {
    const { p, fetch } = provider({
      [`/coins/ethereum/contract/${ETH_USDC.toLowerCase()}/market_chart`]: chart(10, 1),
      [`/coins/solana/contract/${SOL_USDC}/market_chart`]: chart(10, 1),
    });
    expect(
      (
        await p.getPriceHistory({
          assetId: `ethereum-mainnet:${ETH_USDC}`,
          range: "1W",
          currency: "USD",
        })
      ).status,
    ).toBe("available");
    expect(
      (
        await p.getPriceHistory({
          assetId: `solana-mainnet:${SOL_USDC}`,
          range: "1Y",
          currency: "USD",
        })
      ).status,
    ).toBe("available");
    expect(fetch.calls.map((c) => /days=(\d+)/.exec(c.url)?.[1])).toEqual(["7", "365"]);
  });

  it("downsamples long series and caches per asset and range", async () => {
    const { p, fetch } = provider(
      { "/coins/ethereum/market_chart": chart(1000) },
      { maxPoints: 50 },
    );
    const a = await p.getPriceHistory({
      assetId: "base-mainnet:native",
      range: "1M",
      currency: "USD",
    });
    const b = await p.getPriceHistory({
      assetId: "base-mainnet:native",
      range: "1M",
      currency: "USD",
    });
    expect(a.status === "available" && a.points.length).toBe(50);
    expect(b).toEqual(a);
    expect(fetch.calls).toHaveLength(1);
  });

  it("fails closed: testnets, non-USD, provider errors and empty series are unavailable", async () => {
    const { p } = provider({
      "/coins/solana/market_chart": new HttpReply(503, { error: "down" }),
      "/coins/ethereum/market_chart": chart(1),
    });
    expect(
      await p.getPriceHistory({ assetId: "solana-devnet:native", range: "1D", currency: "USD" }),
    ).toEqual({
      status: "unavailable",
      reason: "TESTNET_ASSET",
    });
    expect(
      await p.getPriceHistory({ assetId: "solana-mainnet:native", range: "1D", currency: "EUR" }),
    ).toEqual({
      status: "unavailable",
      reason: "CURRENCY_UNSUPPORTED",
    });
    expect(
      await p.getPriceHistory({ assetId: "solana-mainnet:native", range: "1D", currency: "USD" }),
    ).toEqual({
      status: "unavailable",
      reason: "PROVIDER_UNAVAILABLE",
    });
    expect(
      await p.getPriceHistory({ assetId: "ethereum-mainnet:native", range: "1D", currency: "USD" }),
    ).toEqual({
      status: "unavailable",
      reason: "UNSUPPORTED_ASSET",
    });
  });

  it("prices testnet natives at mainnet history only with the labelled dev proxy", async () => {
    const { p } = provider(
      { "/coins/solana/market_chart": chart(5) },
      { valueTestnetsAtMainnetPrices: true },
    );
    const r = await p.getPriceHistory({
      assetId: "solana-devnet:native",
      range: "1D",
      currency: "USD",
    });
    expect(r.status === "available" && r.source).toBe("coingecko+testnet-proxy");
  });
});
