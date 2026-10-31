import type { HttpOptions } from "@zyropay/blockchain";
import {
  ChainError,
  findKnownToken,
  numberToDecimalString,
  requestJson,
  resolveHttpOptions,
} from "@zyropay/blockchain";
import type {
  AssetId,
  HeaderReader,
  NetworkId,
  OnrampProvider,
  OnrampQuote,
  OnrampWebhookEvent,
} from "@zyropay/shared";
import {
  AssetIdSchema,
  FiatValueSchema,
  isMainnet,
  isValidAddressForNetwork,
  NETWORKS,
  parseAssetId,
  toBaseUnits,
} from "@zyropay/shared";
import { z } from "zod";
import { toJsonObject } from "./common";

export type TransakEnvironment = "STAGING" | "PRODUCTION";

const ENDPOINTS: Record<TransakEnvironment, { api: string; gateway: string }> = {
  STAGING: { api: "https://api-stg.transak.com", gateway: "https://api-gateway-stg.transak.com" },
  PRODUCTION: { api: "https://api.transak.com", gateway: "https://api-gateway.transak.com" },
};

/** Partner access token persistence. Refreshing invalidates the previous token, so every
 * isolate must share one copy: back this with KV or the database in the API. */
export interface TransakTokenStore {
  get(): Promise<{ accessToken: string; expiresAt: number; previous?: string } | null>;
  set(value: { accessToken: string; expiresAt: number; previous?: string }): Promise<void>;
}

export function createMemoryTokenStore(): TransakTokenStore {
  let value: { accessToken: string; expiresAt: number; previous?: string } | null = null;
  return {
    get: () => Promise.resolve(value),
    set: (v) => {
      value = v;
      return Promise.resolve();
    },
  };
}

export interface TransakConfig extends HttpOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly environment: TransakEnvironment;
  /** Domain registered with Transak (widgetParams.referrerDomain). */
  readonly referrerDomain: string;
  readonly tokenStore?: TransakTokenStore;
  /** Extra HMAC secret accepted for webhook JWTs (TRANSAK_WEBHOOK_SECRET), if configured. */
  readonly webhookSecret?: string;
  /** Quote validity. Default 120 s. */
  readonly quoteTtlSeconds?: number;
  readonly now?: () => Date;
}

/**
 * ZyroPay asset -> Transak (cryptoCurrencyCode, network). Testnet rows serve the STAGING
 * environment, which settles on test networks. The staging network naming is an assumption to
 * confirm against GET /api/v2/currencies/crypto-currencies with sandbox keys.
 */
const TRANSAK_ASSETS: ReadonlyArray<{
  network: NetworkId;
  token: string | null;
  code: string;
  transakNetwork: string;
}> = [
  { network: "solana-mainnet", token: null, code: "SOL", transakNetwork: "solana" },
  {
    network: "solana-mainnet",
    token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    code: "USDC",
    transakNetwork: "solana",
  },
  { network: "ethereum-mainnet", token: null, code: "ETH", transakNetwork: "ethereum" },
  {
    network: "ethereum-mainnet",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    code: "USDC",
    transakNetwork: "ethereum",
  },
  { network: "base-mainnet", token: null, code: "ETH", transakNetwork: "base" },
  {
    network: "base-mainnet",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    code: "USDC",
    transakNetwork: "base",
  },
  { network: "solana-devnet", token: null, code: "SOL", transakNetwork: "solana" },
  { network: "ethereum-sepolia", token: null, code: "ETH", transakNetwork: "ethereum" },
  { network: "base-sepolia", token: null, code: "ETH", transakNetwork: "base" },
];

function transakAsset(assetId: AssetId): {
  code: string;
  transakNetwork: string;
  decimals: number;
} {
  const { network, tokenAddress } = parseAssetId(assetId);
  const row = TRANSAK_ASSETS.find(
    (r) =>
      r.network === network &&
      (r.token === null
        ? tokenAddress === null
        : tokenAddress?.toLowerCase() === r.token.toLowerCase()),
  );
  if (row === undefined)
    throw new ChainError("VALIDATION_FAILED", `Transak does not support ${assetId}`);
  const decimals =
    tokenAddress === null
      ? NETWORKS[network].nativeCurrency.decimals
      : (findKnownToken(network, tokenAddress)?.decimals ?? -1);
  if (decimals < 0) throw new ChainError("VALIDATION_FAILED", "unknown token decimals");
  return { code: row.code, transakNetwork: row.transakNetwork, decimals };
}

// ---- base64url + HMAC (WebCrypto: Workers, Node, RN with polyfill) -----------------------

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(data),
  );
  return b64url(new Uint8Array(sig));
}

async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  try {
    const sig = fromB64url(signature);
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      sig,
      new TextEncoder().encode(data),
    );
  } catch {
    return false;
  }
}

/** Verify an HS256 JWT and return its claims, or null. Constant-time via WebCrypto verify. */
export async function verifyHs256Jwt(
  token: string,
  secrets: readonly string[],
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as unknown;
    if (
      typeof header !== "object" ||
      header === null ||
      (header as Record<string, unknown>).alg !== "HS256"
    )
      return null;
    let ok = false;
    for (const secret of secrets) {
      if (secret.length > 0 && (await hmacVerify(secret, `${h}.${p}`, s))) {
        ok = true;
        break;
      }
    }
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as unknown;
    return typeof claims === "object" && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Transak order status -> normalized event type. */
export function normalizeTransakStatus(statusOrEvent: string): OnrampWebhookEvent["type"] | null {
  switch (statusOrEvent.toUpperCase()) {
    case "ORDER_CREATED":
    case "AWAITING_PAYMENT_FROM_USER":
      return "order_created";
    case "ORDER_PAYMENT_VERIFYING":
    case "ORDER_PROCESSING":
    case "PAYMENT_DONE_MARKED_BY_USER":
    case "PROCESSING":
    case "PENDING_DELIVERY_FROM_TRANSAK":
    case "ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK":
      return "order_processing";
    case "ORDER_COMPLETED":
    case "COMPLETED":
      return "order_completed";
    case "ORDER_FAILED":
    case "ORDER_REFUNDED":
    case "ORDER_EXPIRED":
    case "ORDER_CANCELLED":
    case "FAILED":
    case "CANCELLED":
    case "EXPIRED":
    case "REFUNDED":
      return "order_failed";
    default:
      return null;
  }
}

const QuoteResponseSchema = z.looseObject({
  response: z.looseObject({
    quoteId: z.string().min(1),
    cryptoAmount: z.union([z.number(), z.string()]),
    totalFee: z.union([z.number(), z.string()]),
    fiatCurrency: z.string(),
  }),
});

interface QuoteToken {
  v: 1;
  q: string;
  a: AssetId;
  n: NetworkId;
  f: string;
  c: string;
  w: string;
  e: string;
}

export interface TransakOnrampProvider extends OnrampProvider {
  createSession(input: {
    quoteId: string;
    walletAddress: string;
    userId: string;
    userIp?: string;
  }): ReturnType<OnrampProvider["createSession"]>;
  /** Partner access token (refreshed and persisted through the token store). */
  accessToken(): Promise<string>;
}

/**
 * Transak on-ramp (https://docs.transak.com):
 *  - quote:   GET {api}/api/v1/pricing/public/quotes (x-api-key)
 *  - token:   POST {api}/partners/api/v2/refresh-token (x-api-key, api-secret) -> 7-day token
 *  - session: POST {gateway}/api/v2/auth/session (access-token, x-api-key, x-user-ip) ->
 *             widgetUrl; query-parameter widget URLs are no longer supported by Transak
 *  - webhook: body {data: <JWT HS256 signed with the partner access token>}
 * STAGING serves only testnets and PRODUCTION only mainnets (never mixed).
 * The quoteId we return is self-contained and HMAC-signed with the API secret, so
 * createSession needs no shared state and cannot be fed tampered quote parameters.
 */
export function createTransakOnrampProvider(config: TransakConfig): TransakOnrampProvider {
  const http = resolveHttpOptions(config);
  const urls = ENDPOINTS[config.environment];
  const now = config.now ?? (() => new Date());
  const store = config.tokenStore ?? createMemoryTokenStore();
  const ttl = (config.quoteTtlSeconds ?? 120) * 1000;

  function assertEnvironment(network: NetworkId): void {
    const mainnet = isMainnet(network);
    if (mainnet !== (config.environment === "PRODUCTION")) {
      throw new ChainError(
        "NETWORK_MODE_MISMATCH",
        `Transak ${config.environment} cannot serve ${network}`,
      );
    }
  }

  async function accessToken(): Promise<string> {
    const stored = await store.get();
    if (stored !== null && stored.expiresAt * 1000 - now().getTime() > 3_600_000)
      return stored.accessToken;
    const body = await requestJson(http, {
      url: `${urls.api}/partners/api/v2/refresh-token`,
      headers: { "x-api-key": config.apiKey, "api-secret": config.apiSecret },
      body: { apiKey: config.apiKey },
      label: "transak refresh-token",
    });
    const parsed = z
      .looseObject({
        data: z.looseObject({ accessToken: z.string().min(1), expiresAt: z.number() }),
      })
      .safeParse(body);
    if (!parsed.success)
      throw new ChainError("UPSTREAM_UNAVAILABLE", "transak refresh-token: unexpected response");
    const next = {
      accessToken: parsed.data.data.accessToken,
      expiresAt: parsed.data.data.expiresAt,
      ...(stored !== null ? { previous: stored.accessToken } : {}),
    };
    await store.set(next);
    return next.accessToken;
  }

  return {
    id: "transak",
    accessToken,

    async getQuote({ fiat, network, assetId, walletAddress }): Promise<OnrampQuote> {
      FiatValueSchema.parse(fiat);
      AssetIdSchema.parse(assetId);
      assertEnvironment(network);
      if (parseAssetId(assetId).network !== network)
        throw new ChainError("NETWORK_MODE_MISMATCH", "asset is on a different network");
      if (!isValidAddressForNetwork(network, walletAddress))
        throw new ChainError("INVALID_ADDRESS", "wallet address is not valid for the network");
      const asset = transakAsset(assetId);
      const query = new URLSearchParams({
        partnerApiKey: config.apiKey,
        fiatCurrency: fiat.currency,
        cryptoCurrency: asset.code,
        isBuyOrSell: "BUY",
        network: asset.transakNetwork,
        paymentMethod: "credit_debit_card",
        fiatAmount: fiat.value,
      });
      const body = await requestJson(http, {
        url: `${urls.api}/api/v1/pricing/public/quotes?${query.toString()}`,
        headers: { "x-api-key": config.apiKey },
        label: "transak quote",
      });
      const parsed = QuoteResponseSchema.safeParse(body);
      if (!parsed.success)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "transak quote: unexpected response");
      const r = parsed.data.response;
      const crypto = numberToDecimalString(r.cryptoAmount);
      const fee = numberToDecimalString(r.totalFee);
      if (crypto === null || fee === null)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "transak quote: bad amounts");
      // Truncate (never round up) the estimate to the asset's decimals.
      const [whole = "0", frac = ""] = crypto.split(".");
      const cryptoAmount = toBaseUnits(
        frac.length > 0 ? `${whole}.${frac.slice(0, asset.decimals)}` : whole,
        asset.decimals,
      );
      const expiresAt = new Date(now().getTime() + ttl).toISOString();
      const token: QuoteToken = {
        v: 1,
        q: r.quoteId,
        a: assetId,
        n: network,
        f: fiat.value,
        c: fiat.currency,
        w: walletAddress,
        e: expiresAt,
      };
      const encoded = b64url(new TextEncoder().encode(JSON.stringify(token)));
      return {
        quoteId: `${encoded}.${await hmacSign(config.apiSecret, encoded)}`,
        provider: "transak",
        fiat,
        network,
        assetId,
        cryptoAmount,
        decimals: asset.decimals,
        fees: { value: fee, currency: fiat.currency },
        expiresAt,
        simulated: false,
      };
    },

    async createSession({ quoteId, walletAddress, userId, userIp }) {
      const [encoded, sig] = quoteId.split(".");
      if (
        encoded === undefined ||
        sig === undefined ||
        !(await hmacVerify(config.apiSecret, encoded, sig))
      ) {
        throw new ChainError("VALIDATION_FAILED", "invalid quote id");
      }
      const token = JSON.parse(new TextDecoder().decode(fromB64url(encoded))) as QuoteToken;
      if (Date.parse(token.e) <= now().getTime())
        throw new ChainError("REQUEST_EXPIRED", "quote expired");
      if (token.w !== walletAddress)
        throw new ChainError("VALIDATION_FAILED", "wallet differs from the quoted wallet");
      assertEnvironment(token.n);
      if (userIp === undefined || userIp.length === 0) {
        throw new ChainError("VALIDATION_FAILED", "Transak requires the end user's IP (x-user-ip)");
      }
      const asset = transakAsset(token.a);
      const body = await requestJson(http, {
        url: `${urls.gateway}/api/v2/auth/session`,
        headers: {
          "access-token": await accessToken(),
          "x-api-key": config.apiKey,
          "x-user-ip": userIp,
        },
        body: {
          widgetParams: {
            apiKey: config.apiKey,
            referrerDomain: config.referrerDomain,
            productsAvailed: "BUY",
            cryptoCurrencyCode: asset.code,
            network: asset.transakNetwork,
            walletAddress,
            disableWalletAddressForm: true,
            fiatCurrency: token.c,
            fiatAmount: token.f,
            partnerCustomerId: userId,
            partnerOrderId: token.q,
          },
        },
        label: "transak session",
      });
      const parsed = z
        .looseObject({ data: z.looseObject({ widgetUrl: z.url({ protocol: /^https$/ }) }) })
        .safeParse(body);
      if (!parsed.success)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "transak session: unexpected response");
      const url = parsed.data.data.widgetUrl;
      const sessionId = new URL(url).searchParams.get("sessionId") ?? token.q;
      return {
        sessionId,
        url,
        expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
        simulated: false,
      };
    },

    async verifyWebhook(
      rawBody: string,
      _headers: HeaderReader,
    ): Promise<OnrampWebhookEvent | null> {
      try {
        const body = JSON.parse(rawBody) as unknown;
        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as Record<string, unknown>).data !== "string"
        )
          return null;
        const stored = await store.get();
        const secrets = [stored?.accessToken, stored?.previous, config.webhookSecret].filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        );
        if (secrets.length === 0) secrets.push(await accessToken());
        const claims = await verifyHs256Jwt((body as { data: string }).data, secrets);
        if (claims === null) return null;
        const data = claims.webhookData;
        if (typeof data !== "object" || data === null) return null;
        const order = data as Record<string, unknown>;
        const eventName =
          typeof claims.eventID === "string"
            ? claims.eventID
            : typeof order.status === "string"
              ? order.status
              : "";
        const type = normalizeTransakStatus(eventName);
        if (type === null || typeof order.id !== "string") return null;
        return {
          provider: "transak",
          eventId: `${order.id}:${eventName}`,
          type,
          orderId: order.id,
          walletAddress: typeof order.walletAddress === "string" ? order.walletAddress : null,
          raw: toJsonObject(claims),
          simulated: false,
        };
      } catch {
        return null;
      }
    },
  };
}
