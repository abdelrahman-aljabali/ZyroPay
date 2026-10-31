/*
 * Ports implemented by wave-2 packages. Interfaces only.
 *
 * Mock rule: any fake implementation MUST be named `Mock*` (e.g. MockPriceProvider) and
 * MUST return `simulated: true` in every object it produces. Real implementations return
 * `simulated: false`. The UI shows a "SIMULATED" badge whenever it sees `simulated: true`,
 * and production mode (ZYROPAY_MODE=production) refuses to start with mocks enabled.
 */
import type { z } from "zod";
import type { OnrampQuoteSchema, StampedTurnkeyRequest } from "./api/contracts";
import type { PricePoint, PriceHistoryUnavailableReason, PriceRange } from "./api/ext";
import type { JsonObject } from "./common";
import type { AssetId, PriceQuote } from "./domain/assets";
import type { PortfolioSnapshot } from "./domain/portfolio";
import type { Transaction } from "./domain/transactions";
import type { BaseUnitAmount, FiatCurrency, FiatValue } from "./money";
import type { ChainFamily, NetworkId } from "./networks";
import type { CanonicalTransactionPayload, PayloadHash } from "./payload";
import type { PluginManifest } from "./plugins";

export interface Simulated {
  readonly simulated: boolean;
}

export interface WatchedAddress {
  readonly walletId: string;
  readonly network: NetworkId;
  readonly address: string;
}

export interface PortfolioProvider {
  getSnapshot(input: {
    addresses: readonly WatchedAddress[];
    currency: FiatCurrency;
  }): Promise<PortfolioSnapshot>;
  getTransactions(input: {
    address: WatchedAddress;
    limit: number;
    cursor?: string;
  }): Promise<{ transactions: Transaction[]; nextCursor: string | null } & Simulated>;
}

export interface PriceProvider {
  /** Missing assets are simply absent from the result: never invent a price. */
  getPrices(input: {
    assetIds: readonly AssetId[];
    currency: FiatCurrency;
  }): Promise<{ prices: Partial<Record<AssetId, PriceQuote>> } & Simulated>;
}

export type PriceHistoryResult =
  | ({
      readonly status: "available";
      /** Oldest first, at least two points. */
      readonly points: readonly PricePoint[];
      readonly source: string;
    } & Simulated)
  | { readonly status: "unavailable"; readonly reason: PriceHistoryUnavailableReason };

export interface PriceHistoryProvider {
  /** Never throws for a provider failure: answers `unavailable` instead (fail closed). */
  getPriceHistory(input: {
    assetId: AssetId;
    range: PriceRange;
    currency: FiatCurrency;
  }): Promise<PriceHistoryResult>;
}

export interface UnsignedTransaction extends Simulated {
  readonly family: ChainFamily;
  readonly network: NetworkId;
  readonly payloadHash: PayloadHash;
  /** base64 (Solana wire format) or 0x-hex (EVM RLP, unsigned). */
  readonly encoding: "base64" | "hex";
  readonly serialized: string;
  readonly estimatedFee: BaseUnitAmount;
  /** Solana: blockhash expiry; EVM: null (nonce-bound). */
  readonly validUntil: string | null;
}

/** One implementation per chain family (packages/blockchain). */
export interface TransactionBuilder<F extends ChainFamily = ChainFamily> {
  readonly family: F;
  /** Build the unsigned transaction for a plain native/token transfer payload. */
  buildTransfer(payload: CanonicalTransactionPayload): Promise<UnsignedTransaction>;
  /**
   * Decode `serialized` and check it does exactly what `payload` says (recipient, amount,
   * asset, fee cap, chain). Used before forwarding any signing request. Must fail closed.
   */
  verifyMatchesPayload(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
}

export interface BroadcastResult extends Simulated {
  readonly txHash: string;
}

export interface Broadcaster {
  broadcast(input: {
    network: NetworkId;
    signedTransaction: string;
    encoding: "base64" | "hex";
  }): Promise<BroadcastResult>;
  getStatus(input: { network: NetworkId; txHash: string }): Promise<
    {
      status: "pending" | "confirmed" | "failed";
      confirmations: number;
      error: string | null;
    } & Simulated
  >;
}

/** Result of an independent decode: never throws, fails closed. */
export type VerificationResult = { ok: true } | { ok: false; reason: string };

/**
 * Typed data to sign instead of a transaction (x402 on EVM: an EIP-3009
 * TransferWithAuthorization). The user signs `digest` with Turnkey SIGN_RAW_PAYLOAD
 * (hexadecimal payload, no-op hash), after the API independently re-derived it from
 * `typedData` and checked it against the payload.
 */
export interface UnsignedTypedData extends Simulated {
  readonly kind: "eip712";
  readonly network: NetworkId;
  readonly payloadHash: PayloadHash;
  /** EIP-712 {domain, types, primaryType, message}; uint256 values as decimal strings. */
  readonly typedData: JsonObject;
  /** 0x-prefixed 32-byte EIP-712 digest (hashTypedData(typedData)). */
  readonly digest: string;
  /** Latest time the signature is useful (EIP-3009 validBefore), or null. */
  readonly validUntil: string | null;
}

/** secp256k1 signature over a raw payload (hex, no 0x). */
export interface RawPayloadSignature extends Simulated {
  readonly r: string;
  readonly s: string;
  /** Recovery id as Turnkey returns it ("00"/"01" or "1b"/"1c"). */
  readonly v: string;
  /** Turnkey activity id for audit. */
  readonly activityId: string;
}

export interface SignedTransaction extends Simulated {
  readonly signedTransaction: string;
  readonly encoding: "base64" | "hex";
  /** Turnkey activity id for audit. */
  readonly activityId: string;
}

/** Turnkey (packages/wallet). The API never holds user root credentials. */
export interface Signer {
  /**
   * User path: forward a passkey-stamped SIGN_TRANSACTION request unmodified, after the
   * caller verified that its body signs exactly the expected unsigned transaction.
   */
  forwardStampedSignRequest(request: StampedTurnkeyRequest): Promise<SignedTransaction>;
  /**
   * User path for typed data (x402 on EVM): forward a passkey-stamped SIGN_RAW_PAYLOAD_V2
   * over an EIP-712 digest unmodified, after the caller verified the stamped body signs
   * exactly the digest it derived. There is deliberately no delegated-key counterpart: a
   * raw-digest signature cannot be bounded by Turnkey policies, so it is never autonomous.
   */
  forwardStampedSignRawPayload(request: StampedTurnkeyRequest): Promise<RawPayloadSignature>;
  /** Forward a stamped read-only request (e.g. get_whoami at login). */
  forwardStampedQuery<T>(request: StampedTurnkeyRequest): Promise<T>;
  /**
   * Agent path (autonomous only): sign with the sub-org's delegated non-root API key.
   * Turnkey policies bound what this key can sign; the API's policy engine runs first.
   */
  signWithDelegatedKey(input: {
    subOrganizationId: string;
    signWith: string;
    unsigned: UnsignedTransaction;
  }): Promise<SignedTransaction>;
}

export type OnrampQuote = z.infer<typeof OnrampQuoteSchema>;

export interface OnrampWebhookEvent extends Simulated {
  readonly provider: string;
  readonly eventId: string;
  readonly type: "order_created" | "order_processing" | "order_completed" | "order_failed";
  readonly orderId: string;
  readonly walletAddress: string | null;
  readonly raw: JsonObject;
}

/** Minimal subset of the Fetch `Headers` interface (portable across runtimes). */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface OnrampProvider {
  readonly id: string;
  getQuote(input: {
    fiat: FiatValue;
    network: NetworkId;
    assetId: AssetId;
    walletAddress: string;
  }): Promise<OnrampQuote>;
  createSession(input: {
    quoteId: string;
    walletAddress: string;
    userId: string;
    /** End user's IP (CF-Connecting-IP). Transak requires it; others may ignore it. */
    userIp?: string;
  }): Promise<{ sessionId: string; url: string; expiresAt: string } & Simulated>;
  /** Verify the signature over the raw body; return null if invalid. Never throws on bad input. */
  verifyWebhook(rawBody: string, headers: HeaderReader): Promise<OnrampWebhookEvent | null>;
}

export interface PluginQuote extends Simulated {
  readonly pluginId: string;
  /** Material terms that go into CanonicalTransactionPayload.pluginData. */
  readonly pluginData: JsonObject;
  readonly inputAmount: BaseUnitAmount;
  readonly expectedOutputAmount: BaseUnitAmount | null;
  readonly expiresAt: string;
}

export interface PluginAdapter {
  readonly manifest: PluginManifest;
  quote(input: { action: string; network: NetworkId; params: JsonObject }): Promise<PluginQuote>;
  buildTransaction(input: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTransaction>;
  /**
   * Independent decode of a transaction this adapter built, against the payload (the
   * plugin counterpart of TransactionBuilder.verifyMatchesPayload). An adapter without a
   * verifier cannot have its transactions signed: callers must fail closed.
   */
  verifyTransaction?(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
  /** Typed data to sign instead of a transaction (x402 on EVM). */
  buildTypedData?(input: {
    payload: CanonicalTransactionPayload;
    quote: PluginQuote;
  }): Promise<UnsignedTypedData>;
  /** Independent check of typed data (and its digest) against the payload. */
  verifyTypedData?(
    typedData: UnsignedTypedData,
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
}

export interface Notification {
  readonly kind:
    | "approval_requested"
    | "transaction_confirmed"
    | "transaction_failed"
    | "agent_connected"
    | "onramp_completed";
  readonly title: string;
  readonly body: string;
  /** Deep-link data; never include secrets or full payloads. */
  readonly data: Record<string, string>;
}

export interface Notifier {
  notify(input: {
    userId: string;
    notification: Notification;
  }): Promise<{ delivered: number; failed: number } & Simulated>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUID (v7 recommended). */
  newId(): string;
}
