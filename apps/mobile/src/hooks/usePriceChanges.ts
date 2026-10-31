import { useQueries } from "@tanstack/react-query";
import type { PriceChange } from "@zyropay/ui";
import { apiClient } from "@/api";
import { qk } from "@/api/hooks";
import { changeFromHistory } from "@/lib/asset-list";

const EMPTY: ReadonlyMap<string, PriceChange | null> = new Map();

/**
 * 24h change of each asset's unit price, from the same 1D price series the home total uses
 * (shared query keys, so nothing is fetched twice). An asset is absent while its series
 * loads and null when no trustworthy series exists: rows then show the price alone.
 * Series are USD only, so other display currencies show no change rather than a mixed one.
 */
export function usePriceChanges(
  assetIds: readonly string[],
  currency = "USD",
): ReadonlyMap<string, PriceChange | null> {
  return useQueries({
    queries: assetIds.map((assetId) => ({
      queryKey: qk.priceHistory(assetId, "1D"),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiClient
          .call("getPriceHistory", {
            params: { assetId },
            query: { range: "1D", currency: "USD" },
            signal,
          })
          .then((r) => r.history),
      retry: false,
      staleTime: 5 * 60_000,
      enabled: currency === "USD",
    })),
    combine: (results) => {
      if (results.length === 0) return EMPTY;
      const out = new Map<string, PriceChange | null>();
      results.forEach((r, i) => {
        const id = assetIds[i];
        if (id !== undefined && r.data !== undefined) out.set(id, changeFromHistory(r.data));
      });
      return out;
    },
  });
}
