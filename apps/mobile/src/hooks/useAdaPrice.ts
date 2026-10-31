import { nativeAsset } from "@zyropay/shared";
import { useMemo } from "react";
import { usePortfolio } from "@/api/hooks";
import type { FiatCurrency } from "@/lib/allowance";

const ADA = nativeAsset("cardano-preprod").id;

/**
 * The live ADA price in `currency` (from the portfolio's price service), or null while unknown
 * or when the API priced it in another currency. Previews only: the API converts fiat limits
 * itself when the allowance is created, and the review shows the exact ADA.
 */
export function useAdaPrice(
  currency: FiatCurrency,
): { readonly value: string; readonly currency: FiatCurrency } | null {
  return useAdaPriceState(currency).price;
}

/** useAdaPrice plus whether the answer is in (a null price after `settled` means none). */
export function useAdaPriceState(currency: FiatCurrency): {
  readonly price: { readonly value: string; readonly currency: FiatCurrency } | null;
  readonly settled: boolean;
} {
  const portfolio = usePortfolio({ network: "cardano-preprod", currency });
  const price = useMemo(() => {
    const p = portfolio.data?.balances.find((b) => b.asset.id === ADA)?.price;
    return p != null && p.currency === currency ? { value: p.value, currency } : null;
  }, [portfolio.data, currency]);
  return { price, settled: !portfolio.isPending };
}
