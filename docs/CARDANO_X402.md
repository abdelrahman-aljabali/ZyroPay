# Cardano x402: live runbook

An AI agent pays a Cardano x402 resource through ZyroPay on **preprod**, and the user approves with a passkey:

1. The agent calls `pay_x402`. The MCP worker probes the resource for its 402.
2. The API checks the requirements against the agent's policy and builds a plain ADA transfer to `payTo`. That transfer is valid no longer than `maxTimeoutSeconds`.
3. The user approves in the app. The passkey signs the body hash (`SIGN_RAW_PAYLOAD_V2`), and the API attaches the witness. Nothing is broadcast.
4. The agent's next `get_approval_status` picks up the payment header, retries the resource with `PAYMENT-SIGNATURE`, and returns the paid response in `resource`.
5. The seller's facilitator (embedded in the seller worker: the official `@x402/cardano` code, which answers once the transaction is submitted) submits it. The API follows its id on chain to `CONFIRMED`, which settles the reservation into the ledger.
6. **Verified delivery.** The seller signs the paid body with the key behind `payTo` (`X-Delivery-Receipt`). The MCP worker hashes the bytes it received itself and forwards both; the API verifies the receipt and the app shows "Delivery verified · signed by the seller you paid" (or a warning).

### Delivery receipt (v1)

Header `X-Delivery-Receipt`: base64 of the JSON `{v:1, resourceUrl, payTo, paymentTx, contentSha256, signedAt, publicKey, signature}`.

- `contentSha256`: hex SHA-256 of the exact response body bytes.
- `paymentTx`: the settled transaction id from `PAYMENT-RESPONSE` (or `null`).
- `publicKey`: the 32-byte Ed25519 verification key of `payTo`'s payment credential; `signature`: Ed25519 (64 bytes hex) over the UTF-8 message
  `"zyropay-x402-receipt-v1\n" + resourceUrl + "\n" + payTo + "\n" + (paymentTx ?? "") + "\n" + contentSha256 + "\n" + signedAt`.

A receipt verifies when blake2b-224(`publicKey`) is the payment key hash of the paid address, it names that address, the bound resource URL and the signed transaction, its `contentSha256` equals the buyer's own hash, and the signature is valid. The reasons it can fail are `X402ReceiptFailureSchema` in `packages/shared/src/x402-receipt.ts`. Only the holder of the paid address's key can produce one, so a verified receipt binds the delivered bytes to the party that was paid.

The design is in `docs/API.md` (x402) and `docs/MCP.md` (x402 delivery). The seller is `apps/seller` (see its README).

## Masumi escrow (`assetTransferMethod: "masumi"`)

The buyer side of Masumi payment-v2 (`vested_pay`, PlutusV3) escrow. The funds go to the canonical escrow script (`addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` on preprod: 2-of-3 admins, 7 min cooldown) and reach the seller only after it submits a result and the unlock time passes. Until then the user can get a refund.

1. **Choosing escrow.** `pay_x402` takes `escrow: true` (the 402 must offer masumi), `false` (pay directly), or nothing (escrow when the 402 offers it and the policy has `x402EscrowAboveUsdMinor`, otherwise pay directly). A policy with `x402EscrowAboveUsdMinor` set treats a direct x402 payment valued above it (or with no valuation) like an over-limit request, with reason `ESCROW_REQUIRED`: approval, or denial when `overLimitBehavior` is `deny`.
2. **Before anything is signed** (`packages/integrations/src/masumi.ts`), using `@x402/cardano` 2.29's pure functions:
   - `validateMasumiExtra` and `verifyMasumiAuthorization`, with every commitment part's content required: the seller's COSE signature over the terms digest, the recomputed input hash, `payTo` equal to the derived escrow, the deadline rules and a 30-day horizon. A registered-agent claim (`terms.agentIdentifier`) passes only through ZyroPay's registry check (see "Discover and identify" below); without one it is refused;
   - ZyroPay's own rules: the canonical deployment only, `payByTime` at least 60 s away and within `maxTimeoutSeconds`, and a commitment `resource` part that names the paid URL;
   - `buildMasumiLock` for the datum and the exact locked lovelace, using live `coinsPerUtxoByte`;
   - a field-by-field round trip through `parseMasumiLockDatum`.

   The terms and the exact datum bytes go into `pluginData.escrow`, so `payloadHash` commits to them. The payload's `to` is the escrow script. `CanonicalTransactionPayloadSchema` accepts a script address only in this case (`isMasumiEscrowLock`). The policy recipient is the **seller**, so the allowlist names the seller, not the script.

3. **Lock.** The API's escrow builder makes one map-format output to the escrow with the inline datum and exactly the locked value, plus change. Its TTL is the slot of `payByTime`, rounded down. `verifyCardanoEscrowLock` re-checks it against the bound datum. The passkey signs the body hash as usual, and the hand-off, header and tracking are the same as for a direct payment. The request expires at `payByTime`.
4. **State.** `request.x402.escrow` (agent and app) and `GET /v1/transaction-requests/:id/escrow` show the state read from the chain once the lock is `CONFIRMED`. The API follows the escrow through continuing outputs with the same datum `reference_signature`. It shows the datum state (`funds_locked` … `refund_authorized`), `refunded`, `withdrawn` (the seller collected), the deadlines and `refund.available`.
5. **Refund** (app, passkey). `POST …/escrow/refund-request` (SetRefundRequested) or `…/escrow/withdraw-refund` (WithdrawRefund) builds the script spend:
   - Blockfrost evaluates it and the measured units get a 20 % margin;
   - lower bounds are rounded up to a slot and TTLs rounded down;
   - the continuing datum sets `buyer_cooldown = TTL + 420 s` and the state to `refund_requested` (or `disputed` after a result).

   The call returns a `SigningReview` whose `rawPayload` is the spend's body hash. `cardanoUnsignedBodyHash` accepts the script witness set. `…/submit` with `{payloadHash, bodyHash, signRequest}` then:
   - re-verifies the stored spend against fresh protocol parameters (`verifyCardanoEscrowSpend`);
   - re-reads the escrow UTxO;
   - checks the stamp like an approval;
   - claims the build by compare-and-set;
   - attaches the witness, runs the C7 check, records the tx id, submits it and tracks it.

   A withdrawal is possible once the seller authorized the refund, or after `submitResultTime` when no result was submitted. After a result, a refund needs the seller (AuthorizeRefund).

6. **Receipts** for escrow payments are verified against the seller's address (`terms.sellerAddress`), not the script.
7. **Proof before release.** The seller records `result_hash = sha256(response body)` on chain with SubmitResult. The MCP worker reports its own SHA-256 of the body the agent received. Whenever the API reads the escrow, it compares the two and returns the verdict as `x402.proof` and `escrow.proof`: `{state, receivedHash, onChainHash, resultTx, checkedAt, message}`. The states are:
   - `pending`: no on-chain result yet, or no delivery report yet;
   - `verified`: the two hashes are equal;
   - `mismatch`: they differ;
   - `not_delivered`: `submitResultTime` passed with no result;
   - `unverifiable`: the agent's body could not be hashed;
   - `receipt_only`: a direct payment, where nothing is recorded on chain and only the signed receipt applies.

   On `mismatch` or `not_delivered`, `escrow.refund.recommended` names the refund to take (`request_refund`, or `withdraw_refund` once possible) and `refund.reason` says why. The verdict is stored in `x402_escrow.proof`, and each change is audited once: `x402.proof_verified`, `security.x402_proof_mismatch`, `x402.proof_not_delivered` or `x402.proof_unverifiable`.

## Discover and identify (Masumi agent registry)

ZyroPay's AI can find agents registered in the Masumi registry, and ZyroPay pays a Masumi escrow seller that claims a registry identity only after it verified that identity on chain.

- **Registry.** An agent is a CIP-25 NFT under the V2 registry policy `67ab0c92…bd0b` (same id on preprod and mainnet); `agentIdentifier` = policy id + asset name (120 hex). The policy is permissionless: registration proves identity _binding_ (this key controls a live NFT whose metadata names this endpoint and price), not trustworthiness. `packages/integrations/src/masumi-registry.ts` reads it through Blockfrost (`/assets/policy`, `/assets/{unit}`, `/assets/{unit}/addresses`, `/txs`), size-capped, time-bounded, fail closed; metadata is cached a week and liveness a minute (per API isolate, in memory).
- **Discover.** App: `GET /v1/masumi/agents?q&capability&tag&maxPriceUnit&maxPriceAmount&limit` → `{agents, scanned, truncated}` and `GET /v1/masumi/agents/:agentIdentifier` → `{status: active|burned|not_found|invalid, agent, reason}`. Agent (MCP): `find_agents` and `verify_agent` (internal `GET /internal/v1/agents/:agentId/masumi/agents`, `POST …/masumi/verify`). They are read-only, not `allowedTools` policy tools, and every metadata string reaches the model sanitized inside the untrusted-data envelope.
- **Identify (at quote).** For a masumi requirement whose signed terms carry `agentIdentifier`, `verifyMasumiAuthorization` runs with `validateRegistryClaim` = `verifySeller`: the NFT is live and held by exactly one key address whose payment key hash is the terms' signer (`sellerAddress`), the agent advertises the canonical Web3CardanoV2 escrow, its endpoint is public https and covers the paid URL, and the signed price equals its fixed price. Any failure (including an unreachable registry) refuses the quote. The datum's `agent_identifier` must equal the claim, and `{agentIdentifier, agentName, sellerPaymentKeyHash}` are bound into `pluginData.escrow` (so `payloadHash` commits to them; the lock verifier re-checks the datum field).
- **Show.** `x402.sellerIdentity` on request results and the approval detail: `{registered: true, agentIdentifier, name, reasons: []}` for a verified claim, `{registered: false, agentIdentifier: null, name: null, reasons: ["not_claimed"]}` for an escrow seller without one, `null` for direct payments.
- **Policy.** `requireRegisteredAgent` ("Only pay registered Masumi agents", default false) denies a pay_x402 without a verified identity (`AGENT_NOT_REGISTERED`); with it, a non-empty `trustedAgentIdentifiers` (max 50) denies other registered agents (`AGENT_NOT_TRUSTED`). Agents with the rule prefer escrow when the 402 offers it. Absent on update = unchanged (migration 0007).
- **Not covered:** the identity is checked at quote time, not again at approval (an NFT transferred in between is not noticed); search scans at most 100 live entries per query.

## What is verified, and what is not

**Verified offline (tests, no network):**

- **Adapter:** quote, binding, refusals (escrow/script methods, caps, `maxAmount`, resource, network) and header encoding (`packages/integrations/src/__tests__/x402-cardano.test.ts`).
- **API:** approve, hand-off, `BROADCAST`, `CONFIRMED`, ledger; receipt mismatch; refused delivery; expiry and reservation release; delivery receipts (valid → verified; wrong key, other bytes, other URL, other payment, malformed, forged signature → not verified + `security.x402_receipt_invalid`) (`apps/api/test/integration/x402-cardano.test.ts`, mock chain).
- **MCP:** the paid retry through the real MCP SDK client against a fake seller (`apps/mcp/tests/e2e/x402.test.ts`).
- **Seller:** 402 shape, `resource.url`, validation before payment, and no settlement on errors (`apps/seller/test`). Delivery receipts verify with ZyroPay's verifier over the exact body bytes; no or a wrong key serves the report without a receipt (`apps/seller/test/receipt.test.ts`). Its 402 was also checked against the hosted facilitator's `/supported`.
- **Facilitator compatibility:** a payment built and signed exactly as the API does it passes the official `@x402/cardano` 2.29.0 facilitator verification (`isValid: true`, with Blockfrost stubbed). The facilitator's tx id equals ZyroPay's body hash, and the transaction is byte-identical after Evolution's decode and re-encode. The test also runs end to end through the seller to `/tx/submit` and checks 9 negative controls (`apps/seller/test/facilitator-compat.test.ts`).
- **Builder:** the Cardano builder's validity cap (`packages/blockchain`).
- **Masumi escrow:** these are verified offline.
  - Quote, binding and refusals: tampered amount or terms, a foreign `payTo`, a custom deployment, the payment window, another resource, no `coinsPerUtxoByte`.
  - The built lock passes ZyroPay's verifier **and** `@x402/cardano`'s facilitator `verifyMasumiLock`.
  - The SetRefundRequested and Disputed continuing datums (`packages/integrations/src/__tests__/x402-masumi.test.ts`).
  - The real `EscrowChain` over Blockfrost fixtures: the lock, following continuations, both spends evaluated, verified, body-hashed without CBOR and signed (`apps/api/test/integration/escrow-chain.test.ts`).
  - The API lifecycle on mock chain: lock, `CONFIRMED`, `funds_locked`, refund request, seller authorization, withdrawal, `refunded`; withdrawal after the deadline; seller collected, `withdrawn`; forged body hash or stamp refused and audited; one signature per build; the policy rule (`apps/api/test/integration/x402-masumi.test.ts`).
  - MCP `escrow` forwarding (`apps/mcp/tests/e2e/x402.test.ts`).
- **Masumi registry:** discovery and identity checks over recorded preprod Blockfrost responses (`packages/integrations/src/__tests__/masumi-registry.test.ts`); a verified claim bound into the datum and terms, a failed or unconfigured check refused (`x402-masumi.test.ts`); the endpoints, `sellerIdentity`, a stolen identity refused and the policy rule on the API (`apps/api/test/integration/masumi-registry.test.ts`); `find_agents` / `verify_agent` sanitized and wrapped (`apps/mcp/tests/e2e/tools.test.ts`).

**Verified live on preprod (2026-10-30)** (hashes, fees and explorer checks: https://docs.zyropay.online/evidence/):

- ZyroPay's first passkey-signed Cardano send, 1 ADA: `081800083252d4c1a46ebb7afc53ba1dd61c02847b7b219d01c5f2868eef1ace` (block 5353436).
- An AI-paid x402 report, direct (ChatGPT through the MCP connector, passkey approval, 2 ADA, receipt verified, HTTP 200): `83ecc5742fafb0a332032c9b11902f54e2dcc71262843e6592103680c79d787b` (block 5353756).
- An AI-paid lock into Masumi escrow, 5 ADA: `630f20122b624f2e7960d8ad5e1c037b299f12bf4cd97d078f91dba41243c653` (block 5353819).
- The seller's SubmitResult (Plutus V3 spend; proof `verified`: received hash = on-chain `result_hash` `d80a4d02d13d…`): `ee7b142e7306e1ecce7fb57f1da3c904f6a1c372eaacf3c471f581f5db865361` (block 5353820).
- The seller's Withdraw after `unlock_time`, submitted by its cron sweeper 39 s after unlock (Plutus V3 spend, redeemer Withdraw, 4.357634 ADA to the seller): `c59d85cf3b906342d70adcdf20247c42a01070fadff642d2b4a3d34814b916d3` (block 5353887). Lock, SubmitResult and Withdraw are one escrow, start to finish.
- The demo seller's Masumi registry registration through our own Payment Service ("Cardano Address Intelligence", MIP-003 endpoint https://masumi-agent.zyropay.online): registry NFT mint `11dcdf21c55a4eca0d8bddbd3b823785ae19ef84e218e6f93b304c816f1486e9` (block 5354719), `agentIdentifier` `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b106fe284ceb06b6c8510815f3d9813378d66b57c8c9cecf4e31532928f000000`. Details: `infrastructure/masumi/EVIDENCE.md`.

**Not verified until it runs live:**

- A buyer refund (SetRefundRequested, WithdrawRefund with the passkey).
- A dishonest-seller run (`mismatch`, `not_delivered`).
- A live sub-hire payment and a paid Sokosumi task (waits on an interactive Sokosumi login). The x402 routes do not yet claim the registered identity in their terms.
- Push delivery is not configured, so the app finds approvals by polling (every 15 s, or on open).

## 1. Configuration

| Where    | What                                                                      | How                                                                                                                  |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| API      | `BLOCKFROST_PROJECT_ID_PREPROD` (starts with `preprod`): turns Cardano on | `printf %s "$ID" \| pnpm --filter @zyropay/api exec wrangler secret put BLOCKFROST_PROJECT_ID_PREPROD --env staging` |
| API      | `X402_CAPS`: already `{"cardano-preprod:native":"5000000"}` (5 tADA)      | `apps/api/wrangler.jsonc`                                                                                            |
| Seller   | `BLOCKFROST_PROJECT_ID`, `SELLER_ADDRESS`                                 | `apps/seller/README.md` → Deploy                                                                                     |
| Seller   | `SELLER_SIGNING_KEY` (optional): turns on delivery receipts               | `pnpm --filter @zyropay/seller receipt-key`, then `wrangler secret put` (`apps/seller/README.md` → Deploy)           |
| Database | Migration `0005_x402_delivery`                                            | Applied by `pnpm deploy:staging` (runs migrations first)                                                             |

A single Blockfrost preprod project can serve both the API and the seller. The free tier is 50,000 requests per day.

## 2. Deploy

```sh
pnpm check                          # everything green before deploying
pnpm deploy:staging                 # migration 0005, API, MCP, web
pnpm --filter @zyropay/seller receipt-key   # .secrets/seller.signing-key (0600), checked against SELLER_ADDRESS
cd apps/seller && pnpm exec wrangler secret put BLOCKFROST_PROJECT_ID \
  && pnpm exec wrangler secret put SELLER_SIGNING_KEY < .secrets/seller.signing-key \
  && pnpm exec wrangler deploy
pnpm health                         # API, MCP, web
curl -s https://<seller>/ | jq .config            # {"ok": true}
curl -s https://<seller>/ | jq .deliveryReceipts  # {"enabled": true, ...}
curl -si "https://<seller>/v1/address-report?address=<addr_test1…>" | head -1   # 402
```

## 3. Live verification, in order

Each step isolates one unknown. Stop at the first failure.

1. **Seller safety net.** Fund a buyer wallet, then run the seller's `buy --yes` (`apps/seller/README.md` → Live steps). The result is a preprod tx hash that does not depend on ZyroPay. It spends about 2.2 tADA.
2. **ZyroPay Cardano, plain send:**
   1. Sign in to the staging web app.
   2. Open Wallets, then Receive, then Cardano Preprod. Fund the address with at least 10 tADA from https://docs.cardano.org/cardano-testnets/tools/faucet.
   3. Send 1 tADA to the seller address in the app.
   4. Expect `CONFIRMED` and a cardanoscan link.

   This is the first live Cardano transaction ZyroPay has ever sent.

3. **Agent setup (app):**
   1. Plugins: enable **x402 payments**.
   2. Agents: connect Claude with the MCP server `https://mcp.zyropay.online/mcp`, choosing the wallet and Cardano Preprod.
   3. In the policy, turn on spending, allow the **x402** protocol, add the seller address to the recipient allowlist, and set limits of a few dollars.
4. **Paid request (Claude):** ask Claude to buy the report. The tool call should be:
   `pay_x402 { walletId, network: "cardano-preprod", resourceUrl: "https://<seller>/v1/address-report?address=<addr_test1…>", method: "GET", assetId: "cardano-preprod:native", decimals: 6, maxAmount: "3000000", idempotencyKey }`
   1. It returns `PENDING_APPROVAL`.
   2. Approve in the app. The screen should show the seller's description, the host and 2 ADA.
   3. Claude calls `get_approval_status`. It returns `resource` with the report, `settlement.transaction` and `receipt.verified: true`. Allow up to about 60 s.
   4. In the app, the approval moves to Submitted to Cardano, then Paid, with a cardanoscan link and "Delivery verified".
5. **Deny moment:** ask Claude to pay an address that is not on the allowlist. The request should come back `REJECTED` with `RECIPIENT_NOT_ALLOWED`, and nothing reaches the app or the chain.

## 4. If something fails

| Symptom                                                                                | Likely cause                                                                   | Check                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `pay_x402` → `NETWORK_NOT_SUPPORTED`                                                   | API has no `BLOCKFROST_PROJECT_ID_PREPROD`                                     | secret set? `wrangler secret list --env staging`                                           |
| `pay_x402` → `POLICY_DENIED` "no x402 cap"                                             | `X402_CAPS` lacks `cardano-preprod:native`                                     | `apps/api/wrangler.jsonc`                                                                  |
| `pay_x402` → 400 "resource does not match"                                             | The URL given differs from the seller's `resource.url`                         | Use the exact URL. Host case and default ports are normalised; query order is not.         |
| `REJECTED` with `PROTOCOL_NOT_ALLOWED` / `RECIPIENT_NOT_ALLOWED` / `SPENDING_DISABLED` | Agent policy                                                                   | Step 3                                                                                     |
| Approve → "this request has expired" or a rebuild                                      | More than 10 min since the request (`maxTimeoutSeconds` 600)                   | Make a new request                                                                         |
| `get_approval_status` → `resource.httpStatus` 402 with `errorReason`                   | The facilitator refused the transaction (`invalid_*`)                          | Note the reason. The request stays deliverable while valid. Suspect the CBOR or TTL first. |
| `resource` 402 `settlement_pending`                                                    | The facilitator is waiting for confirmation (only with `L1_CONFIRMATIONS` > 0) | Check cardanoscan for the tx id before retrying                                            |
| Request `FAILED` "validity expired before landing"                                     | Handed off but never submitted                                                 | The reservation is released. Retry with a new request.                                     |
