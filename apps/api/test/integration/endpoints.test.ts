import { api, buildPath } from "@zyropay/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { apiExt, apiWallets } from "../../src/contracts";
import * as t from "../../src/db/tables";
import { dispatchNotification } from "../../src/services/notifications";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, signUp } from "../helpers";

describe("endpoint coverage and read APIs", () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
  });

  it("every contract (api + ext + wallets) has a mounted route", async () => {
    const zero = "00000000-0000-4000-8000-000000000000";
    for (const contract of [
      ...Object.values(api),
      ...Object.values(apiExt),
      ...Object.values(apiWallets),
    ]) {
      const params: Record<string, string> = {};
      for (const m of contract.path.matchAll(/:([A-Za-z]+)/g)) {
        const name = m[1]!;
        params[name] =
          name === "provider"
            ? contract.path.includes("onramp")
              ? "transak"
              : "helius"
            : name === "pluginId"
              ? "jupiter"
              : zero;
      }
      const res = await h.app.request(buildPath(contract.path, params), {
        method: contract.method,
      });
      const body = res.status === 404 ? await res.json<{ error: { message: string } }>() : null;
      expect(body?.error.message, `${contract.method} ${contract.path}`).not.toBe(
        "route not found",
      );
    }
  });

  it("portfolio and paginated history for the user's addresses", async () => {
    const portfolio = await call(h, "GET", "/v1/portfolio", { token: user.accessToken });
    expect(portfolio.status).toBe(200);
    expect(portfolio.json.portfolio.simulated).toBe(true);
    expect(portfolio.json.portfolio.balances.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string =
        cursor === null ? "limit=2" : `limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await call(h, "GET", `/v1/transactions?${q}`, { token: user.accessToken });
      expect(page.status).toBe(200);
      for (const tx of page.json.transactions) {
        expect(seen.has(tx.id)).toBe(false);
        seen.add(tx.id);
      }
      cursor = page.json.nextCursor;
      pages++;
    } while (cursor !== null && pages < 20);
    // 3 mock txs per (address, network): solana-devnet + ethereum-sepolia + base-sepolia
    // + cardano-preprod
    expect(seen.size).toBe(12);
    const one = [...seen][0]!;
    expect(
      (await call(h, "GET", `/v1/transactions/${one}`, { token: user.accessToken })).json
        .transaction.id,
    ).toBe(one);
  });

  it("plugins list reflects configuration and enablement", async () => {
    const list = await call(h, "GET", "/v1/plugins", { token: user.accessToken });
    const byId = (id: string) =>
      list.json.plugins.find((p: { manifest: { id: string } }) => p.manifest.id === id);
    expect(byId("x402")).toMatchObject({ enabled: false, configured: true });
    // Development serves test networks only, where Jupiter has no route: not configured.
    expect(byId("jupiter")).toMatchObject({ enabled: false, configured: false });
    const kamino = await call(h, "PUT", "/v1/plugins/kamino", {
      token: user.accessToken,
      body: { enabled: true },
    });
    expect(kamino.json.error.code).toBe("PLUGIN_DISABLED");
  });

  it("connection flow: MCP sees the user only after approval; reject works; rename works", async () => {
    const created = await call(h, "POST", "/internal/v1/agent-connections", {
      internal: true,
      body: {
        oauthClientId: "client-x",
        clientName: "Claude",
        clientUri: "https://claude.ai",
        redirectUri: "https://claude.ai/cb",
        scopes: ["mcp"],
      },
    });
    expect(created.json.connection.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const id = created.json.connection.id;
    await call(h, "POST", "/v1/agent-connections/claim", {
      token: user.accessToken,
      body: { userCode: created.json.connection.userCode },
    });
    const polled = await call(h, "GET", `/internal/v1/agent-connections/${id}`, { internal: true });
    expect(polled.json.userId).toBeNull();
    // Another user cannot claim an already-claimed code.
    const other = await signUp(h);
    expect(
      (
        await call(h, "POST", "/v1/agent-connections/claim", {
          token: other.accessToken,
          body: { userCode: created.json.connection.userCode },
        })
      ).status,
    ).toBe(404);
    const rejected = await call(h, "POST", `/v1/agent-connections/${id}/reject`, {
      token: user.accessToken,
    });
    expect(rejected.json.connection.status).toBe("rejected");

    const agentId = await connectAgent(h, user);
    const renamed = await call(h, "PATCH", `/v1/agents/${agentId}`, {
      token: user.accessToken,
      body: { name: "Renamed" },
    });
    expect(renamed.json.agent.name).toBe("Renamed");
    const policy = await call(h, "GET", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
    });
    expect(policy.json.policy).toMatchObject({
      mode: "always_ask",
      spendingEnabled: false,
      revoked: false,
    });
  });

  it("push notifications are dispatched once per dedupe key and devices can be removed", async () => {
    const device = await call(h, "POST", "/v1/notifications/devices", {
      token: user.accessToken,
      body: { expoPushToken: "ExponentPushToken[abc]", platform: "ios" },
    });
    const msg = {
      dedupeKey: "test:once",
      userId: user.userId,
      event: "security_event",
      title: "t",
      body: "b",
      data: {},
    };
    const before = h.notifier.sent.length;
    await dispatchNotification(h.deps, msg);
    await dispatchNotification(h.deps, msg);
    expect(h.notifier.sent.length - before).toBe(1);
    expect(
      (
        await call(h, "DELETE", `/v1/notifications/devices/${device.json.deviceId}`, {
          token: user.accessToken,
        })
      ).status,
    ).toBe(200);
    const [row] = await h.db
      .select()
      .from(t.notificationDevices)
      .where(eq(t.notificationDevices.id, device.json.deviceId));
    expect(row?.disabledAt).not.toBeNull();
  });
});
