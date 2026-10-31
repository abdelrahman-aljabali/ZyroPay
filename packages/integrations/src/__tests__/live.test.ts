/**
 * Live checks against PUBLIC endpoints (no API keys, no funds moved, nothing broadcast).
 * Skipped unless LIVE_TESTS=1:  pnpm --filter @zyropay/integrations test:live
 */
import {
  ChainError,
  createConfirmationTracker,
  createEvmTransactionBuilder,
  createPriceProvider,
  createSolanaTransactionBuilder,
  publicRpcUrlFor,
} from "@zyropay/blockchain";
import { createCanonicalPayload, nativeAssetId, tokenAssetId } from "@zyropay/shared";
import type { CanonicalTransactionPayload, NetworkId } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { createHyperliquidAdapter } from "../hyperliquid";
import { createJupiterAdapter } from "../jupiter";
import { createKaminoAdapter } from "../kamino";

const LIVE = process.env.LIVE_TESTS === "1";
const T = 60_000;

/** Freshly generated, never-funded addresses. */
const SOL_EMPTY = "9VYxLSLGf9z4VsKoQm8aFwJDDunePHbxKbdBzRsSJgNB";
const SOL_TO = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const EVM_EMPTY = "0x000000000000000000000000000000000000dEaD";
const EVM_TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function p(
  network: NetworkId,
  overrides: Partial<CanonicalTransactionPayload> = {},
): CanonicalTransactionPayload {
  const sol = network.startsWith("solana");
  return createCanonicalPayload({
    version: 1,
    network,
    from: sol ? SOL_EMPTY : EVM_EMPTY,
    to: sol ? SOL_TO : EVM_TO,
    asset: { id: nativeAssetId(network), kind: "native", decimals: sol ? 9 : 18 },
    amount: "1000",
    feeCap: sol ? "100000" : "1000000000000000",
    plugin: null,
    tool: "app_send",
    pluginData: null,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: "live-test-0001",
    ...overrides,
  });
}

const code = (e: unknown): string =>
  e instanceof ChainError
    ? e.code
    : `non-ChainError: ${e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e)}`;

describe.skipIf(!LIVE)("live: public RPCs", () => {
  it(
    "solana devnet: genesis check, blockhash, priority fees, simulation (unfunded sender -> INSUFFICIENT_FUNDS)",
    async () => {
      const b = createSolanaTransactionBuilder({
        rpcUrl: publicRpcUrlFor("solana-devnet"),
        network: "solana-devnet",
      });
      const err = await b.buildTransfer(p("solana-devnet")).catch((e: unknown) => e);
      expect(code(err)).toBe("INSUFFICIENT_FUNDS");
    },
    T,
  );

  it(
    "solana: a mainnet RPC is refused by a devnet builder",
    async () => {
      const b = createSolanaTransactionBuilder({
        rpcUrl: publicRpcUrlFor("solana-mainnet"),
        network: "solana-devnet",
      });
      const err = await b.buildTransfer(p("solana-devnet")).catch((e: unknown) => e);
      expect(code(err)).toBe("NETWORK_MODE_MISMATCH");
    },
    T,
  );

  it(
    "sepolia: chain id check, ERC-20 decimals via eth_call, estimateGas mapping",
    async () => {
      const b = createEvmTransactionBuilder({
        rpcUrl: publicRpcUrlFor("ethereum-sepolia"),
        network: "ethereum-sepolia",
      });
      const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
      const wrongDecimals = await b
        .buildTransfer(
          p("ethereum-sepolia", {
            asset: { id: tokenAssetId("ethereum-sepolia", usdc), kind: "erc20", decimals: 18 },
          }),
        )
        .catch((e: unknown) => e);
      expect(code(wrongDecimals)).toBe("DECIMALS_MISMATCH");
      // Whether 0x1111.. holds test ETH is outside our control: accept a verified build or INSUFFICIENT_FUNDS.
      const payload = p("ethereum-sepolia", { from: "0x1111111111111111111111111111111111111111" });
      const result = await b.buildTransfer(payload).catch((e: unknown) => e);
      if (result instanceof ChainError) expect(result.code).toBe("INSUFFICIENT_FUNDS");
      else
        expect(
          (
            await b.verifyMatchesPayload(
              (result as { serialized: string }).serialized,
              "hex",
              payload,
            )
          ).ok,
        ).toBe(true);
    },
    T,
  );

  it(
    "base sepolia: builds a native transfer from a funded address incl. the OP-stack L1 fee",
    async () => {
      const b = createEvmTransactionBuilder({
        rpcUrl: publicRpcUrlFor("base-sepolia"),
        network: "base-sepolia",
      });
      // 0x...dEaD holds test ETH on most testnets; nothing is signed or sent.
      const tx = await b.buildTransfer(p("base-sepolia"));
      expect(BigInt(tx.l1DataFee)).toBeGreaterThan(0n);
      expect(BigInt(tx.estimatedFee)).toBeLessThanOrEqual(1_000_000_000_000_000n);
      expect((await b.verifyMatchesPayload(tx.serialized, "hex", p("base-sepolia"))).ok).toBe(true);
      const tracker = createConfirmationTracker({
        networks: { "base-sepolia": { rpcUrl: publicRpcUrlFor("base-sepolia") } },
      });
      const unknown = await tracker.track({
        network: "base-sepolia",
        txHash: `0x${"ab".repeat(32)}`,
      });
      expect(unknown.status).toBe("pending");
    },
    T,
  );
});

describe.skipIf(!LIVE)("live: public provider APIs", () => {
  it(
    "prices: Jupiter (keyless) and CoinGecko (keyless) return fresh USD quotes",
    async () => {
      const prices = await createPriceProvider().getPrices({
        assetIds: ["solana-mainnet:native", "ethereum-mainnet:native"],
        currency: "USD",
      });
      expect(prices.prices["solana-mainnet:native"]?.price.value).toMatch(/^\d+(\.\d+)?$/);
      expect(prices.prices["ethereum-mainnet:native"]?.price.value).toMatch(/^\d+(\.\d+)?$/);
    },
    T,
  );

  it(
    "jupiter: v1 quote passes the guards (keyless tier)",
    async () => {
      const a = createJupiterAdapter({ apiKey: "", rpcUrl: publicRpcUrlFor("solana-mainnet") });
      const q = await a.quote({
        action: "swap",
        network: "solana-mainnet",
        params: {
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "10000000",
          slippageBps: 50,
          userPublicKey: SOL_TO,
        },
      });
      expect(BigInt(q.pluginData.minOutAmount as string)).toBeGreaterThan(0n);
    },
    T,
  );

  it(
    "kamino + hyperliquid read endpoints",
    async () => {
      const markets = await createKaminoAdapter({
        rpcUrl: publicRpcUrlFor("solana-mainnet"),
      }).listMarkets();
      expect(markets.length).toBeGreaterThan(0);
      const spot = await createHyperliquidAdapter({ environment: "mainnet" }).getSpotMarkets();
      expect(spot.find((m) => m.name === "PURR/USDC")?.midPx).toMatch(/^\d+(\.\d+)?$/);
    },
    T,
  );
});
