import type {
  AssetId,
  Broadcaster,
  CanonicalTransactionPayload,
  ChainFamily,
  PortfolioProvider,
  PriceProvider,
  PriceQuote,
  TransactionBuilder,
  UnsignedTransaction,
} from "@zyropay/shared";
import {
  CanonicalTransactionPayloadSchema,
  canonicalize,
  chainFamilyOf,
  nativeAsset,
  parseAssetId,
  payloadHash,
  sha256Hex,
} from "@zyropay/shared";
import { buildSnapshot } from "./portfolio/common";

/*
 * Mock* adapters for local development (ZYROPAY_USE_MOCK_ADAPTERS=true). Every object they
 * return carries `simulated: true`; the API refuses them in production mode.
 */

const MOCK_PRICES: Record<string, string> = {
  native_solana: "150.00",
  native_evm: "3000.00",
  native_cardano: "0.50",
  stable: "1.00",
};

/** Fixed prices: SOL 150, ETH 3000, ADA 0.50, every token 1.00 (as if a stablecoin). */
export class MockPriceProvider implements PriceProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}
  getPrices({ assetIds, currency }: { assetIds: readonly AssetId[]; currency: string }) {
    const prices: Partial<Record<AssetId, PriceQuote>> = {};
    for (const id of assetIds) {
      const { network, tokenAddress } = parseAssetId(id);
      const value =
        tokenAddress !== null
          ? MOCK_PRICES.stable
          : chainFamilyOf(network) === "solana"
            ? MOCK_PRICES.native_solana
            : chainFamilyOf(network) === "cardano"
              ? MOCK_PRICES.native_cardano
              : MOCK_PRICES.native_evm;
      prices[id] = {
        assetId: id,
        price: { value: value ?? "1.00", currency },
        asOf: this.now().toISOString(),
        source: "mock",
        simulated: true,
      };
    }
    return Promise.resolve({ prices, simulated: true });
  }
}

/** Every watched address holds 1.5 of the native asset. No history. */
export class MockPortfolioProvider implements PortfolioProvider {
  constructor(
    private readonly priceProvider: PriceProvider = new MockPriceProvider(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  getSnapshot({ addresses, currency }: Parameters<PortfolioProvider["getSnapshot"]>[0]) {
    const asOf = this.now().toISOString();
    return buildSnapshot({
      entries: addresses.map((address) => {
        const asset = nativeAsset(address.network);
        return {
          address,
          data: {
            asOf,
            holdings: [{ asset, amount: ((3n * 10n ** BigInt(asset.decimals)) / 2n).toString() }],
          },
        };
      }),
      stale: false,
      currency,
      priceProvider: this.priceProvider,
      simulated: true,
      now: this.now(),
    });
  }

  getTransactions() {
    return Promise.resolve({ transactions: [], nextCursor: null, simulated: true as const });
  }
}

const MOCK_FEES: Record<ChainFamily, string> = {
  solana: "5000",
  evm: "21000000000000",
  cardano: "170000",
};

/**
 * Builds a fake "transaction": the canonical payload JSON, base64/hex-encoded. Verification
 * compares that encoding with the payload, so the approval flow can be exercised end to end.
 */
export class MockTransactionBuilder<F extends ChainFamily> implements TransactionBuilder<F> {
  constructor(readonly family: F) {}

  private encode(payload: CanonicalTransactionPayload): {
    encoding: "base64" | "hex";
    serialized: string;
  } {
    const json = canonicalize(CanonicalTransactionPayloadSchema.parse(payload));
    const bytes = new TextEncoder().encode(json);
    if (this.family === "solana") {
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return { encoding: "base64", serialized: btoa(bin) };
    }
    return {
      encoding: "hex",
      serialized: `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    };
  }

  buildTransfer(payload: CanonicalTransactionPayload): Promise<UnsignedTransaction> {
    if (chainFamilyOf(payload.network) !== this.family) {
      return Promise.reject(
        new Error(`mock ${this.family} builder cannot build ${payload.network}`),
      );
    }
    const { encoding, serialized } = this.encode(payload);
    return Promise.resolve({
      family: this.family,
      network: payload.network,
      payloadHash: payloadHash(payload),
      encoding,
      serialized,
      estimatedFee: MOCK_FEES[this.family],
      validUntil:
        this.family === "evm"
          ? null
          : new Date(Date.now() + (this.family === "solana" ? 60_000 : 7_200_000)).toISOString(),
      simulated: true,
    });
  }

  verifyMatchesPayload(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ) {
    try {
      const expected = this.encode(payload);
      return Promise.resolve(
        expected.encoding === encoding && expected.serialized === serialized
          ? ({ ok: true } as const)
          : ({ ok: false, reason: "mock transaction does not match payload" } as const),
      );
    } catch {
      return Promise.resolve({ ok: false, reason: "invalid payload" } as const);
    }
  }
}

/** Accepts anything; the hash is sha256 of the signed bytes; confirms immediately. */
export class MockBroadcaster implements Broadcaster {
  broadcast(input: Parameters<Broadcaster["broadcast"]>[0]) {
    const txHash = sha256Hex(input.signedTransaction);
    return Promise.resolve({
      txHash: chainFamilyOf(input.network) === "evm" ? `0x${txHash}` : txHash,
      simulated: true,
    });
  }
  getStatus() {
    return Promise.resolve({
      status: "confirmed" as const,
      confirmations: 1,
      error: null,
      simulated: true,
    });
  }
}
