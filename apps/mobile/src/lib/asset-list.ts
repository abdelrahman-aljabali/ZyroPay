import { isZeroAmount, type Balance, type PriceHistory } from "@zyropay/shared";
import { priceChange, type PriceChange } from "@zyropay/ui/format";

export interface ListOptions {
  /**
   * The list spans several wallets (home): an asset shows its zero-balance row only when no
   * wallet holds any of it, and then once, so a new user sees each network's coin and its
   * price without one empty row per wallet.
   */
  readonly mergeWallets?: boolean;
}

/**
 * The rows of an asset list. Native coins of the wallet's networks stay listed at zero (the
 * providers always report them), so their price is visible before the wallet is funded.
 * Zero-balance tokens are dropped: nothing about an empty token row is worth a line.
 * Funded rows come first, in the API's order; zero-balance coins follow, also in order.
 */
export function listedBalances(balances: readonly Balance[], options: ListOptions = {}): Balance[] {
  const funded = balances.filter((b) => !isZeroAmount(b.amount));
  const held = new Set(funded.map((b) => b.asset.id));
  const empty: Balance[] = [];
  const seen = new Set<string>();
  for (const b of balances) {
    if (!isZeroAmount(b.amount) || b.asset.kind !== "native") continue;
    if (options.mergeWallets === true) {
      if (held.has(b.asset.id) || seen.has(b.asset.id)) continue;
      seen.add(b.asset.id);
    }
    empty.push(b);
  }
  return [...funded, ...empty];
}

/** Asset ids worth a 24h price series: those the API priced. */
export function pricedAssetIds(balances: readonly Balance[]): string[] {
  return [...new Set(balances.filter((b) => b.price !== null).map((b) => b.asset.id))];
}

/** 24h change of the unit price from a 1D series (oldest -> newest), or null. */
export function changeFromHistory(history: PriceHistory | undefined): PriceChange | null {
  if (history?.status !== "available") return null;
  const first = history.points[0];
  const last = history.points[history.points.length - 1];
  if (!first || !last) return null;
  return priceChange(first.price, last.price);
}
