import { ChainError, MockTransactionBuilder } from "@zyropay/blockchain";
import type {
  CanonicalTransactionPayload,
  HeaderReader,
  JsonObject,
  NetworkId,
  OnrampProvider,
  OnrampQuote,
  OnrampWebhookEvent,
  PluginAdapter,
  PluginManifest,
  PluginQuote,
  UnsignedTransaction,
  UnsignedTypedData,
  VerificationResult,
} from "@zyropay/shared";
import {
  canonicalize,
  CanonicalTransactionPayloadSchema,
  chainFamilyOf,
  isTestnet,
  NETWORKS,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
  toBaseUnitString,
} from "@zyropay/shared";
import { getAddress, hashTypedData, keccak256, toHex, zeroAddress } from "viem";
import { assertPayloadMatchesQuote, manifestFor, runVerifier, toJsonObject } from "./common";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, x402TypedDataToJson } from "./x402";

/*
 * Mock* plugins and on-ramp for local development. Every quote/transaction/session carries
 * `simulated: true`, the adapters expose `simulated = true`, and createPluginRegistry refuses
 * them in production mode. They run on TESTNETS. There is no swap mock: Jupiter routes on
 * Solana mainnet only, so a swap on a test network fails instead of pretending to happen.
 */

// No Jupiter entry: Jupiter routes on Solana mainnet only, and a swap is never simulated.
const DEV_NETWORKS: Record<string, NetworkId[]> = {
  x402: ["base-sepolia", "solana-devnet"],
  kamino: ["solana-devnet"],
  aave: ["ethereum-sepolia", "base-sepolia"],
  hyperliquid: [],
};

export class MockPluginAdapter implements PluginAdapter {
  readonly simulated = true;
  readonly manifest: PluginManifest;
  constructor(
    id: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const real = manifestFor(id);
    this.manifest = {
      ...real,
      status: "available",
      networks: DEV_NETWORKS[id] ?? [],
      notes: [...real.notes, "SIMULATED: mock adapter for development."],
    };
  }

  quote(input: { action: string; network: NetworkId; params: JsonObject }): Promise<PluginQuote> {
    if (!this.manifest.networks.includes(input.network) || !isTestnet(input.network)) {
      return Promise.reject(
        new ChainError("NETWORK_NOT_SUPPORTED", `mock ${this.manifest.id} only runs on testnets`),
      );
    }
    if (!this.manifest.tools.some((t) => t.name === input.action)) {
      return Promise.reject(new ChainError("VALIDATION_FAILED", `unknown action ${input.action}`));
    }
    const amount = typeof input.params.amount === "string" ? input.params.amount : "0";
    parseBaseUnits(amount);
    const out = toBaseUnitString(parseBaseUnits(amount));
    const slippage =
      typeof input.params.slippageBps === "number" ? BigInt(input.params.slippageBps) : 0n;
    const minOut = toBaseUnitString((parseBaseUnits(out) * (10_000n - slippage)) / 10_000n);
    return Promise.resolve({
      pluginId: this.manifest.id,
      pluginData: toJsonObject({
        action: input.action,
        params: input.params,
        minOutAmount: minOut,
        riskCategory: this.manifest.riskCategory,
        simulated: true,
      }),
      inputAmount: amount,
      expectedOutputAmount: out,
      expiresAt: new Date(this.now().getTime() + 60_000).toISOString(),
      simulated: true,
    });
  }

  buildTransaction({
    payload,
    quote,
  }: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTransaction> {
    try {
      assertPayloadMatchesQuote(this.manifest.id, payload, quote, this.now());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("mismatch"));
    }
    return new MockTransactionBuilder(chainFamilyOf(payload.network)).buildTransfer(payload);
  }

  /**
   * Counterpart of buildTransaction: the mock "transaction" is the canonical payload encoded
   * by MockTransactionBuilder (base64 on Solana, hex on EVM), so verification re-encodes the
   * payload and compares. Testnets of this mock's manifest only. Never throws.
   */
  verifyTransaction(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult> {
    let expected: "base64" | "hex";
    try {
      expected = chainFamilyOf(payload.network) === "solana" ? "base64" : "hex";
    } catch {
      return Promise.resolve({ ok: false, reason: "invalid payload" });
    }
    return runVerifier(this.manifest.id, expected, encoding, payload, (p) => {
      if (!this.manifest.networks.includes(p.network) || !isTestnet(p.network))
        return { ok: false, reason: `mock ${this.manifest.id} only runs on testnets` };
      return new MockTransactionBuilder(chainFamilyOf(p.network)).verifyMatchesPayload(
        serialized,
        encoding,
        p,
      );
    });
  }
}

/**
 * x402 mock. On EVM testnets it also produces a deterministic EIP-3009
 * TransferWithAuthorization (domain "ZyroPay Mock x402" v1, verifyingContract = the payload
 * token, nonce = keccak256(payloadHash), validBefore = payload expiry) labelled simulated.
 */
export class MockX402Adapter extends MockPluginAdapter {
  private readonly clock: () => Date;
  constructor(now: () => Date = () => new Date()) {
    super("x402", now);
    this.clock = now;
  }

  private mockTypedData(payload: CanonicalTransactionPayload): UnsignedTypedData {
    const p = CanonicalTransactionPayloadSchema.parse(payload);
    if (chainFamilyOf(p.network) !== "evm" || !isTestnet(p.network))
      throw new ChainError("BAD_REQUEST", "mock x402 typed data is for EVM testnets only");
    if (!this.manifest.networks.includes(p.network))
      throw new ChainError("NETWORK_NOT_SUPPORTED", `mock x402 does not run on ${p.network}`);
    const chainId = NETWORKS[p.network].evmChainId;
    if (chainId === null)
      throw new ChainError("NETWORK_NOT_SUPPORTED", "network has no EVM chain id");
    const hash = payloadHash(p);
    const validBefore = BigInt(Math.floor(Date.parse(p.expiresAt) / 1000));
    const typedData = {
      domain: {
        name: "ZyroPay Mock x402",
        version: "1",
        chainId,
        verifyingContract: getAddress(parseAssetId(p.asset.id).tokenAddress ?? zeroAddress),
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization" as const,
      message: {
        from: getAddress(p.from),
        to: getAddress(p.to),
        value: parseBaseUnits(p.amount),
        validAfter: 0n,
        validBefore,
        nonce: keccak256(toHex(hash)),
      },
    };
    return {
      kind: "eip712",
      network: p.network,
      payloadHash: hash,
      typedData: x402TypedDataToJson(typedData),
      digest: hashTypedData(typedData).toLowerCase(),
      validUntil: new Date(Number(validBefore) * 1000).toISOString(),
      simulated: true,
    };
  }

  buildTypedData({
    payload,
    quote,
  }: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTypedData> {
    return Promise.resolve().then(() => {
      assertPayloadMatchesQuote(this.manifest.id, payload, quote, this.clock());
      return this.mockTypedData(payload);
    });
  }

  verifyTypedData(
    typedData: UnsignedTypedData,
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult> {
    try {
      const expected = this.mockTypedData(payload);
      const ok =
        (typedData.kind as string) === "eip712" &&
        typedData.simulated &&
        typedData.network === expected.network &&
        typedData.payloadHash === expected.payloadHash &&
        typedData.digest.toLowerCase() === expected.digest &&
        typedData.validUntil === expected.validUntil &&
        canonicalize(typedData.typedData) === canonicalize(expected.typedData);
      return Promise.resolve(
        ok ? { ok: true } : { ok: false, reason: "mock typed data does not match payload" },
      );
    } catch (error) {
      return Promise.resolve({
        ok: false,
        reason: error instanceof Error ? error.message : "invalid typed data",
      });
    }
  }
}

/** On-ramp mock: 1 fiat unit = 1 token unit (decimal), fee 1.00, session URL is example.com. */
export class MockOnrampProvider implements OnrampProvider {
  readonly id = "mock-onramp";
  constructor(private readonly now: () => Date = () => new Date()) {}

  getQuote(input: Parameters<OnrampProvider["getQuote"]>[0]): Promise<OnrampQuote> {
    const [whole = "0"] = input.fiat.value.split(".");
    return Promise.resolve({
      quoteId: `mock-${input.network}-${whole}`,
      provider: this.id,
      fiat: input.fiat,
      network: input.network,
      assetId: input.assetId,
      cryptoAmount: `${whole}000000`,
      decimals: 6,
      fees: { value: "1.00", currency: input.fiat.currency },
      expiresAt: new Date(this.now().getTime() + 120_000).toISOString(),
      simulated: true,
    });
  }

  createSession(input: { quoteId: string; walletAddress: string; userId: string }) {
    return Promise.resolve({
      sessionId: `mock-session-${input.quoteId}`,
      url: `https://example.com/mock-onramp?session=${encodeURIComponent(input.quoteId)}`,
      expiresAt: new Date(this.now().getTime() + 300_000).toISOString(),
      simulated: true,
    });
  }

  /** Accepts `{"orderId":"..","status":"COMPLETED"}` with header x-mock-signature: ok. */
  verifyWebhook(rawBody: string, headers: HeaderReader): Promise<OnrampWebhookEvent | null> {
    try {
      if (headers.get("x-mock-signature") !== "ok") return Promise.resolve(null);
      const body = JSON.parse(rawBody) as { orderId?: unknown; status?: unknown };
      if (typeof body.orderId !== "string" || typeof body.status !== "string")
        return Promise.resolve(null);
      const type =
        body.status === "COMPLETED"
          ? "order_completed"
          : body.status === "FAILED"
            ? "order_failed"
            : "order_processing";
      return Promise.resolve({
        provider: this.id,
        eventId: `${body.orderId}:${body.status}`,
        type,
        orderId: body.orderId,
        walletAddress: null,
        raw: toJsonObject(body),
        simulated: true,
      });
    } catch {
      return Promise.resolve(null);
    }
  }
}
