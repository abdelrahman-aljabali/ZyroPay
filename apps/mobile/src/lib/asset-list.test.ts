import type { Balance, PriceHistory } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ADDR, ASSETS, balanceFor, makeBalances, WALLET_MAIN } from "@/api/mock/fixtures";
import { changeFromHistory, listedBalances, pricedAssetIds } from "./asset-list";

const OTHER = "5b1d7a3e-0c4f-4a51-9d3e-2f6b8c9a1e70";
const ids = (list: readonly Balance[]) =>
  list.map((b) => `${b.walletId === OTHER ? "other" : "main"}:${b.asset.id}:${b.amount}`);

describe("listedBalances", () => {
  it("keeps a zero-balance native coin, with its price, after the funded rows", () => {
    const zeroBase = balanceFor(WALLET_MAIN, ADDR.evmMain, ASSETS.ethBase, "0");
    const sol = balanceFor(WALLET_MAIN, ADDR.solMain, ASSETS.sol, "12500000000");
    const rows = listedBalances([zeroBase, sol]);
    expect(ids(rows)).toEqual([`main:${ASSETS.sol.id}:12500000000`, `main:${ASSETS.ethBase.id}:0`]);
    expect(rows[1]?.price).not.toBeNull();
    expect(rows[1]?.value?.value).toBe("0.00");
  });

  it("drops zero-balance tokens", () => {
    const zeroUsdc = balanceFor(WALLET_MAIN, ADDR.evmMain, ASSETS.usdcBase, "0");
    expect(listedBalances([zeroUsdc])).toEqual([]);
  });

  it("lists every wallet's zero coins on one wallet's screen", () => {
    const rows = listedBalances([
      balanceFor(WALLET_MAIN, ADDR.solMain, ASSETS.sol, "0"),
      balanceFor(WALLET_MAIN, ADDR.evmMain, ASSETS.ethSepolia, "0"),
      balanceFor(WALLET_MAIN, ADDR.evmMain, ASSETS.ethBase, "0"),
    ]);
    expect(rows.map((b) => b.asset.id)).toEqual([
      ASSETS.sol.id,
      ASSETS.ethSepolia.id,
      ASSETS.ethBase.id,
    ]);
  });

  it("merged across wallets: a zero row shows only when no wallet holds the coin, once", () => {
    const balances = [
      balanceFor(WALLET_MAIN, ADDR.solMain, ASSETS.sol, "0"),
      balanceFor(OTHER, ADDR.solSavings, ASSETS.sol, "1000"),
      balanceFor(WALLET_MAIN, ADDR.evmMain, ASSETS.ethBase, "0"),
      balanceFor(OTHER, ADDR.evmSavings, ASSETS.ethBase, "0"),
    ];
    expect(ids(listedBalances(balances, { mergeWallets: true }))).toEqual([
      `other:${ASSETS.sol.id}:1000`,
      `main:${ASSETS.ethBase.id}:0`,
    ]);
    // Per wallet nothing is merged away.
    expect(listedBalances(balances)).toHaveLength(4);
  });

  it("leaves the mock portfolio's funded rows in the API's order", () => {
    const all = makeBalances();
    const rows = listedBalances(all, { mergeWallets: true });
    const funded = all.filter((b) => b.amount !== "0");
    expect(rows).toEqual(funded);
  });
});

describe("pricedAssetIds", () => {
  it("asks for a series only for priced assets, once each", () => {
    const list = makeBalances();
    const priced = pricedAssetIds(list);
    expect(priced).toContain(ASSETS.sol.id);
    expect(priced).not.toContain(ASSETS.dust.id);
    expect(new Set(priced).size).toBe(priced.length);
  });
});

describe("changeFromHistory", () => {
  const base = { assetId: ASSETS.sol.id, currency: "USD", range: "1D", simulated: false } as const;
  it("compares the oldest and newest point", () => {
    const history: PriceHistory = {
      ...base,
      status: "available",
      source: "coingecko",
      points: [
        { t: "2026-10-30T12:00:00.000Z", price: "2450.10" },
        { t: "2026-10-31T00:00:00.000Z", price: "2500" },
        { t: "2026-10-31T12:00:00.000Z", price: "2432.05" },
      ],
    };
    expect(changeFromHistory(history)).toEqual({
      percent: "−0.74%",
      direction: "down",
      spoken: "down 0.74%",
    });
  });

  it("is null without a trustworthy series", () => {
    expect(changeFromHistory(undefined)).toBeNull();
    expect(
      changeFromHistory({ ...base, status: "unavailable", reason: "PROVIDER_UNAVAILABLE" }),
    ).toBeNull();
  });
});
