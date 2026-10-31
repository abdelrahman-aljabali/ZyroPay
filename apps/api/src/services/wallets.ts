import type { ChainFamily, NetworkId, Wallet } from "@zyropay/shared";
import {
  cardanoEnterpriseAddress,
  chainFamilyOf,
  isValidAddress,
  networksForMode,
  networksOfFamily,
  normalizeAddress,
} from "@zyropay/shared";
import { servedNetworks } from "../env";
import type { TurnkeyWalletAccount } from "@zyropay/wallet";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { notFound } from "../lib/errors";
import type { WalletAddressRow, WalletRow } from "./mappers";
import { toWallet } from "./mappers";

/**
 * Mirror Turnkey wallets/accounts into wallets + wallet_addresses (idempotent upsert).
 * Accounts of unsupported formats are skipped; invalid addresses fail closed.
 */
export async function upsertWalletAccounts(
  ctx: Ctx,
  db: Db,
  userId: string,
  accounts: readonly TurnkeyWalletAccount[],
): Promise<void> {
  const now = ctx.deps.clock.now();
  const cardanoNetwork = networksForMode(ctx.deps.config.mode).find(
    (n) => chainFamilyOf(n) === "cardano",
  );
  for (const account of accounts) {
    let address: string;
    let publicKey: string | null = null;
    if (account.family === "cardano") {
      // ADR-002: Turnkey holds the Ed25519 key; the address is the enterprise address of
      // its hash on THIS deployment's Cardano network (mainnet or preprod, never both).
      publicKey = (account.publicKey ?? account.address).toLowerCase();
      if (cardanoNetwork === undefined || !/^[0-9a-f]{64}$/.test(publicKey)) {
        throw new Error("Turnkey returned an invalid Cardano public key");
      }
      address = cardanoEnterpriseAddress(publicKey, cardanoNetwork);
    } else {
      if (!isValidAddress(account.family, account.address)) {
        throw new Error(`Turnkey returned an invalid ${account.family} address`);
      }
      address = normalizeAddress(account.family, account.address);
    }
    const [existingWallet] = await db
      .select()
      .from(t.wallets)
      .where(eq(t.wallets.turnkeyWalletId, account.turnkeyWalletId));
    if (existingWallet !== undefined && existingWallet.userId !== userId) {
      throw new Error("Turnkey wallet already belongs to another user");
    }
    const walletId = existingWallet?.id ?? ctx.deps.ids.newId();
    if (existingWallet === undefined) {
      await db.insert(t.wallets).values({
        id: walletId,
        userId,
        name: account.walletName.slice(0, 64) || "Wallet",
        turnkeyWalletId: account.turnkeyWalletId,
        createdAt: now,
        updatedAt: now,
      });
    }
    const [existingAddress] = await db
      .select()
      .from(t.walletAddresses)
      .where(
        and(eq(t.walletAddresses.family, account.family), eq(t.walletAddresses.address, address)),
      );
    if (existingAddress === undefined) {
      await db.insert(t.walletAddresses).values({
        id: ctx.deps.ids.newId(),
        walletId,
        family: account.family,
        address,
        derivationPath: account.derivationPath.slice(0, 64),
        publicKey,
        createdAt: now,
      });
    } else if (existingAddress.walletId !== walletId) {
      throw new Error("address already mapped to another wallet");
    }
  }
}

/**
 * The user's LINKED wallets (and their addresses). Removed (archived) wallets are left
 * out, so every path built on this (list/get, portfolio, history, receive, sends, agent
 * policies and connections, MCP reads) treats them as non-existent. Only wallet
 * management passes `includeArchived` to find a wallet it is about to link again.
 */
export async function loadWallets(
  db: Db,
  userId: string,
  walletIds?: readonly string[],
  options: { includeArchived?: boolean } = {},
): Promise<{ wallets: WalletRow[]; addresses: WalletAddressRow[] }> {
  if (walletIds !== undefined && walletIds.length === 0) return { wallets: [], addresses: [] };
  const wallets = await db
    .select()
    .from(t.wallets)
    .where(
      and(
        eq(t.wallets.userId, userId),
        walletIds === undefined ? undefined : inArray(t.wallets.id, [...walletIds]),
        options.includeArchived === true ? undefined : isNull(t.wallets.archivedAt),
      ),
    )
    .orderBy(t.wallets.createdAt);
  const addresses =
    wallets.length === 0
      ? []
      : await db
          .select()
          .from(t.walletAddresses)
          .where(
            inArray(
              t.walletAddresses.walletId,
              wallets.map((w) => w.id),
            ),
          )
          .orderBy(t.walletAddresses.createdAt);
  return { wallets, addresses };
}

export async function listWalletsFor(
  ctx: Ctx,
  userId: string,
  subOrgId: string,
  walletIds?: readonly string[],
): Promise<Wallet[]> {
  const { wallets, addresses } = await loadWallets(ctx.deps.db, userId, walletIds);
  return wallets.map((w) => toWallet(w, addresses, subOrgId));
}

/** Ownership-checked wallet with its addresses. NOT_FOUND for other users' wallets. */
export async function getOwnedWallet(
  ctx: Ctx,
  userId: string,
  walletId: string,
): Promise<{ wallet: WalletRow; addresses: WalletAddressRow[] }> {
  const { wallets, addresses } = await loadWallets(ctx.deps.db, userId, [walletId]);
  const wallet = wallets[0];
  if (wallet === undefined) throw notFound("wallet");
  return { wallet, addresses };
}

export function addressFor(
  addresses: readonly WalletAddressRow[],
  family: ChainFamily,
): WalletAddressRow | undefined {
  return addresses.find((a) => a.family === family);
}

/** Every (wallet, network, address) triple in scope for this deployment's mode. */
export function watchedAddresses(
  ctx: Ctx,
  addresses: readonly WalletAddressRow[],
  filter: { walletIds?: readonly string[]; networks?: readonly NetworkId[] },
): { walletId: string; network: NetworkId; address: string }[] {
  // Served networks only: a deployment without a Blockfrost key omits Cardano rather than
  // failing the whole portfolio.
  const modeNetworks = servedNetworks(ctx.deps.config);
  const out: { walletId: string; network: NetworkId; address: string }[] = [];
  for (const a of addresses) {
    if (filter.walletIds !== undefined && !filter.walletIds.includes(a.walletId)) continue;
    for (const network of networksOfFamily(a.family)) {
      if (!modeNetworks.includes(network)) continue;
      if (filter.networks !== undefined && !filter.networks.includes(network)) continue;
      out.push({ walletId: a.walletId, network, address: a.address });
    }
  }
  return out;
}
