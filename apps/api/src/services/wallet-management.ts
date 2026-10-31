/*
 * Wallet management (`apiWallets`): link a wallet the app just created with the passkey,
 * rename, remove (= unlink), and read-only watch wallets.
 *
 * ADR-001: the API cannot create wallets (it holds no key for the user's sub-org). The app
 * creates the wallet with the passkey; `createWallet` only re-reads the sub-org from
 * Turnkey and links a wallet that is really there.
 *
 * Remove never touches Turnkey. It sets `wallets.archived_at`, and `loadWallets` leaves
 * archived wallets out, so every read, send, receive, agent and MCP path treats them as
 * non-existent. `syncWallets`/sign-in never un-archive; only `createWallet` does.
 *
 * Watch wallets live in their own table. No signing, send, approval, agent-policy or MCP
 * path ever reads that table, so a watch wallet id is an unknown wallet id there.
 */
import type {
  CreateWalletBody,
  CreateWatchWalletBody,
  NetworkId,
  PortfolioSnapshot,
  Wallet,
  WatchWallet,
} from "@zyropay/shared";
import {
  addressesEqual,
  assertNetworkAllowedInMode,
  chainFamilyOf,
  isPastPointOfNoReturn,
  isValidAddressForNetwork,
  NETWORKS,
  networksOfFamily,
  normalizeAddress,
  TERMINAL_STATES,
} from "@zyropay/shared";
import { and, asc, desc, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { servedNetworks } from "../env";
import { AppError, isUniqueViolation, notFound } from "../lib/errors";
import { audit } from "./audit";
import { mapTurnkeyError } from "./auth";
import { iso, toWallet } from "./mappers";
import { snapshotFor } from "./portfolio";
import type { UserPrincipal } from "./sessions";
import { withdrawRequest } from "./tx-state";
import { getOwnedWallet, loadWallets, upsertWalletAccounts } from "./wallets";

type WatchWalletRow = typeof t.watchWallets.$inferSelect;

function toWatchWallet(row: WatchWalletRow): WatchWallet {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    family: row.family,
    network: row.network,
    address: row.address,
    watchOnly: true,
    createdAt: iso(row.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Linked wallets
// ---------------------------------------------------------------------------

const CREATED_ACTION = "wallets.created";

/**
 * Idempotency for createWallet: the audit row of the first successful call carries the
 * key and the material fields. A retry with the same key returns the wallet as it is now
 * (no side effects re-applied, so a later rename is not undone); the same key with a
 * different wallet/network/name is an IDEMPOTENCY_CONFLICT.
 */
async function replayCreateWallet(
  ctx: Ctx,
  principal: UserPrincipal,
  body: CreateWalletBody,
): Promise<Wallet | null> {
  const [prior] = await ctx.deps.db
    .select({ targetId: t.auditLogs.targetId, metadata: t.auditLogs.metadata })
    .from(t.auditLogs)
    .where(
      and(
        eq(t.auditLogs.userId, principal.userId),
        eq(t.auditLogs.action, CREATED_ACTION),
        sql`${t.auditLogs.metadata} ->> 'idempotencyKey' = ${body.idempotencyKey}`,
      ),
    )
    .orderBy(desc(t.auditLogs.occurredAt))
    .limit(1);
  if (prior === undefined) return null;
  const m = prior.metadata as Record<string, unknown>;
  if (
    m.turnkeyWalletId !== body.turnkeyWalletId ||
    m.network !== body.network ||
    (m.name ?? null) !== (body.name ?? null) ||
    prior.targetId === null
  ) {
    throw new AppError("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different request");
  }
  const { wallets, addresses } = await loadWallets(ctx.deps.db, principal.userId, [prior.targetId]);
  const wallet = wallets[0];
  if (wallet === undefined) {
    throw new AppError("CONFLICT", "wallet was removed after this request; create it again");
  }
  return toWallet(wallet, addresses, principal.subOrganizationId);
}

/** Cardano is only offered where its adapter is configured (`servedNetworks`). */
function assertNetworkServed(ctx: Ctx, network: NetworkId): void {
  if (!servedNetworks(ctx.deps.config).includes(network)) {
    throw new AppError("NETWORK_NOT_SUPPORTED", `${network} is not available in this deployment`);
  }
}

export async function createWallet(
  ctx: Ctx,
  principal: UserPrincipal,
  body: CreateWalletBody,
): Promise<Wallet> {
  const { deps } = ctx;
  assertNetworkAllowedInMode(body.network, deps.config.mode);
  assertNetworkServed(ctx, body.network);
  const replayed = await replayCreateWallet(ctx, principal, body);
  if (replayed !== null) return replayed;

  // Re-read the sub-org: only a wallet that really is in the user's ZyroPay sub-org can
  // be linked (a wallet id from anywhere else is refused).
  let all;
  try {
    all = await deps.turnkey.listWalletAccounts(principal.subOrganizationId);
  } catch (error) {
    throw mapTurnkeyError(error, new AppError("UPSTREAM_UNAVAILABLE", "wallet lookup failed"));
  }
  let accounts = all.filter((a) => a.turnkeyWalletId === body.turnkeyWalletId);
  if (accounts.length === 0) {
    // ADR-003: an imported raw private key is a Turnkey private key, not an HD wallet. It
    // is linked the same way, by its id, and only if it really is in the user's sub-org.
    try {
      const keys = await deps.turnkey.listPrivateKeyAccounts(principal.subOrganizationId);
      accounts = keys.filter((a) => a.turnkeyWalletId === body.turnkeyWalletId);
    } catch (error) {
      throw mapTurnkeyError(error, new AppError("UPSTREAM_UNAVAILABLE", "wallet lookup failed"));
    }
  }
  if (accounts.length === 0) {
    throw new AppError("FORBIDDEN", "wallet is not in your ZyroPay sub-organization");
  }
  const family = chainFamilyOf(body.network);
  if (!accounts.some((a) => a.family === family)) {
    throw new AppError("NETWORK_NOT_SUPPORTED", `wallet has no ${family} account`);
  }

  const link = () =>
    deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(t.wallets)
        .where(eq(t.wallets.turnkeyWalletId, body.turnkeyWalletId))
        .for("update");
      if (existing !== undefined && existing.userId !== principal.userId) {
        throw new AppError("FORBIDDEN", "wallet is linked to another account");
      }
      await upsertWalletAccounts(ctx, tx, principal.userId, accounts);
      const [row] = await tx
        .select()
        .from(t.wallets)
        .where(eq(t.wallets.turnkeyWalletId, body.turnkeyWalletId));
      if (row === undefined) throw new Error("wallet upsert failed");
      const relinked = existing !== undefined && existing.archivedAt !== null;
      const now = deps.clock.now();
      // New wallet: Turnkey's name unless one is given. Re-linked wallet: keep its ZyroPay
      // label unless a new one is given.
      await tx
        .update(t.wallets)
        .set({ name: body.name ?? row.name, archivedAt: null, updatedAt: now })
        .where(eq(t.wallets.id, row.id));
      await audit(
        ctx,
        {
          actorType: "user",
          actorId: principal.userId,
          userId: principal.userId,
          action: CREATED_ACTION,
          targetType: "wallet",
          targetId: row.id,
          metadata: {
            idempotencyKey: body.idempotencyKey,
            turnkeyWalletId: body.turnkeyWalletId,
            network: body.network,
            name: body.name ?? null,
            accounts: accounts.length,
            relinked,
            alreadyLinked: existing !== undefined && existing.archivedAt === null,
          },
        },
        tx,
      );
      return row.id;
    });

  let walletId: string;
  try {
    walletId = await link();
  } catch (error) {
    // A concurrent create (or sign-in sync) inserted the same wallet first: run once more,
    // now against the existing row.
    if (!isUniqueViolation(error)) throw error;
    walletId = await link();
  }
  const { wallet, addresses } = await getOwnedWallet(ctx, principal.userId, walletId);
  return toWallet(wallet, addresses, principal.subOrganizationId);
}

export async function renameWallet(
  ctx: Ctx,
  principal: UserPrincipal,
  walletId: string,
  name: string,
): Promise<Wallet> {
  await getOwnedWallet(ctx, principal.userId, walletId);
  const [row] = await ctx.deps.db
    .update(t.wallets)
    .set({ name, updatedAt: ctx.deps.clock.now() })
    .where(
      and(
        eq(t.wallets.id, walletId),
        eq(t.wallets.userId, principal.userId),
        isNull(t.wallets.archivedAt),
      ),
    )
    .returning({ id: t.wallets.id });
  if (row === undefined) throw notFound("wallet");
  await audit(ctx, {
    actorType: "user",
    actorId: principal.userId,
    userId: principal.userId,
    action: "wallets.renamed",
    targetType: "wallet",
    targetId: walletId,
  });
  const { wallet, addresses } = await getOwnedWallet(ctx, principal.userId, walletId);
  return toWallet(wallet, addresses, principal.subOrganizationId);
}

/**
 * Unlink (archive) a wallet. Refused with CONFLICT while it is the user's last linked
 * wallet, while a non-revoked agent's policy lists it, or while a request for it is in
 * flight. Pre-signing requests whose deadline already passed are expired here (the same
 * lazy expiry the approval paths apply) instead of blocking the removal.
 */
export async function removeWallet(
  ctx: Ctx,
  principal: UserPrincipal,
  walletId: string,
): Promise<void> {
  const { deps } = ctx;
  const userId = principal.userId;
  await deps.db.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(t.wallets)
      .where(
        and(eq(t.wallets.id, walletId), eq(t.wallets.userId, userId), isNull(t.wallets.archivedAt)),
      )
      .for("update");
    if (wallet === undefined) throw notFound("wallet");

    const [other] = await tx
      .select({ id: t.wallets.id })
      .from(t.wallets)
      .where(
        and(eq(t.wallets.userId, userId), ne(t.wallets.id, walletId), isNull(t.wallets.archivedAt)),
      )
      .limit(1);
    if (other === undefined) {
      throw new AppError("CONFLICT", "you can't remove your only wallet", {
        reason: "last_wallet",
      });
    }

    const [agent] = await tx
      .select({ id: t.agents.id })
      .from(t.agents)
      .innerJoin(t.agentPolicies, eq(t.agentPolicies.agentId, t.agents.id))
      .where(
        and(
          eq(t.agents.userId, userId),
          isNull(t.agents.revokedAt),
          eq(t.agentPolicies.revoked, false),
          sql`${t.agentPolicies.allowedWalletIds} @> ${JSON.stringify([walletId])}::jsonb`,
        ),
      )
      .limit(1);
    if (agent !== undefined) {
      throw new AppError(
        "CONFLICT",
        "an agent can use this wallet; remove it from the agent first",
        {
          reason: "agent_access",
          agentId: agent.id,
        },
      );
    }

    const now = deps.clock.now();
    const open = await tx
      .select()
      .from(t.transactionRequests)
      .where(
        and(
          eq(t.transactionRequests.walletId, walletId),
          notInArray(t.transactionRequests.state, [...TERMINAL_STATES]),
        ),
      )
      .orderBy(asc(t.transactionRequests.createdAt))
      .for("update");
    let inFlight = 0;
    for (const row of open) {
      if (!isPastPointOfNoReturn(row.state) && row.expiresAt <= now) {
        await withdrawRequest(tx, row, "EXPIRE", now, "expired");
      } else {
        inFlight++;
      }
    }
    if (inFlight > 0) {
      throw new AppError("CONFLICT", "a transaction for this wallet is still in progress", {
        reason: "request_in_flight",
      });
    }

    await tx
      .update(t.wallets)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(t.wallets.id, walletId));
    await audit(
      ctx,
      {
        actorType: "user",
        actorId: userId,
        userId,
        action: "wallets.removed",
        targetType: "wallet",
        targetId: walletId,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Watch wallets
// ---------------------------------------------------------------------------

async function loadOwnedWatchWallet(
  ctx: Ctx,
  userId: string,
  watchWalletId: string,
): Promise<WatchWalletRow> {
  const [row] = await ctx.deps.db
    .select()
    .from(t.watchWallets)
    .where(
      and(
        eq(t.watchWallets.id, watchWalletId),
        eq(t.watchWallets.userId, userId),
        isNull(t.watchWallets.removedAt),
      ),
    );
  if (row === undefined) throw notFound("watch wallet");
  return row;
}

export async function listWatchWallets(ctx: Ctx, userId: string): Promise<WatchWallet[]> {
  const rows = await ctx.deps.db
    .select()
    .from(t.watchWallets)
    .where(and(eq(t.watchWallets.userId, userId), isNull(t.watchWallets.removedAt)))
    .orderBy(asc(t.watchWallets.createdAt), asc(t.watchWallets.id));
  return rows.map(toWatchWallet);
}

async function watchByKey(
  ctx: Ctx,
  userId: string,
  key: string,
): Promise<WatchWalletRow | undefined> {
  const [row] = await ctx.deps.db
    .select()
    .from(t.watchWallets)
    .where(and(eq(t.watchWallets.userId, userId), eq(t.watchWallets.idempotencyKey, key)));
  return row;
}

function replayWatch(
  row: WatchWalletRow,
  input: { network: NetworkId; address: string },
): WatchWallet {
  if (row.network !== input.network || row.address !== input.address) {
    throw new AppError("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different request");
  }
  if (row.removedAt !== null) {
    throw new AppError("CONFLICT", "watch wallet was removed after this request; add it again");
  }
  return toWatchWallet(row);
}

/**
 * Watch an address. Re-adding an address that was removed earlier creates a fresh row
 * (removed rows stay as history; the partial unique index only covers live rows).
 */
export async function createWatchWallet(
  ctx: Ctx,
  userId: string,
  body: CreateWatchWalletBody,
): Promise<WatchWallet> {
  const { deps } = ctx;
  assertNetworkAllowedInMode(body.network, deps.config.mode);
  assertNetworkServed(ctx, body.network);
  const family = chainFamilyOf(body.network);
  // Cardano: a Shelley payment address with a key credential of this network (CIP-19).
  if (!isValidAddressForNetwork(body.network, body.address)) {
    throw new AppError(
      "INVALID_ADDRESS",
      `not a valid ${NETWORKS[body.network].displayName} address`,
    );
  }
  const address = normalizeAddress(family, body.address);

  const prior = await watchByKey(ctx, userId, body.idempotencyKey);
  if (prior !== undefined) return replayWatch(prior, { network: body.network, address });

  const { addresses } = await loadWallets(deps.db, userId);
  if (addresses.some((a) => a.family === family && addressesEqual(family, a.address, address))) {
    throw new AppError("CONFLICT", "this address is one of your own wallets", {
      reason: "own_wallet",
    });
  }
  const alreadyWatched = new AppError("CONFLICT", "you are already watching this address", {
    reason: "already_watched",
  });
  const [live] = await deps.db
    .select({ id: t.watchWallets.id })
    .from(t.watchWallets)
    .where(
      and(
        eq(t.watchWallets.userId, userId),
        eq(t.watchWallets.family, family),
        eq(t.watchWallets.address, address),
        isNull(t.watchWallets.removedAt),
      ),
    );
  if (live !== undefined) throw alreadyWatched;

  const now = deps.clock.now();
  try {
    const row = await deps.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(t.watchWallets)
        .values({
          id: deps.ids.newId(),
          userId,
          name: body.name ?? `Watched ${NETWORKS[body.network].displayName}`,
          family,
          network: body.network,
          address,
          idempotencyKey: body.idempotencyKey,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (inserted === undefined) throw new Error("insert failed");
      await audit(
        ctx,
        {
          actorType: "user",
          actorId: userId,
          userId,
          action: "watch_wallets.created",
          targetType: "watch_wallet",
          targetId: inserted.id,
          metadata: { network: body.network, family },
        },
        tx,
      );
      return inserted;
    });
    return toWatchWallet(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost a race: either the same request (same key) or the same address.
    const winner = await watchByKey(ctx, userId, body.idempotencyKey);
    if (winner !== undefined) return replayWatch(winner, { network: body.network, address });
    throw alreadyWatched;
  }
}

export async function renameWatchWallet(
  ctx: Ctx,
  userId: string,
  watchWalletId: string,
  name: string,
): Promise<WatchWallet> {
  await loadOwnedWatchWallet(ctx, userId, watchWalletId);
  const [row] = await ctx.deps.db
    .update(t.watchWallets)
    .set({ name, updatedAt: ctx.deps.clock.now() })
    .where(
      and(
        eq(t.watchWallets.id, watchWalletId),
        eq(t.watchWallets.userId, userId),
        isNull(t.watchWallets.removedAt),
      ),
    )
    .returning();
  if (row === undefined) throw notFound("watch wallet");
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "watch_wallets.renamed",
    targetType: "watch_wallet",
    targetId: watchWalletId,
  });
  return toWatchWallet(row);
}

export async function removeWatchWallet(
  ctx: Ctx,
  userId: string,
  watchWalletId: string,
): Promise<void> {
  const now = ctx.deps.clock.now();
  const [row] = await ctx.deps.db
    .update(t.watchWallets)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(t.watchWallets.id, watchWalletId),
        eq(t.watchWallets.userId, userId),
        isNull(t.watchWallets.removedAt),
      ),
    )
    .returning({ id: t.watchWallets.id });
  if (row === undefined) throw notFound("watch wallet");
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "watch_wallets.removed",
    targetType: "watch_wallet",
    targetId: watchWalletId,
  });
}

/** Balances of one watch address on every network of its family in the build's mode. */
export async function getWatchWalletPortfolio(
  ctx: Ctx,
  userId: string,
  watchWalletId: string,
  currency: string,
): Promise<PortfolioSnapshot> {
  const row = await loadOwnedWatchWallet(ctx, userId, watchWalletId);
  // Served networks only: a deployment without a Blockfrost key shows no Cardano balances
  // instead of failing the snapshot.
  const served = servedNetworks(ctx.deps.config);
  const addresses = networksOfFamily(row.family)
    .filter((n) => served.includes(n))
    .map((network) => ({ walletId: row.id, network, address: row.address }));
  return snapshotFor(ctx, addresses, currency);
}
