/* Webhook authentication + idempotency (SECURITY.md T11, C12). */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import { MOCK_ONRAMP_SIGNATURE_HEADER, mockUsdcAssetId } from "../../src/providers/mocks";
import type { Harness, TestUser } from "../helpers";
import {
  ALCHEMY_KEY,
  call,
  createHarness,
  HELIUS_SECRET,
  signUp,
  TRANSAK_SECRET,
} from "../helpers";

describe("webhooks", () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    await call(h, "POST", "/v1/notifications/devices", {
      token: user.accessToken,
      body: { expoPushToken: "ExponentPushToken[webhook-device]", platform: "android" },
    });
  });

  const heliusBody = (signature: string, to: string) =>
    JSON.stringify([
      {
        signature,
        type: "TRANSFER",
        nativeTransfers: [
          {
            fromUserAccount: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            toUserAccount: to,
            amount: 250000000,
          },
        ],
        tokenTransfers: [],
      },
    ]);

  it("Helius: wrong or missing secret is rejected and audited", async () => {
    const raw = heliusBody("5".repeat(64), user.solana);
    expect((await call(h, "POST", "/v1/webhooks/chain/helius", { rawBody: raw })).status).toBe(401);
    const bad = await call(h, "POST", "/v1/webhooks/chain/helius", {
      rawBody: raw,
      headers: { authorization: "nope" },
    });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    const rows = await h.db.select().from(t.webhookEvents);
    expect(rows).toHaveLength(0);
    const audit = await h.db
      .select()
      .from(t.auditLogs)
      .where(eq(t.auditLogs.action, "security.webhook_signature_invalid"));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("Helius: valid event -> one incoming transfer + one push, duplicates are idempotent", async () => {
    const raw = heliusBody("4".repeat(64), user.solana);
    for (let i = 0; i < 3; i++) {
      const res = await call(h, "POST", "/v1/webhooks/chain/helius", {
        rawBody: raw,
        headers: { authorization: HELIUS_SECRET },
      });
      expect(res.status).toBe(200);
    }
    await h.drain();
    const transfers = await h.db
      .select()
      .from(t.incomingTransfers)
      .where(eq(t.incomingTransfers.userId, user.userId));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      network: "solana-devnet",
      amount: "250000000",
      assetId: "solana-devnet:native",
    });
    const pushes = h.notifier.sent.filter((n) => n.notification.data.type === "incoming_payment");
    expect(pushes).toHaveLength(1);
    // Push payload carries no addresses or secrets.
    expect(JSON.stringify(pushes[0])).not.toContain(user.solana);
    // ...and no amount: the text shows on the lock screen.
    expect(pushes[0]?.notification.body).not.toMatch(/0\.25|250000000/);
    expect(pushes[0]?.notification.data).toMatchObject({ v: "1", url: "zyropay://activity" });
  });

  it("Alchemy: HMAC over the raw body is required", async () => {
    const payload = {
      webhookId: "wh_1",
      id: "whevt_abc",
      createdAt: "2026-10-30T12:00:00Z",
      type: "ADDRESS_ACTIVITY",
      event: {
        network: "BASE_SEPOLIA",
        activity: [
          {
            fromAddress: "0x52908400098527886e0f7030069857d2e4169ee7",
            toAddress: user.evm.toLowerCase(),
            hash: `0x${"ab".repeat(32)}`,
            category: "token",
            rawContract: {
              rawValue: "0x4c4b40",
              address: mockUsdcAssetId("base-sepolia").split(":")[1]!.toLowerCase(),
              decimals: 6,
            },
          },
        ],
      },
    };
    const raw = JSON.stringify(payload);
    const forged = await call(h, "POST", "/v1/webhooks/chain/alchemy", {
      rawBody: raw,
      headers: { "x-alchemy-signature": "0".repeat(64) },
    });
    expect(forged.status).toBe(401);
    const sig = createHmac("sha256", ALCHEMY_KEY).update(raw).digest("hex");
    const tamperedBody = raw.replace("0x4c4b40", "0xffffff");
    expect(
      (
        await call(h, "POST", "/v1/webhooks/chain/alchemy", {
          rawBody: tamperedBody,
          headers: { "x-alchemy-signature": sig },
        })
      ).status,
    ).toBe(401);
    const ok = await call(h, "POST", "/v1/webhooks/chain/alchemy", {
      rawBody: raw,
      headers: { "x-alchemy-signature": sig },
    });
    expect(ok.status).toBe(200);
    await h.drain();
    const transfers = await h.db
      .select()
      .from(t.incomingTransfers)
      .where(eq(t.incomingTransfers.network, "base-sepolia"));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.amount).toBe("5000000");
  });

  it("mainnet events are ignored in development mode", async () => {
    const payload = {
      id: "whevt_main",
      type: "ADDRESS_ACTIVITY",
      event: {
        network: "BASE_MAINNET",
        activity: [
          {
            toAddress: user.evm,
            hash: `0x${"cd".repeat(32)}`,
            category: "external",
            rawContract: { rawValue: "0x01" },
          },
        ],
      },
    };
    const raw = JSON.stringify(payload);
    const sig = createHmac("sha256", ALCHEMY_KEY).update(raw).digest("hex");
    expect(
      (
        await call(h, "POST", "/v1/webhooks/chain/alchemy", {
          rawBody: raw,
          headers: { "x-alchemy-signature": sig },
        })
      ).status,
    ).toBe(200);
    await h.drain();
    const transfers = await h.db
      .select()
      .from(t.incomingTransfers)
      .where(eq(t.incomingTransfers.network, "base-mainnet"));
    expect(transfers).toHaveLength(0);
  });

  it("on-ramp: signature verified by the provider adapter; status flows to the order", async () => {
    const quote = await call(h, "POST", "/v1/onramp/quote", {
      token: user.accessToken,
      body: {
        fiat: { value: "50.00", currency: "EUR" },
        network: "solana-devnet",
        assetId: "solana-devnet:native",
        walletId: user.walletId,
      },
    });
    expect(quote.status).toBe(200);
    const session = await call(h, "POST", "/v1/onramp/session", {
      token: user.accessToken,
      body: { quoteId: quote.json.quote.quoteId, walletId: user.walletId },
    });
    expect(session.status).toBe(200);
    expect(session.json.url).toMatch(/^https:\/\//);

    const raw = JSON.stringify({
      eventId: "evt-1",
      type: "order_completed",
      orderId: "order-1",
      walletAddress: user.solana,
    });
    const forged = await call(h, "POST", "/v1/webhooks/onramp/transak", {
      rawBody: raw,
      headers: { [MOCK_ONRAMP_SIGNATURE_HEADER]: "0".repeat(64) },
    });
    expect(forged.status).toBe(401);
    const sig = createHmac("sha256", TRANSAK_SECRET).update(raw).digest("hex");
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await call(h, "POST", "/v1/webhooks/onramp/transak", {
            rawBody: raw,
            headers: { [MOCK_ONRAMP_SIGNATURE_HEADER]: sig },
          })
        ).status,
      ).toBe(200);
    }
    await h.drain();
    const [order] = await h.db
      .select()
      .from(t.onrampOrders)
      .where(eq(t.onrampOrders.userId, user.userId));
    expect(order?.status).toBe("completed");
    expect(order?.orderId).toBe("order-1");
    expect(h.notifier.sent.filter((n) => n.notification.kind === "onramp_completed")).toHaveLength(
      1,
    );
  });

  it("someone else's quote cannot be turned into a session", async () => {
    const other = await signUp(h);
    const quote = await call(h, "POST", "/v1/onramp/quote", {
      token: user.accessToken,
      body: {
        fiat: { value: "20", currency: "USD" },
        network: "solana-devnet",
        assetId: "solana-devnet:native",
        walletId: user.walletId,
      },
    });
    const res = await call(h, "POST", "/v1/onramp/session", {
      token: other.accessToken,
      body: { quoteId: quote.json.quote.quoteId, walletId: other.walletId },
    });
    expect(res.status).toBe(404);
  });
});
