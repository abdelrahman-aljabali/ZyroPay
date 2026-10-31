import type {
  AssetId,
  NetworkId,
  PriceHistoryProvider,
  PriceHistoryResult,
  PriceRange,
} from "@zyropay/shared";
import { nativeAssetId, parseAssetId, TESTNET_PROXY_SOURCE_SUFFIX } from "@zyropay/shared";
import { KNOWN_TOKENS } from "./assets";
import type { HttpOptions } from "./http";
import { isRecord, requestJson, resolveHttpOptions } from "./http";
import { numberToDecimalString } from "./prices";

export interface PriceHistoryProviderConfig extends HttpOptions {
  readonly coingeckoApiKey?: string;
  readonly coingeckoPlan?: "demo" | "pro";
  readonly coingeckoBaseUrl?: string;
  /** Same switch as the PriceProvider: development only, labelled `+testnet-proxy`. */
  readonly valueTestnetsAtMainnetPrices?: boolean;
  /** Cache per (asset, range). CoinGecko's demo plan allows ~30 calls/min. Default 300 s. */
  readonly cacheSeconds?: number;
  /** At most this many points are returned (evenly downsampled). Default 200. */
  readonly maxPoints?: number;
  readonly now?: () => Date;
}

/** CoinGecko coin id of each mainnet's native asset. */
const NATIVE_COIN: Partial<Record<NetworkId, string>> = {
  "solana-mainnet": "solana",
  "ethereum-mainnet": "ethereum",
  "base-mainnet": "ethereum",
  "cardano-mainnet": "cardano",
};

/** CoinGecko asset platform for token contract lookups. */
const PLATFORM: Partial<Record<NetworkId, string>> = {
  "solana-mainnet": "solana",
  "ethereum-mainnet": "ethereum",
  "base-mainnet": "base",
};

const TESTNET_PROXY: Partial<Record<NetworkId, NetworkId>> = {
  "solana-devnet": "solana-mainnet",
  "ethereum-sepolia": "ethereum-mainnet",
  "base-sepolia": "base-mainnet",
  "cardano-preprod": "cardano-mainnet",
};

const RANGE_DAYS: Record<PriceRange, number> = { "1D": 1, "1W": 7, "1M": 30, "1Y": 365 };

/**
 * PriceHistoryProvider over CoinGecko `market_chart` (USD only):
 *  - natives: `/coins/{solana|ethereum}/market_chart`;
 *  - EVM and SPL tokens: `/coins/{ethereum|base|solana}/contract/{address}/market_chart`
 *    (https://docs.coingecko.com/reference/contract-address-market-chart).
 * Fails closed: unknown assets, testnet assets (unless the dev proxy is on), non-USD, provider
 * errors and malformed points give `{ status: "unavailable", reason }`, never invented data.
 */
export function createPriceHistoryProvider(
  config: PriceHistoryProviderConfig = {},
): PriceHistoryProvider {
  const http = resolveHttpOptions(config);
  const now = config.now ?? (() => new Date());
  const cacheMs = (config.cacheSeconds ?? 300) * 1000;
  const maxPoints = Math.max(2, config.maxPoints ?? 200);
  const plan = config.coingeckoPlan ?? "demo";
  const base =
    config.coingeckoBaseUrl ??
    (plan === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3");
  const headers: Record<string, string> = {};
  if (config.coingeckoApiKey)
    headers[plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = config.coingeckoApiKey;
  const cache = new Map<string, { at: number; result: PriceHistoryResult }>();

  function target(assetId: AssetId): { id: AssetId; proxied: boolean } | null {
    const { network, tokenAddress } = parseAssetId(assetId);
    const proxy = TESTNET_PROXY[network];
    if (proxy === undefined) return { id: assetId, proxied: false };
    if (config.valueTestnetsAtMainnetPrices !== true) return null;
    if (tokenAddress === null) return { id: nativeAssetId(proxy), proxied: true };
    const known = KNOWN_TOKENS.find(
      (t) => t.network === network && t.address.toLowerCase() === tokenAddress.toLowerCase(),
    );
    return known?.mainnetEquivalent ? { id: known.mainnetEquivalent, proxied: true } : null;
  }

  function chartPath(id: AssetId): string | null {
    const { network, tokenAddress } = parseAssetId(id);
    if (tokenAddress === null) {
      const coin = NATIVE_COIN[network];
      return coin === undefined ? null : `/coins/${coin}/market_chart`;
    }
    const platform = PLATFORM[network];
    if (platform === undefined) return null;
    const address = platform === "solana" ? tokenAddress : tokenAddress.toLowerCase();
    return `/coins/${platform}/contract/${encodeURIComponent(address)}/market_chart`;
  }

  function downsample<T>(points: T[]): T[] {
    if (points.length <= maxPoints) return points;
    const out: T[] = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
      const p = points[Math.round(i * step)];
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  return {
    async getPriceHistory({ assetId, range, currency }) {
      if (currency !== "USD") return { status: "unavailable", reason: "CURRENCY_UNSUPPORTED" };
      const t = target(assetId);
      if (t === null) return { status: "unavailable", reason: "TESTNET_ASSET" };
      const path = chartPath(t.id);
      if (path === null) return { status: "unavailable", reason: "UNSUPPORTED_ASSET" };
      const key = `${assetId}|${range}`;
      const hit = cache.get(key);
      if (hit !== undefined && now().getTime() - hit.at < cacheMs) return hit.result;

      let body: unknown;
      try {
        body = await requestJson(http, {
          url: `${base}${path}?vs_currency=usd&days=${String(RANGE_DAYS[range])}&precision=full`,
          headers,
          label: "coingecko market_chart",
        });
      } catch {
        // Serve the last good series for this key if we have one, otherwise fail closed.
        return hit?.result ?? { status: "unavailable", reason: "PROVIDER_UNAVAILABLE" };
      }
      const raw = isRecord(body) && Array.isArray(body.prices) ? body.prices : null;
      const points: { t: string; price: string }[] = [];
      for (const entry of raw ?? []) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [ms, value] = entry as [unknown, unknown];
        const price = numberToDecimalString(value);
        if (typeof ms !== "number" || !Number.isFinite(ms) || price === null) continue;
        points.push({ t: new Date(ms).toISOString(), price });
      }
      points.sort((a, b) => a.t.localeCompare(b.t));
      if (points.length < 2) {
        // 404 / unknown contract / empty series: CoinGecko does not track this asset.
        const result: PriceHistoryResult = { status: "unavailable", reason: "UNSUPPORTED_ASSET" };
        cache.set(key, { at: now().getTime(), result });
        return result;
      }
      const result: PriceHistoryResult = {
        status: "available",
        points: downsample(points),
        source: t.proxied ? `coingecko${TESTNET_PROXY_SOURCE_SUFFIX}` : "coingecko",
        simulated: false,
      };
      cache.set(key, { at: now().getTime(), result });
      return result;
    },
  };
}
