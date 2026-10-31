/*
 * Mock* adapters for the shared ports, used in local development (ZYROPAY_USE_MOCK_ADAPTERS)
 * and the API tests; real deployments use @zyropay/blockchain and @zyropay/integrations
 * (providers.ts). Every object they return carries `simulated: true`; production mode
 * refuses to start with mocks.
 * They are deterministic enough for tests and honest enough for local development:
 * builders really encode the payload and verifiers really decode and compare it.
 */
import type {
  Asset,
  AssetId,
  Balance,
  BroadcastResult,
  Broadcaster,
  CanonicalTransactionPayload,
  ChainFamily,
  FiatCurrency,
  FiatValue,
  JsonObject,
  NetworkId,
  Notification,
  Notifier,
  OnrampProvider,
  OnrampQuote,
  OnrampWebhookEvent,
  PluginAdapter,
  PluginManifest,
  PluginQuote,
  PortfolioProvider,
  PortfolioSnapshot,
  PriceHistoryProvider,
  PriceHistoryResult,
  PriceProvider,
  PriceRange,
  PriceQuote,
  Transaction,
  TransactionBuilder,
  UnsignedTransaction,
  UnsignedTypedData,
  VerificationResult,
  WatchedAddress,
} from "@zyropay/shared";
import type { BlockfrostUtxo, ScriptProtocolParams } from "@zyropay/blockchain";
import {
  cardanoPosixMsToSlot,
  cardanoSlotToPosixMs,
  decodeAllowanceDatum,
  decodeCardanoTx,
  planAllowanceAgentPay,
  planAllowanceCreate,
  planAllowanceFloatSweep,
  planAllowanceOwnerSpend,
  verifyVkeyWitness,
} from "@zyropay/blockchain";
import { datumFromView, datumToView } from "../allowance-chain";
import type { MasumiRegistryClient } from "@zyropay/integrations";
import {
  assertMasumiEscrowBinding,
  createMasumiRegistryClient,
  createMemoryRegistryCache,
  MASUMI_REGISTRY_POLICY_IDS,
  masumiEscrowTermsOf,
  normalizePaymentRequired,
  normalizeResourceUrl,
  quoteMasumiEscrow,
  x402AssetMatches,
  x402TransferMethodOf,
} from "@zyropay/integrations";
import {
  canonicalize,
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  chainFamilyOf,
  explorerTxUrl,
  getPluginManifest,
  MASUMI_ESCROW_ADDRESSES,
  nativeAsset,
  NETWORKS,
  parseAssetId,
  payloadHash,
  sha256Hex,
  tokenAssetId,
  toChecksumAddress,
  valueInUsdMinor,
  minorUnitsToDecimal,
  allowanceScriptAddress,
} from "@zyropay/shared";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  mockAddresses,
} from "@zyropay/wallet";
import type {
  AllowanceChain,
  AllowanceOnChain,
  ChainAdapters,
  EscrowChain,
  EscrowOnChain,
  EscrowRead,
  EscrowRef,
  EscrowSpendInput,
} from "../chain";
import { hmacSha256Hex, timingSafeEqualString } from "../lib/crypto";

/** Circle USDC per network. Cardano has no Circle USDC: mock Cardano wallets hold ADA only. */
const USDC: Readonly<Partial<Record<NetworkId, string>>> = {
  "solana-mainnet": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "ethereum-mainnet": toChecksumAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  "ethereum-sepolia": toChecksumAddress("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"),
  "base-mainnet": toChecksumAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  "base-sepolia": toChecksumAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e"),
};

export function mockUsdcAssetId(network: NetworkId): AssetId {
  const usdc = USDC[network];
  if (usdc === undefined) throw new Error(`no mock USDC on ${network}`);
  return tokenAssetId(network, usdc);
}

function usdcAsset(network: NetworkId): Asset | null {
  const usdc = USDC[network];
  if (usdc === undefined) return null;
  return {
    id: mockUsdcAssetId(network),
    network,
    kind: chainFamilyOf(network) === "solana" ? "spl" : "erc20",
    address: usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoUrl: null,
    verified: true,
  };
}

const PRICES_USD: Readonly<Record<string, string>> = {
  SOL: "150.00",
  ETH: "3000.00",
  ADA: "0.50",
  USDC: "1.00",
};

function priceFor(assetId: AssetId): string | null {
  const { network, tokenAddress } = parseAssetId(assetId);
  if (tokenAddress === null) return PRICES_USD[NETWORKS[network].nativeCurrency.symbol] ?? null;
  return tokenAddress.toLowerCase() === USDC[network]?.toLowerCase()
    ? (PRICES_USD.USDC ?? null)
    : null;
}

// --- Builders ------------------------------------------------------------------------------

interface MockTxBody {
  readonly v: 1;
  readonly payloadHash: string;
  readonly network: NetworkId;
  readonly from: string;
  readonly to: string;
  readonly assetId: string;
  readonly amount: string;
  readonly feeCap: string;
  readonly plugin: string | null;
  readonly recentBlockhash: string;
}

function encode(
  family: ChainFamily,
  body: MockTxBody,
): { encoding: "base64" | "hex"; serialized: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return family === "solana"
    ? { encoding: "base64", serialized: bytesToBase64(bytes) }
    : { encoding: "hex", serialized: `0x${bytesToHex(bytes)}` };
}

function decode(serialized: string, encoding: "base64" | "hex"): MockTxBody | null {
  try {
    const bytes = encoding === "hex" ? hexToBytes(serialized) : base64ToBytes(serialized);
    return JSON.parse(new TextDecoder().decode(bytes)) as MockTxBody;
  } catch {
    return null;
  }
}

function buildMockUnsigned(
  payload: CanonicalTransactionPayload,
  now: () => Date,
  maxValiditySeconds?: number,
): UnsignedTransaction {
  const family = chainFamilyOf(payload.network);
  const hash = payloadHash(payload);
  const body: MockTxBody = {
    v: 1,
    payloadHash: hash,
    network: payload.network,
    from: payload.from,
    to: payload.to,
    assetId: payload.asset.id,
    amount: payload.amount,
    feeCap: payload.feeCap,
    plugin: payload.plugin,
    recentBlockhash: sha256Hex(`${hash}:${now().getTime()}:${Math.random()}`).slice(0, 32),
  };
  return {
    family,
    network: payload.network,
    payloadHash: hash,
    ...encode(family, body),
    estimatedFee: { solana: "5000", evm: "21000000000000", cardano: "170000" }[family],
    validUntil:
      family === "evm"
        ? null
        : new Date(
            now().getTime() +
              (family === "solana" ? 60_000 : Math.min(7_200, maxValiditySeconds ?? 7_200) * 1000),
          ).toISOString(),
    simulated: true,
  };
}

class MockTransactionBuilder<F extends ChainFamily> implements TransactionBuilder<F> {
  constructor(
    readonly family: F,
    private readonly now: () => Date = () => new Date(),
  ) {}

  buildTransfer(
    payload: CanonicalTransactionPayload,
    options: { maxValiditySeconds?: number } = {},
  ): Promise<UnsignedTransaction> {
    if (chainFamilyOf(payload.network) !== this.family)
      return Promise.reject(new Error("wrong family"));
    return Promise.resolve(buildMockUnsigned(payload, this.now, options.maxValiditySeconds));
  }

  verifyMatchesPayload(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const body = decode(serialized, encoding);
    if (body === null) return Promise.resolve({ ok: false, reason: "undecodable" });
    const checks: [boolean, string][] = [
      [body.payloadHash === payloadHash(payload), "payload hash"],
      [body.network === payload.network, "network"],
      [body.from === payload.from, "from"],
      [body.to === payload.to, "recipient"],
      [body.assetId === payload.asset.id, "asset"],
      [body.amount === payload.amount, "amount"],
      [body.feeCap === payload.feeCap, "fee cap"],
    ];
    const failed = checks.find(([ok]) => !ok);
    return Promise.resolve(
      failed === undefined ? { ok: true } : { ok: false, reason: `${failed[1]} mismatch` },
    );
  }
}

// --- Broadcaster ---------------------------------------------------------------------------

/** Deterministic mock transaction id of mock-signed bytes (same as MockBroadcaster returns). */
function mockTxHash(network: NetworkId, signedTransaction: string): string {
  const digest = sha256Hex(signedTransaction);
  const family = chainFamilyOf(network);
  if (family === "evm") return `0x${digest}`;
  if (family === "cardano") return digest; // 32-byte hex, like a Cardano tx id
  return `${mockAddresses(digest).solana}${mockAddresses(`${digest}:2`).solana}`.slice(0, 88);
}

export class MockBroadcaster implements Broadcaster {
  readonly broadcasts: { network: NetworkId; signedTransaction: string }[] = [];
  /** Test hook: force the next N broadcasts to throw. */
  failNext = 0;
  /** Test hook: status returned by getStatus (default confirmed). */
  status: "pending" | "confirmed" | "failed" = "confirmed";

  broadcast(input: {
    network: NetworkId;
    signedTransaction: string;
    encoding: "base64" | "hex";
  }): Promise<BroadcastResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error("mock broadcast failure"));
    }
    this.broadcasts.push({ network: input.network, signedTransaction: input.signedTransaction });
    return Promise.resolve({
      txHash: mockTxHash(input.network, input.signedTransaction),
      simulated: true,
    });
  }

  getStatus(): Promise<{
    status: "pending" | "confirmed" | "failed";
    confirmations: number;
    error: string | null;
    simulated: boolean;
  }> {
    return Promise.resolve({
      status: this.status,
      confirmations: this.status === "confirmed" ? 32 : 0,
      error: this.status === "failed" ? "reverted" : null,
      simulated: true,
    });
  }
}

// --- Portfolio / prices ----------------------------------------------------------------

function fiat(value: string, currency: FiatCurrency): FiatValue {
  return { value, currency };
}

export class MockPortfolioProvider implements PortfolioProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  getSnapshot(input: {
    addresses: readonly WatchedAddress[];
    currency: FiatCurrency;
  }): Promise<PortfolioSnapshot> {
    const balances: Balance[] = [];
    let totalMinor = 0n;
    for (const a of input.addresses) {
      const native = nativeAsset(a.network);
      const usdc = usdcAsset(a.network);
      const holdings: [Asset, string][] = [
        [native, (5n * 10n ** BigInt(native.decimals)).toString()],
        ...(usdc === null ? [] : [[usdc, "1000000000"] as [Asset, string]]), // 1,000 USDC
      ];
      for (const [asset, amount] of holdings) {
        const price = input.currency === "USD" ? priceFor(asset.id) : null;
        const valueMinor =
          price === null ? null : valueInUsdMinor({ amount, decimals: asset.decimals }, price);
        if (valueMinor !== null) totalMinor += BigInt(valueMinor);
        balances.push({
          walletId: a.walletId,
          address: a.address,
          network: a.network,
          asset,
          amount,
          price: price === null ? null : fiat(price, input.currency),
          value: valueMinor === null ? null : fiat(minorUnitsToDecimal(valueMinor), input.currency),
        });
      }
    }
    return Promise.resolve({
      asOf: this.now().toISOString(),
      stale: false,
      currency: input.currency,
      totalValue: fiat(minorUnitsToDecimal(totalMinor), input.currency),
      unpricedAssetCount: balances.filter((b) => b.price === null).length,
      networks: [...new Set(input.addresses.map((a) => a.network))],
      balances,
      simulated: true,
    });
  }

  getTransactions(input: {
    address: WatchedAddress;
    limit: number;
    cursor?: string;
  }): Promise<{ transactions: Transaction[]; nextCursor: string | null; simulated: boolean }> {
    const total = 3;
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    const items: Transaction[] = [];
    for (let i = offset; i < Math.min(total, offset + input.limit); i++) {
      const seed = sha256Hex(`${input.address.walletId}:${input.address.network}:${i}`);
      const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-8${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
      const family = chainFamilyOf(input.address.network);
      const txHash =
        family === "evm" ? `0x${seed}` : family === "cardano" ? seed : mockAddresses(seed).solana;
      items.push({
        id,
        walletId: input.address.walletId,
        network: input.address.network,
        txHash,
        direction: "in",
        status: "confirmed",
        from:
          family === "evm"
            ? mockAddresses(seed).evm
            : family === "cardano"
              ? cardanoEnterpriseAddress(
                  mockAddresses(seed).cardanoPublicKey,
                  input.address.network,
                )
              : mockAddresses(seed).solana,
        to: input.address.address,
        asset: nativeAsset(input.address.network),
        amount: "1000",
        fee: null,
        valueAtTime: null,
        timestamp: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
        blockNumber: String(1000 + i),
        transactionRequestId: null,
        explorerUrl: explorerTxUrl(input.address.network, txHash),
        simulated: true,
      });
    }
    const next = offset + input.limit < total ? String(offset + input.limit) : null;
    return Promise.resolve({ transactions: items.reverse(), nextCursor: next, simulated: true });
  }
}

export class MockPriceProvider implements PriceProvider {
  /** Test hook: assets without a price (valuation must fail closed). */
  readonly unpriced = new Set<string>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  getPrices(input: {
    assetIds: readonly AssetId[];
    currency: FiatCurrency;
  }): Promise<{ prices: Partial<Record<AssetId, PriceQuote>>; simulated: boolean }> {
    const prices: Partial<Record<AssetId, PriceQuote>> = {};
    for (const id of input.assetIds) {
      const price = priceFor(id);
      if (price === null || input.currency !== "USD" || this.unpriced.has(id)) continue;
      prices[id] = {
        assetId: id,
        price: fiat(price, "USD"),
        asOf: this.now().toISOString(),
        source: "mock",
        simulated: true,
      };
    }
    return Promise.resolve({ prices, simulated: true });
  }
}

const RANGE_MS: Record<PriceRange, number> = {
  "1D": 86_400_000,
  "1W": 7 * 86_400_000,
  "1M": 30 * 86_400_000,
  "1Y": 365 * 86_400_000,
};

/**
 * Simulated price history: a deterministic wave around the mock price (bigint cents), labelled
 * `simulated: true` / source "mock". Assets the mock does not price are "unavailable", like the
 * real provider.
 */
export class MockPriceHistoryProvider implements PriceHistoryProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  getPriceHistory(input: {
    assetId: AssetId;
    range: PriceRange;
    currency: FiatCurrency;
  }): Promise<PriceHistoryResult> {
    if (input.currency !== "USD")
      return Promise.resolve({ status: "unavailable", reason: "CURRENCY_UNSUPPORTED" });
    const price = priceFor(input.assetId);
    if (price === null)
      return Promise.resolve({ status: "unavailable", reason: "UNSUPPORTED_ASSET" });
    const [whole = "0", frac = ""] = price.split(".");
    const cents = BigInt(whole + frac.padEnd(2, "0").slice(0, 2));
    const count = 48;
    const span = RANGE_MS[input.range];
    const end = this.now().getTime();
    const points = Array.from({ length: count }, (_, i) => {
      // +-2% triangle wave, ending exactly at the mock price.
      const phase = BigInt((i * 7) % 20) - 10n;
      const c = i === count - 1 ? cents : cents + (cents * phase) / 500n;
      const value = c > 0n ? c : 1n;
      return {
        t: new Date(end - span + Math.round((span / (count - 1)) * i)).toISOString(),
        price: `${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, "0")}`,
      };
    });
    return Promise.resolve({ status: "available", points, source: "mock", simulated: true });
  }
}

// --- On-ramp ------------------------------------------------------------------------------

export const MOCK_ONRAMP_SIGNATURE_HEADER = "x-mock-onramp-signature";

export class MockOnrampProvider implements OnrampProvider {
  readonly id = "transak";
  constructor(
    private readonly webhookSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getQuote(input: {
    fiat: FiatValue;
    network: NetworkId;
    assetId: AssetId;
    walletAddress: string;
  }): Promise<OnrampQuote> {
    const decimals =
      parseAssetId(input.assetId).tokenAddress === null
        ? NETWORKS[input.network].nativeCurrency.decimals
        : 6;
    return Promise.resolve({
      quoteId: `mockq_${sha256Hex(`${input.walletAddress}:${this.now().getTime()}:${Math.random()}`).slice(0, 24)}`,
      provider: this.id,
      fiat: input.fiat,
      network: input.network,
      assetId: input.assetId,
      cryptoAmount: (10n ** BigInt(decimals)).toString(),
      decimals,
      fees: fiat("1.00", input.fiat.currency),
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
      simulated: true,
    });
  }

  /** Test hook: the createSession inputs (the end user's IP must be passed through). */
  readonly sessions: { quoteId: string; userId: string; userIp: string | undefined }[] = [];

  createSession(input: {
    quoteId: string;
    walletAddress: string;
    userId: string;
    userIp?: string;
  }): Promise<{ sessionId: string; url: string; expiresAt: string; simulated: boolean }> {
    this.sessions.push({ quoteId: input.quoteId, userId: input.userId, userIp: input.userIp });
    const sessionId = `mocks_${sha256Hex(`${input.quoteId}:${input.userId}`).slice(0, 24)}`;
    return Promise.resolve({
      sessionId,
      url: `https://global-stg.transak.com/?mockSession=${sessionId}`,
      expiresAt: new Date(this.now().getTime() + 30 * 60_000).toISOString(),
      simulated: true,
    });
  }

  async verifyWebhook(
    rawBody: string,
    headers: { get(name: string): string | null },
  ): Promise<OnrampWebhookEvent | null> {
    const sig = headers.get(MOCK_ONRAMP_SIGNATURE_HEADER);
    if (
      sig === null ||
      !timingSafeEqualString(sig, await hmacSha256Hex(this.webhookSecret, rawBody))
    )
      return null;
    try {
      const raw = JSON.parse(rawBody) as JsonObject;
      const { eventId, type, orderId, walletAddress } = raw as {
        eventId?: unknown;
        type?: unknown;
        orderId?: unknown;
        walletAddress?: unknown;
      };
      if (typeof eventId !== "string" || typeof orderId !== "string") return null;
      if (
        type !== "order_created" &&
        type !== "order_processing" &&
        type !== "order_completed" &&
        type !== "order_failed"
      )
        return null;
      return {
        provider: this.id,
        eventId,
        type,
        orderId,
        walletAddress: typeof walletAddress === "string" ? walletAddress : null,
        raw,
        simulated: true,
      };
    } catch {
      return null;
    }
  }
}

// --- Notifier ----------------------------------------------------------------------------

export class MockNotifier implements Notifier {
  readonly sent: { userId: string; notification: Notification }[] = [];
  /** Optional sink so local development can see simulated pushes (ids and links only). */
  constructor(private readonly onSend?: (notification: Notification) => void) {}
  notify(input: {
    userId: string;
    notification: Notification;
  }): Promise<{ delivered: number; failed: number; simulated: boolean }> {
    this.sent.push(input);
    this.onSend?.(input.notification);
    return Promise.resolve({ delivered: 1, failed: 0, simulated: true });
  }
}

// --- Plugins -------------------------------------------------------------------------------

function str(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`mock plugin: ${key} is required`);
  return value;
}

/**
 * Mock x402 adapter. It takes the SAME params as the real adapter in @zyropay/integrations
 * (paymentRequired/resourceUrl/maxAmount/assetId/payer) and puts the same keys into
 * pluginData, so the request engine is exercised exactly as in production. There is no mock
 * swap: Jupiter routes on Solana mainnet only, and a swap on a test network is refused with
 * SWAP_UNAVAILABLE_ON_NETWORK instead of being simulated.
 */
export class MockPluginAdapter implements PluginAdapter {
  readonly manifest: PluginManifest;
  readonly simulated = true;
  constructor(
    pluginId: "x402",
    private readonly now: () => Date = () => new Date(),
    /** Registry for registered-agent claims (as the real adapter's `masumiRegistry`). */
    private readonly masumiRegistry: MasumiRegistryClient | null = null,
  ) {
    const manifest = getPluginManifest(pluginId);
    if (manifest === undefined) throw new Error(`unknown plugin ${pluginId}`);
    this.manifest = manifest;
  }

  quote(input: { action: string; network: NetworkId; params: JsonObject }): Promise<PluginQuote> {
    try {
      const expiresAt = new Date(this.now().getTime() + 120_000).toISOString();
      const required = normalizePaymentRequired(input.params.paymentRequired);
      const assetId = str(input.params, "assetId");
      const family = chainFamilyOf(input.network);
      const wanted = input.params.transferMethod === "masumi" ? "masumi" : "default";
      const req = required.accepts.find(
        (r) =>
          r.scheme === "exact" &&
          r.network === input.network &&
          x402AssetMatches(input.network, r.asset, assetId) &&
          (family !== "cardano" || x402TransferMethodOf(r) === wanted),
      );
      if (req === undefined)
        throw Object.assign(new Error("no matching requirement"), { code: "VALIDATION_FAILED" });
      if (BigInt(req.amount) > BigInt(str(input.params, "maxAmount")))
        throw new Error("above maxAmount");
      const resourceUrl = normalizeResourceUrl(str(input.params, "resourceUrl"));
      if (family === "cardano" && wanted === "masumi") {
        // The real validation (seller signature, deadlines, datum) runs even in mock mode:
        // it is pure. Only the min-UTxO price is fixed (4310 lovelace/byte).
        return quoteMasumiEscrow({
          network: input.network,
          requirement: req.raw,
          payer: str(input.params, "payer"),
          resourceUrl,
          asset: req.asset,
          amount: BigInt(req.amount),
          maxTimeoutSeconds: req.maxTimeoutSeconds,
          coinsPerUtxoByte: 4310n,
          now: this.now(),
          ...(this.masumiRegistry?.network === input.network
            ? { registry: this.masumiRegistry }
            : {}),
        }).then((escrow) => ({
          pluginId: "x402",
          pluginData: {
            x402Version: req.x402Version,
            scheme: "exact",
            network: NETWORKS[input.network].caip2,
            asset: req.asset,
            payTo: req.payTo,
            amount: req.amount,
            maxTimeoutSeconds: req.maxTimeoutSeconds,
            resourceUrl,
            method: input.params.method === "POST" ? "POST" : "GET",
            accepted: req.raw,
            resource: required.resource,
            riskCategory: this.manifest.riskCategory,
            escrow: { ...escrow },
          },
          inputAmount: req.amount,
          expectedOutputAmount: null,
          expiresAt: new Date(
            Math.min(Date.parse(expiresAt), Number(escrow.payByTime)),
          ).toISOString(),
          simulated: true,
        }));
      }
      return Promise.resolve({
        pluginId: "x402",
        pluginData: {
          x402Version: req.x402Version,
          scheme: "exact",
          network: NETWORKS[input.network].caip2,
          asset: req.asset,
          payTo: family === "evm" ? toChecksumAddress(req.payTo) : req.payTo,
          amount: req.amount,
          maxTimeoutSeconds: req.maxTimeoutSeconds,
          resourceUrl,
          method: input.params.method === "POST" ? "POST" : "GET",
          accepted: req.raw,
          resource: required.resource,
          riskCategory: this.manifest.riskCategory,
        },
        inputAmount: req.amount,
        expectedOutputAmount: null,
        expiresAt,
        simulated: true,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("mock quote failed"));
    }
  }

  buildTransaction(input: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTransaction> {
    if (chainFamilyOf(input.payload.network) === "evm") {
      return Promise.reject(new Error("x402 on EVM is typed data, not a transaction"));
    }
    return Promise.resolve(buildMockUnsigned(input.payload, this.now));
  }

  verifyTransaction(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult> {
    try {
      const escrow = masumiEscrowTermsOf(payload.pluginData);
      if (escrow !== null) assertMasumiEscrowBinding(escrow, payload);
    } catch (error) {
      return Promise.resolve({ ok: false, reason: (error as Error).message });
    }
    return new MockTransactionBuilder(chainFamilyOf(payload.network)).verifyMatchesPayload(
      serialized,
      encoding,
      payload,
    );
  }

  buildTypedData(input: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTypedData> {
    if (chainFamilyOf(input.payload.network) !== "evm") {
      return Promise.reject(new Error("typed data is x402-on-EVM only"));
    }
    const typedData = mockTypedData(input.payload);
    return Promise.resolve({
      kind: "eip712",
      network: input.payload.network,
      payloadHash: payloadHash(input.payload),
      typedData,
      digest: mockTypedDataDigest(typedData),
      validUntil: input.payload.expiresAt,
      simulated: true,
    });
  }

  verifyTypedData(
    typed: UnsignedTypedData,
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult> {
    const expected = mockTypedData(payload);
    if (typed.payloadHash !== payloadHash(payload))
      return Promise.resolve({ ok: false, reason: "payload hash" });
    if (canonicalize(typed.typedData) !== canonicalize(expected))
      return Promise.resolve({ ok: false, reason: "typed data differs from the payload" });
    if (typed.digest !== mockTypedDataDigest(typed.typedData))
      return Promise.resolve({ ok: false, reason: "digest" });
    return Promise.resolve({ ok: true });
  }
}

/** Mock EIP-3009 authorization (shape of the real one; the digest is NOT real EIP-712). */
function mockTypedData(payload: CanonicalTransactionPayload): JsonObject {
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: NETWORKS[payload.network].evmChainId ?? 0,
      verifyingContract: parseAssetId(payload.asset.id).tokenAddress ?? "",
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: payload.from,
      to: payload.to,
      value: payload.amount,
      validAfter: "0",
      validBefore: String(Math.floor(Date.parse(payload.expiresAt) / 1000)),
      nonce: `0x${sha256Hex(payloadHash(payload))}`,
    },
  };
}

function mockTypedDataDigest(typedData: JsonObject): string {
  return `0x${sha256Hex(`mock-eip712:${canonicalize(typedData)}`)}`;
}

// --- Chain adapters (builder/broadcaster routing, tracker, signed-tx tools) -----------------

/**
 * Mock ChainAdapters: one MockTransactionBuilder per family, one MockBroadcaster for every
 * network, a tracker that knows only what MockBroadcaster actually sent, and signed-tx tools
 * that understand MockTurnkey's signatures (unsigned bytes + a 32-byte suffix).
 */
interface MockSpendBody {
  readonly v: 1;
  readonly kind: "mock_escrow_spend";
  readonly network: NetworkId;
  readonly action: EscrowSpendInput["action"];
  readonly from: string;
  readonly utxo: EscrowRef;
  readonly continuingDatumCbor: string | null;
  readonly validityStartSlot: string;
  readonly ttlSlot: string;
  readonly fee: string;
}

const refKey = (ref: EscrowRef) => `${ref.txHash}#${String(ref.index)}`;

/**
 * Simulated Masumi escrow chain. A lock "lands" once its signed bytes were broadcast (the
 * hand-off marks it BROADCAST under the mock tx id); spends are mock JSON (not CBOR) whose
 * effect is applied on submit: SetRefundRequested moves the escrow to `<spend tx>#0` with the
 * continuing datum, WithdrawRefund spends it. `sellerMove` lets tests play the seller.
 */
export class MockEscrowChain implements EscrowChain {
  readonly escrowAddress: string;
  /** Escrow UTxOs that moved or were placed (seller actions, refund requests). */
  readonly utxos = new Map<string, EscrowOnChain>();
  /** ref -> next ref (a continuing output). */
  readonly moved = new Map<string, EscrowRef>();
  /** ref -> spending tx without continuation. */
  readonly spent = new Map<string, string>();
  readonly submitted: string[] = [];
  /** Test hook: force the next submits to throw. */
  failNextSubmits = 0;
  /** Test hook: how far the chain tip trails the clock (slots). */
  tipLagSlots = 0n;
  /** Test hook: force the next lock builds to fail (a chain provider outage). */
  failNextLocks = 0;

  constructor(
    readonly network: NetworkId,
    private readonly now: () => Date,
    private readonly broadcaster: MockBroadcaster,
  ) {
    this.escrowAddress = MASUMI_ESCROW_ADDRESSES[network] ?? "";
  }

  coinsPerUtxoByte(): Promise<bigint> {
    return Promise.resolve(4310n);
  }

  slotOf(ms: bigint, rounding: "floor" | "ceil"): bigint {
    return cardanoPosixMsToSlot(this.network, ms, rounding);
  }

  posixOf(slot: bigint): bigint {
    return cardanoSlotToPosixMs(this.network, slot);
  }

  tipSlot(): Promise<bigint> {
    return Promise.resolve(this.slotOf(BigInt(this.now().getTime()), "floor") - this.tipLagSlots);
  }

  buildLock(
    payload: CanonicalTransactionPayload,
    options: { maxValiditySeconds: number },
  ): Promise<UnsignedTransaction> {
    const escrow = masumiEscrowTermsOf(payload.pluginData);
    if (escrow === null) return Promise.reject(new Error("not a masumi payload"));
    if (this.failNextLocks > 0) {
      this.failNextLocks--;
      return Promise.reject(
        Object.assign(new Error("mock lock build failed"), { code: "UPSTREAM_UNAVAILABLE" }),
      );
    }
    const unsigned = buildMockUnsigned(payload, this.now, options.maxValiditySeconds);
    const payBy = Number(escrow.payByTime);
    const validUntil = Math.min(Date.parse(unsigned.validUntil ?? ""), payBy);
    const ttl = this.slotOf(BigInt(validUntil), "floor");
    return Promise.resolve({
      ...unsigned,
      validUntil: new Date(Number(this.posixOf(ttl))).toISOString(),
      ttlSlot: ttl.toString(),
    } as UnsignedTransaction);
  }

  read(
    ref: EscrowRef,
    hint: { referenceSignature: string; lockDatumCbor: string; lockLovelace: string },
  ): Promise<EscrowRead> {
    let current = ref;
    for (let hop = 0; hop < 8; hop++) {
      const key = refKey(current);
      const spentBy = this.spent.get(key);
      if (spentBy !== undefined) return Promise.resolve({ status: "spent", spentBy });
      const next = this.moved.get(key);
      if (next !== undefined) {
        current = next;
        continue;
      }
      const placed = this.utxos.get(key);
      if (placed !== undefined) return Promise.resolve({ status: "unspent", utxo: placed });
      const landed = this.broadcaster.broadcasts.some(
        (b) =>
          b.network === this.network &&
          mockTxHash(this.network, b.signedTransaction) === current.txHash,
      );
      if (!landed || current.index !== 0) return Promise.resolve({ status: "missing" });
      return Promise.resolve({
        status: "unspent",
        utxo: {
          ...current,
          address: this.escrowAddress,
          lovelace: hint.lockLovelace,
          assets: {},
          inlineDatum: hint.lockDatumCbor,
        },
      });
    }
    return Promise.reject(new Error("mock escrow moved too often"));
  }

  private bodyOf(input: EscrowSpendInput): MockSpendBody {
    return {
      v: 1,
      kind: "mock_escrow_spend",
      network: this.network,
      action: input.action,
      from: input.from,
      utxo: { txHash: input.utxo.txHash, index: input.utxo.index },
      continuingDatumCbor: input.continuingDatumCbor ?? null,
      validityStartSlot: input.validityStartSlot.toString(),
      ttlSlot: input.ttlSlot.toString(),
      fee: "650000",
    };
  }

  buildSpend(input: EscrowSpendInput) {
    const body = this.bodyOf(input);
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return Promise.resolve({
      serialized: bytesToHex(bytes),
      bodyHash: sha256Hex(bytes),
      fee: body.fee,
    });
  }

  verifySpend(serialized: string, input: EscrowSpendInput): Promise<VerificationResult> {
    try {
      const decoded = new TextDecoder().decode(hexToBytes(serialized));
      return Promise.resolve(
        decoded === JSON.stringify(this.bodyOf(input))
          ? { ok: true }
          : { ok: false, reason: "mock spend differs from the expectation" },
      );
    } catch {
      return Promise.resolve({ ok: false, reason: "undecodable mock spend" });
    }
  }

  submit(signedTransaction: string): Promise<{ txHash: string }> {
    if (this.failNextSubmits > 0) {
      this.failNextSubmits--;
      return Promise.reject(new Error("mock submit failed"));
    }
    const signed = signedTransaction.replace(/^0x/, "").toLowerCase();
    // Mock signed form: unsigned bytes + a 32-byte suffix (createMockChainAdapters).
    const body = JSON.parse(
      new TextDecoder().decode(hexToBytes(signed.slice(0, -64))),
    ) as MockSpendBody;
    const txHash = mockTxHash(this.network, signed);
    this.broadcaster.broadcasts.push({ network: this.network, signedTransaction: signed });
    this.submitted.push(txHash);
    const key = refKey(body.utxo);
    if (body.action === "SetRefundRequested") {
      const before = this.utxos.get(key);
      const next = { txHash, index: 0 };
      this.moved.set(key, next);
      this.utxos.set(refKey(next), {
        ...next,
        address: this.escrowAddress,
        lovelace: before?.lovelace ?? "0",
        assets: before?.assets ?? {},
        inlineDatum: body.continuingDatumCbor ?? "",
      });
    } else {
      this.spent.set(key, txHash);
    }
    return Promise.resolve({ txHash });
  }

  /** Test hook: the seller spends `from` into a continuing output with `datum`. */
  sellerMove(from: EscrowRef, datum: string, lovelace: string): EscrowRef {
    const txHash = sha256Hex(`seller:${refKey(from)}:${datum}`);
    const next = { txHash, index: 0 };
    this.moved.set(refKey(from), next);
    this.utxos.set(refKey(next), {
      ...next,
      address: this.escrowAddress,
      lovelace,
      assets: {},
      inlineDatum: datum,
    });
    return next;
  }

  /** Test hook: the seller collects (no continuation). */
  sellerWithdraw(from: EscrowRef): string {
    const txHash = sha256Hex(`withdraw:${refKey(from)}`);
    this.spent.set(refKey(from), txHash);
    return txHash;
  }
}

export function createMockChainAdapters(
  now: () => Date,
  broadcaster: MockBroadcaster,
  escrow: MockEscrowChain = new MockEscrowChain("cardano-preprod", now, broadcaster),
  allowance: MockAllowanceChain = new MockAllowanceChain("cardano-preprod", now),
): ChainAdapters {
  const builders = {
    solana: new MockTransactionBuilder("solana", now),
    evm: new MockTransactionBuilder("evm", now),
    cardano: new MockTransactionBuilder("cardano", now),
  };
  const unsignedHex = (serialized: string, encoding: "base64" | "hex") =>
    bytesToHex(encoding === "hex" ? hexToBytes(serialized) : base64ToBytes(serialized));
  const signedHex = (signed: string) => signed.replace(/^0x/, "").toLowerCase();
  return {
    builder: (network) => builders[chainFamilyOf(network)],
    broadcaster: () => broadcaster,
    cardanoEscrow(network) {
      if (network !== escrow.network)
        throw Object.assign(new Error(`no escrow on ${network}`), {
          code: "NETWORK_NOT_SUPPORTED",
        });
      return escrow;
    },
    cardanoAllowance(network) {
      if (network !== allowance.network)
        throw Object.assign(new Error(`no allowance on ${network}`), {
          code: "NETWORK_NOT_SUPPORTED",
        });
      return allowance;
    },
    async track({ network, txHash }) {
      const sent =
        broadcaster.broadcasts.some(
          (b) => b.network === network && mockTxHash(network, b.signedTransaction) === txHash,
        ) ||
        (network === allowance.network && allowance.submitted.includes(txHash));
      if (!sent) {
        return {
          status: "pending",
          confirmations: 0,
          error: null,
          rebroadcastSuggested: true,
          simulated: true,
        };
      }
      const status = await broadcaster.getStatus();
      return { ...status, rebroadcastSuggested: false, simulated: true };
    },
    normalizeSigned: ({ signedTransaction, encoding }) => ({ signedTransaction, encoding }),
    txHashOf: ({ network, signedTransaction }) => mockTxHash(network, signedTransaction),
    assertSignedMatchesUnsigned({ signed, unsigned, encoding }) {
      const expected = unsignedHex(unsigned, encoding);
      const actual = signedHex(signed);
      if (!actual.startsWith(expected) || actual.length !== expected.length + 64) {
        return Promise.reject(new Error("signed transaction differs from the reviewed one"));
      }
      return Promise.resolve();
    },
    // Mock Cardano: the "body hash" is sha256 of the mock bytes, and the signed form is the
    // unsigned bytes + a 32-byte suffix (same shape MockTurnkey uses for the other families).
    // The Ed25519 signature itself is checked, so a wrong key or payload still fails closed.
    cardanoSigningPayload: ({ unsigned }) => sha256Hex(hexToBytes(unsigned)),
    attachCardanoWitness({ unsigned, publicKey, signature, expectedSigner }) {
      const bodyHash = sha256Hex(hexToBytes(unsigned));
      const keyHash = cardanoPaymentKeyHash(expectedSigner);
      if (keyHash === null || cardanoKeyHash(publicKey) !== keyHash)
        throw new Error("signing key does not own the sending address");
      if (!verifyVkeyWitness(bodyHash, { vkey: publicKey, signature }))
        throw new Error("signature does not verify");
      const hex = unsignedHex(unsigned, "hex");
      return {
        signedTransaction: `${hex}${sha256Hex(`mock-witness:${signature}`)}`,
        encoding: "hex",
      };
    },
    // Mock Cardano x402: the mock bytes in base64 and the first "input" named by the mock
    // tx id. Nothing here would be accepted by a real facilitator.
    cardanoX402Payment({ signedTransaction }) {
      const bytes = hexToBytes(signedHex(signedTransaction));
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return { transaction: btoa(bin), nonce: `${sha256Hex(bytes)}#0` };
    },
  };
}

// --- Masumi registry --------------------------------------------------------------------------

/** One synthetic registry entry (cardano-preprod) of the mock Masumi registry. */
export interface MockMasumiAgentSpec {
  /** 64 hex: nonce byte (>= 0x10) || root hash (28 B) || version (3 B). */
  readonly assetName: string;
  readonly name: string;
  readonly description: string;
  readonly apiBaseUrl: string;
  /** The NFT holder: the seller key that signs the agent's x402 terms. */
  readonly holder: string;
  readonly capability?: string;
  readonly tags?: readonly string[];
  /** Fixed lovelace price; null = Dynamic. */
  readonly priceLovelace: string | null;
  /** Burned (deregistered): listed by Blockfrost with quantity 0. */
  readonly burned?: boolean;
}

/** Demo agents of the mock registry (local development and the e2e smoke). */
export const MOCK_MASUMI_AGENTS: readonly MockMasumiAgentSpec[] = [
  {
    assetName: `10${"a1".repeat(28)}000000`,
    name: "Demo summarizer",
    description: "Summarizes a web page into five bullet points. Paid through Masumi escrow.",
    apiBaseUrl: "https://summarizer.example.com/v1",
    holder:
      "addr_test1qr3l0k6npvhznqv8u0x7v6www8p4phnsjq8m8cxlmynpyxrdt6tjh8gq2f8m95av4jl0dpzxlugtg6v8aaafl2725kyqhuz79v",
    capability: "summarize",
    tags: ["text", "summary"],
    priceLovelace: "2000000",
  },
  {
    assetName: `10${"b2".repeat(28)}000000`,
    name: "Demo translator",
    description: "Translates text between 30 languages.",
    apiBaseUrl: "https://translator.example.com",
    holder:
      "addr_test1qr98r6ej55v5zz5wrqu50vh2mrurtvc0d03rkzumpk8wkjcuqgpcuqjhdh7dghcnq9kw283tg66svw7wzycmlmcys3ksq6nl4z",
    capability: "translate",
    tags: ["text", "translation"],
    priceLovelace: null,
  },
];

/**
 * Mock Masumi registry: the REAL registry client (parsing, identity checks) over a synthetic
 * Blockfrost that serves `agents` as V2 registry NFTs on cardano-preprod. No network.
 */
export function createMockMasumiRegistry(
  agents: readonly MockMasumiAgentSpec[] = MOCK_MASUMI_AGENTS,
): MasumiRegistryClient {
  const policy = MASUMI_REGISTRY_POLICY_IDS["cardano-preprod"] ?? "";
  const escrow = MASUMI_ESCROW_ADDRESSES["cardano-preprod"] ?? "";
  const routes = new Map<string, unknown>();
  const chunks = (s: string): string[] => s.match(/.{1,64}/g) ?? [s];
  routes.set(
    `/assets/policy/${policy}?count=100&order=desc&page=1`,
    agents.map((a) => ({ asset: `${policy}${a.assetName}`, quantity: a.burned ? "0" : "1" })),
  );
  agents.forEach((a, i) => {
    const unit = `${policy}${a.assetName}`;
    const txHash = sha256Hex(`mint:${unit}`);
    routes.set(`/assets/${unit}`, {
      asset: unit,
      policy_id: policy,
      asset_name: a.assetName,
      fingerprint: null,
      quantity: a.burned ? "0" : "1",
      initial_mint_tx_hash: txHash,
      onchain_metadata: {
        name: chunks(a.name),
        description: chunks(a.description),
        api_base_url: chunks(a.apiBaseUrl),
        ...(a.capability !== undefined
          ? { capability: { name: [a.capability], version: ["1.0.0"] } }
          : {}),
        tags: [...(a.tags ?? [])],
        metadata_version: "2",
        supported_payment_sources: [
          {
            chain: ["Cardano"],
            network: ["Preprod"],
            pricing:
              a.priceLovelace === null
                ? { pricingType: "Dynamic" }
                : { pricingType: "Fixed", fixed: [{ asset: "", amount: a.priceLovelace }] },
            settlement: { address: chunks(escrow), paymentSourceType: ["Web3CardanoV2"] },
          },
        ],
      },
    });
    routes.set(
      `/assets/${unit}/addresses?order=desc&count=2`,
      a.burned ? [] : [{ address: a.holder, quantity: "1" }],
    );
    routes.set(`/txs/${txHash}`, { hash: txHash, block_time: 1_792_000_000 + i * 3_600 });
  });
  const base = "https://mock-blockfrost.invalid";
  return createMasumiRegistryClient({
    network: "cardano-preprod",
    blockfrostProjectId: "preprodMOCK",
    blockfrostBaseUrl: base,
    cache: createMemoryRegistryCache(),
    sleep: () => Promise.resolve(),
    fetch: (input) => {
      const body = routes.get(input.slice(base.length));
      return Promise.resolve(
        body === undefined
          ? new Response(JSON.stringify({ status_code: 404 }), { status: 404 })
          : new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Auto-pay allowance (docs/AUTOPAY.md): a tiny simulated UTxO ledger
// ---------------------------------------------------------------------------

const MOCK_SCRIPT_PARAMS: ScriptProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155381n,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384,
  maxValSize: 5000,
  priceMem: { num: 577n, den: 10000n },
  priceStep: { num: 721n, den: 10000000n },
  collateralPercent: 150n,
  maxCollateralInputs: 3,
  maxTxExMem: 14_000_000n,
  maxTxExSteps: 10_000_000_000n,
  // Any non-empty list: the mock never runs the script, only hashes the language view.
  plutusV3CostModel: Array.from({ length: 297 }, (_, i) => BigInt(i)),
};
/** What Blockfrost measured for a live agent payment (contracts/allowance/deployments). */
const MOCK_ALLOWANCE_UNITS = { mem: 264_349n, steps: 106_417_209n };

interface MockLedgerUtxo {
  readonly txHash: string;
  readonly index: number;
  readonly address: string;
  readonly lovelace: bigint;
  readonly inlineDatum: string | null;
}

/**
 * Simulated Cardano ledger for the allowance: the REAL planners build real CBOR from these
 * UTxOs, and `submit` / `land` apply a transaction (inputs out, outputs in) under the mock tx
 * id the rest of the mock stack derives from the signed bytes. Addresses are funded by
 * `fund`; an owner with nothing gets a 100 ADA UTxO the first time it builds.
 */
export class MockAllowanceChain implements AllowanceChain {
  readonly utxos = new Map<string, MockLedgerUtxo>();
  readonly submitted: string[] = [];
  /** Test hook: force the next agent-pay builds to fail (a refused script evaluation). */
  failNextAgentPays = 0;
  /** Test hook: force the next submits to throw. */
  failNextSubmits = 0;
  /** Test hook: force the next reads (allowance UTxOs) to throw, like a provider outage. */
  failNextReads = 0;
  private seq = 0;

  constructor(
    readonly network: NetworkId,
    private readonly now: () => Date,
  ) {}

  slotOf(ms: bigint, rounding: "floor" | "ceil"): bigint {
    return cardanoPosixMsToSlot(this.network, ms, rounding);
  }

  posixOf(slot: bigint): bigint {
    return cardanoSlotToPosixMs(this.network, slot);
  }

  tipSlot(): Promise<bigint> {
    return Promise.resolve(this.slotOf(BigInt(this.now().getTime()), "floor") - 1n);
  }

  /** Test hook: put `lovelace` at `address` (a faucet). */
  fund(address: string, lovelace: bigint): void {
    this.seq++;
    const txHash = sha256Hex(`mock-fund:${address}:${String(this.seq)}`);
    this.utxos.set(`${txHash}#0`, { txHash, index: 0, address, lovelace, inlineDatum: null });
  }

  private at(address: string): BlockfrostUtxo[] {
    return [...this.utxos.values()]
      .filter((u) => u.address === address)
      .map((u) => ({
        address: u.address,
        tx_hash: u.txHash,
        tx_index: u.index,
        output_index: u.index,
        amount: [{ unit: "lovelace", quantity: u.lovelace.toString() }],
        block: "0".repeat(64),
        data_hash: null,
        inline_datum: u.inlineDatum,
        reference_script_hash: null,
      }));
  }

  private ensureFunded(address: string): void {
    if (this.at(address).length === 0) this.fund(address, 100_000_000n);
  }

  read(ownerKeyHash: string, agentKeyHash: string): Promise<AllowanceOnChain[]> {
    if (this.failNextReads > 0) {
      this.failNextReads--;
      return Promise.reject(new Error("mock: chain provider unavailable"));
    }
    const address = allowanceScriptAddress(this.network, ownerKeyHash);
    const out: AllowanceOnChain[] = [];
    for (const u of this.at(address)) {
      if (u.inline_datum === null) continue;
      try {
        const datum = decodeAllowanceDatum(u.inline_datum);
        if (datum.agentKeyHash !== agentKeyHash) continue;
        out.push({
          txHash: u.tx_hash,
          index: u.output_index,
          lovelace: BigInt(u.amount[0]?.quantity ?? "0"),
          datum: datumToView(datum),
        });
      } catch {
        // not an allowance datum
      }
    }
    return Promise.resolve(out);
  }

  adaBalance(address: string): Promise<bigint> {
    return Promise.resolve(
      this.at(address).reduce((sum, u) => sum + BigInt(u.amount[0]?.quantity ?? "0"), 0n),
    );
  }

  buildCreate(input: Parameters<AllowanceChain["buildCreate"]>[0]) {
    this.ensureFunded(input.owner);
    const plan = planAllowanceCreate({
      network: this.network,
      from: input.owner,
      lovelace: input.lovelace,
      datum: datumFromView(input.datum),
      float: input.float,
      utxos: this.at(input.owner),
      params: MOCK_SCRIPT_PARAMS,
      ttlSlot: input.ttlSlot,
    });
    return Promise.resolve({ serialized: plan.serialized, fee: plan.fee });
  }

  buildAgentPay(input: Parameters<AllowanceChain["buildAgentPay"]>[0]) {
    if (this.failNextAgentPays > 0) {
      this.failNextAgentPays--;
      return Promise.reject(
        Object.assign(new Error("mock evaluation refused the spend"), {
          code: "VALIDATION_FAILED",
        }),
      );
    }
    try {
      const plan = planAllowanceAgentPay({
        network: this.network,
        ownerKeyHash: input.ownerKeyHash,
        allowance: {
          txHash: input.allowance.txHash,
          index: input.allowance.index,
          value: { coin: input.allowance.lovelace, assets: new Map() },
          datum: datumFromView(input.allowance.datum),
        },
        agent: input.agent,
        payee: input.payee,
        lovelace: input.lovelace,
        utxos: this.at(input.agent),
        params: MOCK_SCRIPT_PARAMS,
        validityStartSlot: input.validityStartSlot,
        ttlSlot: input.ttlSlot,
        exUnits: MOCK_ALLOWANCE_UNITS,
      });
      return Promise.resolve({
        serialized: plan.serialized,
        fee: plan.fee,
        nextDatum: datumToView(plan.nextDatum),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  buildOwnerSpend(input: Parameters<AllowanceChain["buildOwnerSpend"]>[0]) {
    this.ensureFunded(input.owner);
    const plan = planAllowanceOwnerSpend({
      network: this.network,
      owner: input.owner,
      allowance: {
        txHash: input.allowance.txHash,
        index: input.allowance.index,
        value: { coin: input.allowance.lovelace, assets: new Map() },
      },
      ...(input.continuing !== undefined
        ? {
            continuing: {
              lovelace: input.continuing.lovelace,
              datum: datumFromView(input.continuing.datum),
            },
          }
        : {}),
      utxos: this.at(input.owner),
      params: MOCK_SCRIPT_PARAMS,
      validityStartSlot: input.validityStartSlot,
      ttlSlot: input.ttlSlot,
      exUnits: { mem: 28_095n, steps: 7_961_098n },
    });
    return Promise.resolve({ serialized: plan.serialized, fee: plan.fee });
  }

  buildFloatSweep(input: { from: string; to: string; ttlSlot: bigint }) {
    const plan = planAllowanceFloatSweep({
      network: this.network,
      from: input.from,
      to: input.to,
      utxos: this.at(input.from),
      params: MOCK_SCRIPT_PARAMS,
      ttlSlot: input.ttlSlot,
    });
    return Promise.resolve(plan === null ? null : { serialized: plan.serialized, fee: plan.fee });
  }

  /** Apply a signed transaction to the ledger (also the test hook for a seller's submit). */
  land(signedTransaction: string): string {
    const signed = signedTransaction.replace(/^0x/, "").toLowerCase();
    // Mock signed form: unsigned bytes + a 32-byte suffix (createMockChainAdapters).
    const tx = decodeCardanoTx(hexToBytes(signed.slice(0, -64)));
    const txHash = mockTxHash(this.network, signed);
    for (const i of tx.inputs) this.utxos.delete(`${i.txHash}#${String(i.index)}`);
    tx.outputs.forEach((o, index) => {
      if (o.address === null) return;
      this.utxos.set(`${txHash}#${String(index)}`, {
        txHash,
        index,
        address: o.address,
        lovelace: o.value.coin,
        inlineDatum: o.inlineDatum === undefined ? null : bytesToHex(o.inlineDatum),
      });
    });
    this.submitted.push(txHash);
    return txHash;
  }

  submit(signedTransaction: string): Promise<{ txHash: string }> {
    if (this.failNextSubmits > 0) {
      this.failNextSubmits--;
      return Promise.reject(new Error("mock submit failed"));
    }
    return Promise.resolve({ txHash: this.land(signedTransaction) });
  }
}
