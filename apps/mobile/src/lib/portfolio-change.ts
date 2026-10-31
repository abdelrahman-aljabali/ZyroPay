import { minorUnitsToDecimal, valueInUsdMinor, type PortfolioSnapshot } from "@zyropay/shared";
import { formatPercent } from "@zyropay/ui/format";

export interface PortfolioChange {
  /** Signed fiat decimal string, e.g. "-12.40". */
  readonly value: string;
  readonly percent: string | null;
  readonly label: string;
}

export type SeriesEndpoints = ReadonlyMap<
  string,
  { readonly first: string; readonly last: string } | null
>;

/**
 * 24h change of the priced holdings from each asset's 1D price history:
 * Σ amount × (price now − price 24h ago), in exact cents (bigint, never floats).
 *
 * Fails closed: if any priced asset has no trustworthy series (testnet assets
 * on the real API, provider down, non-USD), no change is shown at all rather
 * than a partial number that looks complete.
 */
export function computeChange(
  portfolio: Pick<PortfolioSnapshot, "balances" | "currency">,
  histories: SeriesEndpoints,
): PortfolioChange | null {
  if (portfolio.currency !== "USD") return null;
  const priced = portfolio.balances.filter((b) => b.value !== null);
  if (priced.length === 0) return null;
  let now = 0n;
  let before = 0n;
  for (const b of priced) {
    const h = histories.get(b.asset.id);
    if (!h) return null;
    const amount = { amount: b.amount, decimals: b.asset.decimals };
    now += BigInt(valueInUsdMinor(amount, h.last));
    before += BigInt(valueInUsdMinor(amount, h.first));
  }
  const delta = now - before;
  const magnitude = minorUnitsToDecimal(delta < 0n ? -delta : delta);
  return {
    value: delta < 0n ? `-${magnitude}` : magnitude,
    percent: formatPercent(delta, before),
    label: "Today",
  };
}
