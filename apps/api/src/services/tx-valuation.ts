import type { AssetId, PriceHistoryResult, PriceRange, Transaction } from "@zyropay/shared";
import { minorUnitsToDecimal, priceBasisOfSource, valueInUsdMinor } from "@zyropay/shared";
import type { Ctx } from "../deps";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Smallest CoinGecko `market_chart` range that covers a transaction's age, and how far the
 * nearest point may be from the transaction time (the series is downsampled to <= 200 points:
 * ~7 min for 1D, hourly for 1W, ~3.6 h for 1M, ~1.8 days for 1Y).
 */
const WINDOWS: ReadonlyArray<{ range: PriceRange; maxAgeMs: number; toleranceMs: number }> = [
  { range: "1D", maxAgeMs: DAY, toleranceMs: 30 * MINUTE },
  { range: "1W", maxAgeMs: 7 * DAY, toleranceMs: 3 * HOUR },
  { range: "1M", maxAgeMs: 30 * DAY, toleranceMs: 8 * HOUR },
  { range: "1Y", maxAgeMs: 365 * DAY, toleranceMs: 3 * DAY },
];

/** Price of one whole unit nearest to `at` in an available series, or null if none is close. */
export function priceNear(
  history: PriceHistoryResult,
  at: number,
  toleranceMs: number,
): string | null {
  if (history.status !== "available" || history.simulated) return null;
  let best: { d: number; price: string } | null = null;
  for (const p of history.points) {
    const d = Math.abs(Date.parse(p.t) - at);
    if (Number.isFinite(d) && (best === null || d < best.d)) best = { d, price: p.price };
  }
  return best !== null && best.d <= toleranceMs ? best.price : null;
}

/**
 * Fill `valueAtTime` (USD) from the price history near each transaction's timestamp. Real
 * adapters only; testnet assets are valued only through the development mainnet-price proxy
 * (`priceBasis: "mainnet_proxy"`). Fails closed: no series, a series too coarse for the
 * timestamp, a failed transfer or a non-USD currency leave `valueAtTime: null`.
 */
export async function valueTransactionsAtTime(
  ctx: Ctx,
  transactions: readonly Transaction[],
): Promise<Transaction[]> {
  if (ctx.deps.config.useMocks) return [...transactions];
  const now = ctx.deps.clock.now().getTime();
  const plan = transactions.map((tx) => {
    if (tx.valueAtTime !== null || tx.status === "failed") return null;
    const at = Date.parse(tx.timestamp);
    const window = WINDOWS.find((w) => now - at <= w.maxAgeMs);
    return window === undefined || !Number.isFinite(at) ? null : { at, window };
  });
  const keys = new Map<string, { assetId: AssetId; range: PriceRange }>();
  plan.forEach((p, i) => {
    const tx = transactions[i];
    if (p === null || tx === undefined) return;
    keys.set(`${tx.asset.id}|${p.window.range}`, { assetId: tx.asset.id, range: p.window.range });
  });
  const series = new Map<string, PriceHistoryResult>();
  await Promise.all(
    [...keys].map(async ([key, input]) => {
      try {
        series.set(key, await ctx.deps.priceHistory.getPriceHistory({ ...input, currency: "USD" }));
      } catch (error) {
        ctx.deps.logger.warn("tx_valuation.failed", { assetId: input.assetId, error });
      }
    }),
  );
  return transactions.map((tx, i) => {
    const p = plan[i];
    if (p === null || p === undefined) return tx;
    const history = series.get(`${tx.asset.id}|${p.window.range}`);
    if (history === undefined || history.status !== "available") return tx;
    const price = priceNear(history, p.at, p.window.toleranceMs);
    if (price === null) return tx;
    const minor = valueInUsdMinor({ amount: tx.amount, decimals: tx.asset.decimals }, price);
    return {
      ...tx,
      valueAtTime: { value: minorUnitsToDecimal(minor), currency: "USD" },
      priceBasis: priceBasisOfSource(history.source),
    };
  });
}
