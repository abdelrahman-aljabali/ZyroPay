/*
 * Wallet management isolation: users cannot see or change each other's wallets or watch
 * wallets (404, never existence leaks), and a watch wallet id is unusable for sends,
 * agent policies, agent connections, receive and every MCP internal endpoint.
 */
import { sha256Hex } from "@zyropay/shared";
import { beforeAll, describe, expect, it } from "vitest";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, sendInput, setPolicy, signUp } from "../helpers";

const WATCHED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const key = (label: string) => `${label}-${sha256Hex(String(Math.random())).slice(0, 16)}`;

describe("wallet management isolation", () => {
  let h: Harness;
  let alice: TestUser;
  let bob: TestUser;
  let aliceSecond: string;
  let aliceWatch: string;
  let aliceAgent: string;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    alice = await signUp(h, "alice");
    bob = await signUp(h, "bob");
    const created = h.turnkey.createWallet(alice.organizationId);
    const k1 = key("c");
    const linked = await call(h, "POST", "/v1/wallets", {
      token: alice.accessToken,
      body: {
        turnkeyWalletId: created.turnkeyWalletId,
        network: "solana-devnet",
        idempotencyKey: k1,
      },
      idempotencyKey: k1,
    });
    aliceSecond = linked.json.wallet.id;
    const k2 = key("w");
    const watched = await call(h, "POST", "/v1/watch-wallets", {
      token: alice.accessToken,
      body: { network: "solana-devnet", address: WATCHED, idempotencyKey: k2 },
      idempotencyKey: k2,
    });
    aliceWatch = watched.json.watchWallet.id;
    aliceAgent = await connectAgent(h, alice);
    await setPolicy(h, alice, aliceAgent, { spendingEnabled: true });
  });

  it("bob cannot rename, remove or read alice's wallets and watch wallets (404)", async () => {
    const asBob = { token: bob.accessToken };
    const checks: [string, string, unknown?][] = [
      ["PATCH", `/v1/wallets/${aliceSecond}`, { name: "pwned" }],
      ["DELETE", `/v1/wallets/${aliceSecond}`],
      ["PATCH", `/v1/wallets/${alice.walletId}`, { name: "pwned" }],
      ["DELETE", `/v1/wallets/${alice.walletId}`],
      ["PATCH", `/v1/watch-wallets/${aliceWatch}`, { name: "pwned" }],
      ["DELETE", `/v1/watch-wallets/${aliceWatch}`],
      ["GET", `/v1/watch-wallets/${aliceWatch}/portfolio`],
    ];
    for (const [method, path, body] of checks) {
      const res = await call(h, method, path, {
        ...asBob,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.json)).not.toContain(WATCHED);
    }
    const list = await call(h, "GET", "/v1/watch-wallets", asBob);
    expect(list.json.watchWallets).toHaveLength(0);
    // Alice's data is unchanged.
    const mine = await call(h, "GET", "/v1/watch-wallets", { token: alice.accessToken });
    expect(mine.json.watchWallets.map((w: { id: string }) => w.id)).toEqual([aliceWatch]);
    const wallet = await call(h, "GET", `/v1/wallets/${aliceSecond}`, { token: alice.accessToken });
    expect(wallet.status).toBe(200);
    expect(wallet.json.wallet.name).not.toBe("pwned");
  });

  it("bob cannot link alice's Turnkey wallet (not in his sub-org)", async () => {
    const created = h.turnkey.createWallet(alice.organizationId);
    const k = key("steal");
    const res = await call(h, "POST", "/v1/wallets", {
      token: bob.accessToken,
      body: {
        turnkeyWalletId: created.turnkeyWalletId,
        network: "solana-devnet",
        idempotencyKey: k,
      },
      idempotencyKey: k,
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
  });

  it("bob may watch an address alice watches; it stays a separate row", async () => {
    const k = key("w");
    const res = await call(h, "POST", "/v1/watch-wallets", {
      token: bob.accessToken,
      body: { network: "solana-devnet", address: WATCHED, idempotencyKey: k },
      idempotencyKey: k,
    });
    expect(res.status).toBe(200);
    expect(res.json.watchWallet.id).not.toBe(aliceWatch);
    expect(res.json.watchWallet.userId).toBe(bob.userId);
  });

  it("a watch wallet id cannot be used for sends or receive (NOT_FOUND)", async () => {
    const idem = key("q");
    const quote = await call(h, "POST", "/v1/send/quote", {
      token: alice.accessToken,
      body: {
        walletId: aliceWatch,
        network: "solana-devnet",
        to: "11111111111111111111111111111112",
        assetId: "solana-devnet:native",
        amount: "1000",
        decimals: 9,
        idempotencyKey: idem,
      },
      idempotencyKey: idem,
    });
    expect(quote.status).toBe(404);
    expect(quote.json.error.code).toBe("NOT_FOUND");
    for (const path of [
      `/v1/wallets/${aliceWatch}`,
      `/v1/receive?walletId=${aliceWatch}&network=solana-devnet`,
      `/v1/portfolio?walletId=${aliceWatch}`,
      `/v1/transactions?walletId=${aliceWatch}`,
    ]) {
      const res = await call(h, "GET", path, { token: alice.accessToken });
      expect(res.status, path).toBe(404);
    }
    // A watch wallet is not a wallet: it cannot be renamed/removed through /v1/wallets.
    const del = await call(h, "DELETE", `/v1/wallets/${aliceWatch}`, { token: alice.accessToken });
    expect(del.status).toBe(404);
  });

  it("a watch wallet id is refused in agent policies and agent connections", async () => {
    const current = await call(h, "GET", `/v1/agents/${aliceAgent}/policy`, {
      token: alice.accessToken,
    });
    const { version, revoked: _r, ...policy } = current.json.policy;
    const put = await call(h, "PUT", `/v1/agents/${aliceAgent}/policy`, {
      token: alice.accessToken,
      body: {
        expectedVersion: version,
        policy: { ...policy, allowedWalletIds: [alice.walletId, aliceWatch] },
      },
    });
    expect(put.status).toBe(400);
    expect(put.json.error.code).toBe("BAD_REQUEST");

    const created = await call(h, "POST", "/internal/v1/agent-connections", {
      internal: true,
      body: {
        oauthClientId: `client-watch-${alice.userId}`,
        clientName: "Watch Agent",
        clientUri: null,
        redirectUri: "https://agent.example/callback",
        scopes: ["mcp"],
      },
    });
    const claimed = await call(h, "POST", "/v1/agent-connections/claim", {
      token: alice.accessToken,
      body: { userCode: created.json.connection.userCode },
    });
    const approved = await call(
      h,
      "POST",
      `/v1/agent-connections/${claimed.json.connection.id}/approve`,
      {
        token: alice.accessToken,
        body: { name: "Agent", walletIds: [aliceWatch], networks: ["solana-devnet"] },
      },
    );
    expect(approved.status).toBe(400);
  });

  it("MCP internal endpoints never see or accept a watch wallet", async () => {
    const context = await call(h, "GET", `/internal/v1/agents/${aliceAgent}/context`, {
      internal: true,
    });
    expect(context.status).toBe(200);
    expect(context.json.wallets.map((w: { id: string }) => w.id)).not.toContain(aliceWatch);
    expect(JSON.stringify(context.json)).not.toContain(WATCHED);

    const portfolio = await call(
      h,
      "GET",
      `/internal/v1/agents/${aliceAgent}/portfolio?walletId=${aliceWatch}`,
      { internal: true },
    );
    expect(portfolio.status).toBe(403);
    const all = await call(h, "GET", `/internal/v1/agents/${aliceAgent}/portfolio`, {
      internal: true,
    });
    expect(all.status).toBe(200);
    expect(JSON.stringify(all.json)).not.toContain(WATCHED);
    expect(JSON.stringify(all.json)).not.toContain(aliceWatch);

    const txs = await call(
      h,
      "GET",
      `/internal/v1/agents/${aliceAgent}/transactions?walletId=${aliceWatch}`,
      { internal: true },
    );
    expect(txs.status).toBe(403);

    const body = sendInput(alice, { walletId: aliceWatch });
    const request = await call(
      h,
      "POST",
      `/internal/v1/agents/${aliceAgent}/transaction-requests`,
      {
        internal: true,
        body,
        idempotencyKey: body.input.idempotencyKey,
      },
    );
    expect(request.status).toBe(404);
    expect(request.json.error.code).toBe("NOT_FOUND");
  });

  it("a removed wallet disappears from the agent context and is refused for agent sends", async () => {
    // Alice's second wallet is not shared with the agent, so it can be removed.
    const removed = await call(h, "DELETE", `/v1/wallets/${aliceSecond}`, {
      token: alice.accessToken,
    });
    expect(removed.status).toBe(200);
    const body = sendInput(alice, { walletId: aliceSecond });
    const request = await call(
      h,
      "POST",
      `/internal/v1/agents/${aliceAgent}/transaction-requests`,
      {
        internal: true,
        body,
        idempotencyKey: body.input.idempotencyKey,
      },
    );
    expect(request.status).toBe(404);
    const context = await call(h, "GET", `/internal/v1/agents/${aliceAgent}/context`, {
      internal: true,
    });
    expect(context.json.wallets.map((w: { id: string }) => w.id)).not.toContain(aliceSecond);
  });
});
