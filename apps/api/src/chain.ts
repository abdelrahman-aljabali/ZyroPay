/*
 * Chain access as the API sees it. Real builders, broadcasters and the confirmation tracker
 * from @zyropay/blockchain are bound to ONE network each; `ChainAdapters` routes by network
 * and exposes the extra capabilities the request engine relies on:
 *
 *  - estimateTransferFee: the payload's feeCap is fixed from `recommendedFeeCap` BEFORE the
 *    payload is hashed (a later fee change needs a new payload and a new approval);
 *  - EVM `buildTransfer(payload, { nonce })` + `getNonceState`: the API allocates nonces
 *    itself so concurrent requests from one address never share one;
 *  - Solana `rebuildIfExpiring`: ADR-001 D4, run when an approval is opened;
 *  - signed-transaction tools: normalize Turnkey output, C7 signed-vs-reviewed check, and the
 *    tx hash derived from the signed bytes (recorded before broadcasting).
 */
import type {
  AllowanceDatumView,
  Broadcaster,
  CanonicalTransactionPayload,
  ChainFamily,
  NetworkId,
  UnsignedTransaction,
  VerificationResult,
} from "@zyropay/shared";

export interface FeeEstimate {
  readonly estimatedFee: string;
  readonly recommendedFeeCap: string;
}

export type FeeEstimateInput = Omit<
  CanonicalTransactionPayload,
  "feeCap" | "nonce" | "idempotencyKey" | "expiresAt"
>;

/** A network-bound builder (TransactionBuilder plus the optional extras of the real ones). */
export interface NetworkBuilder {
  readonly family: ChainFamily;
  buildTransfer(
    payload: CanonicalTransactionPayload,
    /** `nonce`: EVM. `maxValiditySeconds`: Cardano validity cap (x402 maxTimeoutSeconds). */
    options?: { nonce?: number; maxValiditySeconds?: number },
  ): Promise<UnsignedTransaction>;
  verifyMatchesPayload(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
  /** Fee estimate before the payload (and so its feeCap) is fixed. */
  estimateTransferFee?(input: FeeEstimateInput): Promise<FeeEstimate>;
  /** Solana (ADR-001 D4): rebuild when the blockhash is about to expire; same payloadHash. */
  rebuildIfExpiring?(
    stored: UnsignedTransaction,
    payload: CanonicalTransactionPayload,
  ): Promise<{ rebuilt: boolean; transaction: UnsignedTransaction }>;
  /** EVM: latest (mined) vs pending (mempool) nonce of an address. */
  getNonceState?(address: string): Promise<{ latest: number; pending: number }>;
}

export interface TrackOutcome {
  readonly status: "pending" | "confirmed" | "failed" | "expired" | "replaced";
  readonly confirmations: number;
  readonly error: string | null;
  /** The node does not know the hash but it may still land: re-send the same bytes. */
  readonly rebroadcastSuggested: boolean;
  readonly simulated: boolean;
}

export interface SignedInput {
  readonly network: NetworkId;
  readonly signedTransaction: string;
  readonly encoding: "base64" | "hex";
}

/** An escrow UTxO reference. */
export interface EscrowRef {
  readonly txHash: string;
  readonly index: number;
}

/** An unspent escrow UTxO as read from the chain. */
export interface EscrowOnChain extends EscrowRef {
  readonly address: string;
  readonly lovelace: string;
  /** Native tokens, unit -> quantity (decimal strings). */
  readonly assets: Readonly<Record<string, string>>;
  readonly inlineDatum: string;
}

export type EscrowRead =
  | { readonly status: "unspent"; readonly utxo: EscrowOnChain }
  /** Spent by a transaction that left no continuation of this escrow. */
  | { readonly status: "spent"; readonly spentBy: string }
  /** Not (yet) known to the chain provider. */
  | { readonly status: "missing" };

export type EscrowBuyerAction = "SetRefundRequested" | "WithdrawRefund";

export interface EscrowSpendInput {
  readonly action: EscrowBuyerAction;
  /** Buyer: fee, Plutus collateral, required signer and payee. */
  readonly from: string;
  readonly utxo: EscrowOnChain;
  /** SetRefundRequested only. */
  readonly continuingDatumCbor?: string;
  readonly validityStartSlot: bigint;
  readonly ttlSlot: bigint;
  readonly feeCap: bigint;
}

export interface EscrowSpendBuilt {
  /** Unsigned transaction (hex): witness set holds only redeemers (5) and the script (7). */
  readonly serialized: string;
  readonly bodyHash: string;
  readonly fee: string;
}

/**
 * Masumi escrow (x402 `masumi`) on one Cardano network: lock building, chain reads that
 * follow the escrow through continuing outputs, buyer script spends (evaluated by the chain
 * provider) and their independent verification, and submission. Nothing here signs.
 */
export interface EscrowChain {
  readonly network: NetworkId;
  readonly escrowAddress: string;
  /** Live coinsPerUtxoByte (the lock datum's collateral depends on it). */
  coinsPerUtxoByte(): Promise<bigint>;
  /** Slot <-> POSIX ms of this network ("ceil" for lower bounds, "floor" for TTLs). */
  slotOf(ms: bigint, rounding: "floor" | "ceil"): bigint;
  posixOf(slot: bigint): bigint;
  /**
   * Slot of the chain provider's latest block. The node checks a transaction's validity
   * interval against its ledger tip, which trails the wall clock (blocks are ~20 s apart on
   * average and gaps of minutes happen), so a lower bound must already be reached here.
   */
  tipSlot(): Promise<bigint>;
  /** The lock for a masumi x402 payload (pluginData.escrow), TTL <= payByTime. */
  buildLock(
    payload: CanonicalTransactionPayload,
    options: { maxValiditySeconds: number },
  ): Promise<UnsignedTransaction>;
  /**
   * The escrow's current UTxO, starting at `ref` and following continuing outputs (same
   * datum reference_signature) through at most a few spends.
   */
  read(
    ref: EscrowRef,
    hint: { referenceSignature: string; lockDatumCbor: string; lockLovelace: string },
  ): Promise<EscrowRead>;
  buildSpend(input: EscrowSpendInput): Promise<EscrowSpendBuilt>;
  /** Independent check of a stored unsigned spend against fresh protocol parameters. */
  verifySpend(serialized: string, input: EscrowSpendInput): Promise<VerificationResult>;
  /** Submit a signed spend; returns the transaction id. */
  submit(signedTransaction: string): Promise<{ txHash: string }>;
}

/** An allowance UTxO (contracts/allowance) with its decoded datum (docs/AUTOPAY.md). */
export interface AllowanceOnChain {
  readonly txHash: string;
  readonly index: number;
  readonly lovelace: bigint;
  readonly datum: AllowanceDatumView;
}

/** An unsigned allowance transaction ZyroPay built (hex CBOR) and its fee. */
export interface AllowanceBuilt {
  readonly serialized: string;
  readonly fee: bigint;
}

/**
 * The agent allowance on one Cardano network: reads, builders (script spends measured by the
 * chain provider's evaluator before they are returned) and submission. Nothing here signs.
 */
export interface AllowanceChain {
  readonly network: NetworkId;
  slotOf(ms: bigint, rounding: "floor" | "ceil"): bigint;
  posixOf(slot: bigint): bigint;
  /** Slot of the provider's latest block (validity lower bounds must not pass it). */
  tipSlot(): Promise<bigint>;
  /** Well-formed allowance UTxOs of `ownerKeyHash` whose datum names `agentKeyHash`. */
  read(ownerKeyHash: string, agentKeyHash: string): Promise<AllowanceOnChain[]>;
  /** Pure-ADA lovelace at `address` (the agent's fee float). */
  adaBalance(address: string): Promise<bigint>;
  buildCreate(input: {
    owner: string;
    lovelace: bigint;
    datum: AllowanceDatumView;
    float: { address: string; lovelace: bigint };
    ttlSlot: bigint;
  }): Promise<AllowanceBuilt>;
  buildAgentPay(input: {
    ownerKeyHash: string;
    allowance: AllowanceOnChain;
    agent: string;
    payee: string;
    lovelace: bigint;
    validityStartSlot: bigint;
    ttlSlot: bigint;
  }): Promise<AllowanceBuilt & { readonly nextDatum: AllowanceDatumView }>;
  buildOwnerSpend(input: {
    owner: string;
    allowance: AllowanceOnChain;
    continuing?: { lovelace: bigint; datum: AllowanceDatumView };
    validityStartSlot: bigint;
    ttlSlot: bigint;
  }): Promise<AllowanceBuilt>;
  /** The agent's whole float back to `to`; null when nothing worth sending is left. */
  buildFloatSweep(input: {
    from: string;
    to: string;
    ttlSlot: bigint;
  }): Promise<AllowanceBuilt | null>;
  /** Submit a signed transaction; returns its id. */
  submit(signedTransaction: string): Promise<{ txHash: string }>;
}

export interface ChainAdapters {
  /** Throws NETWORK_NOT_SUPPORTED for a network this deployment has no adapter for. */
  builder(network: NetworkId): NetworkBuilder;
  /** Masumi escrow on a Cardano network. Throws NETWORK_NOT_SUPPORTED when not served. */
  cardanoEscrow(network: NetworkId): EscrowChain;
  /** Auto-pay allowance on a Cardano network. Throws NETWORK_NOT_SUPPORTED when not served. */
  cardanoAllowance(network: NetworkId): AllowanceChain;
  broadcaster(network: NetworkId): Broadcaster;
  track(input: {
    network: NetworkId;
    txHash: string;
    lastValidBlockHeight?: string;
    from?: string;
    nonce?: number;
    /** Cardano: TTL slot of the transaction (enables `expired`). */
    validUntilSlot?: string;
  }): Promise<TrackOutcome>;
  /**
   * Cardano (ADR-002): what the passkey signs for a stored unsigned transaction, i.e. the
   * blake2b-256 hash of its body (lowercase hex), recomputed from the bytes. Throws when
   * the bytes are not a well-formed unsigned transaction.
   */
  cardanoSigningPayload(input: { network: NetworkId; unsigned: string }): string;
  /**
   * Cardano: the signed transaction from the reviewed unsigned one plus Turnkey's raw
   * Ed25519 signature (r || s). Fails closed unless the key owns `expectedSigner` and the
   * signature verifies over the body hash.
   */
  attachCardanoWitness(input: {
    network: NetworkId;
    unsigned: string;
    publicKey: string;
    signature: string;
    expectedSigner: string;
  }): { signedTransaction: string; encoding: "hex" };
  /**
   * Cardano x402 (exact scheme) payment payload from the stored signed transaction: the
   * transaction as base64 CBOR and a nonce naming one of its inputs. Throws when the bytes
   * are not a signed transaction.
   */
  cardanoX402Payment(input: { network: NetworkId; signedTransaction: string }): {
    transaction: string;
    nonce: string;
  };
  /** Wire encoding for broadcast (Solana: base64; EVM: 0x hex). Throws on malformed input. */
  normalizeSigned(input: SignedInput): { signedTransaction: string; encoding: "base64" | "hex" };
  /** Transaction id from the signed bytes alone. Throws if the bytes are not fully signed. */
  txHashOf(input: SignedInput): string;
  /** C7: the signed bytes are exactly the reviewed unsigned bytes (and the expected signer). */
  assertSignedMatchesUnsigned(input: {
    network: NetworkId;
    encoding: "base64" | "hex";
    signed: string;
    unsigned: string;
    expectedSigner: string;
  }): Promise<void>;
}
