import type {
  Asset,
  NetworkId,
  PortfolioProvider,
  PriceProvider,
  Transaction,
  TransactionDirection,
  WatchedAddress,
} from "@zyropay/shared";
import {
  addressesEqual,
  evmChainId,
  explorerTxUrl,
  isValidEvmAddress,
  nativeAsset,
  toChecksumAddress,
} from "@zyropay/shared";
import { deterministicUuid, tokenAsset } from "../assets";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord, JsonRpcClient, resolveHttpOptions, toBigInt } from "../http";
import { assertAddress, assertFamily, assertSameNetwork, rpcUrlFor } from "../networks";
import type { AddressHoldings, HoldingsCache } from "./common";
import { buildSnapshot, collectHoldings, createMemoryHoldingsCache } from "./common";

export interface EvmPortfolioConfig extends HttpOptions {
  readonly alchemyApiKey: string;
  readonly network: NetworkId;
  readonly rpcUrl?: string;
  readonly priceProvider?: PriceProvider | null;
  readonly cache?: HoldingsCache;
  /** Max pages of alchemy_getTokenBalances (100 tokens each). Default 5. */
  readonly maxPages?: number;
  readonly now?: () => Date;
}

/** Networks where alchemy_getAssetTransfers supports the `internal` category. */
const INTERNAL_TRANSFER_NETWORKS: ReadonlySet<NetworkId> = new Set([
  "ethereum-mainnet",
  "base-mainnet",
]);

interface TokenMetadata {
  readonly decimals: number | null;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly logo: string | null;
}

/**
 * EVM PortfolioProvider on Alchemy (Ethereum, Base and their Sepolia testnets):
 *  - balances: eth_getBalance + alchemy_getTokenBalances("erc20", paged) +
 *    alchemy_getTokenMetadata (memoized per isolate);
 *  - history: alchemy_getAssetTransfers, outgoing and incoming merged by block; the fee of
 *    sent transactions from eth_getTransactionReceipt (getAssetTransfers carries none).
 * Docs: https://www.alchemy.com/docs/reference/alchemy-gettokenbalances,
 *       https://www.alchemy.com/docs/reference/alchemy-gettokenmetadata,
 *       https://www.alchemy.com/docs/reference/alchemy-getassettransfers
 */
export function createEvmPortfolioProvider(config: EvmPortfolioConfig): PortfolioProvider {
  assertFamily(config.network, "evm");
  const url = config.rpcUrl ?? rpcUrlFor(config.network, { alchemyApiKey: config.alchemyApiKey });
  const rpc = new JsonRpcClient(url, resolveHttpOptions(config), "alchemy");
  const cache = config.cache ?? createMemoryHoldingsCache();
  const maxPages = config.maxPages ?? 5;
  const now = config.now ?? (() => new Date());
  const metadataCache = new Map<string, TokenMetadata>();
  let chainChecked = false;

  async function assertChain(): Promise<void> {
    if (chainChecked) return;
    const id = toBigInt(await rpc.call("eth_chainId", []), "chainId");
    if (id !== BigInt(evmChainId(config.network))) {
      throw new ChainError("NETWORK_MODE_MISMATCH", `Alchemy endpoint is not ${config.network}`);
    }
    chainChecked = true;
  }

  async function metadata(contract: string): Promise<TokenMetadata> {
    const key = contract.toLowerCase();
    const hit = metadataCache.get(key);
    if (hit !== undefined) return hit;
    const r = await rpc.call("alchemy_getTokenMetadata", [contract]);
    const m: TokenMetadata = isRecord(r)
      ? {
          decimals: typeof r.decimals === "number" ? r.decimals : null,
          symbol: typeof r.symbol === "string" ? r.symbol : null,
          name: typeof r.name === "string" ? r.name : null,
          logo: typeof r.logo === "string" ? r.logo : null,
        }
      : { decimals: null, symbol: null, name: null, logo: null };
    metadataCache.set(key, m);
    return m;
  }

  async function readHoldings(address: WatchedAddress): Promise<AddressHoldings> {
    assertSameNetwork(config.network, address.network);
    assertAddress(address.network, address.address);
    await assertChain();
    const wei = toBigInt(await rpc.call("eth_getBalance", [address.address, "latest"]), "balance");
    const holdings: Array<{ asset: Asset; amount: string }> = [
      { asset: nativeAsset(address.network), amount: wei.toString() },
    ];
    let pageKey: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const options: Record<string, unknown> = { maxCount: 100 };
      if (pageKey !== undefined) options.pageKey = pageKey;
      const r = await rpc.call("alchemy_getTokenBalances", [address.address, "erc20", options]);
      if (!isRecord(r) || !Array.isArray(r.tokenBalances)) {
        throw new ChainError("UPSTREAM_UNAVAILABLE", "alchemy_getTokenBalances: malformed");
      }
      for (const tb of r.tokenBalances) {
        if (!isRecord(tb) || typeof tb.contractAddress !== "string") continue;
        if (tb.error !== null && tb.error !== undefined) continue;
        if (typeof tb.tokenBalance !== "string") continue;
        const amount = toBigInt(tb.tokenBalance, "tokenBalance");
        if (amount === 0n || !isValidEvmAddress(tb.contractAddress)) continue;
        const m = await metadata(tb.contractAddress);
        // Without decimals the amount cannot be shown honestly; skip rather than guess.
        if (m.decimals === null || m.decimals < 0 || m.decimals > 36) continue;
        holdings.push({
          asset: tokenAsset({
            network: address.network,
            address: tb.contractAddress,
            decimals: m.decimals,
            symbol: m.symbol,
            name: m.name,
            logoUrl: m.logo,
          }),
          amount: amount.toString(),
        });
      }
      pageKey = typeof r.pageKey === "string" && r.pageKey.length > 0 ? r.pageKey : undefined;
      if (pageKey === undefined) break;
    }
    return { asOf: now().toISOString(), holdings };
  }

  async function transfers(
    address: string,
    direction: "fromAddress" | "toAddress",
    toBlock: string,
    limit: number,
  ): Promise<unknown[]> {
    const category = ["external", "erc20"];
    if (INTERNAL_TRANSFER_NETWORKS.has(config.network)) category.push("internal");
    const r = await rpc.call("alchemy_getAssetTransfers", [
      {
        fromBlock: "0x0",
        toBlock,
        [direction]: address,
        category,
        order: "desc",
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: `0x${limit.toString(16)}`,
      },
    ]);
    if (!isRecord(r) || !Array.isArray(r.transfers)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "alchemy_getAssetTransfers: malformed");
    }
    return r.transfers as unknown[];
  }

  /**
   * Fee of each transaction this address sent (the fee payer is the receipt's `from`):
   * gasUsed × effectiveGasPrice, plus the OP-stack `l1Fee` on Base. Charged once per
   * transaction, to its first non-incoming row on the page. A receipt that cannot be read
   * leaves the fee null (unknown) rather than failing the history page.
   */
  async function withFees(address: string, txs: Transaction[]): Promise<Transaction[]> {
    const hashes = [...new Set(txs.filter((t) => t.direction !== "in").map((t) => t.txHash))];
    const fees = new Map<string, string>();
    for (let i = 0; i < hashes.length; i += RECEIPT_CONCURRENCY) {
      await Promise.all(
        hashes.slice(i, i + RECEIPT_CONCURRENCY).map(async (hash) => {
          try {
            const fee = receiptFee(address, await rpc.call("eth_getTransactionReceipt", [hash]));
            if (fee !== null) fees.set(hash, fee);
          } catch {
            // unknown fee; the row is still correct without it
          }
        }),
      );
    }
    return txs.map((t) => {
      const fee = t.direction === "in" ? undefined : fees.get(t.txHash);
      if (fee === undefined) return t;
      fees.delete(t.txHash);
      return { ...t, fee };
    });
  }

  return {
    async getSnapshot({ addresses, currency }) {
      const { entries, stale } = await collectHoldings(addresses, readHoldings, cache);
      return buildSnapshot({
        entries,
        stale,
        currency,
        priceProvider: config.priceProvider ?? null,
        simulated: false,
        now: now(),
      });
    },

    /**
     * Cursor = block number upper bound + uniqueIds already returned at that block, so two
     * merged streams (in/out) page correctly without duplicates or gaps.
     */
    async getTransactions({ address, limit, cursor }) {
      assertSameNetwork(config.network, address.network);
      assertAddress(address.network, address.address);
      await assertChain();
      const n = Math.min(Math.max(limit, 1), 100);
      const state = decodeCursor(cursor);
      const toBlock = state === null ? "latest" : `0x${state.block.toString(16)}`;
      const seen = new Set(state?.seen ?? []);
      const [out, inc] = await Promise.all([
        transfers(address.address, "fromAddress", toBlock, n + seen.size),
        transfers(address.address, "toAddress", toBlock, n + seen.size),
      ]);
      const rows = new Map<string, { block: bigint; tx: Transaction }>();
      for (const raw of [...out, ...inc]) {
        const parsed = parseAlchemyTransfer(address, raw);
        if (parsed === null || seen.has(parsed.uniqueId)) continue;
        rows.set(parsed.uniqueId, { block: parsed.block, tx: parsed.tx });
      }
      const sorted = [...rows.entries()].sort((a, b) =>
        a[1].block > b[1].block ? -1 : a[1].block < b[1].block ? 1 : a[0] < b[0] ? -1 : 1,
      );
      const page = sorted.slice(0, n);
      const last = page[page.length - 1];
      let nextCursor: string | null = null;
      if (
        last !== undefined &&
        (sorted.length > n || out.length >= n + seen.size || inc.length >= n + seen.size)
      ) {
        const lastBlock = last[1].block;
        const sameBlock = page.filter(([, v]) => v.block === lastBlock).map(([k]) => k);
        const carried = state !== null && state.block === lastBlock ? state.seen : [];
        nextCursor = encodeCursor({ block: lastBlock, seen: [...carried, ...sameBlock] });
      }
      return {
        transactions: await withFees(
          address.address,
          page.map(([, v]) => v.tx),
        ),
        nextCursor,
        simulated: false,
      };
    },
  };
}

const RECEIPT_CONCURRENCY = 5;

/** Fee paid by `address` according to a transaction receipt, or null if it paid none. */
export function receiptFee(address: string, receipt: unknown): string | null {
  if (!isRecord(receipt) || typeof receipt.from !== "string") return null;
  if (!isValidEvmAddress(receipt.from) || !addressesEqual("evm", receipt.from, address))
    return null;
  if (typeof receipt.gasUsed !== "string" || typeof receipt.effectiveGasPrice !== "string")
    return null;
  let fee =
    toBigInt(receipt.gasUsed, "receipt.gasUsed") *
    toBigInt(receipt.effectiveGasPrice, "receipt.effectiveGasPrice");
  if (typeof receipt.l1Fee === "string") fee += toBigInt(receipt.l1Fee, "receipt.l1Fee");
  return fee >= 0n ? fee.toString() : null;
}

function encodeCursor(state: { block: bigint; seen: string[] }): string {
  return btoa(JSON.stringify({ b: state.block.toString(), s: state.seen }));
}

function decodeCursor(cursor: string | undefined): { block: bigint; seen: string[] } | null {
  if (cursor === undefined) return null;
  try {
    const v = JSON.parse(atob(cursor)) as unknown;
    if (isRecord(v) && typeof v.b === "string" && /^\d+$/.test(v.b) && Array.isArray(v.s)) {
      return {
        block: BigInt(v.b),
        seen: v.s.filter((x): x is string => typeof x === "string").slice(0, 500),
      };
    }
  } catch {
    // fall through
  }
  throw new ChainError("BAD_REQUEST", "invalid cursor");
}

/** Normalize one alchemy_getAssetTransfers entry. Amounts come from rawContract (hex). */
export function parseAlchemyTransfer(
  address: WatchedAddress,
  raw: unknown,
): { uniqueId: string; block: bigint; tx: Transaction } | null {
  if (!isRecord(raw) || typeof raw.hash !== "string" || typeof raw.uniqueId !== "string")
    return null;
  if (typeof raw.from !== "string" || typeof raw.to !== "string") return null;
  if (!isValidEvmAddress(raw.from) || !isValidEvmAddress(raw.to)) return null;
  const rc = isRecord(raw.rawContract) ? raw.rawContract : {};
  if (typeof rc.value !== "string") return null;
  const amount = toBigInt(rc.value, "rawContract.value");
  let asset: Asset;
  if (raw.category === "external" || raw.category === "internal") {
    asset = nativeAsset(address.network);
  } else if (raw.category === "erc20") {
    if (
      typeof rc.address !== "string" ||
      !isValidEvmAddress(rc.address) ||
      typeof rc.decimal !== "string"
    )
      return null;
    const decimals = Number(toBigInt(rc.decimal, "rawContract.decimal"));
    if (decimals > 36) return null;
    asset = tokenAsset({
      network: address.network,
      address: rc.address,
      decimals,
      symbol: typeof raw.asset === "string" ? raw.asset : null,
    });
  } else {
    return null;
  }
  const from = toChecksumAddress(raw.from);
  const to = toChecksumAddress(raw.to);
  const isFrom = addressesEqual("evm", from, address.address);
  const isTo = addressesEqual("evm", to, address.address);
  if (!isFrom && !isTo) return null;
  const direction: TransactionDirection = isFrom && isTo ? "self" : isFrom ? "out" : "in";
  const block = toBigInt(raw.blockNum, "blockNum");
  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const ts = typeof meta.blockTimestamp === "string" ? Date.parse(meta.blockTimestamp) : Number.NaN;
  return {
    uniqueId: raw.uniqueId,
    block,
    tx: {
      id: deterministicUuid(`${address.network}|${raw.uniqueId}|${address.address.toLowerCase()}`),
      walletId: address.walletId,
      network: address.network,
      txHash: raw.hash,
      direction,
      status: "confirmed",
      from,
      to,
      asset,
      amount: amount.toString(),
      fee: null,
      valueAtTime: null,
      timestamp: new Date(Number.isFinite(ts) ? ts : 0).toISOString(),
      blockNumber: block.toString(),
      transactionRequestId: null,
      explorerUrl: explorerTxUrl(address.network, raw.hash),
      simulated: false,
    },
  };
}
