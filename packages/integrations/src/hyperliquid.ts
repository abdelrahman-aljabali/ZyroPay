import type { HttpOptions } from "@zyropay/blockchain";
import { ChainError, requestJson, resolveHttpOptions } from "@zyropay/blockchain";
import type {
  PluginAdapter,
  PluginQuote,
  UnsignedTransaction,
  VerificationResult,
} from "@zyropay/shared";
import { z } from "zod";
import { manifestFor } from "./common";

export interface HyperliquidAdapterConfig extends HttpOptions {
  readonly environment: "mainnet" | "testnet";
  readonly baseUrl?: string;
}

const SpotMetaSchema = z.looseObject({
  tokens: z.array(
    z.looseObject({
      name: z.string(),
      szDecimals: z.number().int(),
      weiDecimals: z.number().int(),
      index: z.number().int(),
    }),
  ),
  universe: z.array(
    z.looseObject({
      name: z.string(),
      tokens: z.tuple([z.number().int(), z.number().int()]),
      index: z.number().int(),
    }),
  ),
});
const AssetCtxSchema = z.looseObject({
  coin: z.string().optional(),
  markPx: z.string().nullable().optional(),
  midPx: z.string().nullable().optional(),
  prevDayPx: z.string().optional(),
  dayNtlVlm: z.string().optional(),
});

export interface HyperliquidSpotMarket {
  /** "PURR/USDC" or the "@<index>" alias used by allMids. */
  readonly name: string;
  readonly index: number;
  readonly base: string;
  readonly quote: string;
  /** Mid price as the decimal string Hyperliquid returns, null when no book. */
  readonly midPx: string | null;
  readonly markPx: string | null;
  readonly dayNotionalVolume: string | null;
}

export interface HyperliquidAdapter extends PluginAdapter {
  getSpotMarkets(): Promise<HyperliquidSpotMarket[]>;
  getMids(): Promise<Record<string, string>>;
  /** Always {ok: false}: Hyperliquid is read-only, nothing it could build may be signed. */
  verifyTransaction(): Promise<VerificationResult>;
}

/**
 * Hyperliquid, READ-ONLY (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).
 * POST {base}/info with {type:"spotMetaAndAssetCtxs"} / {type:"allMids"}; no auth.
 *
 * Trading is deliberately not implemented. Hyperliquid is its own L1: actions are not
 * transactions on any ZyroPay network but EIP-712 signatures POSTed to /exchange
 * (L1 actions: msgpack hash -> phantom agent {source, connectionId} signed under domain
 * {name:"Exchange", chainId:1337}; user actions such as usdSend/withdraw3 signed under
 * {name:"HyperliquidSignTransaction", chainId: signatureChainId}). That needs a dedicated
 * signing review, a policy model for leverage, and Turnkey EIP-712 policies (ADR-001 open
 * item) before it can be offered. quote/buildTransaction therefore refuse with PLUGIN_DISABLED.
 */
export function createHyperliquidAdapter(config: HyperliquidAdapterConfig): HyperliquidAdapter {
  const manifest = manifestFor("hyperliquid");
  const http = resolveHttpOptions(config);
  const baseUrl =
    config.baseUrl ??
    (config.environment === "mainnet"
      ? "https://api.hyperliquid.xyz"
      : "https://api.hyperliquid-testnet.xyz");
  const info = (body: object, label: string): Promise<unknown> =>
    requestJson(http, { url: `${baseUrl}/info`, body, label: `hyperliquid ${label}` });

  return {
    manifest,

    async getSpotMarkets() {
      const body = await info({ type: "spotMetaAndAssetCtxs" }, "spotMetaAndAssetCtxs");
      const parsed = z.tuple([SpotMetaSchema, z.array(AssetCtxSchema)]).safeParse(body);
      if (!parsed.success)
        throw new ChainError(
          "UPSTREAM_UNAVAILABLE",
          "hyperliquid spotMetaAndAssetCtxs: unexpected response",
        );
      const [meta, ctxs] = parsed.data;
      const tokenName = new Map(meta.tokens.map((t) => [t.index, t.name]));
      // Contexts are keyed by `coin`; their array is NOT index-aligned with `universe`
      // (observed live: 332 universe entries vs 1061 contexts).
      const byCoin = new Map(
        ctxs.filter((c) => typeof c.coin === "string").map((c) => [c.coin as string, c]),
      );
      return meta.universe.map((u) => {
        const ctx = byCoin.get(u.name) ?? byCoin.get(`@${u.index}`);
        return {
          name: u.name,
          index: u.index,
          base: tokenName.get(u.tokens[0]) ?? String(u.tokens[0]),
          quote: tokenName.get(u.tokens[1]) ?? String(u.tokens[1]),
          midPx: ctx?.midPx ?? null,
          markPx: ctx?.markPx ?? null,
          dayNotionalVolume: ctx?.dayNtlVlm ?? null,
        };
      });
    },

    async getMids() {
      const body = await info({ type: "allMids" }, "allMids");
      const parsed = z.record(z.string(), z.string().regex(/^\d+(\.\d+)?$/)).safeParse(body);
      if (!parsed.success)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "hyperliquid allMids: unexpected response");
      return parsed.data;
    },

    quote(): Promise<PluginQuote> {
      return Promise.reject(
        new ChainError("PLUGIN_DISABLED", "Hyperliquid is read-only in ZyroPay v1"),
      );
    },

    verifyTransaction(): Promise<VerificationResult> {
      return Promise.resolve({ ok: false, reason: "read-only" });
    },

    buildTransaction(): Promise<UnsignedTransaction> {
      return Promise.reject(
        new ChainError("PLUGIN_DISABLED", "Hyperliquid is read-only in ZyroPay v1"),
      );
    },
  };
}
