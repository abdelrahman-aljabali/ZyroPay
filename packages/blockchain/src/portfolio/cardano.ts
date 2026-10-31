import type {
  Asset,
  NetworkId,
  PortfolioProvider,
  PriceProvider,
  Transaction,
  TransactionDirection,
  WatchedAddress,
} from "@zyropay/shared";
import { explorerTxUrl, isValidCardanoAddress, nativeAsset } from "@zyropay/shared";
import { deterministicUuid, tokenAsset } from "../assets";
import type { BlockfrostAmount } from "../cardano/blockfrost";
import { BlockfrostClient, parseAmounts } from "../cardano/blockfrost";
import type { CardanoAssetMetadata } from "../cardano/metadata";
import { readAssetMetadata } from "../cardano/metadata";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord } from "../http";
import { assertAddress, assertFamily, assertSameNetwork } from "../networks";
import type { AddressHoldings, HoldingsCache } from "./common";
import { buildSnapshot, collectHoldings, createMemoryHoldingsCache } from "./common";

export interface CardanoPortfolioConfig extends HttpOptions {
  readonly blockfrostProjectId: string;
  readonly network: NetworkId;
  readonly blockfrostBaseUrl?: string;
  readonly priceProvider?: PriceProvider | null;
  readonly cache?: HoldingsCache;
  /**
   * Transactions per history page. Each costs two Blockfrost calls (`/txs/{h}` and
   * `/txs/{h}/utxos`), and Blockfrost allows 10 requests/s, so the default is 10.
   */
  readonly historyPageSize?: number;
  /** Native tokens resolved per address (each needs an `/assets/{unit}` call). Default 50. */
  readonly maxTokensPerAddress?: number;
  readonly now?: () => Date;
}

const MAX_TOKENS_DEFAULT = 50;

/**
 * Cardano PortfolioProvider on Blockfrost (https://docs.blockfrost.io):
 *  - balances: `/addresses/{address}` returns lovelace and every native token in one call
 *    (404 = never used => empty). Token decimals/ticker come from `/assets/{unit}`
 *    (Token Registry or CIP-25/68 metadata); NFTs (total supply 1) are skipped like on
 *    Solana. No Cardano token is on the curated list, so every token is `verified: false`.
 *  - history: `/addresses/{address}/transactions?order=desc` paged by `page`; each
 *    transaction's movement for this address is the net of its outputs to the address minus
 *    its inputs from it (`/txs/{hash}/utxos`), in exact lovelace / token units, and the fee
 *    (`/txs/{hash}`) is attributed when the address funded the transaction.
 */
export function createCardanoPortfolioProvider(config: CardanoPortfolioConfig): PortfolioProvider {
  assertFamily(config.network, "cardano");
  const client = new BlockfrostClient({
    ...config,
    projectId: config.blockfrostProjectId,
    ...(config.blockfrostBaseUrl !== undefined ? { baseUrl: config.blockfrostBaseUrl } : {}),
  });
  const cache = config.cache ?? createMemoryHoldingsCache();
  const pageSize = Math.min(Math.max(config.historyPageSize ?? 10, 1), 100);
  const maxTokens = config.maxTokensPerAddress ?? MAX_TOKENS_DEFAULT;
  const now = config.now ?? (() => new Date());

  async function assetFor(
    unit: string,
  ): Promise<{ asset: Asset; meta: CardanoAssetMetadata } | null> {
    const meta = await readAssetMetadata(client, unit);
    if (meta === null) return null;
    return {
      meta,
      asset: tokenAsset({
        network: config.network,
        address: unit,
        decimals: meta.decimals,
        symbol: meta.ticker ?? meta.name,
        name: meta.name,
      }),
    };
  }

  async function readHoldings(address: WatchedAddress): Promise<AddressHoldings> {
    assertSameNetwork(config.network, address.network);
    assertAddress(address.network, address.address);
    const body = await client.getOrNull(
      `/addresses/${encodeURIComponent(address.address)}`,
      "addresses",
    );
    const holdings: Array<{ asset: Asset; amount: string }> = [];
    if (body === null) {
      holdings.push({ asset: nativeAsset(address.network), amount: "0" });
      return { asOf: now().toISOString(), holdings };
    }
    if (!isRecord(body)) throw new ChainError("UPSTREAM_UNAVAILABLE", "address: malformed");
    const amounts = parseAmounts(body.amount, "address.amount");
    const lovelace = amounts.find((a) => a.unit === "lovelace")?.quantity ?? "0";
    holdings.push({ asset: nativeAsset(address.network), amount: lovelace });
    const tokens = amounts.filter((a) => a.unit !== "lovelace" && BigInt(a.quantity) > 0n);
    for (const t of tokens.slice(0, maxTokens)) {
      const resolved = await assetFor(t.unit);
      if (resolved === null) continue;
      // Total supply 1 and no decimals: an NFT, not a balance.
      if (resolved.meta.supply === "1" && resolved.meta.decimals === 0) continue;
      holdings.push({ asset: resolved.asset, amount: t.quantity });
    }
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

    async getTransactions({ address, cursor }) {
      assertSameNetwork(config.network, address.network);
      assertAddress(address.network, address.address);
      const page = cursor === undefined ? 1 : Number(cursor);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
        throw new ChainError("BAD_REQUEST", "invalid cursor");
      }
      const list = await client.getOrNull(
        `/addresses/${encodeURIComponent(address.address)}/transactions?order=desc&count=${pageSize}&page=${page}`,
        "addresses/transactions",
      );
      if (list === null) return { transactions: [], nextCursor: null, simulated: false };
      if (!Array.isArray(list))
        throw new ChainError("UPSTREAM_UNAVAILABLE", "transactions: malformed");
      const transactions: Transaction[] = [];
      for (const entry of list as unknown[]) {
        if (!isRecord(entry) || typeof entry.tx_hash !== "string") continue;
        const [tx, utxos] = await Promise.all([
          client.get(`/txs/${entry.tx_hash}`, "txs"),
          client.get(`/txs/${entry.tx_hash}/utxos`, "txs/utxos"),
        ]);
        const units = new Set<string>();
        for (const side of ["inputs", "outputs"] as const) {
          const rows =
            isRecord(utxos) && Array.isArray(utxos[side]) ? (utxos[side] as unknown[]) : [];
          for (const r of rows) {
            if (isRecord(r) && r.address === address.address) {
              for (const a of parseAmounts(r.amount, "amount"))
                if (a.unit !== "lovelace") units.add(a.unit);
            }
          }
        }
        const assets = new Map<string, Asset>();
        for (const unit of [...units].slice(0, maxTokens)) {
          const resolved = await assetFor(unit);
          if (resolved !== null) assets.set(unit, resolved.asset);
        }
        transactions.push(...parseCardanoTransaction(address, tx, utxos, assets));
      }
      return {
        transactions,
        nextCursor: list.length < pageSize ? null : String(page + 1),
        simulated: false,
      };
    },
  };
}

interface UtxoRow {
  readonly address: string;
  readonly amount: readonly BlockfrostAmount[];
}

function rowsOf(utxos: unknown, side: "inputs" | "outputs"): UtxoRow[] {
  if (!isRecord(utxos) || !Array.isArray(utxos[side])) {
    throw new ChainError("UPSTREAM_UNAVAILABLE", `tx utxos: missing ${side}`);
  }
  return (utxos[side] as unknown[]).flatMap((r) => {
    if (!isRecord(r) || typeof r.address !== "string") return [];
    // Collateral and reference inputs are not spent by a valid transaction.
    if (r.collateral === true || r.reference === true) return [];
    return [{ address: r.address, amount: parseAmounts(r.amount, `${side}.amount`) }];
  });
}

/**
 * Normalize one Blockfrost transaction (`/txs/{h}` + `/txs/{h}/utxos`) into history rows
 * for `address`: one row per asset whose balance at the address changed (in/out), or a
 * single `self` row when only the fee moved. Amounts are exact base units.
 */
export function parseCardanoTransaction(
  address: WatchedAddress,
  tx: unknown,
  utxos: unknown,
  tokenAssets: ReadonlyMap<string, Asset>,
): Transaction[] {
  if (!isRecord(tx) || typeof tx.hash !== "string") return [];
  const txHash = tx.hash;
  const inputs = rowsOf(utxos, "inputs");
  const outputs = rowsOf(utxos, "outputs");
  const ours = (r: UtxoRow) => r.address === address.address;
  const paid = inputs.some(ours);
  const fee = typeof tx.fees === "string" && /^\d+$/.test(tx.fees) ? BigInt(tx.fees) : 0n;
  const net = new Map<string, bigint>();
  const add = (rows: UtxoRow[], sign: bigint) => {
    for (const r of rows.filter(ours)) {
      for (const a of r.amount)
        net.set(a.unit, (net.get(a.unit) ?? 0n) + sign * BigInt(a.quantity));
    }
  };
  add(outputs, 1n);
  add(inputs, -1n);
  // The fee left our balance but went to no one: the ADA *sent* excludes it.
  if (paid) net.set("lovelace", (net.get("lovelace") ?? 0n) + fee);

  const counterparty = (rows: UtxoRow[]) => {
    const other = rows.find((r) => !ours(r))?.address;
    return other !== undefined && isValidCardanoAddress(other) ? other : address.address;
  };
  const timestamp =
    typeof tx.block_time === "number"
      ? new Date(tx.block_time * 1000).toISOString()
      : new Date(0).toISOString();
  const blockNumber = typeof tx.block_height === "number" ? String(tx.block_height) : null;
  const failed = tx.valid_contract === false;
  let feeAssigned = false;
  const rows: Transaction[] = [];
  const push = (unit: string, direction: TransactionDirection, amount: bigint) => {
    const asset = unit === "lovelace" ? nativeAsset(address.network) : tokenAssets.get(unit);
    if (asset === undefined) return; // metadata unavailable: never guess decimals
    let rowFee: string | null = null;
    if (paid && !feeAssigned && direction !== "in") {
      rowFee = fee.toString();
      feeAssigned = true;
    }
    rows.push({
      id: deterministicUuid(`${address.network}|${txHash}|${unit}|${address.address}`),
      walletId: address.walletId,
      network: address.network,
      txHash,
      direction,
      status: failed ? "failed" : "confirmed",
      from: direction === "in" ? counterparty(inputs) : address.address,
      to:
        direction === "in"
          ? address.address
          : direction === "self"
            ? address.address
            : counterparty(outputs),
      asset,
      amount: amount.toString(),
      fee: rowFee,
      valueAtTime: null,
      timestamp,
      blockNumber,
      transactionRequestId: null,
      explorerUrl: explorerTxUrl(address.network, txHash),
      simulated: false,
    });
  };
  const units = [...net.keys()].sort((a, b) =>
    a === "lovelace" ? -1 : b === "lovelace" ? 1 : a.localeCompare(b),
  );
  for (const unit of units) {
    const delta = net.get(unit) ?? 0n;
    if (delta > 0n) push(unit, "in", delta);
    else if (delta < 0n) push(unit, "out", -delta);
  }
  if (rows.length === 0 && paid) push("lovelace", "self", 0n);
  return rows;
}
