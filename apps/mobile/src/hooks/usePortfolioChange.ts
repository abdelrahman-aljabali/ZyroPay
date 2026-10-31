import { useQueries } from "@tanstack/react-query";
import type { PortfolioSnapshot, PriceHistory } from "@zyropay/shared";
import type { BalanceChange } from "@zyropay/ui";
import { useMemo } from "react";
import { apiClient } from "@/api";
import { qk } from "@/api/hooks";
import { computeChange, type SeriesEndpoints } from "@/lib/portfolio-change";

function endpointsOf(history: PriceHistory | undefined) {
  if (history?.status !== "available") return null;
  const first = history.points[0];
  const last = history.points[history.points.length - 1];
  return first && last ? { first: first.price, last: last.price } : null;
}

/** BalanceChange for the home header, or null while loading / when it can't be trusted. */
export function usePortfolioChange(portfolio: PortfolioSnapshot | undefined): BalanceChange | null {
  const assetIds = useMemo(
    () => [
      ...new Set(
        (portfolio?.balances ?? []).filter((b) => b.value !== null).map((b) => b.asset.id),
      ),
    ],
    [portfolio],
  );
  const histories = useQueries({
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
      enabled: portfolio !== undefined,
    })),
    combine: (results) =>
      results.some((r) => r.isPending)
        ? null
        : (new Map(
            assetIds.map((id, i) => [id, endpointsOf(results[i]?.data)]),
          ) as SeriesEndpoints),
  });
  return useMemo(
    () => (portfolio && histories ? computeChange(portfolio, histories) : null),
    [portfolio, histories],
  );
}
