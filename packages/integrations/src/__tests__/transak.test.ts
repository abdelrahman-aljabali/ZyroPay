import { ChainError } from "@zyropay/blockchain";
import { fixtureFetch, noSleep } from "@zyropay/blockchain/testing";
import { describe, expect, it } from "vitest";
import { MockOnrampProvider } from "../mocks";
import { createTransakOnrampProvider, normalizeTransakStatus, verifyHs256Jwt } from "../transak";

const NOW = () => new Date("2026-10-30T12:00:00.000Z");
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCESS_TOKEN = "eyJ-partner-access-token-staging";

/** Shapes per docs.transak.com: get-price, refresh-access-token, create-widget-url. */
const QUOTE = {
  response: {
    quoteId: "0b3d2a5e-7f3c-4c1b-9a43-5c0f1e2d3c4b",
    conversionPrice: 0.000312,
    fiatCurrency: "EUR",
    cryptoCurrency: "ETH",
    paymentMethod: "credit_debit_card",
    fiatAmount: 100,
    cryptoAmount: 0.0298765432101234,
    isBuyOrSell: "BUY",
    network: "ethereum",
    totalFee: 4.51,
    feeDecimal: 0.0451,
  },
};
const TOKEN = {
  data: { accessToken: ACCESS_TOKEN, expiresAt: Date.parse("2026-11-06T12:00:00.000Z") / 1000 },
};
const SESSION = {
  data: { widgetUrl: "https://global-stg.transak.com?apiKey=pk_test&sessionId=sess_123" },
};

function provider(environment: "STAGING" | "PRODUCTION" = "STAGING") {
  const fetch = fixtureFetch({
    rest: {
      "/api/v1/pricing/public/quotes": QUOTE,
      "/partners/api/v2/refresh-token": TOKEN,
      "/api/v2/auth/session": SESSION,
    },
  });
  return {
    fetch,
    p: createTransakOnrampProvider({
      apiKey: "pk_test",
      apiSecret: "sk_test",
      environment,
      referrerDomain: "zyropay.app",
      fetch,
      sleep: noSleep,
      now: NOW,
    }),
  };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function jwt(claims: object, secret: string, alg = "HS256"): Promise<string> {
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg, typ: "JWT" })}.${enc(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))))}`;
}

const headers = { get: () => null };

describe("Transak on-ramp (sandbox)", () => {
  it("quotes in base units (truncated), never rounding up", async () => {
    const { p, fetch } = provider();
    const q = await p.getQuote({
      fiat: { value: "100", currency: "EUR" },
      network: "ethereum-sepolia",
      assetId: "ethereum-sepolia:native",
      walletAddress: WALLET,
    });
    expect(q).toMatchObject({
      provider: "transak",
      cryptoAmount: "29876543210123400",
      decimals: 18,
      fees: { value: "4.51", currency: "EUR" },
      simulated: false,
    });
    const call = fetch.calls[0];
    expect(call?.url).toContain("https://api-stg.transak.com/api/v1/pricing/public/quotes?");
    expect(call?.url).toContain("cryptoCurrency=ETH");
    expect(call?.url).toContain("network=ethereum");
  });

  it("keeps sandbox on testnets and production on mainnets", async () => {
    await expect(
      provider("STAGING").p.getQuote({
        fiat: { value: "100", currency: "EUR" },
        network: "ethereum-mainnet",
        assetId: "ethereum-mainnet:native",
        walletAddress: WALLET,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.code === "NETWORK_MODE_MISMATCH",
    );
    await expect(
      provider("PRODUCTION").p.getQuote({
        fiat: { value: "100", currency: "EUR" },
        network: "base-sepolia",
        assetId: "base-sepolia:native",
        walletAddress: WALLET,
      }),
    ).rejects.toThrow(ChainError);
    await expect(
      provider().p.getQuote({
        fiat: { value: "100", currency: "EUR" },
        network: "solana-devnet",
        assetId: "solana-devnet:native",
        walletAddress: WALLET,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.code === "INVALID_ADDRESS");
  });

  it("creates a widget session from a signed quote id; tampering is rejected", async () => {
    const { p, fetch } = provider();
    const q = await p.getQuote({
      fiat: { value: "100", currency: "EUR" },
      network: "ethereum-sepolia",
      assetId: "ethereum-sepolia:native",
      walletAddress: WALLET,
    });
    const s = await p.createSession({
      quoteId: q.quoteId,
      walletAddress: WALLET,
      userId: "user-1",
      userIp: "203.0.113.7",
    });
    expect(s).toMatchObject({
      sessionId: "sess_123",
      url: SESSION.data.widgetUrl,
      simulated: false,
    });
    const sessionCall = fetch.calls.find((c) => c.url.includes("/api/v2/auth/session"));
    expect(sessionCall?.url).toBe("https://api-gateway-stg.transak.com/api/v2/auth/session");
    expect(sessionCall?.headers["access-token"]).toBe(ACCESS_TOKEN);
    expect(sessionCall?.headers["x-user-ip"]).toBe("203.0.113.7");
    expect(
      (sessionCall?.body as { widgetParams: Record<string, unknown> }).widgetParams,
    ).toMatchObject({
      walletAddress: WALLET,
      cryptoCurrencyCode: "ETH",
      fiatAmount: "100",
      referrerDomain: "zyropay.app",
    });

    const [enc, sig] = q.quoteId.split(".");
    const forged = `${btoa(atob((enc ?? "").replace(/-/g, "+").replace(/_/g, "/")).replace("100", "999")).replace(/=+$/, "")}.${sig ?? ""}`;
    await expect(
      p.createSession({ quoteId: forged, walletAddress: WALLET, userId: "u", userIp: "1.1.1.1" }),
    ).rejects.toThrow(ChainError);
    await expect(
      p.createSession({
        quoteId: q.quoteId,
        walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        userId: "u",
        userIp: "1.1.1.1",
      }),
    ).rejects.toThrow(ChainError);
    await expect(
      p.createSession({ quoteId: q.quoteId, walletAddress: WALLET, userId: "u" }),
    ).rejects.toThrow(ChainError);
  });

  it("verifies webhook JWTs signed with the partner access token and normalizes status", async () => {
    const { p } = provider();
    await p.accessToken();
    const claims = {
      webhookData: {
        id: "order-9",
        status: "COMPLETED",
        walletAddress: WALLET,
        cryptoAmount: 0.03,
      },
      eventID: "ORDER_COMPLETED",
      createdAt: "2026-10-30T12:00:00Z",
    };
    const event = await p.verifyWebhook(
      JSON.stringify({ data: await jwt(claims, ACCESS_TOKEN) }),
      headers,
    );
    expect(event).toMatchObject({
      provider: "transak",
      eventId: "order-9:ORDER_COMPLETED",
      type: "order_completed",
      orderId: "order-9",
      walletAddress: WALLET,
      simulated: false,
    });
    expect(
      await p.verifyWebhook(JSON.stringify({ data: await jwt(claims, "wrong-secret") }), headers),
    ).toBeNull();
    expect(
      await p.verifyWebhook(
        JSON.stringify({ data: await jwt(claims, ACCESS_TOKEN, "none") }),
        headers,
      ),
    ).toBeNull();
    expect(await p.verifyWebhook("not json", headers)).toBeNull();
    expect(await p.verifyWebhook(JSON.stringify({ data: 5 }), headers)).toBeNull();
    expect(await verifyHs256Jwt("a.b", [ACCESS_TOKEN])).toBeNull();
  });

  it("normalizes every documented order status / event", () => {
    expect(normalizeTransakStatus("AWAITING_PAYMENT_FROM_USER")).toBe("order_created");
    expect(normalizeTransakStatus("ORDER_PAYMENT_VERIFYING")).toBe("order_processing");
    expect(normalizeTransakStatus("PENDING_DELIVERY_FROM_TRANSAK")).toBe("order_processing");
    expect(normalizeTransakStatus("COMPLETED")).toBe("order_completed");
    expect(normalizeTransakStatus("ORDER_REFUNDED")).toBe("order_failed");
    expect(normalizeTransakStatus("EXPIRED")).toBe("order_failed");
    expect(normalizeTransakStatus("KYC_APPROVED")).toBeNull();
  });

  it("mock on-ramp is labelled simulated", async () => {
    const m = new MockOnrampProvider(NOW);
    expect(
      (
        await m.getQuote({
          fiat: { value: "10", currency: "USD" },
          network: "base-sepolia",
          assetId: "base-sepolia:native",
          walletAddress: WALLET,
        })
      ).simulated,
    ).toBe(true);
    expect(
      await m.verifyWebhook(JSON.stringify({ orderId: "o", status: "COMPLETED" }), {
        get: () => "ok",
      }),
    ).toMatchObject({ type: "order_completed", simulated: true });
  });
});
