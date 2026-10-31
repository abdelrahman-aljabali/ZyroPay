import { describe, expect, it } from "vitest";
import { createPriceProvider, numberToDecimalString } from "../prices";
import { fixtureFetch, HttpReply, noSleep } from "../testing";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const nowSec = NOW.getTime() / 1000;
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const JUPITER = {
  So11111111111111111111111111111111111111112: {
    usdPrice: 147.4789340738336,
    blockId: 348004023,
    decimals: 9,
    priceChange24h: 1.29,
  },
  [SOL_USDC]: { usdPrice: 0.99995, blockId: 348004023, decimals: 6, priceChange24h: 0 },
};

function provider(
  rest: Record<string, unknown>,
  extra: Parameters<typeof createPriceProvider>[0] = {},
) {
  const fetch = fixtureFetch({ rest });
  return {
    fetch,
    p: createPriceProvider({
      fetch,
      sleep: noSleep,
      now: () => NOW,
      jupiterApiKey: "jup_test",
      coingeckoApiKey: "cg_test",
      ...extra,
    }),
  };
}

describe("PriceProvider (Jupiter + CoinGecko)", () => {
  it("prices Solana via Jupiter and EVM via CoinGecko, as decimal strings with timestamps", async () => {
    const { p, fetch } = provider({
      "/price/v3": JUPITER,
      "/simple/price": { ethereum: { usd: 3012.5, last_updated_at: nowSec - 30 } },
      "/simple/token_price/ethereum": {
        [ETH_USDC.toLowerCase()]: { usd: 1.0001, last_updated_at: nowSec - 10 },
      },
      "/simple/token_price/base": {
        [BASE_USDC.toLowerCase()]: { usd: 0.9999, last_updated_at: nowSec - 10 },
      },
    });
    const { prices, simulated } = await p.getPrices({
      assetIds: [
        "solana-mainnet:native",
        `solana-mainnet:${SOL_USDC}`,
        "ethereum-mainnet:native",
        "base-mainnet:native",
        `ethereum-mainnet:${ETH_USDC}`,
        `base-mainnet:${BASE_USDC}`,
      ],
      currency: "USD",
    });
    expect(simulated).toBe(false);
    expect(prices["solana-mainnet:native"]?.price).toEqual({
      value: "147.4789340738336",
      currency: "USD",
    });
    expect(prices["solana-mainnet:native"]?.source).toBe("jupiter-price-v3");
    expect(prices["ethereum-mainnet:native"]?.price.value).toBe("3012.5");
    expect(prices["base-mainnet:native"]?.price.value).toBe("3012.5");
    expect(prices["ethereum-mainnet:native"]?.asOf).toBe(
      new Date((nowSec - 30) * 1000).toISOString(),
    );
    expect(prices[`ethereum-mainnet:${ETH_USDC}`]?.price.value).toBe("1.0001");
    expect(prices[`base-mainnet:${BASE_USDC}`]?.price.value).toBe("0.9999");
    const jup = fetch.calls.find((c) => c.url.includes("/price/v3"));
    expect(jup?.headers["x-api-key"]).toBe("jup_test");
    const cg = fetch.calls.find((c) => c.url.includes("coingecko"));
    expect(cg?.headers["x-cg-demo-api-key"]).toBe("cg_test");
  });

  it("fails closed: stale, missing, errored, non-USD and testnet assets are absent", async () => {
    const { p } = provider({
      "/price/v3": new HttpReply(500, "boom"),
      "/simple/price": { ethereum: { usd: 3000, last_updated_at: nowSec - 3600 } },
      "/simple/token_price/ethereum": {},
    });
    const { prices } = await p.getPrices({
      assetIds: [
        "solana-mainnet:native",
        "ethereum-mainnet:native",
        `ethereum-mainnet:${ETH_USDC}`,
        "solana-devnet:native",
        "base-sepolia:native",
      ],
      currency: "USD",
    });
    expect(prices).toEqual({});
    const eur = await provider({ "/price/v3": JUPITER }).p.getPrices({
      assetIds: ["solana-mainnet:native"],
      currency: "EUR",
    });
    expect(eur.prices).toEqual({});
  });

  it("reuses last good quotes only within maxAge", async () => {
    let fail = false;
    const { p } = provider({ "/price/v3": () => (fail ? new HttpReply(503, "down") : JUPITER) });
    expect(
      (await p.getPrices({ assetIds: ["solana-mainnet:native"], currency: "USD" })).prices[
        "solana-mainnet:native"
      ],
    ).toBeDefined();
    fail = true;
    expect(
      (await p.getPrices({ assetIds: ["solana-mainnet:native"], currency: "USD" })).prices[
        "solana-mainnet:native"
      ],
    ).toBeDefined();
  });

  it("opt-in testnet proxy values devnet SOL / Sepolia USDC at mainnet prices, labelled", async () => {
    const { p } = provider(
      {
        "/price/v3": JUPITER,
        "/simple/token_price/ethereum": {
          [ETH_USDC.toLowerCase()]: { usd: 1, last_updated_at: nowSec },
        },
      },
      { valueTestnetsAtMainnetPrices: true },
    );
    const { prices } = await p.getPrices({
      assetIds: [
        "solana-devnet:native",
        "ethereum-sepolia:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        "ethereum-sepolia:0x0000000000000000000000000000000000000001",
      ],
      currency: "USD",
    });
    expect(prices["solana-devnet:native"]?.source).toBe("jupiter-price-v3+testnet-proxy");
    expect(prices["solana-devnet:native"]?.assetId).toBe("solana-devnet:native");
    expect(prices["ethereum-sepolia:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"]?.price.value).toBe(
      "1",
    );
    expect(prices["ethereum-sepolia:0x0000000000000000000000000000000000000001"]).toBeUndefined();
  });

  it("testnet proxy: Sepolia and Base Sepolia ETH at the ETH price; off by default", async () => {
    const rest = {
      "/price/v3": JUPITER,
      "/simple/price": { ethereum: { usd: 3012.5, last_updated_at: nowSec - 30 } },
    };
    const ids = [
      "ethereum-sepolia:native",
      "base-sepolia:native",
      "solana-devnet:native",
      "base-sepolia:0x0000000000000000000000000000000000000002",
    ] as const;
    const on = await provider(rest, { valueTestnetsAtMainnetPrices: true }).p.getPrices({
      assetIds: ids,
      currency: "USD",
    });
    expect(on.prices["ethereum-sepolia:native"]?.price.value).toBe("3012.5");
    expect(on.prices["base-sepolia:native"]?.price.value).toBe("3012.5");
    expect(on.prices["base-sepolia:native"]?.source).toBe("coingecko+testnet-proxy");
    expect(on.prices["solana-devnet:native"]?.price.value).toBe("147.4789340738336");
    // Unknown testnet token: never guessed (fail closed).
    expect(on.prices["base-sepolia:0x0000000000000000000000000000000000000002"]).toBeUndefined();

    const off = await provider(rest).p.getPrices({ assetIds: ids, currency: "USD" });
    expect(off.prices).toEqual({});
  });

  it("converts provider numbers without exponents", () => {
    expect(numberToDecimalString(1e-7)).toBe("0.0000001");
    expect(numberToDecimalString(147.5)).toBe("147.5");
    expect(numberToDecimalString(-1)).toBeNull();
    expect(numberToDecimalString(Number.NaN)).toBeNull();
    expect(numberToDecimalString("12.30")).toBe("12.30");
  });
});
