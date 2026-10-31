import { useMemo } from "react";
import { usePortfolio } from "@/api/hooks";

/** assetId -> symbol for assets the user holds (canonical payloads carry ids, not symbols). */
export function useKnownSymbols(): ReadonlyMap<string, string> {
  const portfolio = usePortfolio();
  return useMemo(
    () =>
      new Map((portfolio.data?.balances ?? []).map((b) => [b.asset.id, b.asset.symbol] as const)),
    [portfolio.data],
  );
}
