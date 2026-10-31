import type {
  Asset,
  NetworkId,
  PortfolioProvider,
  PriceProvider,
  Transaction,
  TransactionDirection,
  WatchedAddress,
} from "@zyropay/shared";
import { explorerTxUrl, isValidSolanaAddress, nativeAsset } from "@zyropay/shared";
import { deterministicUuid, tokenAsset } from "../assets";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord, JsonRpcClient, resolveHttpOptions, toBigInt } from "../http";
import { heliusKeyPool } from "../key-failover";
import { assertAddress, assertFamily, assertSameNetwork, rpcUrlFor } from "../networks";
import type { AddressHoldings, HoldingsCache } from "./common";
import { buildSnapshot, collectHoldings, createMemoryHoldingsCache } from "./common";

export interface SolanaPortfolioConfig extends HttpOptions {
  /**
   * Helius key, or an ordered key list (primary first). With a list, a key that answers
   * 401/403/429 ("max usage reached") is cooled down and the call is replayed with the next
   * key (`key-failover.ts`).
   */
  readonly heliusApiKey: string | readonly string[];
  readonly network: NetworkId;
  /** Override the Helius RPC URL (tests, proxies). Must serve the same network. */
  readonly rpcUrl?: string;
  readonly priceProvider?: PriceProvider | null;
  readonly cache?: HoldingsCache;
  /** DAS page size (max 1000) and page cap. Defaults 1000 and 5. */
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly now?: () => Date;
}

/**
 * Solana PortfolioProvider on Helius:
 *  - balances: DAS `getAssetsByOwner` with showFungible + showNativeBalance (one call returns
 *    SOL and every SPL/Token-2022 balance), paged;
 *  - history: `getTransactionsForAddress` (full, jsonParsed) so amounts come from the parsed
 *    System/SPL instructions in exact base units (the legacy Enhanced Transactions API returns
 *    UI-scaled token amounts, which are floats).
 * Docs: https://www.helius.dev/docs/api-reference/das/getassetsbyowner,
 *       https://www.helius.dev/docs/rpc/gettransactionsforaddress
 */
export function createSolanaPortfolioProvider(config: SolanaPortfolioConfig): PortfolioProvider {
  assertFamily(config.network, "solana");
  const url = config.rpcUrl ?? rpcUrlFor(config.network, { heliusApiKey: config.heliusApiKey });
  const http = resolveHttpOptions(config);
  const keys =
    typeof config.heliusApiKey === "string" ? [config.heliusApiKey] : config.heliusApiKey;
  const rpc = new JsonRpcClient(
    url,
    keys.length > 1 ? { ...http, fetch: heliusKeyPool(keys).wrap(http.fetch) } : http,
    "helius",
  );
  const cache = config.cache ?? createMemoryHoldingsCache();
  const pageSize = Math.min(config.pageSize ?? 1000, 1000);
  const maxPages = config.maxPages ?? 5;
  const now = config.now ?? (() => new Date());

  async function readHoldings(address: WatchedAddress): Promise<AddressHoldings> {
    assertSameNetwork(config.network, address.network);
    assertAddress(address.network, address.address);
    const holdings: Array<{ asset: Asset; amount: string }> = [];
    let lamports: bigint | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const result = await rpc.call("getAssetsByOwner", {
        ownerAddress: address.address,
        page,
        limit: pageSize,
        options: { showFungible: true, showNativeBalance: true, showZeroBalance: false },
      });
      if (!isRecord(result) || !Array.isArray(result.items)) {
        throw new ChainError("UPSTREAM_UNAVAILABLE", "getAssetsByOwner: malformed response");
      }
      if (lamports === null && isRecord(result.nativeBalance)) {
        lamports = toBigInt(result.nativeBalance.lamports, "nativeBalance.lamports");
      }
      for (const item of result.items) {
        const h = fungibleHolding(address.network, item);
        if (h !== null) holdings.push(h);
      }
      if (result.items.length < pageSize) break;
    }
    if (lamports === null) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "getAssetsByOwner: missing nativeBalance");
    }
    holdings.unshift({ asset: nativeAsset(address.network), amount: lamports.toString() });
    return { asOf: now().toISOString(), holdings };
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

    async getTransactions({ address, limit, cursor }) {
      assertSameNetwork(config.network, address.network);
      assertAddress(address.network, address.address);
      const options: Record<string, unknown> = {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder: "desc",
        limit: Math.min(Math.max(limit, 1), 100),
        filters: { tokenAccounts: "balanceChanged" },
      };
      if (cursor !== undefined) options.paginationToken = cursor;
      const result = await rpc.call("getTransactionsForAddress", [address.address, options]);
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new ChainError("UPSTREAM_UNAVAILABLE", "getTransactionsForAddress: malformed");
      }
      const transactions = result.data.flatMap((tx) => parseSolanaTransaction(address, tx));
      const token = result.paginationToken;
      return {
        transactions,
        nextCursor: typeof token === "string" && token.length > 0 ? token : null,
        simulated: false,
      };
    },
  };
}

function fungibleHolding(
  network: NetworkId,
  item: unknown,
): { asset: Asset; amount: string } | null {
  if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.token_info)) return null;
  const info = item.token_info;
  if (typeof info.decimals !== "number" || !Number.isInteger(info.decimals)) return null;
  if (info.decimals < 0 || info.decimals > 36) return null;
  const amount = toBigInt(info.balance ?? 0, "token_info.balance");
  if (amount <= 0n) return null;
  // Non-fungible tokens (0 decimals, supply 1) are NFTs, not balances.
  if (info.decimals === 0 && toBigInt(info.supply ?? 0, "supply") === 1n) return null;
  if (!isValidSolanaAddress(item.id)) return null;
  const content = isRecord(item.content) ? item.content : {};
  const metadata = isRecord(content.metadata) ? content.metadata : {};
  const links = isRecord(content.links) ? content.links : {};
  return {
    asset: tokenAsset({
      network,
      address: item.id,
      decimals: info.decimals,
      symbol:
        typeof info.symbol === "string" ? info.symbol : (metadata.symbol as string | undefined),
      name: typeof metadata.name === "string" ? metadata.name : null,
      logoUrl: links.image,
    }),
    amount: amount.toString(),
  };
}

interface TokenAccountInfo {
  readonly owner: string;
  readonly mint: string;
  readonly decimals: number;
}

interface RawTransfer {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  /** null = native SOL. */
  readonly mint: string | null;
  readonly decimals: number;
}

/** Normalize one getTransactionsForAddress (jsonParsed) entry into Transaction rows. */
export function parseSolanaTransaction(address: WatchedAddress, entry: unknown): Transaction[] {
  if (!isRecord(entry) || !isRecord(entry.transaction) || !isRecord(entry.meta)) return [];
  const meta = entry.meta;
  const message = isRecord(entry.transaction.message) ? entry.transaction.message : {};
  const signatures = entry.transaction.signatures;
  const txHash =
    Array.isArray(signatures) && typeof signatures[0] === "string" ? signatures[0] : null;
  if (txHash === null) return [];
  const accountKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map((k) =>
        isRecord(k) && typeof k.pubkey === "string" ? k.pubkey : typeof k === "string" ? k : "",
      )
    : [];

  const tokenAccounts = new Map<string, TokenAccountInfo>();
  for (const list of [meta.preTokenBalances, meta.postTokenBalances]) {
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!isRecord(b) || typeof b.accountIndex !== "number" || typeof b.mint !== "string")
        continue;
      const key = accountKeys[b.accountIndex];
      const ui = isRecord(b.uiTokenAmount) ? b.uiTokenAmount : {};
      if (key === undefined || typeof b.owner !== "string" || typeof ui.decimals !== "number")
        continue;
      tokenAccounts.set(key, { owner: b.owner, mint: b.mint, decimals: ui.decimals });
    }
  }

  const instructions: unknown[] = [];
  if (Array.isArray(message.instructions))
    instructions.push(...(message.instructions as unknown[]));
  if (Array.isArray(meta.innerInstructions)) {
    for (const inner of meta.innerInstructions) {
      if (isRecord(inner) && Array.isArray(inner.instructions))
        instructions.push(...(inner.instructions as unknown[]));
    }
  }

  const transfers: RawTransfer[] = [];
  for (const ix of instructions) {
    const t = parseTransferInstruction(ix, tokenAccounts);
    if (t !== null && t.amount > 0n) transfers.push(t);
  }

  const failed = meta.err !== null && meta.err !== undefined;
  const blockTime = typeof entry.blockTime === "number" ? entry.blockTime : null;
  const timestamp = new Date((blockTime ?? 0) * 1000).toISOString();
  const slot = entry.slot === undefined ? null : toBigInt(entry.slot, "slot").toString();
  const feePayer = accountKeys[0];
  let feeAssigned = false;
  const rows: Transaction[] = [];
  transfers.forEach((t, index) => {
    const isFrom = t.from === address.address;
    const isTo = t.to === address.address;
    if (!isFrom && !isTo) return;
    if (!isValidSolanaAddress(t.from) || !isValidSolanaAddress(t.to)) return;
    const direction: TransactionDirection = isFrom && isTo ? "self" : isFrom ? "out" : "in";
    const asset =
      t.mint === null
        ? nativeAsset(address.network)
        : tokenAsset({ network: address.network, address: t.mint, decimals: t.decimals });
    let fee: string | null = null;
    if (!feeAssigned && direction !== "in" && feePayer === address.address) {
      fee = toBigInt(meta.fee ?? 0, "fee").toString();
      feeAssigned = true;
    }
    rows.push({
      id: deterministicUuid(`${address.network}|${txHash}|${index}|${address.address}`),
      walletId: address.walletId,
      network: address.network,
      txHash,
      direction,
      status: failed ? "failed" : "confirmed",
      from: t.from,
      to: t.to,
      asset,
      amount: t.amount.toString(),
      fee,
      valueAtTime: null,
      timestamp,
      blockNumber: slot,
      transactionRequestId: null,
      explorerUrl: explorerTxUrl(address.network, txHash),
      simulated: false,
    });
  });
  return rows;
}

function parseTransferInstruction(
  ix: unknown,
  tokenAccounts: ReadonlyMap<string, TokenAccountInfo>,
): RawTransfer | null {
  if (!isRecord(ix) || !isRecord(ix.parsed) || typeof ix.program !== "string") return null;
  const { type, info } = ix.parsed;
  if (!isRecord(info) || typeof type !== "string") return null;
  if (ix.program === "system" && (type === "transfer" || type === "transferWithSeed")) {
    if (typeof info.source !== "string" || typeof info.destination !== "string") return null;
    return {
      from: info.source,
      to: info.destination,
      amount: toBigInt(info.lamports, "lamports"),
      mint: null,
      decimals: 9,
    };
  }
  if (ix.program === "spl-token" && (type === "transfer" || type === "transferChecked")) {
    if (typeof info.source !== "string" || typeof info.destination !== "string") return null;
    const src = tokenAccounts.get(info.source);
    const dst = tokenAccounts.get(info.destination);
    const mint = typeof info.mint === "string" ? info.mint : (src?.mint ?? dst?.mint);
    if (mint === undefined) return null;
    const tokenAmount = isRecord(info.tokenAmount) ? info.tokenAmount : null;
    const amount = toBigInt(tokenAmount?.amount ?? info.amount, "token amount");
    const decimals =
      typeof tokenAmount?.decimals === "number"
        ? tokenAmount.decimals
        : (src?.decimals ?? dst?.decimals ?? 0);
    const authority = typeof info.authority === "string" ? info.authority : undefined;
    const from = src?.owner ?? authority;
    const to = dst?.owner;
    if (from === undefined || to === undefined) return null;
    return { from, to, amount, mint, decimals };
  }
  return null;
}
