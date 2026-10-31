/**
 * Live READ-ONLY Cardano checks against Blockfrost. Nothing is signed or submitted: the
 * builder test only builds an unsigned transaction from a public address's UTxOs and runs
 * the independent verifier on it.
 *
 * Skipped unless LIVE_TESTS=1 and a project id is in the environment, e.g.
 *   node --env-file=../../.env.local ../../node_modules/vitest/vitest.mjs run \
 *     src/__tests__/cardano.live.test.ts          (with LIVE_TESTS=1 in that env file or shell)
 * BLOCKFROST_PROJECT_ID_MAINNET enables the mainnet block, BLOCKFROST_PROJECT_ID_PREPROD the
 * preprod block.
 */
import { createCanonicalPayload } from "@zyropay/shared";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { BlockfrostClient } from "../cardano/blockfrost";
import { createCardanoTransactionBuilder } from "../cardano/builder";
import { decodeCardanoTx } from "../cardano/tx";
import { createConfirmationTracker } from "../confirmation";
import { createCardanoPortfolioProvider } from "../portfolio/cardano";
import { createPriceProvider } from "../prices";

const LIVE = process.env.LIVE_TESTS === "1";
const MAINNET = process.env.BLOCKFROST_PROJECT_ID_MAINNET ?? "";
const PREPROD = process.env.BLOCKFROST_PROJECT_ID_PREPROD ?? "";
const T = 60_000;

/** A busy public mainnet base address (seen in a recorded block). */
const PUBLIC_ADDRESS =
  "addr1q84vs052fv3efuqaw2sqcjkq3mxgsk2emmmpxsrfz2rxnls4ty54ad8pqpwengnkrt4vqm2fs33k8pahuex9qml2334q22hzls";
/** A historic mainnet transaction (block 14081264). */
const KNOWN_TX = "745ed6e91cb4d24eab5c44ef1428ef47580521e913df97a73915ecf0f66562b4";
const WALLET = "00000000-0000-4000-8000-000000000001";

describe.skipIf(!LIVE || MAINNET === "")("live: Cardano mainnet via Blockfrost (read-only)", () => {
  // Lazy: the describe body runs even when skipped, and there may be no project id.
  let cached: BlockfrostClient | null = null;
  const mainnet = () =>
    (cached ??= new BlockfrostClient({ projectId: MAINNET, network: "cardano-mainnet" }));

  it(
    "genesis magic, protocol parameters and tip",
    async () => {
      await mainnet().ensureNetwork();
      const params = await mainnet().protocolParams();
      expect(params.minFeeA).toBeGreaterThan(0n);
      expect(params.minFeeB).toBeGreaterThan(0n);
      expect(params.coinsPerUtxoByte).toBeGreaterThan(0n);
      expect(params.maxTxSize).toBeGreaterThan(1000);
      const tip = await mainnet().tip();
      expect(tip.slot).toBeGreaterThan(100_000_000n);
      expect(Math.abs(tip.time - Date.now() / 1000)).toBeLessThan(600);
    },
    T,
  );

  it(
    "a preprod builder refuses the mainnet project id",
    () => {
      expect(() =>
        createCardanoTransactionBuilder({
          blockfrostProjectId: MAINNET,
          network: "cardano-preprod",
        }),
      ).toThrow(/not a preprod project/);
    },
    T,
  );

  it(
    "balance, tokens and history of a public address",
    async () => {
      const provider = createCardanoPortfolioProvider({
        blockfrostProjectId: MAINNET,
        network: "cardano-mainnet",
        priceProvider: createPriceProvider(),
        historyPageSize: 3,
      });
      const watched = {
        walletId: WALLET,
        network: "cardano-mainnet" as const,
        address: PUBLIC_ADDRESS,
      };
      const snapshot = await provider.getSnapshot({ addresses: [watched], currency: "USD" });
      expect(snapshot.stale).toBe(false);
      const ada = snapshot.balances.find((b) => b.asset.kind === "native");
      expect(ada?.asset.symbol).toBe("ADA");
      expect(BigInt(ada?.amount ?? "-1")).toBeGreaterThanOrEqual(0n);
      const page = await provider.getTransactions({ address: watched, limit: 3 });
      expect(page.transactions.length).toBeGreaterThan(0);
      for (const t of page.transactions) {
        expect(t.txHash).toMatch(/^[0-9a-f]{64}$/);
        expect(BigInt(t.amount)).toBeGreaterThanOrEqual(0n);
      }
    },
    T,
  );

  it(
    "a historic transaction: body hash of its CBOR is its id, and it is confirmed",
    async () => {
      const cbor = (await mainnet().get(`/txs/${KNOWN_TX}/cbor`, "txs/cbor")) as { cbor: string };
      expect(decodeCardanoTx(hexToBytes(cbor.cbor), { strict: false }).bodyHash).toBe(KNOWN_TX);
      const tracker = createConfirmationTracker({
        networks: { "cardano-mainnet": { blockfrostProjectId: MAINNET } },
      });
      const status = await tracker.track({ network: "cardano-mainnet", txHash: KNOWN_TX });
      expect(status.status).toBe("confirmed");
      expect(status.confirmations).toBeGreaterThan(3);
    },
    T,
  );

  it(
    "builds and independently verifies an UNSIGNED transfer from real UTxOs (never signed or sent)",
    async () => {
      const builder = createCardanoTransactionBuilder({
        blockfrostProjectId: MAINNET,
        network: "cardano-mainnet",
      });
      const input = {
        version: 1 as const,
        network: "cardano-mainnet" as const,
        from: PUBLIC_ADDRESS,
        to: PUBLIC_ADDRESS,
        asset: { id: "cardano-mainnet:native", kind: "native" as const, decimals: 6 },
        amount: "1500000",
        plugin: null,
        tool: "app_send" as const,
        pluginData: null,
      };
      const estimate = await builder.estimateTransferFee(input);
      expect(BigInt(estimate.estimatedFee)).toBeGreaterThan(150_000n);
      const payload = createCanonicalPayload({
        ...input,
        feeCap: estimate.recommendedFeeCap,
        nonce: "0123456789abcdef0123456789abcdef",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        idempotencyKey: "live-cardano-0001",
      });
      const unsigned = await builder.buildTransfer(payload);
      expect((await builder.verifyMatchesPayload(unsigned.serialized, "hex", payload)).ok).toBe(
        true,
      );
      expect(unsigned.estimatedFee).toBe(estimate.estimatedFee);
    },
    T,
  );

  it(
    "ADA price from CoinGecko",
    async () => {
      const prices = await createPriceProvider().getPrices({
        assetIds: ["cardano-mainnet:native"],
        currency: "USD",
      });
      expect(Number(prices.prices["cardano-mainnet:native"]?.price.value)).toBeGreaterThan(0);
    },
    T,
  );
});

describe.skipIf(!LIVE || PREPROD === "")("live: Cardano preprod via Blockfrost (read-only)", () => {
  it(
    "genesis magic 1, parameters and tip",
    async () => {
      const client = new BlockfrostClient({ projectId: PREPROD, network: "cardano-preprod" });
      await client.ensureNetwork();
      expect((await client.protocolParams()).minFeeA).toBeGreaterThan(0n);
      expect((await client.tip()).slot).toBeGreaterThan(0n);
    },
    T,
  );
});
