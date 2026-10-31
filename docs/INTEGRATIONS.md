# Chain layer and integrations

Owner: Chain engineer. Packages: `@zyropay/blockchain` and `@zyropay/integrations`.
Each section cites its sources.

Both packages are runtime-agnostic. They use only `fetch`, `AbortController`, WebCrypto and pure-JS libraries (`@solana/kit`, `viem`, `@noble/hashes`, `@noble/curves` for Ed25519, and ZyroPay's own Cardano CBOR codec). They never read `process.env`, and every key and URL is passed in by the caller.

`pnpm --filter @zyropay/integrations check:workers` bundles a smoke worker without `nodejs_compat`. `smoke:workers` runs it in workerd: `GET /` builds and verifies Solana and EVM transfers, decodes the recorded Jupiter swap, builds an x402 EIP-712 authorization, checks the Transak and JWT failure paths, and runs a full Cardano round trip (build, independent verify, Ed25519 sign, attach the witness, C7 check, derive the tx id, broadcast to a fixture `tx/submit`).

## Wiring (API engineer)

```ts
import {
  rpcUrlFor,
  createSolanaPortfolioProvider,
  createEvmPortfolioProvider,
  createCompositePortfolioProvider,
  createPriceProvider,
  createSolanaTransactionBuilder,
  createEvmTransactionBuilder,
  createSolanaBroadcaster,
  createEvmBroadcaster,
  createConfirmationTracker,
  MockPortfolioProvider,
  MockPriceProvider,
  MockTransactionBuilder,
  MockBroadcaster,
} from "@zyropay/blockchain";
import {
  createJupiterAdapter,
  createX402Adapter,
  createKaminoAdapter,
  createAaveAdapter,
  createHyperliquidAdapter,
  createTransakOnrampProvider,
  createPluginRegistry,
  MockX402Adapter,
  MockPluginAdapter,
  MockOnrampProvider,
} from "@zyropay/integrations";

const keys = { heliusApiKey: env.HELIUS_API_KEY, alchemyApiKey: env.ALCHEMY_API_KEY };
const prices = createPriceProvider({
  coingeckoApiKey: env.COINGECKO_API_KEY,
  jupiterApiKey: env.JUPITER_API_KEY,
  maxAgeSeconds: Number(env.PRICE_MAX_AGE_SECONDS),
});
const portfolio = createCompositePortfolioProvider({
  byNetwork: {
    "solana-devnet": createSolanaPortfolioProvider({
      heliusApiKey: env.HELIUS_API_KEY,
      network: "solana-devnet",
    }),
    "ethereum-sepolia": createEvmPortfolioProvider({
      alchemyApiKey: env.ALCHEMY_API_KEY,
      network: "ethereum-sepolia",
    }),
    "base-sepolia": createEvmPortfolioProvider({
      alchemyApiKey: env.ALCHEMY_API_KEY,
      network: "base-sepolia",
    }),
  },
  priceProvider: prices,
});
const solBuilder = createSolanaTransactionBuilder({
  rpcUrl: rpcUrlFor("solana-devnet", keys),
  network: "solana-devnet",
});

// Cardano (section 7): Blockfrost, one project id per network, never shared across the divide.
const adaKey = env.BLOCKFROST_PROJECT_ID_PREPROD; // production: BLOCKFROST_PROJECT_ID_MAINNET
const adaPortfolio = createCardanoPortfolioProvider({
  blockfrostProjectId: adaKey,
  network: "cardano-preprod",
  priceProvider: prices,
});
const adaBuilder = createCardanoTransactionBuilder({
  blockfrostProjectId: adaKey,
  network: "cardano-preprod",
});
const adaBroadcaster = createCardanoBroadcaster({
  blockfrostProjectId: adaKey,
  network: "cardano-preprod",
});
const tracker = createConfirmationTracker({
  networks: { "cardano-preprod": { blockfrostProjectId: adaKey, confirmations: 3 } },
});
```

Each provider, builder and broadcaster is bound to **one network** and refuses any other network (`NETWORK_MODE_MISMATCH`). The composite routes each address by `byNetwork` first, then falls back to the family providers (`solana`, `evm`).

### Exported factories

| Package      | Factory                                                                                                                                                                | Implements                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blockchain   | `rpcUrlFor(network, { heliusApiKey?, alchemyApiKey? })`                                                                                                                | Helius URL for Solana, Alchemy URL for EVM. Throws if the key is missing; it never falls back to a public RPC. `publicRpcUrlFor` exists for dev and live tests.                                          |
| blockchain   | `createSolanaPortfolioProvider({ heliusApiKey, network, rpcUrl?, priceProvider?, cache?, pageSize?, maxPages?, now?, ...http })`                                       | `PortfolioProvider`                                                                                                                                                                                      |
| blockchain   | `createEvmPortfolioProvider({ alchemyApiKey, network, rpcUrl?, priceProvider?, cache?, maxPages?, now?, ...http })`                                                    | `PortfolioProvider`                                                                                                                                                                                      |
| blockchain   | `createCompositePortfolioProvider({ byNetwork?, solana?, evm?, priceProvider?, now? })`                                                                                | `PortfolioProvider` (routes by family, prices once)                                                                                                                                                      |
| blockchain   | `createPriceProvider({ jupiterApiKey?, coingeckoApiKey?, coingeckoPlan?, maxAgeSeconds?, valueTestnetsAtMainnetPrices?, now?, ...http })`                              | `PriceProvider`                                                                                                                                                                                          |
| blockchain   | `createPriceHistoryProvider({ coingeckoApiKey?, coingeckoPlan?, valueTestnetsAtMainnetPrices?, cacheSeconds?, maxPoints?, now?, ...http })`                            | `PriceHistoryProvider` (CoinGecko `market_chart`; fails closed to `unavailable`)                                                                                                                         |
| blockchain   | `createSolanaTransactionBuilder({ rpcUrl, network, maxMicroLamportsPerCu?, minMicroLamportsPerCu?, priorityFeePercentile?, computeUnitMarginBps?, now?, ...http })`    | `TransactionBuilder<"solana">`, plus `estimateTransferFee`, `rebuildIfExpiring`, `isBlockhashValid`                                                                                                      |
| blockchain   | `createEvmTransactionBuilder({ rpcUrl, network, maxFeePerGasCap?, maxPriorityFeePerGasCap?, baseFeeMultiplier?, gasLimitMarginBps?, l1FeeMarginBps?, now?, ...http })` | `TransactionBuilder<"evm">`, plus `buildTransfer(payload, { nonce? })`, `buildContractCall`, `estimateTransferFee`, `buildReplacement`, `buildCancellation`, `getNonceState`                             |
| blockchain   | `createSolanaBroadcaster({ rpcUrl, network, commitment? })`, `createEvmBroadcaster({ rpcUrl, network, confirmations? })`                                               | `Broadcaster`                                                                                                                                                                                            |
| blockchain   | `createConfirmationTracker({ networks: { [network]: { rpcUrl, confirmations?, commitment? } }, ...http })`                                                             | `track({ network, txHash, lastValidBlockHeight?, from?, nonce? })` returns `pending`, `confirmed`, `failed`, `expired` or `replaced`, plus `rebroadcastSuggested`                                        |
| blockchain   | `assertSignedMatchesUnsigned({ encoding, signed, unsigned, expectedSigner?, network? })`                                                                               | C7: the signed bytes must be the reviewed bytes, and the EVM signer is recovered and checked. Cardano (pass `network`): same body bytes, exactly one vkey witness that verifies and hashes to the sender |
| blockchain   | `createCardanoPortfolioProvider({ blockfrostProjectId, network, blockfrostBaseUrl?, priceProvider?, cache?, historyPageSize?, maxTokensPerAddress?, now?, ...http })`  | `PortfolioProvider` (Blockfrost)                                                                                                                                                                         |
| blockchain   | `createCardanoTransactionBuilder({ blockfrostProjectId, network, blockfrostBaseUrl?, ttlMarginSeconds?, maxTtlSeconds?, maxInputs?, now?, ...http })`                  | `TransactionBuilder<"cardano">`, plus `estimateTransferFee` (returns `minAdaDeposit`)                                                                                                                    |
| blockchain   | `createCardanoBroadcaster({ blockfrostProjectId, network, confirmations?, ...http })`                                                                                  | `Broadcaster`, plus `track({ txHash, validUntilSlot? })`                                                                                                                                                 |
| blockchain   | `attachCardanoWitness({ unsignedHex, publicKey, signature, expectedKeyHash })`, `verifyCardanoTransfer`, `decodeCardanoTx`, `cardanoTxHashOfSigned`                    | Witness assembly from Turnkey's raw Ed25519 signature (verified first), the independent decoder, strict CBOR decode, tx id                                                                               |
| integrations | `createJupiterAdapter({ apiKey, rpcUrl, baseUrl?, maxSlippageBps?, maxPriceImpactBps?, maxPriorityFeeLamports?, quoteTtlSeconds?, now?, ...http })`                    | `PluginAdapter`                                                                                                                                                                                          |
| integrations | `createX402Adapter({ caps, solanaRpcUrls?, maxTimeoutSeconds?, now?, ...http })`                                                                                       | `PluginAdapter`, plus `buildPaymentAuthorization` and `encodePaymentHeader`. `parseX402Response` and `normalizePaymentRequired` are standalone.                                                          |
| integrations | `createKaminoAdapter({ rpcUrl, baseUrl?, quoteTtlSeconds?, now?, ...http })`                                                                                           | `PluginAdapter`, plus `listMarkets` and `listReserves`                                                                                                                                                   |
| integrations | `createAaveAdapter({ rpcUrls, builder?, quoteTtlSeconds?, now?, ...http })`                                                                                            | `PluginAdapter`, plus `listReserves` and `allowance`                                                                                                                                                     |
| integrations | `createHyperliquidAdapter({ environment, baseUrl?, ...http })`                                                                                                         | `PluginAdapter` (read-only), plus `getSpotMarkets` and `getMids`                                                                                                                                         |
| integrations | `createTransakOnrampProvider({ apiKey, apiSecret, environment, referrerDomain, tokenStore?, webhookSecret?, quoteTtlSeconds?, now?, ...http })`                        | `OnrampProvider` (`createSession` also takes `userIp`)                                                                                                                                                   |
| integrations | `createPluginRegistry(adapters, { mode, enableComingSoon? })`                                                                                                          | `list`, `get`, and `require(id, { network, action })`                                                                                                                                                    |

`...http` is `{ fetch?, timeoutMs?, maxRetries?, backoffMs?, maxBackoffMs?, sleep? }`. The defaults are a 10 s timeout and 2 retries with exponential backoff that honours `Retry-After` on 429 and 5xx responses.

Every failure is a `ChainError` whose `code` is a shared `ErrorCode` and which carries `retryable`. Provider URLs embed keys, so they never appear in error messages.

**Mocks.** All of these return `simulated: true`:

- `MockPriceProvider`: SOL 150, ETH 3000, ADA 0.50, every token 1.
- `MockPortfolioProvider`
- `MockTransactionBuilder(family)`
- `MockBroadcaster`
- `MockX402Adapter` and `MockPluginAdapter(id)`, which run on testnets only. There is no swap mock: Jupiter has no test network.
- `MockOnrampProvider`

`createPluginRegistry` throws if a mock is registered in production mode.

## 1. Portfolio

**Solana: Helius.**

- Balances come from DAS `getAssetsByOwner` with `showFungible`, `showNativeBalance` and `showZeroBalance: false`, paged up to `limit` 1000.
- One call returns lamports and every SPL and Token-2022 balance. NFTs (0 decimals, supply 1) are dropped.
- Sources: https://www.helius.dev/docs/api-reference/das/getassetsbyowner and https://www.helius.dev/docs/das/fungible-token-extension.

**Solana history: Helius `getTransactionsForAddress`.** We call it with `transactionDetails: "full"`, `encoding: "jsonParsed"` and `filters.tokenAccounts: "balanceChanged"`, so incoming SPL transfers to ATAs are included. Pagination uses `paginationToken`. Source: https://www.helius.dev/docs/rpc/gettransactionsforaddress.

We did not use the Enhanced Transactions API (`/v0/addresses/{a}/transactions`). Helius has put it in maintenance mode, and its `tokenTransfers[].tokenAmount` is a UI-scaled float. Instead we read amounts from parsed System and SPL instructions as exact base-unit strings: `lamports`, `tokenAmount.amount`.

**EVM: Alchemy** (`{eth,base}-{mainnet,sepolia}.g.alchemy.com/v2/<key>`):

- Balances: `eth_getBalance`, plus `alchemy_getTokenBalances(addr, "erc20", { maxCount: 100, pageKey })`, plus `alchemy_getTokenMetadata`, which is memoized.
  - Tokens without decimals are skipped rather than guessed.
- History: `alchemy_getAssetTransfers`, fetched outgoing and incoming separately and merged by block.
  - The cursor holds a block bound plus the `uniqueId`s already returned in that block.
  - The `internal` category is requested only on Ethereum and Base mainnet, where it is supported.
- Sources:
  - https://www.alchemy.com/docs/reference/alchemy-gettokenbalances
  - https://www.alchemy.com/docs/reference/alchemy-gettokenmetadata
  - https://www.alchemy.com/docs/reference/alchemy-getassettransfers

**Normalization.**

- Amounts are base-unit integer strings, and JSON is parsed losslessly: u64 values above 2^53 stay exact. Tests cover this.
- Token metadata is untrusted: control characters are stripped, lengths are capped, and only `https:` logos are kept.
- `verified: true` is set only for a curated list: the USDC/USDT addresses in `KNOWN_TOKENS`.
- `Transaction.id` is a deterministic UUID (v8) derived from network, hash, index and address.

**Network checks.**

- Solana RPC: `getGenesisHash` must match the bound network's CAIP-2 genesis.
- EVM RPC: `eth_chainId` must match.
- Addresses are validated with the shared helpers.

**Stale data.** If a provider read fails (outage or 429), the last good holdings for that address are served from `HoldingsCache` and the snapshot gets `stale: true`. With no cache, the address is left out and the snapshot is still `stale: true`; the total is never lied about.

The default cache is per-isolate memory. Pass a KV-backed `cache` so it survives across isolates.

## 2. Prices

`createPriceProvider` works in USD only. A provider fails closed: an asset that is unknown, stale (`> maxAgeSeconds`), errored or non-USD is **absent** from the result, which the policy engine reads as "no valuation". Last good quotes are reused only while they are within `maxAgeSeconds`.

- **Solana mainnet** (SOL via wSOL, SPL mints): Jupiter Price API v3, `GET https://api.jup.ag/price/v3?ids=` (at most 50 ids, `x-api-key`).
  - The response has no timestamp, so `asOf` is the fetch time.
  - Mints Jupiter omits stay unpriced.
  - `lite-api.jup.ag` is being phased out.
  - Sources: https://developers.jup.ag/docs/price and https://developers.jup.ag/docs/portal/migration
- **Ethereum and Base mainnet**: CoinGecko `/simple/price?ids=ethereum` and `/simple/token_price/{ethereum|base}`, with `include_last_updated_at=true`, so `asOf` is CoinGecko's `last_updated_at`.
  - Demo plan: `api.coingecko.com` with `x-cg-demo-api-key`. Pro plan: `pro-api.coingecko.com` with `x-cg-pro-api-key`.
  - Sources: https://docs.coingecko.com/v3.0.1/reference/simple-price, https://docs.coingecko.com/v3.0.1/reference/simple-token-price and https://docs.coingecko.com/reference/authentication
- **Testnets**: unpriced by the provider's default. `valueTestnetsAtMainnetPrices: true`, for development only, values native coins (devnet SOL, Sepolia and Base Sepolia ETH, preprod ADA) and curated testnet USDC at their mainnet counterpart's price, labelled `source: "...+testnet-proxy"`. The API turns it on through `VALUE_TESTNETS_AT_MAINNET_PRICES` (default `true` in development, refused in production) and labels every such value `priceBasis: "mainnet_proxy"` (balances, signing reviews, transactions); the app shows "testnet · mainnet price". Unknown testnet tokens stay unpriced, so agent payments in them need approval (fail closed).
- **Transaction values**: the API fills `Transaction.valueAtTime` from the price history nearest the transaction time (1D/1W/1M/1Y series, tolerance 30 min to 3 days); no close point leaves it null.

### Price history

`createPriceHistoryProvider` serves the app's asset chart from CoinGecko `market_chart`, in USD only:

- **Natives:** `/coins/{solana|ethereum}/market_chart`.
- **Tokens:** `/coins/{ethereum|base|solana}/contract/{address}/market_chart`, with EVM addresses lowercased.
- **Shape:** the series is downsampled to `maxPoints` (default 200) and cached per asset and range (default 300 s, since the demo plan allows about 30 calls a minute). Points are decimal strings converted with `numberToDecimalString`.
- **Fails closed:** a testnet asset (unless `valueTestnetsAtMainnetPrices`, labelled `coingecko+testnet-proxy`), non-USD, a provider error or a series with fewer than two points returns `{ status: "unavailable", reason }`. An error falls back to the last good series for that key.
- **Mock:** `MockPriceHistoryProvider` (apps/api) returns a deterministic, `simulated: true` series around the mock price.

Source: https://docs.coingecko.com/reference/coins-id-market-chart and https://docs.coingecko.com/reference/contract-address-market-chart

## 3. Transaction building

### Solana (`@solana/kit` 8.5, `@solana-program/{system,token,compute-budget}`)

`buildTransfer(payload)` runs these steps in order:

1. Zod-validate the payload, the bound network, the address format and expiry, and refuse a zero amount.
2. Build the transfer instruction:
   - **SOL:** `SystemProgram.transfer`.
   - **SPL:** read the mint with `jsonParsed`; it must be owned by Token or Token-2022.
     - Decimals must equal the payload's, else `DECIMALS_MISMATCH`.
     - Token-2022 mints are refused if they have a non-zero transfer fee, a transfer-hook program, are non-transferable, or are paused.
     - The recipient must be a wallet, not a token account (`INVALID_ADDRESS`).
     - The sender's ATA must exist (`INSUFFICIENT_FUNDS`).
     - `CreateAssociatedTokenIdempotent` is added when the recipient ATA is missing. The rent is reported as `rentDeposit` and is not part of the fee.
     - The transfer is `TransferChecked` with the token program as `programAddress`.
3. Set the priority fee: the 75th percentile of `getRecentPrioritizationFees` over the writable accounts, clamped to `[min, maxMicroLamportsPerCu]` (default ceiling 2,000,000 µlamports/CU).
4. Size compute: simulate at 1.4M CU with `replaceRecentBlockhash: true`, then use `unitsConsumed` × 1.2 + 300 as the limit.
5. Fit the fee cap: `5000 × signatures + ceil(limit × price / 1e6) ≤ payload.feeCap`. The price is lowered to fit. A cap below the base fee gives `VALIDATION_FAILED`.
6. Simulate the **exact bytes** with no blockhash replacement. Errors are mapped: `Custom:1`, `InsufficientFunds*` and `AccountNotFound` become `INSUFFICIENT_FUNDS`.
7. Run `verifyMatchesPayload` on the built bytes as a self-check.

The output is a v0 message with no lookup tables, base64 wire format, and an empty signature. It also carries `blockhash`, `lastValidBlockHeight`, `computeUnitLimit`, `microLamportsPerCu`, `rentDeposit` and `validUntil` (an ISO estimate at 0.4 s per block).

`verifyMatchesPayload` decodes the bytes independently with no RPC and fails closed. It checks:

- the sender is fee payer and the only signer;
- there are no lookup tables;
- only ComputeBudget limit and price are present, at most once each;
- there is exactly one System transfer (SOL), or an optional matching idempotent ATA create plus exactly one `TransferChecked` with the derived ATAs, mint, authority, amount and decimals (SPL);
- the worst-case fee is at most `feeCap`.

`rebuildIfExpiring(stored, payload, { minRemainingBlocks = 40 })` implements ADR-001 D4. It rebuilds from the same payload and asserts that `payloadHash` is unchanged; the hash never covers the blockhash. `estimateTransferFee` returns `recommendedFeeCap` (2× the estimate, or at least +10k lamports) so the API can fix `feeCap` before hashing.

### EVM (viem 2.57)

`buildTransfer(payload, { nonce? })` runs these steps in order:

1. Check the chain id via `eth_chainId`.
2. ERC-20 only: check that the contract has code, and that `decimals()` equals the payload's decimals.
3. Simulate with `eth_call` against `pending`. A `transfer` call must return true.
4. Estimate gas with `eth_estimateGas` plus 20%.
5. Set EIP-1559 fees from `eth_feeHistory(5, latest, [50])`:
   - `maxFee = 2 × baseFee + tip`;
   - the tip is capped at 10 gwei and `maxFee` at 300 gwei;
   - if the base fee is above the cap, the build fails with a retryable `UPSTREAM_UNAVAILABLE`.
6. Base only: add the L1 data fee from `GasPriceOracle.getL1Fee(unsignedTx)` at `0x42…0F`, plus 50%.
7. Fit under `feeCap`. `maxFeePerGas` is lowered, but never below `baseFee + tip`.
8. Take the nonce from `pending`, unless an explicit nonce is passed. **The API must pass explicit nonces when several requests from one address are in flight.**

The output is an unsigned EIP-1559 RLP hex string.

`verifyEvmTransfer` checks:

- type 2, unsigned, and the chain id of the payload's network;
- no access list and no contract creation;
- native transfers: exact `to` and `value`, and empty calldata;
- ERC-20 transfers: `to` is the token, value is 0, and calldata is exactly `transfer(to, amount)` with no trailing bytes;
- `gas × maxFeePerGas ≤ feeCap`.

The OP-stack L1 fee is not encoded in the transaction. It is bounded at build time only.

Helpers for stuck transactions:

- `buildReplacement(stored, payload, { bumpBps = 1250 })` keeps the same nonce and call with at least a 10% fee bump, and refuses if that exceeds the approved `feeCap`.
- `buildCancellation({ from, nonce, ... })` builds a zero-value self-send that is bound to no payload, so it needs its own request.
- `getNonceState(address)` returns `latest` vs `pending`.

## 4. Broadcast and confirmation

**Solana:**

- Broadcast with `sendTransaction(base64, { skipPreflight: false, preflightCommitment })`.
- The tx hash is the fee payer's signature, computed locally. The send is refused if any signature is missing.
- Error mapping:
  - "already processed" counts as **success** (idempotent rebroadcast);
  - "Blockhash not found" is `BROADCAST_FAILED` with `details.reason = "blockhash_expired"`, meaning rebuild and re-sign;
  - insufficient lamports or `AccountNotFound` is `INSUFFICIENT_FUNDS`.
- Status comes from `getSignatureStatuses(searchTransactionHistory)` compared against the configured commitment (`SOLANA_COMMITMENT`).

**EVM:**

- Before sending, the transaction must carry a signature and the right chain id. The hash is `keccak256(signed)`.
- Error mapping:
  - "already known" counts as success;
  - "nonce too low" is success if our hash is known, otherwise `BROADCAST_FAILED`;
  - insufficient funds is `INSUFFICIENT_FUNDS`;
  - underpriced is `BROADCAST_FAILED` with `details.reason = "underpriced"`.
- Status comes from the receipt: confirmations = head − block + 1, compared against `EVM_CONFIRMATIONS`.

**Tracker:**

- Solana returns `expired` only when the block height is above `lastValidBlockHeight` and a re-check still finds nothing. That transaction can never land.
- EVM returns `replaced` when there is no receipt, the transaction is not in the mempool, and the sender's `latest` nonce is above ours. Otherwise it returns `pending`, with `rebroadcastSuggested` when the node does not know the hash.

## 5. Integrations

Every adapter has the same safety properties:

- It takes structured params through strict Zod objects. Unknown keys such as `instructions` or `note` are rejected with `VALIDATION_FAILED`.
- The quote comes before execution.
- `riskCategory` is copied into `pluginData`.
- `buildTransaction` first asserts that the payload's `plugin`, `pluginData` (canonical JSON), `amount` and expiry match the quote.
- It then runs an adapter-specific independent decode before returning bytes.

### Jupiter (`riskCategory: medium`, mainnet only)

**API:** Swap API v1 (Metis): `GET https://api.jup.ag/swap/v1/quote` and `POST /swap/v1/swap`, with `x-api-key`. Sources: https://developers.jup.ag/docs/swap and https://developers.jup.ag/docs/openapi-spec/swap/v1/swap.yaml.

Why v1: v2 `/order` + `/execute` sends the transaction through Jupiter and RFQ makers, which conflicts with ADR-001's sign-only model with our own broadcaster. `/swap/v2/build`, which returns instructions, is the migration target. v1 still works and has no published sunset date.

**Guards:**

- `slippageBps ≤ maxSlippageBps` (default 100; hard ceiling 1000).
- Price impact ≤ `maxPriceImpactBps` (default 100). `priceImpactPct` is a fraction, converted with bigint ceil.
- ExactIn only.
- The quote must echo the requested mints, amount and slippage.

**Payload binding.** `pluginData = { inputMint, outputMint, inAmount, minOutAmount, slippageBps, riskCategory }`, and nothing route-specific. The raw quote travels in `JupiterQuote.jupiterQuote`.

`minOutAmount = floor(outAmount × (10000 − slippage) / 10000)` is what the Jupiter program enforces on-chain. The API's `otherAmountThreshold` is rounded up and was 1 unit higher in the recorded fixture.

If the stored quote has expired, `buildTransaction` re-quotes. It accepts the new route only if its guaranteed minimum is at least the approved `minOutAmount`, so the payload hash survives blockhash rebuilds.

**`verifyJupiterSwap`** (checked against a real recorded mainnet transaction). It checks:

- the user is fee payer and sole signer;
- the programs are limited to Jupiter v6 (`JUP6Lkb…`), ComputeBudget, System, Token/2022 and ATA;
- System instructions are only transfers from the user into the user's own wSOL ATA, never more than the input;
- Token instructions are only SyncNative, or CloseAccount back to the user;
- ATA instructions are idempotent and for the user only;
- there is exactly one `route` or `shared_accounts_route`, whose encoded tail (`in_amount u64 | quoted_out u64 | slippage u16 | platform_fee u8`, confirmed on the fixture) has `in_amount = payload.amount`, `floor(quoted × (1 − slip)) ≥ minOutAmount` and a platform fee of 0;
- the fee is at most `feeCap`.

**Residual limit:** pool accounts, and sometimes the output token account, come from address lookup tables and cannot be resolved offline. The on-chain slippage check enforces the minimum output.

Swaps are never autonomous (ADR-001 D7, `AUTONOMY_ELIGIBLE_TOOLS`). Jupiter routes on Solana mainnet only, so development and staging (test networks) have no swaps: the API refuses them with `SWAP_UNAVAILABLE_ON_NETWORK` instead of simulating one.

### x402 (`riskCategory: medium`)

**Spec:** x402 v2, with v1 as a fallback. Sources:

- https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
- https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
- https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
- https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md

**Why not `@x402/*` 2.28:** those packages pin zod 3 and `@solana-program/*` versions that are majors behind our kit-8 stack. ZyroPay also needs the unsigned artifact for Turnkey, not an in-process signer. We implement the spec directly.

**Parsing.**

- `parseX402Response({ status, headers, body })`: for v2, base64 JSON in the `PAYMENT-REQUIRED` header; for v1, a JSON body with `maxAmountRequired` and v1 network names.
- `normalizePaymentRequired(obj)` handles `AgentTransactionRequestBody.paymentRequirements`.

**Quote checks.**

- Payment caps:
  - scheme `exact`, on a CAIP-2 network equal to the request's;
  - the asset must equal `assetId`;
  - the amount must be ≤ the agent's `maxAmount` **and** ≤ `caps[assetId]` (`POLICY_DENIED`);
  - **an asset with no configured cap is refused**, so the adapter never pays above its cap.
- Address and timeout checks:
  - `payTo` must be valid and must not be the payer;
  - `maxTimeoutSeconds` must be at most 600;
  - the resource URL must equal the one the agent requested.
- EVM: `extra.name` and `extra.version` are required, and `assetTransferMethod` must be absent or `eip3009` (Permit2 and ERC-7710 are refused).
- SVM: `extra.feePayer` is required and must not be the payer.

**EVM.** `buildTransaction` refuses with `BAD_REQUEST`. Use `buildPaymentAuthorization({ payload, quote })` instead, which returns:

- EIP-712 `TransferWithAuthorization` typed data, with domain `{ name, version, chainId, verifyingContract: asset }`;
- the message, with `nonce = keccak256(payloadHash)` (deterministic and payload-bound), `validAfter = 0` and `validBefore = min(expiresAt, now + maxTimeoutSeconds)`;
- the `digest`.

`verifyX402Authorization` checks it independently. `encodePaymentHeader` produces the `PAYMENT-SIGNATURE` value (v2: `{ x402Version, resource, accepted, payload }`) or `X-PAYMENT` (v1).

**SVM.** `buildTransaction` produces the exact-scheme layout:

1. ComputeBudget limit (40k)
2. ComputeBudget price (1 µlamport, at most 5 lamports/CU allowed)
3. `TransferChecked` from the payer's ATA to `payTo`'s ATA (that ATA must already exist, since the scheme forbids creating it)
4. Memo (`extra.memo`, or the first 16 bytes of `payloadHash` as hex)

The facilitator is fee payer, so `estimatedFee` is 0. The user signs as the second signer. `verifyX402SolanaPayment` checks this layout.

**Cardano** (v2 only; `cardano:preprod` / `cardano:mainnet`, CIP-34 ids also accepted):

- Asset `lovelace` is ADA (`cardano-*:native`); a token is `<policyId>.<assetNameHex>` against our concatenated unit (`x402AssetMatches`).
- Only the `default` transfer method: `masumi` (escrow) and `script` lock funds at a script address with a datum, which ZyroPay neither builds nor verifies. Sponsored fees are refused.
- The adapter does not build the payment: it is a plain transfer to `payTo`, built by the Cardano `TransactionBuilder` with `maxValiditySeconds = maxTimeoutSeconds` (the facilitator refuses a TTL beyond now + maxTimeoutSeconds), and verified by `verifyCardanoTransfer` plus the binding to the x402 terms.
- Every output needs about 1 ADA (min-UTxO), so prices below that cannot be paid in lovelace.
- `cardanoPaymentPayload(signedHex)` builds the scheme payload: the signed transaction as base64 CBOR and a nonce naming its first input (`<txHash>#<index>`); it refuses an unsigned transaction. The client pays the network fee.

### Kamino (`riskCategory: high`, mainnet only)

**API:** the public REST API with no key, from https://kamino.com/docs/build/api-reference/introduction:

- discovery: `GET /v2/kamino-market?programId=KLend…`, `GET /kamino-market/{m}/reserves/metrics?env=mainnet-beta`
- transactions: `POST /ktx/klend/{deposit|withdraw}` with `{ wallet, market, reserve, amount: "<decimal string>" }`, returning `{ transaction }`

Transaction building is implemented, not just read-only discovery. The recorded fixture is a real KTX deposit of 1.5 USDC.

**`verifyKaminoTransaction`.** It checks:

- the user is fee payer and sole signer;
- the programs are limited to KLend, Farms, AddressLookupTable (create/extend only, user as authority), ComputeBudget, ATA, Token (SyncNative/Close) and Memo;
- there is exactly one KLend deposit (v1 or v2 discriminator), whose u64 amount at offset 8 equals `payload.amount`, or exactly one withdraw;
- the fee is at most `feeCap`.

**Limit:** withdraw instructions carry a collateral (cToken) amount that cannot be mapped to the liquidity amount offline, so withdrawals are checked only by instruction kind. Funds flow back to the user.

The transaction is simulated before handoff. Payload mapping: deposit is `to = reserve`; withdraw is `to = wallet`.

### Aave v3 (`riskCategory: high`)

**Addresses** come from bgd-labs/aave-address-book (`AaveV3Ethereum`, `AaveV3Base`, `AaveV3Sepolia`, `AaveV3BaseSepolia`; https://github.com/bgd-labs/aave-address-book).

**ABIs:** IPool `supply`/`withdraw` and IPoolDataProvider `getAllReservesTokens`, `getReserveConfigurationData` and `getReserveData`, from https://github.com/aave-dao/aave-v3-origin.

**Reads:** `listReserves(network)` returns symbol, decimals, active/frozen state and the supply rate as a ray integer string.

**Actions.**

- `supply`: refused if the reserve is frozen or inactive, or if the allowance is below the amount. The error's `details.requiredAction = "approve"`.
- `approve`: an exact-amount ERC-20 approve to the Pool, never unlimited.
- `withdraw`: no extra checks beyond the shared ones.

Each action is built with `EvmTransactionBuilder.buildContractCall`, which simulates and fits fees. `verifyAaveTransaction` re-derives the exact calldata: asset, amount, `onBehalfOf`/`to` = the user, spender = the Pool, no trailing bytes, zero value.

Testnet markets use Aave faucet tokens, not Circle USDC.

### Hyperliquid (`riskCategory: critical`, read-only)

`POST https://api.hyperliquid.xyz/info` with `{ type: "spotMetaAndAssetCtxs" | "allMids" }` (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Asset contexts are matched by `coin`: live data had 332 universe entries against 1061 contexts, so matching by position is wrong.

`quote` and `buildTransaction` refuse with `PLUGIN_DISABLED`.

**Why trading is out of scope.** Hyperliquid is its own L1. An "action" is an EIP-712 signature posted to `/exchange`, not a transaction on a ZyroPay network. There are two signing paths:

- **L1 actions** (orders): `keccak(msgpack(action) ‖ nonce ‖ vault)`, signed as a phantom agent `{ source, connectionId }` under the domain `{ name: "Exchange", chainId: 1337 }`.
- **User actions** (`usdSend`, `withdraw3`, `approveAgent`): signed under `HyperliquidSignTransaction` with `signatureChainId`.

Offering trading needs a separate signing review, a leverage policy model, and Turnkey EIP-712 policies (an ADR-001 open item). Source: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing.

## 6. Transak on-ramp

Sources:

- https://docs.transak.com/api/public/get-price
- https://docs.transak.com/api/public/refresh-access-token
- https://docs.transak.com/api/public/create-widget-url
- https://docs.transak.com/guides/migration-to-api-based-transak-widget-url
- https://docs.transak.com/features/webhooks

**Flow.**

- **Quote:** `GET {api}/api/v1/pricing/public/quotes`.
  - `cryptoAmount` is a float. It is truncated to the asset's decimals and never rounded up.
  - The returned `quoteId` is a self-contained token, HMAC-SHA256 signed with the API secret, so `createSession` needs no shared state and rejects tampered or expired quotes or a different wallet.
- **Access token:** `POST {api}/partners/api/v2/refresh-token`, valid for 7 days. **Refreshing invalidates the previous token**, so pass a KV- or DB-backed `tokenStore` shared by every isolate.
- **Session:** `POST {gateway}/api/v2/auth/session` with `access-token`, `x-api-key` and `x-user-ip`.
  - Query-parameter widget URLs are no longer supported by Transak.
  - Transak requires the end user's IP, so **`createSession` needs `userIp`**. The shared port lacks it; pass `CF-Connecting-IP`.
- **Webhook:** the body is `{ data: JWT }`, HS256-signed with the partner access token.
  - We verify with WebCrypto against the current token, the previous token and an optional `TRANSAK_WEBHOOK_SECRET`. `alg` must be HS256 (`none` is refused).
  - `eventId = <orderId>:<eventID>` for deduplication. Status is mapped by `normalizeTransakStatus`.
  - The function never throws.

**Environments.** `STAGING` serves only testnets and `PRODUCTION` only mainnets. The staging network names for test chains (`ethereum`, `base`, `solana`) are an assumption; confirm them with sandbox keys via `GET /api/v2/currencies/crypto-currencies`.

## 7. Cardano (Blockfrost, Turnkey raw Ed25519)

Networks `cardano-mainnet` and `cardano-preprod` (family `cardano`, ADA = 6 decimals, 1 ADA = 1,000,000 lovelace, CAIP-2 per CIP-34: `cip34:1-764824073` and `cip34:0-1`). Production serves mainnet only, development preprod only. Explorer: cardanoscan.io (`preprod.cardanoscan.io` on preprod). Key derivation and the signing model are ADR-002 in `ARCHITECTURE.md`.

### Turnkey verdict

Turnkey **can sign Cardano**, at the curve level only:

- There is no `ADDRESS_FORMAT_CARDANO` and no `TRANSACTION_TYPE_CARDANO`. Turnkey's Cardano guide uses an `ADDRESS_FORMAT_COMPRESSED` account on `CURVE_ED25519` (the account "address" is the raw Ed25519 public key) and derives the Cardano address client side (Blake2b-224 of the key, enterprise address). Sources: https://docs.turnkey.com/features/networks/cardano, https://docs.turnkey.com/features/wallets ("You can use `ADDRESS_FORMAT_COMPRESSED` to generate a public key ... only raw payloads are supported"), and the official example https://github.com/tkhq/sdk/tree/main/examples/chain-integrations/with-cardano.
- Signing is `SIGN_RAW_PAYLOAD` over the 32-byte transaction **body hash** with `PAYLOAD_ENCODING_HEXADECIMAL` and `HASH_FUNCTION_NOT_APPLICABLE`; `@turnkey/sdk-server` 8.6.0 types say the hash function "must be set to HASH_FUNCTION_NOT_APPLICABLE for EdDSA/ed25519 signature requests". The result's `r || s` is the 64-byte Ed25519 signature for the vkey witness (no `v`). Source: https://docs.turnkey.com/api-reference/activities/sign-raw-payload and the example above.
- Consequences: Turnkey's policy engine cannot parse Cardano transactions, so **no Turnkey policy can bound a Cardano signature**. Cardano is therefore never autonomous (shared `AUTONOMY_ELIGIBLE_FAMILIES`); every Cardano payment needs the user's passkey.
- Turnkey does not document its Ed25519 derivation scheme (its default table mixes hardened and soft trailing segments, e.g. Sui `m/44'/784'/0'/0/0`). ZyroPay uses `m/1852'/1815'/0'/0'/0'`, every level hardened, which is derivable under SLIP-10 (https://github.com/satoshilabs/slips/blob/master/slip-0010.md) and BIP32-Ed25519 alike.
- **Not verified against a real Turnkey organization** (no credentials in this environment): that `createWalletAccounts` / the Auth Proxy accept that account spec, and that `list_wallet_accounts` returns the public key as the address. MockTurnkey implements the documented behaviour with a real Ed25519 key.

### Library choice: own CBOR codec + `@noble/curves`

Measured by bundling each candidate with wrangler 4.151 (no `nodejs_compat`) and running it in workerd:

| Candidate                                             | Bundle (raw / gzip) | Runs in workerd        | Notes                                                                                                                                  |
| ----------------------------------------------------- | ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@emurgo/cardano-serialization-lib-browser` 17.0.0    | 2,827 / 816 KiB     | **no**                 | `wasm2.__wbindgen_start is not a function`: its bundler-target WASM import needs a custom instantiation shim on Workers                |
| `@emurgo/cardano-serialization-lib-asmjs` 17.0.0      | 50 MB source        | not tried              | Far above the Worker size limit                                                                                                        |
| `@meshsdk/core-cst` 1.9.1                             | 7,295 / 1,214 KiB   | yes (import)           | Pulls `@cardano-sdk/*`, libsodium, bn.js, hash.js                                                                                      |
| `@harmoniclabs/cardano-ledger-ts` 0.5.6               | 3,137 / 473 KiB     | yes                    | Pure TS; a general ledger model                                                                                                        |
| `@lucid-evolution/lucid` 0.8.3                        | not tried           | -                      | Built on CSL (same WASM problem) plus Effect                                                                                           |
| **ZyroPay codec** (`packages/blockchain/src/cardano`) | adds ~10 KiB        | **yes** (smoke worker) | Strict canonical CBOR, exactly the transaction shape ZyroPay builds; Ed25519 via `@noble/curves` 2.4.0 (pure JS, already in the graph) |

The decision: ZyroPay only ever builds one shape (inputs, outputs, fee, TTL; legacy `[address, value]` outputs; tag-258 sets), and the security-critical part is the **independent, strict decoder** behind `verifyMatchesPayload`, which must reject everything else anyway. A general library would decode certificates, withdrawals, scripts and governance actions that ZyroPay then has to re-reject field by field. So the codec is our own (~600 lines) and is cross-checked in unit tests against the reference implementation, **EMURGO CSL 17.0.0 (`@emurgo/cardano-serialization-lib-nodejs`, a dev dependency only)**: CSL parses every transaction we build, computes the same transaction id (`FixedTransaction.transaction_hash`), the same `min_fee` and the same `min_ada_for_output`, and produces a byte-identical vkey witness for the same key. Two recorded real mainnet transactions decode to their on-chain ids with both implementations.

### Blockfrost (https://docs.blockfrost.io, OpenAPI https://github.com/blockfrost/openapi)

- Base URLs `https://cardano-mainnet.blockfrost.io/api/v0` and `https://cardano-preprod.blockfrost.io/api/v0`; header `project_id`; one project per network. Project ids start with the network name, and `BlockfrostClient` refuses a mainnet id on preprod and back (`NETWORK_MODE_MISMATCH`). Before anything else it checks `/genesis.network_magic` (764824073 mainnet, 1 preprod).
- Limits (OpenAPI): 10 requests/s per IP with a burst of 500, plus a daily quota per plan. 429/5xx are retried with backoff; 402 (quota) and 418 (auto-ban) become retryable `RATE_LIMITED`; 403 is a refused project id; 425 (mempool full) on submit is retryable.
- Endpoints used: `/addresses/{a}` (balance and tokens in one call; 404 = unused, empty), `/addresses/{a}/utxos` (pages of 100), `/addresses/{a}/transactions?order=desc`, `/txs/{h}`, `/txs/{h}/utxos`, `/assets/{unit}`, `/epochs/latest/parameters`, `/blocks/latest`, `/mempool/{h}`, `POST /tx/submit` (`Content-Type: application/cbor`, returns the tx id).

### Addresses (CIP-19, CIP-5)

- Send recipients and senders must be Shelley addresses of the bound network (`addr1…` mainnet, `addr_test1…` testnet) with a **key** payment credential (base, pointer or enterprise). Refused: Byron (`Ae2…`/`DdzFF…`), stake (`stake…`), the other network's addresses, and **script** payment credentials (a plain transfer to a Plutus script without a datum can lock funds for good). Note that preprod and preview share network id 0, so their addresses look the same.
- `AddressSchema` (display) also accepts script and Byron addresses so history counterparties validate; its max length is now 128 (base addresses are up to 108 characters).
- ZyroPay's own address is the **enterprise** address (CIP-19 type 6) of Blake2b-224 of the Turnkey key. It has no stake part, so ADA there does not earn staking rewards; the receive screen says so.
- Receive QR: `web+cardano:<address>` (CIP-13).
- Native tokens: asset id `<network>:<policy id hex><asset name hex>` (Blockfrost's `unit`), kind `cardano_token`. Decimals come from the Token Registry (CIP-26) or CIP-68/CIP-25 metadata, else 0 (the ledger's integer unit). Supply-1 tokens without decimals (NFTs) are not shown as balances. No Cardano token is curated, so every token is `verified: false`.

### Building (`createCardanoTransactionBuilder`)

1. Validate the payload, the bound network and expiry; token sends read `/assets/{unit}` and require the payload's decimals (`DECIMALS_MISMATCH`).
2. The payment output is output 0: ADA sends carry exactly `amount` lovelace and must meet min-UTxO; token sends carry exactly `amount` of the token plus the minimum lovelace that output needs (`minAdaDeposit`).
3. Coin selection: UTxOs with the token first, then pure-ADA, then other token-bearing UTxOs, largest first, at most 60 inputs. UTxOs with reference scripts are skipped (Conway charges for them). Change (output 1) returns to the sender and must meet min-UTxO, otherwise more inputs are added; if none are left the build fails `INSUFFICIENT_FUNDS` rather than burning dust as fee.
4. Fee = `min_fee_a × size + min_fee_b` on the size of the transaction **with one vkey witness**, iterated to a fixed point. Min-UTxO = `(160 + output size) × coins_per_utxo_size` (https://docs.cardano.org/native-tokens/minimum-ada-value-requirement/, https://docs.cardano.org/about-cardano/explore-more/fee-structure).
5. TTL = tip slot + (time until `payload.expiresAt`) + 10 minutes, at most 2 hours; `validUntil` is its wall-clock time.
6. Checks: value conserved, size ≤ `max_tx_size`, values ≤ `max_val_size`, **fee + minAdaDeposit ≤ feeCap**. Then the self-check `verifyMatchesPayload`.

`estimateTransferFee` returns `recommendedFeeCap = fee + max(fee, 0.2 ADA) + minAdaDeposit`, so the payload's fee cap covers the token deposit too. The API's static ceiling is 3 ADA (`FEE_CAPS`).

There is no node-side simulation for plain key-witnessed transfers (no scripts to evaluate); the ledger rules that would reject the transaction are checked locally instead.

**Concurrency limit.** Two in-flight sends from one address can select the same UTxO. The second then fails at submit with `BadInputsUTxO`, which is definitive (`inputs_spent`): the request fails and the user retries. There is no UTxO reservation yet.

### `verifyMatchesPayload` (no network access, fails closed)

- strict canonical CBOR, and the body must re-encode to the same bytes;
- body keys exactly {inputs, outputs, fee, ttl}: no certificates, withdrawals, mint, collateral, required signers, script data, metadata hash, validity start or governance fields;
- empty witness set, `is_valid = true`, no auxiliary data;
- output 0 pays `to` exactly (ADA: `amount` lovelace and nothing else; token: exactly `amount` of the asset, at most 5 ADA alongside); at most one more output, back to `from`; no datums or script references;
- fee + the token output's lovelace ≤ `feeCap`.

### Signing and broadcast (API)

- The review carries `rawPayload = { kind: "cardano_tx_body_hash", payload, signWith }`; the API recomputes the body hash from the stored bytes (strict decode) and `signWith` is the public key stored at wallet sync (`wallet_addresses.public_key`).
- The app stamps `SIGN_RAW_PAYLOAD_V2` with the passkey. The API (`verifySignCardanoRequest`) requires the passkey stamp over this body, the sign_raw_payload URL, the user's sub-org, `signWith` = the stored key whose Blake2b-224 is the payment credential of `payload.from`, the payload byte-equal to the body hash, `HASH_FUNCTION_NOT_APPLICABLE`, and a fresh timestamp; then the usual `payloadHash` and independent-decode checks.
- After Turnkey signs, `attachCardanoWitness` verifies the Ed25519 signature over the body hash before building the signed transaction; C7 (`assertSignedMatchesUnsigned` with `network`) re-checks it before broadcast. The tx id (body hash) is recorded before sending.
- Broadcast: `POST /tx/submit`. `BadInputsUTxO` for our own already-landed (or mempool) transaction is success; otherwise `inputs_spent`; `OutsideValidityIntervalUTxO` is `ttl_expired`. Both are definitive. Confirmation: `/txs/{h}` block height vs the tip (`CARDANO_CONFIRMATIONS`, default 3); `expired` only once the tip slot is past the TTL and the transaction is still unknown; `rebroadcastSuggested` when it is neither on chain nor in Blockfrost's mempool.

### Prices

ADA via CoinGecko `/simple/price?ids=cardano` (mainnet; preprod only through the development `VALUE_TESTNETS_AT_MAINNET_PRICES`). Price history via `/coins/cardano/market_chart`. Native tokens stay unpriced: CoinGecko documents no contract lookup for Cardano policy ids, so nothing is guessed and agent payments in tokens need approval (no valuation).

### History

`/addresses/{a}/transactions?order=desc&count=10&page=N` (cursor = page). For each transaction `/txs/{h}` and `/txs/{h}/utxos`: the movement of each asset is outputs to the address minus inputs from it (collateral and reference inputs ignored), with the fee attributed when the address funded the transaction. One row per asset that moved, or one `self` row when only the fee did. Each transaction costs two calls, hence the page size of 10.

## Credentials required

| Variable                                                                     | Used by                                                                                 |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `HELIUS_API_KEY`                                                             | Solana RPC, DAS, history (`rpcUrlFor`)                                                  |
| `ALCHEMY_API_KEY`                                                            | Ethereum/Base RPC, balances, transfers                                                  |
| `COINGECKO_API_KEY` (demo or pro)                                            | EVM prices                                                                              |
| `JUPITER_API_KEY`                                                            | Jupiter prices and swaps; the keyless tier is 0.5 RPS                                   |
| `TRANSAK_API_KEY`, `TRANSAK_API_SECRET`, `TRANSAK_WEBHOOK_SECRET` (optional) | On-ramp (sandbox)                                                                       |
| `BLOCKFROST_PROJECT_ID_MAINNET` / `BLOCKFROST_PROJECT_ID_PREPROD` (optional) | Cardano in production / development; without the id for the mode, Cardano is not served |

Kamino, Hyperliquid and x402 need no key. x402 needs `caps` per asset from configuration.

## Tests

- `pnpm test`: unit tests using recorded fixtures, with no network.
  - blockchain: 67 tests (19 Cardano, cross-checked against EMURGO CSL 17.0.0) plus 7 live Cardano tests skipped by default.
  - integrations: 45 tests (7 live tests skipped by default).
- The recorded fixtures were captured:
  - a real Jupiter v1 quote and swap transaction (keyless);
  - a real Kamino KTX deposit transaction and its reserves/markets;
  - Hyperliquid spot meta.
- Cardano fixtures (`packages/blockchain/src/__tests__/fixtures/cardano/mainnet-recorded.json`) were recorded read-only from Blockfrost mainnet: genesis, epoch-662 protocol parameters (cost models removed), the latest block, a public address with its UTxOs and history, two transactions with their UTxOs and CBOR, and the NIGHT token's metadata (logo removed).
- `pnpm --filter @zyropay/blockchain test:live:cardano` (`LIVE_TESTS=1` plus `BLOCKFROST_PROJECT_ID_MAINNET` and/or `BLOCKFROST_PROJECT_ID_PREPROD` in the environment) is **read-only**: genesis magic, parameters and tip; the preprod builder refusing the mainnet id; balance, tokens and history of a public address; a historic transaction's CBOR hashing to its id and tracking as confirmed; building and independently verifying an **unsigned** transfer from real mainnet UTxOs (never signed, never submitted); the ADA price.
- `pnpm --filter @zyropay/integrations test:live` (`LIVE_TESTS=1`) runs against public endpoints only and moves no funds:
  - Solana devnet: genesis, blockhash, fees, simulation;
  - mainnet-RPC refusal;
  - Sepolia: chain id, ERC-20 decimals;
  - Base Sepolia: a full build including the L1 fee, and the tracker;
  - Jupiter and CoinGecko prices;
  - Jupiter quote;
  - Kamino and Hyperliquid reads.
