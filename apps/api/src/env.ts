import type { AssetId, NetworkId, ZyroPayMode } from "@zyropay/shared";
import {
  AssetIdSchema,
  BaseUnitAmountSchema,
  chainFamilyOf,
  networksForMode,
  ZyroPayModeSchema,
} from "@zyropay/shared";
import { z } from "zod";
import type { QueueMessage } from "./queue/messages";

/** Worker bindings. Secrets come from `wrangler secret put` / `.dev.vars`; see .env.example. */
export interface Env {
  ZYROPAY_MODE?: string;
  ZYROPAY_USE_MOCK_ADAPTERS?: string;
  API_PUBLIC_URL?: string;
  APP_DEEP_LINK_SCHEME?: string;
  DATABASE_URL?: string;
  /**
   * neon (default): @neondatabase/serverless over WebSockets (Neon). pg: node-postgres over
   * TCP (workerd sockets), for a plain local Postgres in development only.
   */
  DATABASE_DRIVER?: string;
  TURNKEY_API_BASE_URL?: string;
  TURNKEY_ORGANIZATION_ID?: string;
  TURNKEY_API_PUBLIC_KEY?: string;
  TURNKEY_API_PRIVATE_KEY?: string;
  DELEGATED_KEY_ENCRYPTION_KEY?: string;
  SESSION_ACCESS_TOKEN_TTL_SECONDS?: string;
  SESSION_REFRESH_TOKEN_TTL_SECONDS?: string;
  AUDIT_IP_HASH_SALT?: string;
  INTERNAL_SERVICE_TOKEN?: string;
  INTERNAL_SERVICE_TOKEN_PREVIOUS?: string;
  HELIUS_WEBHOOK_SECRET?: string;
  ALCHEMY_WEBHOOK_SIGNING_KEY?: string;
  TRANSAK_WEBHOOK_SECRET?: string;
  PRICE_MAX_AGE_SECONDS?: string;
  AGENT_CONNECTION_CODE_TTL_SECONDS?: string;
  /** New (API): comma-separated browser origins allowed by CORS. Empty = none. */
  CORS_ALLOWED_ORIGINS?: string;
  // --- real chain / integration adapters (providers.ts) ---------------------------------
  HELIUS_API_KEY?: string;
  /** Second Helius key (another account/plan). Used when the primary answers 401/403/429. */
  HELIUS_API_KEY_SECONDARY?: string;
  /** Optional comma-separated list of further Helius keys, tried after the two above. */
  HELIUS_API_KEYS?: string;
  ALCHEMY_API_KEY?: string;
  /** Blockfrost project ids, one per Cardano network (docs/INTEGRATIONS.md "Cardano"). */
  BLOCKFROST_PROJECT_ID_MAINNET?: string;
  BLOCKFROST_PROJECT_ID_PREPROD?: string;
  /** Blocks before a Cardano transaction counts as confirmed (default 3). */
  CARDANO_CONFIRMATIONS?: string;
  EVM_CONFIRMATIONS?: string;
  SOLANA_COMMITMENT?: string;
  COINGECKO_API_KEY?: string;
  /** demo | pro (CoinGecko plan of COINGECKO_API_KEY). */
  COINGECKO_PLAN?: string;
  /**
   * Development only (default true there): value testnet SOL/ETH/ADA and curated testnet USDC
   * at their mainnet counterparts' prices, labelled `priceBasis: "mainnet_proxy"`. Refused in
   * production. Unknown testnet tokens stay unpriced (fail closed).
   */
  VALUE_TESTNETS_AT_MAINNET_PRICES?: string;
  /** Deprecated alias of VALUE_TESTNETS_AT_MAINNET_PRICES (same rules). */
  PRICE_TESTNET_PROXY?: string;
  JUPITER_API_KEY?: string;
  /** JSON object {assetId: maxBaseUnits}: per-payment x402 caps. Assets without a cap are refused. */
  X402_CAPS?: string;
  X402_MAX_TIMEOUT_SECONDS?: string;
  /** Register coming_soon plugin adapters (Kamino, Aave, Hyperliquid); still not "available". */
  PLUGINS_ENABLE_COMING_SOON?: string;
  TRANSAK_ENVIRONMENT?: string;
  TRANSAK_API_KEY?: string;
  TRANSAK_API_SECRET?: string;
  /** Domain registered with Transak (default: API_PUBLIC_URL's host). */
  TRANSAK_REFERRER_DOMAIN?: string;
  /** Optional Expo access token (enhanced push security). */
  EXPO_ACCESS_TOKEN?: string;
  /** MCP worker base URL for local development (deployed: the MCP service binding). */
  MCP_INTERNAL_URL?: string;
  /** Service binding to the zyropay-mcp worker (agent revocation push). */
  MCP?: Fetcher;
  /** Error monitoring (docs/MONITORING.md). Unset = Sentry off. */
  SENTRY_DSN_API?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  /** Cloudflare Queue for async stages (signing/broadcast, confirmations, push, webhooks). */
  JOBS?: Queue<QueueMessage>;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface AppConfig {
  readonly mode: ZyroPayMode;
  readonly useMocks: boolean;
  readonly apiPublicUrl: string;
  readonly deepLinkScheme: string;
  readonly databaseUrl: string | null;
  readonly databaseDriver: "neon" | "pg";
  readonly turnkey: {
    readonly apiBaseUrl: string;
    readonly organizationId: string;
    readonly apiPublicKey: string;
    readonly apiPrivateKey: string;
  } | null;
  /** Turnkey base URL used to validate stamped request URLs (also in mock mode). */
  readonly turnkeyApiBaseUrl: string;
  readonly delegatedKeyEncryptionKey: string | null;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly auditIpSalt: string;
  readonly internalTokens: readonly string[];
  readonly webhookSecrets: {
    readonly helius: string | null;
    readonly alchemy: string | null;
    readonly transak: string | null;
  };
  readonly priceMaxAgeSeconds: number;
  readonly connectionCodeTtlSeconds: number;
  readonly corsAllowedOrigins: readonly string[];
  readonly agentRequestTtlSeconds: number;
  readonly adapters: AdapterConfig;
  readonly mcpInternalUrl: string | null;
  readonly appSendTtlSeconds: number;
  readonly rateLimits: {
    readonly auth: RateLimitRule;
    readonly user: RateLimitRule;
    readonly internal: RateLimitRule;
    readonly webhook: RateLimitRule;
    readonly connectionClaim: RateLimitRule;
  };
}

export interface AdapterConfig {
  /**
   * Helius keys in failover order (HELIUS_API_KEY, HELIUS_API_KEY_SECONDARY, HELIUS_API_KEYS),
   * deduplicated. Empty => Solana is not configured. See key-failover.ts in
   * @zyropay/blockchain for the cooldown behaviour.
   */
  readonly heliusApiKeys: readonly string[];
  readonly alchemyApiKey: string | null;
  /**
   * Blockfrost project id for THIS mode's Cardano network (mainnet in production, preprod
   * in development); the other network's id is ignored. Null => Cardano is not served by
   * this deployment (its requests fail NETWORK_NOT_SUPPORTED, its balances are omitted).
   */
  readonly blockfrostProjectId: string | null;
  readonly cardanoConfirmations: number;
  readonly evmConfirmations: number;
  readonly solanaCommitment: "processed" | "confirmed" | "finalized";
  readonly coingeckoApiKey: string | null;
  readonly coingeckoPlan: "demo" | "pro";
  /** VALUE_TESTNETS_AT_MAINNET_PRICES: development only, never true in production. */
  readonly priceTestnetProxy: boolean;
  readonly jupiterApiKey: string | null;
  readonly x402Caps: Readonly<Partial<Record<AssetId, string>>>;
  readonly x402MaxTimeoutSeconds: number;
  readonly enableComingSoonPlugins: boolean;
  readonly transak: {
    readonly environment: "STAGING" | "PRODUCTION";
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly referrerDomain: string;
  } | null;
  readonly expoAccessToken: string | null;
}

const X402CapsSchema = z.record(AssetIdSchema, BaseUnitAmountSchema);

function parseX402Caps(raw: string | undefined): Partial<Record<AssetId, string>> {
  if (raw === undefined || raw.trim() === "") return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError("X402_CAPS must be a JSON object {assetId: baseUnits}");
  }
  const parsed = X402CapsSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError("X402_CAPS must map asset ids to base-unit integer strings");
  }
  return parsed.data;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function int(value: string | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be a positive integer`);
  const n = Number(value);
  if (n < min) throw new ConfigError(`${name} must be >= ${min}`);
  return n;
}

const opt = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

/** Helius keys are UUIDs; anything else (spaces, quotes, URLs) is a paste error. */
const HELIUS_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

/** Ordered, deduplicated Helius key list. Never echoes a value in an error. */
export function parseHeliusKeys(env: Env): string[] {
  const sources: Array<[string, string | undefined]> = [
    ["HELIUS_API_KEY", env.HELIUS_API_KEY],
    ["HELIUS_API_KEY_SECONDARY", env.HELIUS_API_KEY_SECONDARY],
    ["HELIUS_API_KEYS", env.HELIUS_API_KEYS],
  ];
  const keys: string[] = [];
  for (const [name, raw] of sources) {
    if (raw === undefined) continue;
    const parts = name === "HELIUS_API_KEYS" ? raw.split(",") : [raw];
    for (const part of parts) {
      const key = part.trim();
      if (key === "") continue;
      if (!HELIUS_KEY_RE.test(key)) {
        throw new ConfigError(`${name} must be a Helius API key (letters, digits and dashes)`);
      }
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Networks this deployment actually serves: the mode's networks, minus Cardano when no
 * Blockfrost project id is configured (mock adapters serve every mode network).
 */
export function servedNetworks(config: AppConfig): readonly NetworkId[] {
  return networksForMode(config.mode).filter(
    (n) =>
      chainFamilyOf(n) !== "cardano" ||
      config.useMocks ||
      config.adapters.blockfrostProjectId !== null,
  );
}

/**
 * Strict mainnet/testnet separation for Cardano: production reads only the MAINNET project
 * id, development only the PREPROD one, and a project id must belong to its network
 * (Blockfrost ids start with the network name). A mismatch refuses to start.
 */
function blockfrostProjectIdFor(mode: ZyroPayMode, env: Env): string | null {
  const [value, prefix, name] =
    mode === "production"
      ? [opt(env.BLOCKFROST_PROJECT_ID_MAINNET), "mainnet", "BLOCKFROST_PROJECT_ID_MAINNET"]
      : [opt(env.BLOCKFROST_PROJECT_ID_PREPROD), "preprod", "BLOCKFROST_PROJECT_ID_PREPROD"];
  if (value === null) return null;
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9]{16,64}$/.test(value)) {
    throw new ConfigError(`${name} must be a Blockfrost ${prefix} project id`);
  }
  return value;
}

function parseFlag(value: string | undefined, name: string): boolean | null {
  if (value === undefined || value.trim() === "") return null;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ConfigError(`${name} must be true or false`);
}

/**
 * VALUE_TESTNETS_AT_MAINNET_PRICES (alias PRICE_TESTNET_PROXY). Development defaults to true so
 * testnet USD limits, the autonomous-mode envelope and the app's values work; production
 * defaults to false and refuses to start if either variable says true (mainnets only: there is
 * nothing to proxy, and a proxy there would be a configuration error).
 */
function parseTestnetValuation(mode: ZyroPayMode, env: Env): boolean {
  const primary = parseFlag(
    env.VALUE_TESTNETS_AT_MAINNET_PRICES,
    "VALUE_TESTNETS_AT_MAINNET_PRICES",
  );
  const alias = parseFlag(env.PRICE_TESTNET_PROXY, "PRICE_TESTNET_PROXY");
  if (primary !== null && alias !== null && primary !== alias) {
    throw new ConfigError("VALUE_TESTNETS_AT_MAINNET_PRICES and PRICE_TESTNET_PROXY disagree");
  }
  const explicit = primary ?? alias;
  if (mode === "production") {
    if (explicit === true) {
      throw new ConfigError("VALUE_TESTNETS_AT_MAINNET_PRICES is development only");
    }
    return false;
  }
  return explicit ?? true;
}

/**
 * Parse and validate the environment. Fails closed:
 *  - unknown mode, or mocks in production => refuse to start;
 *  - production without Turnkey, DB, internal token, key-encryption key or IP salt => refuse.
 */
export function parseConfig(env: Env): AppConfig {
  const modeParsed = ZyroPayModeSchema.safeParse(env.ZYROPAY_MODE ?? "development");
  if (!modeParsed.success) throw new ConfigError("ZYROPAY_MODE must be development or production");
  const mode = modeParsed.data;
  const useMocks = (env.ZYROPAY_USE_MOCK_ADAPTERS ?? "false").toLowerCase() === "true";
  if (mode === "production" && useMocks) {
    throw new ConfigError("mock adapters are refused in production (ZYROPAY_USE_MOCK_ADAPTERS)");
  }

  const turnkeyApiBaseUrl = env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com";
  const tk = {
    organizationId: opt(env.TURNKEY_ORGANIZATION_ID),
    apiPublicKey: opt(env.TURNKEY_API_PUBLIC_KEY),
    apiPrivateKey: opt(env.TURNKEY_API_PRIVATE_KEY),
  };
  const turnkey =
    tk.organizationId !== null && tk.apiPublicKey !== null && tk.apiPrivateKey !== null
      ? {
          apiBaseUrl: turnkeyApiBaseUrl,
          organizationId: tk.organizationId,
          apiPublicKey: tk.apiPublicKey,
          apiPrivateKey: tk.apiPrivateKey,
        }
      : null;

  const internalTokens = [
    opt(env.INTERNAL_SERVICE_TOKEN),
    opt(env.INTERNAL_SERVICE_TOKEN_PREVIOUS),
  ].filter((t): t is string => t !== null);
  for (const t of internalTokens) {
    if (t.length < 32)
      throw new ConfigError("INTERNAL_SERVICE_TOKEN must be at least 32 characters");
  }

  const apiPublicUrl = env.API_PUBLIC_URL ?? "http://localhost:8787";
  const transakEnv = env.TRANSAK_ENVIRONMENT ?? (mode === "production" ? "PRODUCTION" : "STAGING");
  if (transakEnv !== "STAGING" && transakEnv !== "PRODUCTION") {
    throw new ConfigError("TRANSAK_ENVIRONMENT must be STAGING or PRODUCTION");
  }
  if ((transakEnv === "PRODUCTION") !== (mode === "production")) {
    throw new ConfigError(
      "TRANSAK_ENVIRONMENT must be PRODUCTION exactly when ZYROPAY_MODE=production",
    );
  }
  const transakKey = opt(env.TRANSAK_API_KEY);
  const transakSecret = opt(env.TRANSAK_API_SECRET);
  const commitment = env.SOLANA_COMMITMENT ?? "confirmed";
  if (commitment !== "processed" && commitment !== "confirmed" && commitment !== "finalized") {
    throw new ConfigError("SOLANA_COMMITMENT must be processed, confirmed or finalized");
  }
  const coingeckoPlan = env.COINGECKO_PLAN ?? "demo";
  if (coingeckoPlan !== "demo" && coingeckoPlan !== "pro") {
    throw new ConfigError("COINGECKO_PLAN must be demo or pro");
  }
  const priceTestnetProxy = parseTestnetValuation(mode, env);
  const adapters: AdapterConfig = {
    heliusApiKeys: parseHeliusKeys(env),
    alchemyApiKey: opt(env.ALCHEMY_API_KEY),
    blockfrostProjectId: blockfrostProjectIdFor(mode, env),
    cardanoConfirmations: int(env.CARDANO_CONFIRMATIONS, 3, "CARDANO_CONFIRMATIONS"),
    evmConfirmations: int(env.EVM_CONFIRMATIONS, 2, "EVM_CONFIRMATIONS"),
    solanaCommitment: commitment,
    coingeckoApiKey: opt(env.COINGECKO_API_KEY),
    coingeckoPlan,
    priceTestnetProxy,
    jupiterApiKey: opt(env.JUPITER_API_KEY),
    x402Caps: parseX402Caps(env.X402_CAPS),
    x402MaxTimeoutSeconds: int(env.X402_MAX_TIMEOUT_SECONDS, 600, "X402_MAX_TIMEOUT_SECONDS"),
    enableComingSoonPlugins: (env.PLUGINS_ENABLE_COMING_SOON ?? "false").toLowerCase() === "true",
    transak:
      transakKey !== null && transakSecret !== null
        ? {
            environment: transakEnv,
            apiKey: transakKey,
            apiSecret: transakSecret,
            referrerDomain: opt(env.TRANSAK_REFERRER_DOMAIN) ?? new URL(apiPublicUrl).hostname,
          }
        : null,
    expoAccessToken: opt(env.EXPO_ACCESS_TOKEN),
  };
  const auditIpSalt = opt(env.AUDIT_IP_HASH_SALT);
  const databaseDriver = env.DATABASE_DRIVER ?? "neon";
  if (databaseDriver !== "neon" && databaseDriver !== "pg")
    throw new ConfigError("DATABASE_DRIVER must be neon or pg");
  if (databaseDriver === "pg" && mode === "production")
    throw new ConfigError("DATABASE_DRIVER=pg is for local development only");

  if (mode === "production") {
    const missing: string[] = [];
    if (turnkey === null) missing.push("TURNKEY_*");
    if (opt(env.DATABASE_URL) === null) missing.push("DATABASE_URL");
    if (internalTokens.length === 0) missing.push("INTERNAL_SERVICE_TOKEN");
    if (opt(env.DELEGATED_KEY_ENCRYPTION_KEY) === null)
      missing.push("DELEGATED_KEY_ENCRYPTION_KEY");
    if (auditIpSalt === null) missing.push("AUDIT_IP_HASH_SALT");
    if (!apiPublicUrl.startsWith("https://")) missing.push("API_PUBLIC_URL (https)");
    if (!turnkeyApiBaseUrl.startsWith("https://")) missing.push("TURNKEY_API_BASE_URL (https)");
    if (missing.length > 0)
      throw new ConfigError(`production config incomplete: ${missing.join(", ")}`);
  }

  return {
    mode,
    useMocks,
    apiPublicUrl,
    deepLinkScheme: env.APP_DEEP_LINK_SCHEME ?? "zyropay",
    databaseUrl: opt(env.DATABASE_URL),
    databaseDriver,
    turnkey,
    turnkeyApiBaseUrl,
    delegatedKeyEncryptionKey: opt(env.DELEGATED_KEY_ENCRYPTION_KEY),
    accessTokenTtlSeconds: int(
      env.SESSION_ACCESS_TOKEN_TTL_SECONDS,
      900,
      "SESSION_ACCESS_TOKEN_TTL_SECONDS",
      60,
    ),
    refreshTokenTtlSeconds: int(
      env.SESSION_REFRESH_TOKEN_TTL_SECONDS,
      2_592_000,
      "SESSION_REFRESH_TOKEN_TTL_SECONDS",
      300,
    ),
    auditIpSalt: auditIpSalt ?? "development-only-ip-salt",
    internalTokens,
    webhookSecrets: {
      helius: opt(env.HELIUS_WEBHOOK_SECRET),
      alchemy: opt(env.ALCHEMY_WEBHOOK_SIGNING_KEY),
      transak: opt(env.TRANSAK_WEBHOOK_SECRET),
    },
    priceMaxAgeSeconds: int(env.PRICE_MAX_AGE_SECONDS, 120, "PRICE_MAX_AGE_SECONDS"),
    connectionCodeTtlSeconds: int(
      env.AGENT_CONNECTION_CODE_TTL_SECONDS,
      600,
      "AGENT_CONNECTION_CODE_TTL_SECONDS",
      60,
    ),
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    agentRequestTtlSeconds: 15 * 60,
    adapters,
    mcpInternalUrl: opt(env.MCP_INTERNAL_URL),
    appSendTtlSeconds: 10 * 60,
    rateLimits: {
      auth: { limit: 20, windowSeconds: 60 },
      user: { limit: 120, windowSeconds: 60 },
      internal: { limit: 120, windowSeconds: 60 },
      webhook: { limit: 600, windowSeconds: 60 },
      connectionClaim: { limit: 10, windowSeconds: 300 },
    },
  };
}

/**
 * Everything the real (non-mock) adapters need. Called at startup and by /health, so a
 * deployment without its credentials refuses to serve with a message naming what is
 * missing (never a value). Mock mode (development only) needs none of it.
 */
export function assertRuntimeConfig(config: AppConfig): void {
  if (config.useMocks) return;
  const missing: string[] = [];
  if (config.turnkey === null)
    missing.push("TURNKEY_ORGANIZATION_ID/TURNKEY_API_PUBLIC_KEY/TURNKEY_API_PRIVATE_KEY");
  if (config.databaseUrl === null) missing.push("DATABASE_URL");
  if (config.adapters.heliusApiKeys.length === 0) missing.push("HELIUS_API_KEY");
  if (config.adapters.alchemyApiKey === null) missing.push("ALCHEMY_API_KEY");
  if (config.mode === "production" && config.adapters.coingeckoApiKey === null)
    missing.push("COINGECKO_API_KEY");
  if (missing.length > 0) {
    throw new ConfigError(
      `real adapters are not configured: missing ${missing.join(", ")}` +
        (config.mode === "development"
          ? " (or set ZYROPAY_USE_MOCK_ADAPTERS=true for simulated adapters in development)"
          : ""),
    );
  }
}
