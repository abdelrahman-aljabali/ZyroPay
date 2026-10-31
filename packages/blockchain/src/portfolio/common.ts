import type {
  Asset,
  Balance,
  FiatCurrency,
  NetworkId,
  PortfolioProvider,
  PortfolioSnapshot,
  PriceProvider,
  WatchedAddress,
} from "@zyropay/shared";
import {
  addBaseUnits,
  chainFamilyOf,
  minorUnitsToDecimal,
  priceBasisOfSource,
  valueInUsdMinor,
} from "@zyropay/shared";
import { ChainError } from "../errors";

/** Balances of one address on one network, as read from the chain. */
export interface AddressHoldings {
  readonly asOf: string;
  readonly holdings: ReadonlyArray<{ asset: Asset; amount: string }>;
}

/**
 * Last-known-good storage for stale fallback. The default keeps data in memory for the life
 * of the isolate; the API can pass a KV- or DB-backed implementation.
 */
export interface HoldingsCache {
  get(key: string): Promise<AddressHoldings | null>;
  set(key: string, value: AddressHoldings): Promise<void>;
}

export function createMemoryHoldingsCache(): HoldingsCache {
  const map = new Map<string, AddressHoldings>();
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

function holdingsKey(address: WatchedAddress): string {
  return `${address.network}:${address.address}`;
}

/**
 * Read holdings for every address; on a provider failure fall back to the cached copy and
 * mark the snapshot stale. Addresses with neither fresh nor cached data are left out and the
 * snapshot is stale: the API must show the stale badge, never a silently smaller total.
 */
export async function collectHoldings(
  addresses: readonly WatchedAddress[],
  read: (address: WatchedAddress) => Promise<AddressHoldings>,
  cache: HoldingsCache,
): Promise<{ entries: Array<{ address: WatchedAddress; data: AddressHoldings }>; stale: boolean }> {
  let stale = false;
  const results = await Promise.all(
    addresses.map(async (address) => {
      const key = holdingsKey(address);
      try {
        const data = await read(address);
        await cache.set(key, data);
        return { address, data };
      } catch (error) {
        // Programming/validation errors are not outages: surface them.
        if (error instanceof ChainError && !isOutage(error)) throw error;
        stale = true;
        const cached = await cache.get(key);
        return cached === null ? null : { address, data: cached };
      }
    }),
  );
  return { entries: results.filter((r) => r !== null), stale };
}

function isOutage(error: ChainError): boolean {
  return error.code === "UPSTREAM_UNAVAILABLE" || error.code === "RATE_LIMITED";
}

/**
 * Turn holdings into a priced snapshot. Prices come from the PriceProvider; anything without
 * a fresh price stays `price: null, value: null` and is counted in `unpricedAssetCount`.
 * Value math is bigint (valueInUsdMinor rounds up to the minor unit).
 */
export async function buildSnapshot(input: {
  entries: ReadonlyArray<{ address: WatchedAddress; data: AddressHoldings }>;
  stale: boolean;
  currency: FiatCurrency;
  priceProvider: PriceProvider | null;
  simulated: boolean;
  now: Date;
}): Promise<PortfolioSnapshot> {
  const balances: Balance[] = [];
  for (const { address, data } of input.entries) {
    for (const h of data.holdings) {
      balances.push({
        walletId: address.walletId,
        address: address.address,
        network: address.network,
        asset: h.asset,
        amount: h.amount,
        price: null,
        value: null,
      });
    }
  }
  const assetIds = [...new Set(balances.map((b) => b.asset.id))];
  let prices: Awaited<ReturnType<PriceProvider["getPrices"]>>["prices"] = {};
  if (input.priceProvider !== null && assetIds.length > 0) {
    try {
      prices = (await input.priceProvider.getPrices({ assetIds, currency: input.currency })).prices;
    } catch {
      prices = {};
    }
  }
  let totalMinor = "0";
  let unpriced = 0;
  for (const b of balances) {
    const quote = prices[b.asset.id];
    if (quote?.price.currency !== input.currency || quote.price.value.startsWith("-")) {
      unpriced++;
      continue;
    }
    const minor = valueInUsdMinor(
      { amount: b.amount, decimals: b.asset.decimals },
      quote.price.value,
    );
    b.price = quote.price;
    b.priceBasis = priceBasisOfSource(quote.source);
    b.value = { value: minorUnitsToDecimal(minor), currency: input.currency };
    totalMinor = addBaseUnits(totalMinor, minor);
  }
  const asOfTimes = input.entries.map((e) => Date.parse(e.data.asOf)).filter(Number.isFinite);
  const asOf = asOfTimes.length > 0 ? new Date(Math.min(...asOfTimes)) : input.now;
  const networks = [...new Set(input.entries.map((e) => e.address.network))] as NetworkId[];
  return {
    asOf: asOf.toISOString(),
    stale: input.stale,
    currency: input.currency,
    totalValue: { value: minorUnitsToDecimal(totalMinor), currency: input.currency },
    unpricedAssetCount: unpriced,
    networks,
    balances,
    simulated: input.simulated,
  };
}

/**
 * Routes each watched address to the provider of its chain family and merges the results.
 * This is what the API wires as its single PortfolioProvider.
 */
export function createCompositePortfolioProvider(providers: {
  /** Per-network providers (each Helius/Alchemy provider is bound to one network). */
  byNetwork?: Partial<Record<NetworkId, PortfolioProvider>>;
  /** Family fallbacks (e.g. a mock serving every network of a family). */
  solana?: PortfolioProvider;
  evm?: PortfolioProvider;
  cardano?: PortfolioProvider;
  priceProvider?: PriceProvider | null;
  now?: () => Date;
}): PortfolioProvider {
  const now = providers.now ?? (() => new Date());
  const pick = (network: NetworkId): PortfolioProvider => {
    const p = providers.byNetwork?.[network] ?? providers[chainFamilyOf(network)];
    if (p === undefined)
      throw new ChainError("NETWORK_NOT_SUPPORTED", `no provider for ${network}`);
    return p;
  };
  return {
    async getSnapshot({ addresses, currency }) {
      const groups = new Map<PortfolioProvider, WatchedAddress[]>();
      for (const a of addresses) {
        const p = pick(a.network);
        groups.set(p, [...(groups.get(p) ?? []), a]);
      }
      const parts = await Promise.all(
        [...groups.entries()].map(([p, list]) => p.getSnapshot({ addresses: list, currency })),
      );
      const entries = parts.flatMap((s) => {
        const byAddress = new Map<
          string,
          {
            address: WatchedAddress;
            data: { asOf: string; holdings: Array<{ asset: Asset; amount: string }> };
          }
        >();
        for (const b of s.balances) {
          const key = `${b.walletId}|${b.network}|${b.address}`;
          const entry = byAddress.get(key) ?? {
            address: { walletId: b.walletId, network: b.network, address: b.address },
            data: { asOf: s.asOf, holdings: [] },
          };
          entry.data.holdings.push({ asset: b.asset, amount: b.amount });
          byAddress.set(key, entry);
        }
        return [...byAddress.values()];
      });
      const snapshot = await buildSnapshot({
        entries,
        stale: parts.some((s) => s.stale),
        currency,
        priceProvider: providers.priceProvider ?? null,
        simulated: parts.some((s) => s.simulated),
        now: now(),
      });
      const asOf = parts.map((s) => Date.parse(s.asOf)).filter(Number.isFinite);
      return {
        ...snapshot,
        asOf: asOf.length > 0 ? new Date(Math.min(...asOf)).toISOString() : snapshot.asOf,
        networks: [...new Set(addresses.map((a) => a.network))],
      };
    },
    getTransactions(input) {
      return pick(input.address.network).getTransactions(input);
    },
  };
}
