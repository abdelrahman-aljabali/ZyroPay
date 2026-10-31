/*
 * Composition root: the ONLY place where port implementations are chosen.
 *
 *  - ZYROPAY_USE_MOCK_ADAPTERS=true (development only; parseConfig refuses it in production):
 *    Mock* adapters, every result labelled simulated, plus MockTurnkey when no Turnkey org
 *    is configured.
 *  - Otherwise the real adapters from @zyropay/blockchain and @zyropay/integrations, wired
 *    from env. assertRuntimeConfig refuses to start without their credentials (fail closed):
 *    there is no silent fallback from a missing key to a mock or a public RPC.
 */
import type {
  Broadcaster,
  NetworkId,
  OnrampProvider,
  PluginAdapter,
  PortfolioProvider,
  PriceHistoryProvider,
  PriceProvider,
} from "@zyropay/shared";
import { cardanoPaymentKeyHash, chainFamilyOf, networksForMode } from "@zyropay/shared";
import type { ChainError, HttpOptions, NetworkTrackingConfig } from "@zyropay/blockchain";
import {
  assertSignedMatchesUnsigned,
  attachCardanoWitness,
  BlockfrostClient,
  createCardanoBroadcaster,
  createCardanoPortfolioProvider,
  createCardanoTransactionBuilder,
  createCompositePortfolioProvider,
  decodeCardanoTx,
  createConfirmationTracker,
  heliusKeyPool,
  createEvmBroadcaster,
  createEvmPortfolioProvider,
  createEvmTransactionBuilder,
  createPriceHistoryProvider,
  createPriceProvider,
  createSolanaBroadcaster,
  createSolanaPortfolioProvider,
  createSolanaTransactionBuilder,
  normalizeSignedTransaction,
  rpcUrlFor,
  txHashOfSigned,
} from "@zyropay/blockchain";
import {
  createAaveAdapter,
  createExpoNotifier,
  createHyperliquidAdapter,
  createJupiterAdapter,
  createKaminoAdapter,
  createMemoryTokenStore,
  createPluginRegistry,
  cardanoPaymentPayload,
  createTransakOnrampProvider,
  createX402Adapter,
  createMasumiRegistryClient,
  createMemoryRegistryCache,
} from "@zyropay/integrations";
import type { MasumiRegistryCache, MasumiRegistryClient } from "@zyropay/integrations";
import { hexToBytes, MockTurnkey, TurnkeyClient } from "@zyropay/wallet";
import type { TurnkeyGateway } from "@zyropay/wallet";
import type { AllowanceChain, ChainAdapters, EscrowChain, NetworkBuilder } from "./chain";
import { createRealAllowanceChain } from "./allowance-chain";
import { createRealEscrowChain } from "./escrow-chain";
import type { Db } from "./db/client";
import { createWorkerDb } from "./db/client";
import type { AppDeps } from "./deps";
import { systemClock } from "./deps";
import type { AppConfig, Env } from "./env";
import { assertRuntimeConfig, ConfigError, parseConfig } from "./env";
import { uuidV7 } from "./lib/crypto";
import { AppError } from "./lib/errors";
import type { Logger } from "./lib/logger";
import { createLogger } from "./lib/logger";
import type { JobQueue } from "./queue/messages";
import { CloudflareQueue } from "./queue/messages";
import { resolveDelegatedKey } from "./services/execution";
import { activePushTokens, deactivatePushTokens } from "./services/notifications";
import { createMcpClient } from "./services/mcp";
import { createDbTokenStore } from "./services/provider-credentials";
import {
  createMockChainAdapters,
  createMockMasumiRegistry,
  MockBroadcaster,
  MockNotifier,
  MockOnrampProvider,
  MockPluginAdapter,
  MockPortfolioProvider,
  MockPriceHistoryProvider,
  MockPriceProvider,
} from "./providers/mocks";

/** Process-wide mock Turnkey (dev only): keeps auto-provisioned dev sub-orgs per isolate. */
let devTurnkey: MockTurnkey | null = null;

/**
 * Process-wide mock broadcaster (dev only). The mock tracker confirms only hashes this
 * broadcaster actually sent, and deps are rebuilt per request and per queue batch: with a
 * fresh broadcaster each time, the `confirm` job never found the broadcast and re-queued
 * forever, so agent payments under `wrangler dev` never reached CONFIRMED.
 */
let devBroadcaster: MockBroadcaster | null = null;
/** Mock-mode registry, shared across requests like the dev broadcaster. */
let devMasumiRegistry: MasumiRegistryClient | null = null;

function buildTurnkey(config: AppConfig, depsRef: () => AppDeps): TurnkeyGateway {
  if (config.turnkey !== null) {
    return new TurnkeyClient({
      apiBaseUrl: config.turnkey.apiBaseUrl,
      parentOrganizationId: config.turnkey.organizationId,
      parentApiPublicKey: config.turnkey.apiPublicKey,
      parentApiPrivateKey: config.turnkey.apiPrivateKey,
      resolveDelegatedKey: (subOrgId) => resolveDelegatedKey(depsRef(), subOrgId),
    });
  }
  if (config.mode === "development" && config.useMocks) {
    // Local development without a Turnkey org: passkey credentials named `dev-*` are
    // accepted by the mock. NEVER reachable in production (parseConfig refuses mocks).
    devTurnkey ??= new MockTurnkey({
      apiBaseUrl: config.turnkeyApiBaseUrl,
      autoProvisionDevCredentials: true,
    });
    devTurnkey.setDelegatedKeyResolver((subOrgId) => resolveDelegatedKey(depsRef(), subOrgId));
    return devTurnkey;
  }
  throw new ConfigError("Turnkey is not configured (TURNKEY_ORGANIZATION_ID / TURNKEY_API_*)");
}

// ---------------------------------------------------------------------------------------
// Real adapters
// ---------------------------------------------------------------------------------------

/** Wrap a ChainError in an AppError with the same (shared) code, so it maps to HTTP. */
function unsupported(network: NetworkId): AppError {
  return new AppError("NETWORK_NOT_SUPPORTED", `${network} is not available in this deployment`);
}

/**
 * HTTP options for every adapter that may call Helius: a fetch that fails over between the
 * configured Helius keys (401/403/429 "max usage reached" => next key, cooldown in this
 * isolate). Requests to other hosts pass through unchanged. Events name the key's index,
 * never the key.
 */
function heliusHttp(config: AppConfig, logger?: Logger): HttpOptions {
  const keys = config.adapters.heliusApiKeys;
  if (keys.length === 0) return {};
  const pool = heliusKeyPool(
    keys,
    logger === undefined
      ? {}
      : {
          onEvent: (e) => {
            logger.warn("helius.key_failover", { ...e });
          },
        },
  );
  return { fetch: pool.wrap((input, init) => fetch(input, init)) };
}

function rpcUrls(config: AppConfig): Map<NetworkId, string> {
  const keys = {
    heliusApiKey: config.adapters.heliusApiKeys,
    alchemyApiKey: config.adapters.alchemyApiKey ?? "",
  };
  const urls = new Map<NetworkId, string>();
  for (const network of networksForMode(config.mode)) {
    // Cardano is reached through Blockfrost (cardanoNetwork below), not a JSON-RPC URL.
    if (chainFamilyOf(network) === "cardano") continue;
    try {
      urls.set(network, rpcUrlFor(network, keys));
    } catch (error) {
      throw new ConfigError(
        `no RPC for ${network}: ${(error as ChainError | Error).message}`.slice(0, 200),
      );
    }
  }
  return urls;
}

/**
 * Blockfrost calls on an interactive request path (an agent's quote, an escrow refund): the
 * MCP worker gives the API 10 s, so a hung provider fails fast instead of eating the budget
 * (default: 10 s per attempt, 2 retries). One retry still absorbs a transient 5xx / 429.
 */
const BLOCKFROST_REQUEST_HTTP = { timeoutMs: 4_000, maxRetries: 1 } as const;

/** Network-bound real builders/broadcasters behind one router (ChainAdapters). */
function createRealChainAdapters(config: AppConfig, logger?: Logger): ChainAdapters {
  const urls = rpcUrls(config);
  const http = heliusHttp(config, logger);
  const builders = new Map<NetworkId, NetworkBuilder>();
  const broadcasters = new Map<NetworkId, Broadcaster>();
  const escrows = new Map<NetworkId, EscrowChain>();
  const allowances = new Map<NetworkId, AllowanceChain>();
  for (const [network, rpcUrl] of urls) {
    if (chainFamilyOf(network) === "solana") {
      builders.set(network, createSolanaTransactionBuilder({ ...http, rpcUrl, network }));
      broadcasters.set(
        network,
        createSolanaBroadcaster({
          ...http,
          rpcUrl,
          network,
          commitment: config.adapters.solanaCommitment,
        }),
      );
    } else {
      builders.set(network, createEvmTransactionBuilder({ rpcUrl, network }));
      broadcasters.set(
        network,
        createEvmBroadcaster({
          rpcUrl,
          network,
          confirmations: config.adapters.evmConfirmations,
        }),
      );
    }
  }
  const tracking: Partial<Record<NetworkId, NetworkTrackingConfig>> = Object.fromEntries(
    [...urls].map(([network, rpcUrl]) => [
      network,
      {
        rpcUrl,
        confirmations: config.adapters.evmConfirmations,
        commitment: config.adapters.solanaCommitment,
      },
    ]),
  );
  const cardano = cardanoNetwork(config);
  if (cardano !== null) {
    const { network, blockfrostProjectId } = cardano;
    builders.set(
      network,
      createCardanoTransactionBuilder({ ...BLOCKFROST_REQUEST_HTTP, blockfrostProjectId, network }),
    );
    broadcasters.set(
      network,
      createCardanoBroadcaster({
        blockfrostProjectId,
        network,
        confirmations: config.adapters.cardanoConfirmations,
      }),
    );
    tracking[network] = {
      blockfrostProjectId,
      confirmations: config.adapters.cardanoConfirmations,
    };
    allowances.set(
      network,
      createRealAllowanceChain({ network, blockfrostProjectId, http: BLOCKFROST_REQUEST_HTTP }),
    );
    const broadcaster = broadcasters.get(network);
    // No `http`: Helius key rotation is irrelevant to Blockfrost, and the global fetch lets
    // these clients share the per-isolate genesis / protocol-parameter memo.
    if (broadcaster !== undefined)
      escrows.set(
        network,
        createRealEscrowChain({
          network,
          blockfrostProjectId,
          broadcaster,
          http: BLOCKFROST_REQUEST_HTTP,
        }),
      );
  }
  const tracker = createConfirmationTracker({ ...http, networks: tracking });
  return {
    builder(network) {
      const builder = builders.get(network);
      if (builder === undefined) throw unsupported(network);
      return builder;
    },
    broadcaster(network) {
      const broadcaster = broadcasters.get(network);
      if (broadcaster === undefined) throw unsupported(network);
      return broadcaster;
    },
    cardanoEscrow(network) {
      const escrow = escrows.get(network);
      if (escrow === undefined) throw unsupported(network);
      return escrow;
    },
    cardanoAllowance(network) {
      const allowance = allowances.get(network);
      if (allowance === undefined) throw unsupported(network);
      return allowance;
    },
    track: (input) => tracker.track(input),
    normalizeSigned: (input) => normalizeSignedTransaction(input),
    txHashOf: (input) => txHashOfSigned(input),
    assertSignedMatchesUnsigned: ({ network, encoding, signed, unsigned, expectedSigner }) =>
      assertSignedMatchesUnsigned({ network, encoding, signed, unsigned, expectedSigner }),
    cardanoSigningPayload: ({ network, unsigned }) => {
      if (chainFamilyOf(network) !== "cardano") throw unsupported(network);
      const tx = decodeCardanoTx(hexToBytes(unsigned.replace(/^0x/, "")), { strict: true });
      // Unsigned: no witnesses, or (escrow script spend) only redeemers (5) and scripts (7).
      if (tx.witnessKeys.some((k) => k !== 5 && k !== 7))
        throw new Error("stored Cardano transaction is signed");
      return tx.bodyHash;
    },
    attachCardanoWitness: ({ network, unsigned, publicKey, signature, expectedSigner }) => {
      if (chainFamilyOf(network) !== "cardano") throw unsupported(network);
      const keyHash = cardanoPaymentKeyHash(expectedSigner);
      if (keyHash === null) throw new Error("sender is not a Cardano key address");
      const { signedTransaction } = attachCardanoWitness({
        unsignedHex: unsigned,
        publicKey,
        signature,
        expectedKeyHash: keyHash,
      });
      return { signedTransaction, encoding: "hex" };
    },
    cardanoX402Payment: ({ network, signedTransaction }) => {
      if (chainFamilyOf(network) !== "cardano") throw unsupported(network);
      return cardanoPaymentPayload(signedTransaction);
    },
  };
}

/** This deployment's Cardano network and its Blockfrost project id, or null if not served. */
function cardanoNetwork(
  config: AppConfig,
): { network: NetworkId; blockfrostProjectId: string } | null {
  const blockfrostProjectId = config.adapters.blockfrostProjectId;
  const network = networksForMode(config.mode).find((n) => chainFamilyOf(n) === "cardano");
  return blockfrostProjectId === null || network === undefined
    ? null
    : { network, blockfrostProjectId };
}

/**
 * fetch for the price sources that logs failed upstream answers (host, path, status; never
 * the query string or headers, which can carry keys). Prices fail closed silently otherwise.
 */
function loggedPriceFetch(logger: Logger | undefined): HttpOptions {
  if (logger === undefined) return {};
  return {
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (!res.ok) {
        const url = new URL(input);
        logger.warn("price.source_error", {
          host: url.host,
          path: url.pathname,
          status: res.status,
        });
      }
      return res;
    },
  };
}

function createRealPrices(config: AppConfig, logger?: Logger): PriceProvider {
  const { adapters } = config;
  return createPriceProvider({
    ...loggedPriceFetch(logger),
    ...(adapters.coingeckoApiKey !== null ? { coingeckoApiKey: adapters.coingeckoApiKey } : {}),
    coingeckoPlan: adapters.coingeckoPlan,
    ...(adapters.jupiterApiKey !== null ? { jupiterApiKey: adapters.jupiterApiKey } : {}),
    maxAgeSeconds: config.priceMaxAgeSeconds,
    valueTestnetsAtMainnetPrices: adapters.priceTestnetProxy,
  });
}

function createRealPriceHistory(config: AppConfig, logger?: Logger): PriceHistoryProvider {
  const { adapters } = config;
  return createPriceHistoryProvider({
    ...loggedPriceFetch(logger),
    ...(adapters.coingeckoApiKey !== null ? { coingeckoApiKey: adapters.coingeckoApiKey } : {}),
    coingeckoPlan: adapters.coingeckoPlan,
    valueTestnetsAtMainnetPrices: adapters.priceTestnetProxy,
  });
}

function createRealPortfolio(
  config: AppConfig,
  prices: PriceProvider,
  logger?: Logger,
): PortfolioProvider {
  const http = heliusHttp(config, logger);
  const byNetwork: Partial<Record<NetworkId, PortfolioProvider>> = {};
  const cardano = cardanoNetwork(config);
  if (cardano !== null) {
    byNetwork[cardano.network] = createCardanoPortfolioProvider({
      blockfrostProjectId: cardano.blockfrostProjectId,
      network: cardano.network,
      priceProvider: prices,
    });
  }
  for (const network of networksForMode(config.mode)) {
    if (chainFamilyOf(network) === "cardano") continue;
    byNetwork[network] =
      chainFamilyOf(network) === "solana"
        ? createSolanaPortfolioProvider({
            ...http,
            heliusApiKey: config.adapters.heliusApiKeys,
            network,
            priceProvider: prices,
          })
        : createEvmPortfolioProvider({
            alchemyApiKey: config.adapters.alchemyApiKey ?? "",
            network,
            priceProvider: prices,
          });
  }
  return createCompositePortfolioProvider({ byNetwork, priceProvider: prices });
}

/**
 * Registry reads per isolate: immutable metadata for a week, liveness (listing, holder) for
 * a minute. Module scope, so it outlives one request (Workers reuse isolates).
 */
let registryCache: MasumiRegistryCache | null = null;

/** The Masumi registry of the served Cardano network (reads Blockfrost), or null. */
function createRealMasumiRegistry(config: AppConfig): MasumiRegistryClient | null {
  const cardano = cardanoNetwork(config);
  if (cardano === null) return null;
  registryCache ??= createMemoryRegistryCache({ maxEntries: 5_000 });
  return createMasumiRegistryClient({
    network: cardano.network,
    blockfrostProjectId: cardano.blockfrostProjectId,
    cache: registryCache,
    // Runs inside an agent's quote and find_agents (MCP gives the API 10 s): fail fast, one
    // retry; a cold discovery scan (up to 100 metadata reads) runs 8 wide (Blockfrost
    // allows bursts far above that) so it fits the budget.
    timeoutMs: 4_000,
    maxRetries: 1,
    concurrency: 8,
  });
}

/** Real plugin adapters for this mode, through the integrations registry. */
function createRealPlugins(
  config: AppConfig,
  masumiRegistry: MasumiRegistryClient | null,
  logger?: Logger,
): Record<string, PluginAdapter> {
  const urls = rpcUrls(config);
  const http = heliusHttp(config, logger);
  const solanaUrls: Partial<Record<NetworkId, string>> = {};
  const evmUrls: Partial<Record<NetworkId, string>> = {};
  for (const [network, url] of urls) {
    if (chainFamilyOf(network) === "solana") solanaUrls[network] = url;
    else evmUrls[network] = url;
  }
  const cardano = cardanoNetwork(config);
  // Masumi lock collateral depends on the live min-UTxO price of the served Cardano network.
  let cardanoCoinsPerUtxoByte: ((network: NetworkId) => Promise<bigint>) | undefined;
  if (cardano !== null) {
    const params = new BlockfrostClient({
      ...BLOCKFROST_REQUEST_HTTP,
      projectId: cardano.blockfrostProjectId,
      network: cardano.network,
    });
    cardanoCoinsPerUtxoByte = async (network) => {
      if (network !== cardano.network) throw new Error(`${network} is not served`);
      return (await params.protocolParams()).coinsPerUtxoByte;
    };
  }
  const adapters: PluginAdapter[] = [
    createX402Adapter({
      ...http,
      caps: config.adapters.x402Caps,
      solanaRpcUrls: solanaUrls,
      maxTimeoutSeconds: config.adapters.x402MaxTimeoutSeconds,
      ...(cardanoCoinsPerUtxoByte !== undefined ? { cardanoCoinsPerUtxoByte } : {}),
      masumiRegistry: (network) =>
        masumiRegistry !== null && masumiRegistry.network === network ? masumiRegistry : null,
    }),
    createAaveAdapter({ rpcUrls: evmUrls }),
    createHyperliquidAdapter({
      environment: config.mode === "production" ? "mainnet" : "testnet",
    }),
  ];
  const mainnetSolana = solanaUrls["solana-mainnet"];
  if (config.mode === "production" && mainnetSolana !== undefined) {
    // Jupiter and Kamino are mainnet-only. Jupiter needs an API key (no keyless fallback).
    if (config.adapters.jupiterApiKey !== null) {
      adapters.push(
        createJupiterAdapter({
          ...http,
          apiKey: config.adapters.jupiterApiKey,
          rpcUrl: mainnetSolana,
        }),
      );
    }
    adapters.push(createKaminoAdapter({ ...http, rpcUrl: mainnetSolana }));
  }
  const registry = createPluginRegistry(adapters, {
    mode: config.mode,
    enableComingSoon: config.adapters.enableComingSoonPlugins,
  });
  return Object.fromEntries(registry.list().map((a) => [a.manifest.id, a]));
}

/** Refuses every call: the on-ramp is not configured (no Transak keys). */
const disabledOnramp: OnrampProvider = {
  id: "transak",
  getQuote: () => Promise.reject(new AppError("UPSTREAM_UNAVAILABLE", "on-ramp is not configured")),
  createSession: () =>
    Promise.reject(new AppError("UPSTREAM_UNAVAILABLE", "on-ramp is not configured")),
  verifyWebhook: () => Promise.resolve(null),
};

function createRealOnramp(config: AppConfig, dbRef: () => Db, logger: Logger): OnrampProvider {
  const transak = config.adapters.transak;
  if (transak === null) return disabledOnramp;
  const kek = config.delegatedKeyEncryptionKey;
  if (kek === null) {
    logger.warn("onramp.token_store_memory", {
      reason: "DELEGATED_KEY_ENCRYPTION_KEY unset: Transak token is per isolate",
    });
  }
  return createTransakOnrampProvider({
    apiKey: transak.apiKey,
    apiSecret: transak.apiSecret,
    environment: transak.environment,
    referrerDomain: transak.referrerDomain,
    // Refreshing the partner token invalidates the previous one, so every isolate must
    // share it: encrypted in Postgres (provider_credentials).
    tokenStore: kek !== null ? createDbTokenStore(dbRef, kek, "transak") : createMemoryTokenStore(),
    ...(config.webhookSecrets.transak !== null
      ? { webhookSecret: config.webhookSecrets.transak }
      : {}),
  });
}

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

export interface BuildDepsInput {
  readonly env: Env;
  readonly logger?: Logger;
  readonly queue?: JobQueue;
}

export interface BuiltDeps {
  readonly deps: AppDeps;
  /** Close the DB pool (call via ExecutionContext.waitUntil after the response). */
  readonly dispose: () => Promise<void>;
}

/** Validate everything needed to serve (used by /health and at the start of every entry). */
export function loadRuntimeConfig(env: Env): AppConfig {
  const config = parseConfig(env);
  assertRuntimeConfig(config);
  return config;
}

/** Wire dependencies for one request / queue batch / cron run. The DB connects lazily. */
export function buildDeps(input: BuildDepsInput): BuiltDeps {
  const config = loadRuntimeConfig(input.env);
  const clock = systemClock;
  const now = () => clock.now();
  const logger = input.logger ?? createLogger({ service: "api", mode: config.mode });
  let db: Db | null = null;
  let close: (() => Promise<void>) | null = null;
  const queueBinding = input.env.JOBS;
  const queue =
    input.queue ?? (queueBinding !== undefined ? new CloudflareQueue(queueBinding) : null);
  if (queue === null) throw new ConfigError("JOBS queue binding is missing");
  const dbRef = (): Db => {
    if (db === null) {
      if (config.databaseUrl === null) throw new ConfigError("DATABASE_URL is not set");
      const created = createWorkerDb(config.databaseUrl, config.databaseDriver);
      db = created.db;
      close = created.close;
    }
    return db;
  };

  let adapters: Pick<
    AppDeps,
    | "chain"
    | "portfolio"
    | "prices"
    | "priceHistory"
    | "onramp"
    | "notifier"
    | "plugins"
    | "masumiRegistry"
  >;
  if (config.useMocks) {
    const masumiRegistry = (devMasumiRegistry ??= createMockMasumiRegistry());
    adapters = {
      chain: createMockChainAdapters(now, (devBroadcaster ??= new MockBroadcaster())),
      portfolio: new MockPortfolioProvider(now),
      prices: new MockPriceProvider(now),
      priceHistory: new MockPriceHistoryProvider(now),
      onramp: new MockOnrampProvider(
        config.webhookSecrets.transak ?? "mock-onramp-webhook-secret",
        now,
      ),
      // Simulated pushes are logged so local development (and the e2e smoke) can see them.
      // The payload is the shared PushData: event type, opaque ids and a deep link only.
      notifier: new MockNotifier((n) => {
        logger.info("push.simulated", { kind: n.kind, data: n.data });
      }),
      plugins: {
        x402: new MockPluginAdapter("x402", now, masumiRegistry),
      },
      masumiRegistry,
    };
  } else {
    const prices = createRealPrices(config, logger);
    const masumiRegistry = createRealMasumiRegistry(config);
    adapters = {
      chain: createRealChainAdapters(config, logger),
      prices,
      priceHistory: createRealPriceHistory(config, logger),
      portfolio: createRealPortfolio(config, prices, logger),
      onramp: createRealOnramp(config, dbRef, logger),
      notifier: createExpoNotifier({
        ...(config.adapters.expoAccessToken !== null
          ? { accessToken: config.adapters.expoAccessToken }
          : {}),
        resolveTokens: (userId) => activePushTokens(deps, userId),
        deactivateTokens: (tokens) => deactivatePushTokens(deps, tokens),
        // Expo recommends checking receipts after ~15 minutes.
        onTickets: (tickets) =>
          deps.queue.send(
            { type: "push_receipts", tickets: tickets.slice(0, 100).map((t) => ({ ...t })) },
            { delaySeconds: 900 },
          ),
      }),
      plugins: createRealPlugins(config, masumiRegistry, logger),
      masumiRegistry,
    };
  }

  const deps: AppDeps = {
    config,
    get db(): Db {
      return dbRef();
    },
    turnkey: buildTurnkey(config, () => deps),
    ...adapters,
    queue,
    mcp: createMcpClient({
      binding: input.env.MCP,
      baseUrl: config.mcpInternalUrl,
      serviceToken: config.internalTokens[0] ?? null,
    }),
    clock,
    ids: uuidV7,
    logger,
  };
  return { deps, dispose: () => (close === null ? Promise.resolve() : close()) };
}
