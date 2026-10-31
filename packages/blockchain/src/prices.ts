import type { AssetId, FiatCurrency, NetworkId, PriceProvider, PriceQuote } from "@zyropay/shared";
import { nativeAssetId, parseAssetId, TESTNET_PROXY_SOURCE_SUFFIX } from "@zyropay/shared";
import { KNOWN_TOKENS } from "./assets";
import type { HttpOptions } from "./http";
import { isRecord, requestJson, resolveHttpOptions } from "./http";
import { WSOL_MINT } from "./solana/constants";

export interface PriceProviderConfig extends HttpOptions {
  /** Jupiter API key (x-api-key). Without one the keyless tier (0.5 RPS) is used. */
  readonly jupiterApiKey?: string;
  readonly jupiterBaseUrl?: string;
  readonly coingeckoApiKey?: string;
  /** "demo" (api.coingecko.com, x-cg-demo-api-key) or "pro" (pro-api, x-cg-pro-api-key). */
  readonly coingeckoPlan?: "demo" | "pro";
  readonly coingeckoBaseUrl?: string;
  /** Quotes older than this are dropped (fail closed). Default 120 s (PRICE_MAX_AGE_SECONDS). */
  readonly maxAgeSeconds?: number;
  /**
   * Development only, default false: value testnet natives and curated testnet stablecoins at
   * their mainnet counterpart's price, labelled `source: "...+testnet-proxy"`. Lets policy
   * limits be exercised on testnets. Never enable in production.
   */
  readonly valueTestnetsAtMainnetPrices?: boolean;
  readonly now?: () => Date;
}

const COINGECKO_PLATFORM: Partial<Record<NetworkId, string>> = {
  "ethereum-mainnet": "ethereum",
  "base-mainnet": "base",
};

const TESTNET_NATIVE_PROXY: Partial<Record<NetworkId, NetworkId>> = {
  "solana-devnet": "solana-mainnet",
  "ethereum-sepolia": "ethereum-mainnet",
  "base-sepolia": "base-mainnet",
  "cardano-preprod": "cardano-mainnet",
};

/** Number from a provider JSON payload -> plain decimal string (no exponent). Null if bad. */
export function numberToDecimalString(n: unknown): string | null {
  if (typeof n === "string") return /^(0|[1-9]\d*)(\.\d+)?$/.test(n) ? n : null;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  let s = n.toString();
  if (/e/i.test(s)) {
    s = n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  }
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(s) ? s : null;
}

/**
 * PriceProvider:
 *  - Solana mainnet (SOL via wSOL, SPL mints): Jupiter Price API v3
 *    (https://developers.jup.ag/docs/price), max 50 ids per call, no timestamp in the
 *    response so `asOf` is the fetch time;
 *  - Ethereum / Base mainnet (ETH, ERC-20): CoinGecko /simple/price and
 *    /simple/token_price/{ethereum|base} with include_last_updated_at
 *    (https://docs.coingecko.com/v3.0.1/reference/simple-token-price).
 * USD only. Fail closed: unknown, stale, non-USD or errored assets are ABSENT from the
 * result (never guessed), which the policy engine treats as "no valuation".
 */
export function createPriceProvider(config: PriceProviderConfig = {}): PriceProvider {
  const http = resolveHttpOptions(config);
  const now = config.now ?? (() => new Date());
  const maxAgeMs = (config.maxAgeSeconds ?? 120) * 1000;
  const jupiterBase = config.jupiterBaseUrl ?? "https://api.jup.ag";
  const plan = config.coingeckoPlan ?? "demo";
  const cgBase =
    config.coingeckoBaseUrl ??
    (plan === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3");
  const cgHeaders: Record<string, string> = {};
  if (config.coingeckoApiKey) {
    cgHeaders[plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = config.coingeckoApiKey;
  }
  /** Last good quotes, reused only while still within maxAge. */
  const lastGood = new Map<AssetId, PriceQuote>();

  function fresh(q: PriceQuote): boolean {
    return now().getTime() - Date.parse(q.asOf) <= maxAgeMs;
  }

  async function jupiter(mints: string[]): Promise<Map<string, { price: string; asOf: string }>> {
    const out = new Map<string, { price: string; asOf: string }>();
    for (let i = 0; i < mints.length; i += 50) {
      const chunk = mints.slice(i, i + 50);
      const headers: Record<string, string> = {};
      if (config.jupiterApiKey) headers["x-api-key"] = config.jupiterApiKey;
      const fetchedAt = now().toISOString();
      const body = await requestJson(http, {
        url: `${jupiterBase}/price/v3?ids=${chunk.map(encodeURIComponent).join(",")}`,
        headers,
        label: "jupiter price",
      });
      if (!isRecord(body)) continue;
      for (const mint of chunk) {
        const entry = body[mint];
        if (!isRecord(entry)) continue;
        const price = numberToDecimalString(entry.usdPrice);
        if (price !== null) out.set(mint, { price, asOf: fetchedAt });
      }
    }
    return out;
  }

  async function coingecko(
    path: string,
    keys: string[],
  ): Promise<Map<string, { price: string; asOf: string }>> {
    const out = new Map<string, { price: string; asOf: string }>();
    if (keys.length === 0) return out;
    const body = await requestJson(http, {
      url: `${cgBase}${path}${keys.map((k) => encodeURIComponent(k)).join(",")}&vs_currencies=usd&include_last_updated_at=true&precision=full`,
      headers: cgHeaders,
      label: "coingecko price",
    });
    if (!isRecord(body)) return out;
    for (const key of keys) {
      const entry = body[key.toLowerCase()] ?? body[key];
      if (!isRecord(entry) || typeof entry.last_updated_at !== "number") continue;
      const price = numberToDecimalString(entry.usd);
      if (price !== null) {
        out.set(key.toLowerCase(), {
          price,
          asOf: new Date(entry.last_updated_at * 1000).toISOString(),
        });
      }
    }
    return out;
  }

  async function fetchMainnet(ids: readonly AssetId[]): Promise<Map<AssetId, PriceQuote>> {
    const result = new Map<AssetId, PriceQuote>();
    const solana = new Map<string, AssetId>();
    const evmNative: AssetId[] = [];
    const adaNative: AssetId[] = [];
    const evmTokens = new Map<string, Map<string, AssetId>>();
    for (const id of ids) {
      const { network, tokenAddress } = parseAssetId(id);
      // Cardano: ADA only (CoinGecko id `cardano`). Native tokens stay unpriced: CoinGecko
      // has no documented contract lookup for Cardano policy ids, so they are never guessed.
      if (network === "cardano-mainnet") {
        if (tokenAddress === null) adaNative.push(id);
      } else if (network === "solana-mainnet") solana.set(tokenAddress ?? WSOL_MINT, id);
      else if (network === "ethereum-mainnet" || network === "base-mainnet") {
        if (tokenAddress === null) evmNative.push(id);
        else {
          const platform = COINGECKO_PLATFORM[network] ?? "";
          const m = evmTokens.get(platform) ?? new Map<string, AssetId>();
          m.set(tokenAddress.toLowerCase(), id);
          evmTokens.set(platform, m);
        }
      }
    }
    const tasks: Array<Promise<void>> = [];
    const put = (id: AssetId, p: { price: string; asOf: string }, source: string): void => {
      result.set(id, {
        assetId: id,
        price: { value: p.price, currency: "USD" },
        asOf: p.asOf,
        source,
        simulated: false,
      });
    };
    if (solana.size > 0) {
      tasks.push(
        jupiter([...solana.keys()]).then((prices) => {
          for (const [mint, p] of prices) {
            const id = solana.get(mint);
            if (id !== undefined) put(id, p, "jupiter-price-v3");
          }
        }),
      );
    }
    if (evmNative.length > 0) {
      tasks.push(
        coingecko("/simple/price?ids=", ["ethereum"]).then((prices) => {
          const p = prices.get("ethereum");
          if (p !== undefined) for (const id of evmNative) put(id, p, "coingecko");
        }),
      );
    }
    if (adaNative.length > 0) {
      tasks.push(
        coingecko("/simple/price?ids=", ["cardano"]).then((prices) => {
          const p = prices.get("cardano");
          if (p !== undefined) for (const id of adaNative) put(id, p, "coingecko");
        }),
      );
    }
    for (const [platform, tokens] of evmTokens) {
      tasks.push(
        coingecko(`/simple/token_price/${platform}?contract_addresses=`, [...tokens.keys()]).then(
          (prices) => {
            for (const [address, p] of prices) {
              const id = tokens.get(address);
              if (id !== undefined) put(id, p, "coingecko");
            }
          },
        ),
      );
    }
    // One failing source must not drop the others: settle each independently.
    await Promise.allSettled(tasks);
    return result;
  }

  return {
    async getPrices({
      assetIds,
      currency,
    }: {
      assetIds: readonly AssetId[];
      currency: FiatCurrency;
    }) {
      const prices: Partial<Record<AssetId, PriceQuote>> = {};
      if (currency !== "USD" || assetIds.length === 0) return { prices, simulated: false };

      // Map every requested id to the mainnet id that is actually priced.
      const pricedAs = new Map<AssetId, AssetId>();
      for (const id of new Set(assetIds)) {
        const { network, tokenAddress } = parseAssetId(id);
        const proxy = TESTNET_NATIVE_PROXY[network];
        if (proxy === undefined) {
          pricedAs.set(id, id);
        } else if (config.valueTestnetsAtMainnetPrices === true) {
          if (tokenAddress === null) pricedAs.set(id, nativeAssetId(proxy));
          else {
            const known = KNOWN_TOKENS.find(
              (t) =>
                t.network === network && t.address.toLowerCase() === tokenAddress.toLowerCase(),
            );
            if (known?.mainnetEquivalent) pricedAs.set(id, known.mainnetEquivalent);
          }
        }
      }
      const targets = [...new Set(pricedAs.values())];
      const fetched = await fetchMainnet(targets);
      for (const [id, q] of fetched) if (fresh(q)) lastGood.set(id, q);
      for (const [requested, target] of pricedAs) {
        const q = fetched.get(target) ?? lastGood.get(target);
        if (q === undefined || !fresh(q)) continue;
        prices[requested] =
          requested === target
            ? q
            : { ...q, assetId: requested, source: `${q.source}${TESTNET_PROXY_SOURCE_SUFFIX}` };
      }
      return { prices, simulated: false };
    },
  };
}
