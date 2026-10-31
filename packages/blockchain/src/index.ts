/**
 * @zyropay/blockchain: TransactionBuilder (per family), Broadcaster, ConfirmationTracker,
 * PortfolioProvider (Helius for Solana, Alchemy for EVM) and PriceProvider. Owner: Chain.
 *
 * Runtime-agnostic (Cloudflare Workers, Node, React Native): only fetch + Web APIs, every
 * credential and URL injected by the caller, no process.env reads.
 */
export { ChainError, isChainError } from "./errors";
export type { FetchLike, HttpOptions } from "./http";
export { parseJsonLossless } from "./http";
export type { RpcKeys, RpcNetworkId } from "./networks";
export {
  assertAddress,
  assertFamily,
  assertSameNetwork,
  PUBLIC_RPC_URLS,
  publicRpcUrlFor,
  rpcUrlFor,
} from "./networks";
export type { KeyFailoverEvent, KeyFailureReason, KeyPoolOptions } from "./key-failover";
export {
  ApiKeyPool,
  classifyKeyFailure,
  HELIUS_HOSTS,
  heliusKeyPool,
  parseKeyList,
  redactUrl,
  resetHeliusKeyPools,
} from "./key-failover";
export { deterministicUuid, findKnownToken, KNOWN_TOKENS, tokenAsset } from "./assets";
export type { KnownToken } from "./assets";

// Portfolio + prices
export type { AddressHoldings, HoldingsCache } from "./portfolio/common";
export { createCompositePortfolioProvider, createMemoryHoldingsCache } from "./portfolio/common";
export type { SolanaPortfolioConfig } from "./portfolio/solana";
export { createSolanaPortfolioProvider, parseSolanaTransaction } from "./portfolio/solana";
export type { EvmPortfolioConfig } from "./portfolio/evm";
export { createEvmPortfolioProvider, parseAlchemyTransfer } from "./portfolio/evm";
export type { PriceProviderConfig } from "./prices";
export { createPriceProvider, numberToDecimalString } from "./prices";
export type { PriceHistoryProviderConfig } from "./price-history";
export { createPriceHistoryProvider } from "./price-history";

// Transaction building
export type {
  SolanaTransactionBuilder,
  SolanaTransactionBuilderConfig,
  SolanaUnsignedTransaction,
  TransferFeeEstimate,
} from "./solana/builder";
export {
  createSolanaTransactionBuilder,
  simulationError,
  verifySolanaTransferAsync,
} from "./solana/builder";
export type {
  EvmBuildOptions,
  EvmTransactionBuilder,
  EvmTransactionBuilderConfig,
  EvmUnsignedTransaction,
} from "./evm/builder";
export {
  createEvmTransactionBuilder,
  mapExecutionError,
  OP_GAS_PRICE_ORACLE,
  verifyEvmTransfer,
} from "./evm/builder";

// Low-level helpers reused by @zyropay/integrations
export { SolanaRpc } from "./solana/rpc";
export type {
  ParsedMintInfo,
  SolanaCommitment,
  SolanaRpcOptions,
  SimulationResult,
} from "./solana/rpc";
export { EvmRpc } from "./evm/rpc";
export type { EvmCall, EvmReceipt, EvmRpcOptions } from "./evm/rpc";
export { bytesEqual, decodeSolanaTransaction, LOOKUP_TABLE_ACCOUNT } from "./solana/decode";
export type { DecodedInstruction, DecodedSolanaTransaction } from "./solana/decode";
export { maxNetworkFee, readComputeBudget } from "./solana/compute-budget";
export * as solanaPrograms from "./solana/constants";
export { JsonRpcClient, JsonRpcError, requestJson, resolveHttpOptions, toBigInt } from "./http";
export type { ResolvedHttpOptions } from "./http";

// Cardano (Blockfrost + own CBOR codec; docs/INTEGRATIONS.md "Cardano")
export type { CardanoPortfolioConfig } from "./portfolio/cardano";
export { createCardanoPortfolioProvider, parseCardanoTransaction } from "./portfolio/cardano";
export type {
  CardanoTransactionBuilder,
  CardanoTransactionBuilderConfig,
  CardanoTransferFeeEstimate,
  CardanoUnsignedTransaction,
} from "./cardano/builder";
export {
  createCardanoTransactionBuilder,
  MAX_TOKEN_OUTPUT_LOVELACE,
  minAdaFor,
  verifyCardanoTransfer,
} from "./cardano/builder";
export type {
  CardanoBroadcaster,
  CardanoBroadcasterConfig,
  CardanoTrackResult,
} from "./cardano/broadcast";
export {
  assertCardanoSignedMatchesUnsigned,
  cardanoTxHashOfSigned,
  createCardanoBroadcaster,
  normalizeCardanoSigned,
} from "./cardano/broadcast";
export type {
  AdditionalUtxo,
  BlockfrostConfig,
  BlockfrostUtxo,
  EvaluatedRedeemer,
  ProtocolParams,
  Rational,
  ScriptProtocolParams,
} from "./cardano/blockfrost";
export { BLOCKFROST_BASE_URLS, BlockfrostClient, parseEvaluation } from "./cardano/blockfrost";
// Masumi escrow (x402 assetTransferMethod "masumi"): lock + buyer script spends.
export type {
  CardanoEscrowBuilder,
  CardanoEscrowBuilderConfig,
  CardanoEscrowLockExpectation,
  CardanoEscrowLockInput,
  CardanoEscrowPlan,
  CardanoEscrowSpendExpectation,
  CardanoEscrowSpendInput,
  CardanoEscrowSpendPlan,
  EscrowUtxo,
  EscrowVerification,
  MasumiBuyerAction,
} from "./cardano/escrow";
export {
  CARDANO_SLOT_CONFIG,
  cardanoPosixMsToSlot,
  cardanoScriptAddress,
  cardanoSlotToPosixMs,
  createCardanoEscrowBuilder,
  MASUMI_BUYER_ACTIONS,
  MASUMI_SCRIPT_BYTES,
  MASUMI_SCRIPT_HASH,
  masumiEscrowAddress,
  masumiRedeemer,
  planCardanoEscrowLock,
  planCardanoEscrowSpend,
  plutusV3ScriptHash,
  requiredCollateral,
  scriptExecutionFee,
  verifyCardanoEscrowLock,
  verifyCardanoEscrowSpend,
} from "./cardano/escrow";
// Agent allowance (contracts/allowance): codecs, planners and a Blockfrost-backed builder;
// live on preprod, not wired into the app's signing path.
export type {
  AllowanceAction,
  AllowanceAgentPayInput,
  AllowanceCreateInput,
  AllowanceFloatSweepInput,
  AllowanceMeasuredPlan,
  AllowanceUncheckedSpendInput,
  CardanoAllowanceBuilder,
  CardanoAllowanceBuilderConfig,
  AllowanceDatum,
  AllowanceOwnerSpendInput,
  AllowancePayee,
  AllowancePlan,
  AllowanceScript,
  AllowanceSpendPlan,
  AllowanceUtxo,
} from "./cardano/allowance";
export {
  ALLOWANCE_PLACEHOLDER_EX_UNITS,
  ALLOWANCE_UNAPPLIED_SCRIPT,
  allowanceCurrentPeriod,
  allowanceRedeemer,
  allowanceScript,
  applyPlutusDataParam,
  assertAllowanceDatum,
  createCardanoAllowanceBuilder,
  decodeAllowanceDatum,
  encodeAllowanceDatum,
  measureAllowanceSpend,
  nextAllowanceDatum,
  planAllowanceAgentPay,
  planAllowanceCreate,
  planAllowanceFloatSweep,
  planAllowanceOwnerSpend,
  planAllowanceUncheckedSpend,
} from "./cardano/allowance";
export type {
  CardanoInput,
  CardanoOutput,
  CardanoRedeemer,
  CardanoTxOutput,
  CardanoValue,
  DecodedCardanoTx,
  DecodedRedeemer,
  VkeyWitness,
} from "./cardano/tx";
export {
  assembleTx as assembleCardanoTx,
  bodyHashHex as cardanoBodyHash,
  decodeCardanoTx,
  encodeBody as encodeCardanoBody,
  encodeRedeemers as encodeCardanoRedeemers,
  plutusV3LanguageViews,
  scriptDataHash as cardanoScriptDataHash,
  verifyVkeyWitness,
} from "./cardano/tx";

/**
 * Attach the user's vkey witness (Turnkey SIGN_RAW_PAYLOAD r||s over the body hash) to the
 * reviewed unsigned transaction. The body bytes are reused exactly; the result is hex.
 */
export { attachCardanoWitness } from "./cardano/witness";

// Broadcast + confirmation
export type { EvmBroadcasterConfig, SolanaBroadcasterConfig } from "./broadcast";
export {
  assertSignedMatchesUnsigned,
  createEvmBroadcaster,
  createSolanaBroadcaster,
  normalizeSignedTransaction,
  solanaSignatureOf,
  txHashOfSigned,
} from "./broadcast";
export type {
  ConfirmationTracker,
  ConfirmationTrackerConfig,
  NetworkTrackingConfig,
  TrackedStatus,
  TrackInput,
  TrackResult,
} from "./confirmation";
export { createConfirmationTracker } from "./confirmation";

// Mocks (simulated: true)
export {
  MockBroadcaster,
  MockPortfolioProvider,
  MockPriceProvider,
  MockTransactionBuilder,
} from "./mocks";
