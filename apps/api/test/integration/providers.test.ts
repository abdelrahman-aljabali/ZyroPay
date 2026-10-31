/*
 * Composition root: real adapters from env, mocks only in development, fail closed.
 * No network is touched: building adapters makes no RPC calls.
 */
import { resetHeliusKeyPools } from "@zyropay/blockchain";
import { generateP256ApiKeyPair } from "@zyropay/wallet";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { ConfigError, parseConfig, parseHeliusKeys, servedNetworks } from "../../src/env";
import { buildDeps, loadRuntimeConfig } from "../../src/providers";
import { InMemoryQueue } from "../../src/queue/messages";
import { createLogger, silentLogger } from "../../src/lib/logger";

async function realEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const parent = await generateP256ApiKeyPair();
  return {
    ZYROPAY_MODE: "development",
    ZYROPAY_USE_MOCK_ADAPTERS: "false",
    DATABASE_URL: "postgres://user:pass@localhost:5432/zyropay",
    TURNKEY_ORGANIZATION_ID: "parent-org",
    TURNKEY_API_PUBLIC_KEY: parent.publicKey,
    TURNKEY_API_PRIVATE_KEY: parent.privateKey,
    HELIUS_API_KEY: "helius-key",
    ALCHEMY_API_KEY: "alchemy-key",
    INTERNAL_SERVICE_TOKEN: "internal-test-token-0123456789abcdefghijkl",
    ...overrides,
  };
}

const build = (env: Env) => buildDeps({ env, queue: new InMemoryQueue(), logger: silentLogger });

describe("composition root", () => {
  it("mock mode: a broadcast is confirmable from the deps of a later request or queue batch", async () => {
    const env: Env = {
      ZYROPAY_MODE: "development",
      ZYROPAY_USE_MOCK_ADAPTERS: "true",
      INTERNAL_SERVICE_TOKEN: "internal-test-token-0123456789abcdefghijkl",
    };
    const request = build(env).deps; // e.g. the approve request that broadcast
    const { txHash } = await request.chain
      .broadcaster("solana-devnet")
      .broadcast({ network: "solana-devnet", signedTransaction: "ab".repeat(40), encoding: "hex" });
    const batch = build(env).deps; // the later `confirm` queue batch
    const status = await batch.chain.track({ network: "solana-devnet", txHash });
    expect(status.status).toBe("confirmed");
  });

  it("DATABASE_DRIVER=pg is a development-only local path", () => {
    const base: Env = {
      ZYROPAY_MODE: "development",
      ZYROPAY_USE_MOCK_ADAPTERS: "true",
      DATABASE_URL: "postgres://localhost/zyropay",
    };
    expect(loadRuntimeConfig({ ...base, DATABASE_DRIVER: "pg" }).databaseDriver).toBe("pg");
    expect(loadRuntimeConfig(base).databaseDriver).toBe("neon");
    expect(() => loadRuntimeConfig({ ...base, DATABASE_DRIVER: "mysql" })).toThrow(ConfigError);
    expect(() => loadRuntimeConfig({ ZYROPAY_MODE: "production", DATABASE_DRIVER: "pg" })).toThrow(
      /local development only/,
    );
  });

  it("with mocks off and no credentials, refuses to start and names what is missing", () => {
    const env: Env = { ZYROPAY_MODE: "development", ZYROPAY_USE_MOCK_ADAPTERS: "false" };
    expect(() => loadRuntimeConfig(env)).toThrow(ConfigError);
    expect(() => loadRuntimeConfig(env)).toThrow(
      /TURNKEY_ORGANIZATION_ID.*DATABASE_URL.*HELIUS_API_KEY.*ALCHEMY_API_KEY/,
    );
    expect(() => build(env)).toThrow(ConfigError);
  });

  it("production refuses mocks and requires CoinGecko", async () => {
    expect(() =>
      loadRuntimeConfig({ ZYROPAY_MODE: "production", ZYROPAY_USE_MOCK_ADAPTERS: "true" }),
    ).toThrow(/refused in production/);
    const env = await realEnv({
      ZYROPAY_MODE: "production",
      API_PUBLIC_URL: "https://api.zyropay.example",
      DELEGATED_KEY_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      AUDIT_IP_HASH_SALT: "salt",
    });
    expect(() => loadRuntimeConfig(env)).toThrow(/COINGECKO_API_KEY/);
    expect(() =>
      loadRuntimeConfig({ ...env, COINGECKO_API_KEY: "cg", PRICE_TESTNET_PROXY: "true" }),
    ).toThrow(/development only/);
  });

  it("VALUE_TESTNETS_AT_MAINNET_PRICES: on by default in development, refused in production", async () => {
    const dev = await realEnv();
    expect(loadRuntimeConfig(dev).adapters.priceTestnetProxy).toBe(true);
    expect(
      loadRuntimeConfig({ ...dev, VALUE_TESTNETS_AT_MAINNET_PRICES: "false" }).adapters
        .priceTestnetProxy,
    ).toBe(false);
    expect(
      loadRuntimeConfig({ ...dev, PRICE_TESTNET_PROXY: "false" }).adapters.priceTestnetProxy,
    ).toBe(false);
    expect(() =>
      loadRuntimeConfig({
        ...dev,
        VALUE_TESTNETS_AT_MAINNET_PRICES: "true",
        PRICE_TESTNET_PROXY: "false",
      }),
    ).toThrow(/disagree/);
    expect(() => loadRuntimeConfig({ ...dev, VALUE_TESTNETS_AT_MAINNET_PRICES: "yes" })).toThrow(
      /true or false/,
    );

    const prod = await realEnv({
      ZYROPAY_MODE: "production",
      API_PUBLIC_URL: "https://api.zyropay.example",
      DELEGATED_KEY_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      AUDIT_IP_HASH_SALT: "salt",
      COINGECKO_API_KEY: "cg",
    });
    expect(loadRuntimeConfig(prod).adapters.priceTestnetProxy).toBe(false);
    expect(
      loadRuntimeConfig({ ...prod, VALUE_TESTNETS_AT_MAINNET_PRICES: "false" }).adapters
        .priceTestnetProxy,
    ).toBe(false);
    expect(() => loadRuntimeConfig({ ...prod, VALUE_TESTNETS_AT_MAINNET_PRICES: "true" })).toThrow(
      /development only/,
    );
  });

  it("wires the real adapters per network for the mode, never mocks", async () => {
    const { deps } = build(
      await realEnv({
        X402_CAPS: JSON.stringify({
          "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e": "1000000",
        }),
      }),
    );
    expect(deps.config.useMocks).toBe(false);
    expect(deps.turnkey.simulated).toBe(false);
    for (const network of ["solana-devnet", "ethereum-sepolia", "base-sepolia"] as const) {
      expect(deps.chain.builder(network)).toBeDefined();
      expect(deps.chain.broadcaster(network)).toBeDefined();
    }
    expect(() => deps.chain.builder("solana-mainnet")).toThrow(/not available/);
    expect(
      typeof (
        deps.chain.builder("solana-devnet") as unknown as Record<string, unknown> | undefined
      )?.["rebuildIfExpiring"],
    ).toBe("function");
    expect(
      typeof (
        deps.chain.builder("base-sepolia") as unknown as Record<string, unknown> | undefined
      )?.["getNonceState"],
    ).toBe("function");
    expect(
      typeof (
        deps.chain.builder("base-sepolia") as unknown as Record<string, unknown> | undefined
      )?.["estimateTransferFee"],
    ).toBe("function");
    // Jupiter and Kamino are mainnet-only; x402, Aave and Hyperliquid are registered.
    expect(Object.keys(deps.plugins).sort()).toEqual(["aave", "hyperliquid", "x402"]);
    for (const adapter of Object.values(deps.plugins)) {
      expect((adapter as { simulated?: boolean }).simulated).not.toBe(true);
      expect(
        typeof (adapter as unknown as Record<string, unknown> | undefined)?.["verifyTransaction"],
      ).toBe("function");
    }
    expect(
      typeof (deps.plugins.x402 as unknown as Record<string, unknown> | undefined)?.[
        "buildTypedData"
      ],
    ).toBe("function");
    expect(
      typeof (deps.notifier as unknown as Record<string, unknown> | undefined)?.["checkReceipts"],
    ).toBe("function");
    // No Transak keys: the on-ramp refuses instead of pretending.
    await expect(
      deps.onramp.getQuote({
        fiat: { value: "10", currency: "USD" },
        network: "base-sepolia",
        assetId: "base-sepolia:native",
        walletAddress: "0x52908400098527886E0F7030069857D2E4169EE7",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    // No MCP binding or URL configured.
    expect(deps.mcp).toBeNull();
  });

  it("Cardano: wired only with this mode's Blockfrost project id; strict network separation", async () => {
    const preprod = "preprodAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const mainnet = "mainnetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // No preprod key: Cardano is not served (requests refused, portfolio omits it).
    const without = build(await realEnv({ BLOCKFROST_PROJECT_ID_MAINNET: mainnet })).deps;
    expect(without.config.adapters.blockfrostProjectId).toBeNull();
    expect(() => without.chain.builder("cardano-preprod")).toThrow(/not available/);
    expect(servedNetworks(without.config)).not.toContain("cardano-preprod");
    const withKey = build(await realEnv({ BLOCKFROST_PROJECT_ID_PREPROD: preprod })).deps;
    expect(servedNetworks(withKey.config)).toContain("cardano-preprod");
    const builder = withKey.chain.builder("cardano-preprod");
    expect(builder.family).toBe("cardano");
    expect(typeof builder.estimateTransferFee).toBe("function");
    expect(withKey.chain.broadcaster("cardano-preprod")).toBeDefined();
    expect(() => withKey.chain.builder("cardano-mainnet")).toThrow(/not available/);
    // A key of the other network is refused at startup.
    const crossed = await realEnv({ BLOCKFROST_PROJECT_ID_PREPROD: mainnet });
    expect(() => loadRuntimeConfig(crossed)).toThrow(/BLOCKFROST_PROJECT_ID_PREPROD/);
    expect(() =>
      parseConfig({
        ZYROPAY_MODE: "production",
        BLOCKFROST_PROJECT_ID_MAINNET: preprod,
      }),
    ).toThrow(/BLOCKFROST_PROJECT_ID_MAINNET/);
  });

  it("rejects malformed adapter settings", async () => {
    expect(() => loadRuntimeConfig({ X402_CAPS: "not json" })).toThrow(/X402_CAPS/);
    expect(() => loadRuntimeConfig({ X402_CAPS: '{"base-sepolia:native":"1.5"}' })).toThrow(
      /X402_CAPS/,
    );
    expect(() => loadRuntimeConfig({ TRANSAK_ENVIRONMENT: "PRODUCTION" })).toThrow(/TRANSAK/);
    expect(() => loadRuntimeConfig({ SOLANA_COMMITMENT: "fast" })).toThrow(/SOLANA_COMMITMENT/);
    const env = await realEnv({ MCP_INTERNAL_URL: "http://localhost:8788" });
    expect(build(env).deps.mcp).not.toBeNull();
  });
});

describe("Helius key failover (composition root)", () => {
  const K1 = "11111111-aaaa-4aaa-8aaa-111111111111";
  const K2 = "22222222-bbbb-4bbb-8bbb-222222222222";
  const K3 = "33333333-cccc-4ccc-8ccc-333333333333";
  const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHeliusKeyPools();
  });

  it("reads HELIUS_API_KEY, _SECONDARY and HELIUS_API_KEYS in order, deduplicated", () => {
    expect(
      parseHeliusKeys({
        HELIUS_API_KEY: K1,
        HELIUS_API_KEY_SECONDARY: ` ${K2} `,
        HELIUS_API_KEYS: `${K1}, ${K3},`,
      }),
    ).toEqual([K1, K2, K3]);
    expect(parseHeliusKeys({})).toEqual([]);
  });

  it("refuses a malformed key without echoing it", () => {
    let message = "";
    try {
      parseHeliusKeys({ HELIUS_API_KEY_SECONDARY: `https://devnet.helius-rpc.com/?api-key=${K1}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/HELIUS_API_KEY_SECONDARY must be a Helius API key/);
    expect(message).not.toContain(K1);
  });

  it("only the secondary key configured is enough to start", async () => {
    const env = await realEnv({ HELIUS_API_KEY: "", HELIUS_API_KEY_SECONDARY: K2 });
    expect(loadRuntimeConfig(env).adapters.heliusApiKeys).toEqual([K2]);
  });

  it("a Solana read fails over to the secondary key and logs the index, never the key", async () => {
    const used: string[] = [];
    vi.stubGlobal("fetch", (input: string) => {
      const key = new URL(input).searchParams.get("api-key") ?? "";
      used.push(key);
      if (key === K1) return Promise.resolve(new Response("max usage reached", { status: 429 }));
      const result = { items: [], nativeBalance: { lamports: 7 } };
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })));
    });
    const lines: string[] = [];
    const logger = createLogger({}, (l) => lines.push(l));
    // Prices off: this test counts Helius calls only (the testnet proxy would call Jupiter).
    const env = await realEnv({
      HELIUS_API_KEY: K1,
      HELIUS_API_KEY_SECONDARY: K2,
      VALUE_TESTNETS_AT_MAINNET_PRICES: "false",
    });
    const { deps } = buildDeps({ env, queue: new InMemoryQueue(), logger });
    const snap = await deps.portfolio.getSnapshot({
      addresses: [
        {
          walletId: "0199e7a0-0000-7000-8000-000000000001",
          network: "solana-devnet",
          address: SOL,
        },
      ],
      currency: "USD",
    });
    expect(snap.stale).toBe(false);
    expect(used).toEqual([K1, K2]);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      expect.objectContaining({
        event: "helius.key_failover",
        keyIndex: 0,
        keyCount: 2,
        status: 429,
        reason: "quota_exhausted",
        failedOver: true,
      }),
    ]);
    expect(lines.join("\n")).not.toContain(K1);
    expect(lines.join("\n")).not.toContain(K2);

    // The next request builds fresh deps in the same isolate and skips the exhausted key.
    used.length = 0;
    const next = buildDeps({ env, queue: new InMemoryQueue(), logger }).deps;
    await next.portfolio.getSnapshot({
      addresses: [
        {
          walletId: "0199e7a0-0000-7000-8000-000000000001",
          network: "solana-devnet",
          address: SOL,
        },
      ],
      currency: "USD",
    });
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((k) => k === K2)).toBe(true);
  });

  it("the logger masks keys inside provider URLs", () => {
    const lines: string[] = [];
    createLogger({}, (l) => lines.push(l)).error("x", {
      detail: `fetch https://devnet.helius-rpc.com/?api-key=${K1} failed`,
      url: `https://eth-sepolia.g.alchemy.com/v2/${K2}`,
    });
    expect(lines[0]).not.toContain(K1);
    expect(lines[0]).not.toContain(K2);
  });
});
