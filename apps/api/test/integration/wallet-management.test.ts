/*
 * Wallet management (`apiWallets`): link a passkey-created wallet, rename, remove
 * (unlink, never delete keys), and read-only watch wallets.
 */
import { cardanoEnterpriseAddress, sha256Hex, toChecksumAddress } from "@zyropay/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, setPolicy, signUp } from "../helpers";

const key = (label: string) => `${label}-${sha256Hex(String(Math.random())).slice(0, 16)}`;

async function linkWallet(
  h: Harness,
  user: TestUser,
  body: Record<string, unknown>,
  idempotencyKey = key("create"),
) {
  return call(h, "POST", "/v1/wallets", {
    token: user.accessToken,
    body: { idempotencyKey, ...body },
    idempotencyKey,
  });
}

async function auditActions(h: Harness, userId: string): Promise<string[]> {
  const rows = await h.db
    .select({ action: t.auditLogs.action })
    .from(t.auditLogs)
    .where(eq(t.auditLogs.userId, userId));
  return rows.map((r) => r.action);
}

describe("createWallet", () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h, "creator");
  });

  it("links a wallet from the user's sub-org (only that wallet's accounts), audited", async () => {
    const created = h.turnkey.createWallet(user.organizationId, { name: "Turnkey name" });
    const other = h.turnkey.createWallet(user.organizationId);
    const res = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "solana-devnet",
    });
    expect(res.status).toBe(200);
    const wallet = res.json.wallet;
    expect(wallet.name).toBe("Turnkey name");
    expect(wallet.turnkeyWalletId).toBe(created.turnkeyWalletId);
    expect(wallet.turnkeySubOrganizationId).toBe(user.organizationId);
    expect(wallet.addresses.map((a: { address: string }) => a.address).sort()).toEqual(
      [created.solana, created.evm].sort(),
    );
    const list = await call(h, "GET", "/v1/wallets", { token: user.accessToken });
    const ids = list.json.wallets.map((w: { turnkeyWalletId: string }) => w.turnkeyWalletId);
    expect(ids).toContain(created.turnkeyWalletId);
    // Only the requested wallet was linked, not every new wallet of the sub-org.
    expect(ids).not.toContain(other.turnkeyWalletId);
    expect(await auditActions(h, user.userId)).toContain("wallets.created");
  });

  it("applies a given name (trimmed)", async () => {
    const created = h.turnkey.createWallet(user.organizationId);
    const res = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "base-sepolia",
      name: "  Savings  ",
    });
    expect(res.status).toBe(200);
    expect(res.json.wallet.name).toBe("Savings");
  });

  it("idempotent: same key returns the same wallet and does not undo a later rename", async () => {
    const created = h.turnkey.createWallet(user.organizationId);
    const idem = key("replay");
    const body = { turnkeyWalletId: created.turnkeyWalletId, network: "solana-devnet" };
    const first = await linkWallet(h, user, body, idem);
    expect(first.status).toBe(200);
    const renamed = await call(h, "PATCH", `/v1/wallets/${first.json.wallet.id}`, {
      token: user.accessToken,
      body: { name: "Renamed" },
    });
    expect(renamed.status).toBe(200);
    const again = await linkWallet(h, user, body, idem);
    expect(again.status).toBe(200);
    expect(again.json.wallet.id).toBe(first.json.wallet.id);
    expect(again.json.wallet.name).toBe("Renamed");
    const audits = (await auditActions(h, user.userId)).filter((a) => a === "wallets.created");
    // A replay writes no second audit row.
    const conflict = await linkWallet(
      h,
      user,
      {
        turnkeyWalletId: h.turnkey.createWallet(user.organizationId).turnkeyWalletId,
        network: "solana-devnet",
      },
      idem,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await auditActions(h, user.userId)).filter((a) => a === "wallets.created")).toEqual(
      audits,
    );
  });

  it("requires a matching Idempotency-Key header", async () => {
    const created = h.turnkey.createWallet(user.organizationId);
    const missing = await call(h, "POST", "/v1/wallets", {
      token: user.accessToken,
      body: {
        turnkeyWalletId: created.turnkeyWalletId,
        network: "solana-devnet",
        idempotencyKey: key("k"),
      },
    });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe("BAD_REQUEST");
    const mismatch = await call(h, "POST", "/v1/wallets", {
      token: user.accessToken,
      body: {
        turnkeyWalletId: created.turnkeyWalletId,
        network: "solana-devnet",
        idempotencyKey: key("a"),
      },
      idempotencyKey: key("b"),
    });
    expect(mismatch.status).toBe(400);
  });

  it("FORBIDDEN for a wallet that is not in the user's sub-org", async () => {
    const stranger = h.turnkey.createSubOrg({ credentialId: `stranger-${Math.random()}` });
    const foreign = h.turnkey.createWallet(stranger.organizationId);
    for (const turnkeyWalletId of [foreign.turnkeyWalletId, "mock-wallet-does-not-exist"]) {
      const res = await linkWallet(h, user, { turnkeyWalletId, network: "solana-devnet" });
      expect(res.status, turnkeyWalletId).toBe(403);
      expect(res.json.error.code).toBe("FORBIDDEN");
    }
    const [row] = await h.db
      .select()
      .from(t.wallets)
      .where(eq(t.wallets.turnkeyWalletId, foreign.turnkeyWalletId));
    expect(row).toBeUndefined();
  });

  it("refuses a network outside the build's mode, and a wallet without that family", async () => {
    const created = h.turnkey.createWallet(user.organizationId, { families: ["solana"] });
    const mainnet = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "solana-mainnet",
    });
    expect(mainnet.status).toBe(400);
    expect(mainnet.json.error.code).toBe("NETWORK_MODE_MISMATCH");
    const noEvm = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "base-sepolia",
    });
    expect(noEvm.status).toBe(400);
    expect(noEvm.json.error.code).toBe("NETWORK_NOT_SUPPORTED");
  });

  it("validates the body (name, network, wallet id)", async () => {
    const created = h.turnkey.createWallet(user.organizationId);
    for (const bad of [
      { turnkeyWalletId: created.turnkeyWalletId, network: "solana-devnet", name: "   " },
      { turnkeyWalletId: created.turnkeyWalletId, network: "solana-devnet", name: "bad\u0007" },
      { turnkeyWalletId: created.turnkeyWalletId, network: "solana-devnet", name: "x".repeat(65) },
      { turnkeyWalletId: created.turnkeyWalletId, network: "dogecoin" },
      { turnkeyWalletId: "", network: "solana-devnet" },
    ]) {
      const res = await linkWallet(h, user, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.json.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("requires a session", async () => {
    const res = await call(h, "POST", "/v1/wallets", {
      body: { turnkeyWalletId: "x", network: "solana-devnet", idempotencyKey: key("k") },
      idempotencyKey: key("k"),
    });
    expect(res.status).toBe(401);
  });
});

describe("renameWallet / removeWallet", () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h, "remover");
  });

  async function secondWallet(): Promise<{ id: string; turnkeyWalletId: string; solana: string }> {
    const created = h.turnkey.createWallet(user.organizationId);
    const res = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "solana-devnet",
    });
    expect(res.status).toBe(200);
    return {
      id: res.json.wallet.id,
      turnkeyWalletId: created.turnkeyWalletId,
      solana: created.solana!,
    };
  }

  it("renames (validated, audited)", async () => {
    const res = await call(h, "PATCH", `/v1/wallets/${user.walletId}`, {
      token: user.accessToken,
      body: { name: " Main " },
    });
    expect(res.status).toBe(200);
    expect(res.json.wallet.name).toBe("Main");
    const bad = await call(h, "PATCH", `/v1/wallets/${user.walletId}`, {
      token: user.accessToken,
      body: { name: "" },
    });
    expect(bad.status).toBe(422);
    const unknown = await call(h, "PATCH", "/v1/wallets/00000000-0000-4000-8000-000000000000", {
      token: user.accessToken,
      body: { name: "x" },
    });
    expect(unknown.status).toBe(404);
    expect(await auditActions(h, user.userId)).toContain("wallets.renamed");
  });

  it("CONFLICT when removing the last linked wallet", async () => {
    const res = await call(h, "DELETE", `/v1/wallets/${user.walletId}`, {
      token: user.accessToken,
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("CONFLICT");
    expect(res.json.error.details.reason).toBe("last_wallet");
  });

  it("CONFLICT while a non-revoked agent can use it; allowed after the agent is revoked", async () => {
    const extra = await secondWallet();
    const agentId = await connectAgent(h, user);
    await setPolicy(h, user, agentId, { allowedWalletIds: [user.walletId, extra.id] });
    const blocked = await call(h, "DELETE", `/v1/wallets/${extra.id}`, {
      token: user.accessToken,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.reason).toBe("agent_access");
    const revoked = await call(h, "DELETE", `/v1/agents/${agentId}`, { token: user.accessToken });
    expect(revoked.status).toBe(200);
    const ok = await call(h, "DELETE", `/v1/wallets/${extra.id}`, { token: user.accessToken });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
  });

  it("CONFLICT while a request for it is in flight; an expired quote no longer blocks", async () => {
    const extra = await secondWallet();
    const idem = key("quote");
    const quote = await call(h, "POST", "/v1/send/quote", {
      token: user.accessToken,
      body: {
        walletId: extra.id,
        network: "solana-devnet",
        to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        assetId: "solana-devnet:native",
        amount: "1000",
        decimals: 9,
        idempotencyKey: idem,
      },
      idempotencyKey: idem,
    });
    expect(quote.status).toBe(200);
    const requestId = quote.json.review.request.id;
    const blocked = await call(h, "DELETE", `/v1/wallets/${extra.id}`, {
      token: user.accessToken,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.reason).toBe("request_in_flight");

    h.clock.advance(60 * 60 * 1000);
    const ok = await call(h, "DELETE", `/v1/wallets/${extra.id}`, { token: user.accessToken });
    expect(ok.status).toBe(200);
    const [row] = await h.db
      .select()
      .from(t.transactionRequests)
      .where(eq(t.transactionRequests.id, requestId));
    expect(row?.state).toBe("EXPIRED");
  });

  it("a removed wallet is invisible and unusable everywhere; sync does not bring it back", async () => {
    const extra = await secondWallet();
    const removed = await call(h, "DELETE", `/v1/wallets/${extra.id}`, {
      token: user.accessToken,
    });
    expect(removed.status).toBe(200);
    expect(await auditActions(h, user.userId)).toContain("wallets.removed");
    // Keys are never touched: the wallet is still in the Turnkey sub-org.
    const accounts = await h.turnkey.listWalletAccounts(user.organizationId);
    expect(accounts.some((a) => a.turnkeyWalletId === extra.turnkeyWalletId)).toBe(true);

    const asUser = { token: user.accessToken };
    const list = await call(h, "GET", "/v1/wallets", asUser);
    expect(list.json.wallets.map((w: { id: string }) => w.id)).not.toContain(extra.id);
    for (const path of [
      `/v1/wallets/${extra.id}`,
      `/v1/portfolio?walletId=${extra.id}`,
      `/v1/transactions?walletId=${extra.id}`,
      `/v1/receive?walletId=${extra.id}&network=solana-devnet`,
    ]) {
      const res = await call(h, "GET", path, asUser);
      expect(res.status, path).toBe(404);
    }
    const portfolio = await call(h, "GET", "/v1/portfolio", asUser);
    expect(portfolio.status).toBe(200);
    expect(
      portfolio.json.portfolio.balances.some((b: { walletId: string }) => b.walletId === extra.id),
    ).toBe(false);
    expect(JSON.stringify(portfolio.json)).not.toContain(extra.solana);
    const rename = await call(h, "PATCH", `/v1/wallets/${extra.id}`, {
      ...asUser,
      body: { name: "x" },
    });
    expect(rename.status).toBe(404);
    const again = await call(h, "DELETE", `/v1/wallets/${extra.id}`, asUser);
    expect(again.status).toBe(404);
    const idem = key("q");
    const quote = await call(h, "POST", "/v1/send/quote", {
      ...asUser,
      body: {
        walletId: extra.id,
        network: "solana-devnet",
        to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        assetId: "solana-devnet:native",
        amount: "1000",
        decimals: 9,
        idempotencyKey: idem,
      },
      idempotencyKey: idem,
    });
    expect(quote.status).toBe(404);

    // Agents cannot be given a removed wallet.
    const agentId = await connectAgent(h, user);
    const current = await call(h, "GET", `/v1/agents/${agentId}/policy`, asUser);
    const { version, revoked: _r, ...policy } = current.json.policy;
    const put = await call(h, "PUT", `/v1/agents/${agentId}/policy`, {
      ...asUser,
      body: { expectedVersion: version, policy: { ...policy, allowedWalletIds: [extra.id] } },
    });
    expect(put.status).toBe(400);

    const synced = await call(h, "POST", "/v1/wallets/sync", asUser);
    expect(synced.status).toBe(200);
    expect(synced.json.wallets.map((w: { id: string }) => w.id)).not.toContain(extra.id);
    const [row] = await h.db.select().from(t.wallets).where(eq(t.wallets.id, extra.id));
    expect(row?.archivedAt).not.toBeNull();
    await call(h, "DELETE", `/v1/agents/${agentId}`, asUser);
  });

  it("creating a removed wallet again links it back (same id)", async () => {
    const extra = await secondWallet();
    expect(
      (await call(h, "DELETE", `/v1/wallets/${extra.id}`, { token: user.accessToken })).status,
    ).toBe(200);
    const relinked = await linkWallet(h, user, {
      turnkeyWalletId: extra.turnkeyWalletId,
      network: "solana-devnet",
      name: "Back again",
    });
    expect(relinked.status).toBe(200);
    expect(relinked.json.wallet.id).toBe(extra.id);
    expect(relinked.json.wallet.name).toBe("Back again");
    const get = await call(h, "GET", `/v1/wallets/${extra.id}`, { token: user.accessToken });
    expect(get.status).toBe(200);
    const [audit] = await h.db
      .select({ metadata: t.auditLogs.metadata })
      .from(t.auditLogs)
      .where(and(eq(t.auditLogs.action, "wallets.created"), eq(t.auditLogs.targetId, extra.id)))
      .orderBy(t.auditLogs.occurredAt);
    expect(audit).toBeDefined();
  });
});

describe("watch wallets", () => {
  let h: Harness;
  let user: TestUser;
  const EVM = "0x52908400098527886e0f7030069857d2e4169ee7";
  const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h, "watcher");
  });

  const watch = (body: Record<string, unknown>, idempotencyKey = key("watch")) =>
    call(h, "POST", "/v1/watch-wallets", {
      token: user.accessToken,
      body: { idempotencyKey, ...body },
      idempotencyKey,
    });

  it("creates (canonical address, default name), lists oldest first, audited", async () => {
    const evm = await watch({ network: "base-sepolia", address: ` ${EVM} ` });
    expect(evm.status).toBe(200);
    expect(evm.json.watchWallet).toMatchObject({
      name: "Watched Base Sepolia",
      family: "evm",
      network: "base-sepolia",
      address: toChecksumAddress(EVM),
      watchOnly: true,
      userId: user.userId,
    });
    h.clock.advance(1000);
    const sol = await watch({ network: "solana-devnet", address: SOL, name: "Cold storage" });
    expect(sol.status).toBe(200);
    expect(sol.json.watchWallet.name).toBe("Cold storage");
    const list = await call(h, "GET", "/v1/watch-wallets", { token: user.accessToken });
    expect(list.status).toBe(200);
    expect(list.json.watchWallets.map((w: { id: string }) => w.id)).toEqual([
      evm.json.watchWallet.id,
      sol.json.watchWallet.id,
    ]);
    expect(await auditActions(h, user.userId)).toContain("watch_wallets.created");
    // Not part of the user's wallets or main portfolio.
    const wallets = await call(h, "GET", "/v1/wallets", { token: user.accessToken });
    expect(JSON.stringify(wallets.json)).not.toContain(SOL);
    const portfolio = await call(h, "GET", "/v1/portfolio", { token: user.accessToken });
    expect(JSON.stringify(portfolio.json)).not.toContain(SOL);
  });

  it("CONFLICT for the same address twice (any case) and for the user's own address", async () => {
    const dup = await watch({
      network: "ethereum-sepolia",
      address: EVM.toUpperCase().replace("0X", "0x"),
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.reason).toBe("already_watched");
    const own = await watch({ network: "solana-devnet", address: user.solana });
    expect(own.status).toBe(409);
    expect(own.json.error.details.reason).toBe("own_wallet");
  });

  it("idempotent replay returns the same row; same key for another address conflicts", async () => {
    const idem = key("w");
    const addr = "0x000000000000000000000000000000000000dEaD";
    const first = await watch({ network: "base-sepolia", address: addr }, idem);
    expect(first.status).toBe(200);
    const again = await watch({ network: "base-sepolia", address: addr.toLowerCase() }, idem);
    expect(again.status).toBe(200);
    expect(again.json.watchWallet.id).toBe(first.json.watchWallet.id);
    const other = await watch(
      { network: "base-sepolia", address: "0x1111111111111111111111111111111111111111" },
      idem,
    );
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("validates address, network mode and name", async () => {
    const badAddr = await watch({ network: "base-sepolia", address: "0x1234" });
    expect(badAddr.status).toBe(422);
    expect(badAddr.json.error.code).toBe("INVALID_ADDRESS");
    const wrongFamily = await watch({ network: "solana-devnet", address: EVM });
    expect(wrongFamily.json.error.code).toBe("INVALID_ADDRESS");
    const mainnet = await watch({ network: "base-mainnet", address: EVM });
    expect(mainnet.status).toBe(400);
    expect(mainnet.json.error.code).toBe("NETWORK_MODE_MISMATCH");
    const badName = await watch({ network: "base-sepolia", address: EVM, name: "\u0000" });
    expect(badName.status).toBe(422);
    const noHeader = await call(h, "POST", "/v1/watch-wallets", {
      token: user.accessToken,
      body: { network: "base-sepolia", address: EVM, idempotencyKey: key("x") },
    });
    expect(noHeader.status).toBe(400);
  });

  it("portfolio covers every network of the family in the mode, keyed by the watch id", async () => {
    const list = await call(h, "GET", "/v1/watch-wallets", { token: user.accessToken });
    const evm = list.json.watchWallets.find((w: { family: string }) => w.family === "evm");
    const res = await call(h, "GET", `/v1/watch-wallets/${evm.id}/portfolio`, {
      token: user.accessToken,
    });
    expect(res.status).toBe(200);
    const p = res.json.portfolio;
    expect([...p.networks].sort()).toEqual(["base-sepolia", "ethereum-sepolia"]);
    expect(p.balances.length).toBeGreaterThan(0);
    for (const b of p.balances) {
      expect(b.walletId).toBe(evm.id);
      expect(b.address).toBe(evm.address);
    }
    const unknown = await call(
      h,
      "GET",
      "/v1/watch-wallets/00000000-0000-4000-8000-000000000000/portfolio",
      { token: user.accessToken },
    );
    expect(unknown.status).toBe(404);
  });

  it("renames and removes (audited); re-adding a removed address creates a fresh row", async () => {
    const list = await call(h, "GET", "/v1/watch-wallets", { token: user.accessToken });
    const sol = list.json.watchWallets.find((w: { family: string }) => w.family === "solana");
    const renamed = await call(h, "PATCH", `/v1/watch-wallets/${sol.id}`, {
      token: user.accessToken,
      body: { name: "Treasury" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.watchWallet.name).toBe("Treasury");
    const bad = await call(h, "PATCH", `/v1/watch-wallets/${sol.id}`, {
      token: user.accessToken,
      body: { name: "" },
    });
    expect(bad.status).toBe(422);

    const removed = await call(h, "DELETE", `/v1/watch-wallets/${sol.id}`, {
      token: user.accessToken,
    });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ ok: true });
    const after = await call(h, "GET", "/v1/watch-wallets", { token: user.accessToken });
    expect(after.json.watchWallets.map((w: { id: string }) => w.id)).not.toContain(sol.id);
    for (const [method, path, body] of [
      ["GET", `/v1/watch-wallets/${sol.id}/portfolio`],
      ["PATCH", `/v1/watch-wallets/${sol.id}`, { name: "x" }],
      ["DELETE", `/v1/watch-wallets/${sol.id}`],
    ] as const) {
      const res = await call(h, method, path, {
        token: user.accessToken,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const actions = await auditActions(h, user.userId);
    expect(actions).toEqual(
      expect.arrayContaining(["watch_wallets.renamed", "watch_wallets.removed"]),
    );

    const readded = await watch({ network: "solana-devnet", address: SOL });
    expect(readded.status).toBe(200);
    expect(readded.json.watchWallet.id).not.toBe(sol.id);
    expect(readded.json.watchWallet.name).toBe("Watched Solana Devnet");
  });
});

describe("Cardano in wallet management (ADR-002)", () => {
  let h: Harness;
  let user: TestUser;
  // Preprod enterprise address with a key payment credential (CIP-19 type 6).
  const ADA = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
  const ADA_MAINNET = "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8";

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h, "ada-wallets");
  });

  const watch = (body: Record<string, unknown>, idempotencyKey = key("watch")) =>
    call(h, "POST", "/v1/watch-wallets", {
      token: user.accessToken,
      body: { idempotencyKey, ...body },
      idempotencyKey,
    });

  it("links a Cardano-only wallet: preprod enterprise address of its Ed25519 key, receivable", async () => {
    const created = h.turnkey.createWallet(user.organizationId, { families: ["cardano"] });
    const res = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "cardano-preprod",
      name: "ADA wallet",
    });
    expect(res.status).toBe(200);
    const expected = cardanoEnterpriseAddress(created.cardanoPublicKey ?? "", "cardano-preprod");
    expect(res.json.wallet.addresses).toEqual([
      expect.objectContaining({
        family: "cardano",
        address: expected,
        derivationPath: "m/1852'/1815'/0'/0'/0'",
      }),
    ]);
    const receive = await call(
      h,
      "GET",
      `/v1/receive?walletId=${res.json.wallet.id}&network=cardano-preprod`,
      { token: user.accessToken },
    );
    expect(receive.status).toBe(200);
    expect(receive.json.address).toBe(expected);
    // A Cardano-only wallet cannot be registered for another family's chain.
    const solanaOnly = h.turnkey.createWallet(user.organizationId, { families: ["solana"] });
    const noAda = await linkWallet(h, user, {
      turnkeyWalletId: solanaOnly.turnkeyWalletId,
      network: "cardano-preprod",
    });
    expect(noAda.json.error.code).toBe("NETWORK_NOT_SUPPORTED");
    const mainnet = await linkWallet(h, user, {
      turnkeyWalletId: created.turnkeyWalletId,
      network: "cardano-mainnet",
    });
    expect(mainnet.json.error.code).toBe("NETWORK_MODE_MISMATCH");
  });

  it("a removed Cardano wallet is invisible and its address unusable", async () => {
    const list = await call(h, "GET", "/v1/wallets", { token: user.accessToken });
    const ada = list.json.wallets.find((w: { name: string }) => w.name === "ADA wallet");
    const removed = await call(h, "DELETE", `/v1/wallets/${ada.id}`, { token: user.accessToken });
    expect(removed.status).toBe(200);
    const receive = await call(h, "GET", `/v1/receive?walletId=${ada.id}&network=cardano-preprod`, {
      token: user.accessToken,
    });
    expect(receive.status).toBe(404);
    const portfolio = await call(h, "GET", "/v1/portfolio", { token: user.accessToken });
    expect(JSON.stringify(portfolio.json)).not.toContain(ada.addresses[0].address);
    const [pk] = await h.db
      .select({ publicKey: t.walletAddresses.publicKey })
      .from(t.walletAddresses)
      .where(and(eq(t.walletAddresses.walletId, ada.id), eq(t.walletAddresses.family, "cardano")));
    // The key stays recorded (re-linking restores it); only the wallet is archived.
    expect(pk?.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("watches a Cardano address with the shared CIP-19 validation (canonical lowercase)", async () => {
    const res = await watch({ network: "cardano-preprod", address: ADA.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.json.watchWallet).toMatchObject({
      family: "cardano",
      network: "cardano-preprod",
      address: ADA,
      name: "Watched Cardano Preprod",
      watchOnly: true,
    });
    const dup = await watch({ network: "cardano-preprod", address: ADA });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.reason).toBe("already_watched");
    const portfolio = await call(
      h,
      "GET",
      `/v1/watch-wallets/${res.json.watchWallet.id}/portfolio`,
      { token: user.accessToken },
    );
    expect(portfolio.status).toBe(200);
    expect(portfolio.json.portfolio.networks).toEqual(["cardano-preprod"]);
  });

  it("refuses mainnet, wrong-network and other-family addresses, and the user's own", async () => {
    const wrongNet = await watch({ network: "cardano-preprod", address: ADA_MAINNET });
    expect(wrongNet.json.error.code).toBe("INVALID_ADDRESS");
    const mainnet = await watch({ network: "cardano-mainnet", address: ADA_MAINNET });
    expect(mainnet.json.error.code).toBe("NETWORK_MODE_MISMATCH");
    const evm = await watch({
      network: "cardano-preprod",
      address: "0x52908400098527886e0f7030069857d2e4169ee7",
    });
    expect(evm.json.error.code).toBe("INVALID_ADDRESS");
    const wallets = await call(h, "GET", "/v1/wallets", { token: user.accessToken });
    const own = wallets.json.wallets[0].addresses.find(
      (a: { family: string }) => a.family === "cardano",
    );
    expect(own).toBeDefined();
    const ownRes = await watch({ network: "cardano-preprod", address: own.address });
    expect(ownRes.status).toBe(409);
    expect(ownRes.json.error.details.reason).toBe("own_wallet");
  });
});
