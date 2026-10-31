import type { NetworkId, PortfolioSnapshot, Transaction, WatchedAddress } from "@zyropay/shared";
import {
  assertNetworkAllowedInMode,
  chainFamilyOf,
  evmChainId,
  isTestnet,
  NETWORKS,
  sha256Hex,
} from "@zyropay/shared";
import { bytesToBase64Url, base64UrlToBytes } from "@zyropay/wallet";
import { z } from "zod";
import type { Ctx } from "../deps";
import { servedNetworks } from "../env";
import { AppError, notFound } from "../lib/errors";
import { addressFor, getOwnedWallet, loadWallets, watchedAddresses } from "./wallets";

interface Scope {
  readonly walletIds?: readonly string[];
  readonly networks?: readonly NetworkId[];
}

async function watched(ctx: Ctx, userId: string, scope: Scope): Promise<WatchedAddress[]> {
  for (const n of scope.networks ?? []) assertNetworkAllowedInMode(n, ctx.deps.config.mode);
  const { addresses } = await loadWallets(ctx.deps.db, userId, scope.walletIds);
  return watchedAddresses(ctx, addresses, scope);
}

function emptySnapshot(ctx: Ctx, currency: string): PortfolioSnapshot {
  return {
    asOf: ctx.deps.clock.now().toISOString(),
    stale: false,
    currency,
    totalValue: { value: "0", currency },
    unpricedAssetCount: 0,
    networks: [],
    balances: [],
    simulated: ctx.deps.config.useMocks,
  };
}

export async function getPortfolio(
  ctx: Ctx,
  userId: string,
  scope: Scope,
  currency: string,
): Promise<PortfolioSnapshot> {
  return snapshotFor(ctx, await watched(ctx, userId, scope), currency);
}

/**
 * Balances for exactly these (walletId, network, address) triples through the portfolio
 * provider, with the simulated-data guard and the scope filter. Shared by the user's
 * portfolio and the read-only watch-wallet portfolio.
 */
export async function snapshotFor(
  ctx: Ctx,
  addresses: readonly WatchedAddress[],
  currency: string,
): Promise<PortfolioSnapshot> {
  if (addresses.length === 0) return emptySnapshot(ctx, currency);
  let snapshot: PortfolioSnapshot;
  try {
    snapshot = await ctx.deps.portfolio.getSnapshot({ addresses, currency });
  } catch (error) {
    ctx.deps.logger.warn("portfolio.failed", { error });
    throw new AppError("UPSTREAM_UNAVAILABLE", "portfolio provider unavailable");
  }
  if (snapshot.simulated && !ctx.deps.config.useMocks)
    throw new AppError("UPSTREAM_UNAVAILABLE", "simulated data refused");
  // Defence in depth: never return balances outside the requested scope.
  const allowed = new Set(addresses.map((a) => `${a.walletId}|${a.network}|${a.address}`));
  return {
    ...snapshot,
    balances: snapshot.balances.filter((b) =>
      allowed.has(`${b.walletId}|${b.network}|${b.address}`),
    ),
  };
}

/** Compound cursor: per-address provider cursor + items already consumed from that page. */
const CursorSchema = z.record(
  z.string(),
  z.object({ c: z.string().nullable(), s: z.number().int().min(0).max(100), done: z.boolean() }),
);
type CursorState = z.infer<typeof CursorSchema>;

function encodeCursor(state: CursorState): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(state)));
}
function decodeCursor(cursor: string): CursorState {
  try {
    return CursorSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlToBytes(cursor))));
  } catch {
    throw new AppError("BAD_REQUEST", "invalid cursor");
  }
}

export async function listTransactions(
  ctx: Ctx,
  userId: string,
  scope: Scope,
  limit: number,
  cursor: string | undefined,
): Promise<{ transactions: Transaction[]; nextCursor: string | null }> {
  const addresses = await watched(ctx, userId, scope);
  const state: CursorState = cursor === undefined ? {} : decodeCursor(cursor);
  // Short, opaque per-address keys: the compound cursor must stay under CursorSchema's 512
  // characters even with long (Cardano, up to 108-char) addresses in scope.
  const key = (a: WatchedAddress) =>
    sha256Hex(`${a.walletId}|${a.network}|${a.address}`).slice(0, 16);
  const pages: {
    key: string;
    items: Transaction[];
    next: string | null;
    skip: number;
    cursorUsed: string | null;
  }[] = [];
  for (const a of addresses) {
    const st = state[key(a)] ?? { c: null, s: 0, done: false };
    if (st.done) continue;
    let page;
    try {
      page = await ctx.deps.portfolio.getTransactions({
        address: a,
        limit,
        ...(st.c === null ? {} : { cursor: st.c }),
      });
    } catch {
      throw new AppError("UPSTREAM_UNAVAILABLE", "transaction history unavailable");
    }
    if (page.simulated && !ctx.deps.config.useMocks)
      throw new AppError("UPSTREAM_UNAVAILABLE", "simulated data refused");
    const items = page.transactions
      .filter((tx) => tx.walletId === a.walletId && tx.network === a.network)
      .slice(st.s);
    pages.push({ key: key(a), items, next: page.nextCursor, skip: st.s, cursorUsed: st.c });
  }
  const merged = pages
    .flatMap((p) => p.items.map((tx) => ({ tx, key: p.key })))
    .sort((x, y) =>
      x.tx.timestamp < y.tx.timestamp
        ? 1
        : x.tx.timestamp > y.tx.timestamp
          ? -1
          : x.tx.id.localeCompare(y.tx.id),
    );
  const taken = merged.slice(0, limit);
  const nextState: CursorState = { ...state };
  let more = false;
  for (const p of pages) {
    const consumed = taken.filter((x) => x.key === p.key).length;
    if (consumed < p.items.length) {
      nextState[p.key] = { c: p.cursorUsed, s: p.skip + consumed, done: false };
      more = true;
    } else if (p.next !== null) {
      nextState[p.key] = { c: p.next, s: 0, done: false };
      more = true;
    } else {
      nextState[p.key] = { c: null, s: 0, done: true };
    }
  }
  return {
    transactions: taken.map((x) => x.tx),
    nextCursor: more ? encodeCursor(nextState) : null,
  };
}

/** History is provider-backed (no local table): scan recent pages of the user's addresses. */
export async function getTransaction(
  ctx: Ctx,
  userId: string,
  transactionId: string,
): Promise<Transaction> {
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = await listTransactions(ctx, userId, {}, 100, cursor);
    const found = page.transactions.find((tx) => tx.id === transactionId);
    if (found !== undefined) return found;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  throw notFound("transaction");
}

export async function getReceiveInfo(
  ctx: Ctx,
  userId: string,
  walletId: string,
  network: NetworkId,
) {
  assertNetworkAllowedInMode(network, ctx.deps.config.mode);
  if (!servedNetworks(ctx.deps.config).includes(network))
    throw new AppError("NETWORK_NOT_SUPPORTED", `${network} is not available in this deployment`);
  const { addresses } = await getOwnedWallet(ctx, userId, walletId);
  const row = addressFor(addresses, chainFamilyOf(network));
  if (row === undefined)
    throw new AppError("NETWORK_NOT_SUPPORTED", `wallet has no ${chainFamilyOf(network)} address`);
  const family = chainFamilyOf(network);
  const qrPayload =
    family === "solana"
      ? `solana:${row.address}`
      : family === "cardano"
        ? `web+cardano:${row.address}` // CIP-13
        : `ethereum:${row.address}@${evmChainId(network)}`;
  const warnings: string[] = [];
  if (isTestnet(network))
    warnings.push(`${NETWORKS[network].displayName} is a test network. Do not send real funds.`);
  if (family === "evm")
    warnings.push(`Only send assets on ${NETWORKS[network].displayName} to this address.`);
  if (family === "cardano") {
    warnings.push(
      `Only send ADA or Cardano native tokens on ${NETWORKS[network].displayName} to this address.`,
    );
    warnings.push(
      "This Cardano address has no staking part: ADA held here does not earn staking rewards.",
    );
  }
  return { network, address: row.address, qrPayload, isTestnet: isTestnet(network), warnings };
}
