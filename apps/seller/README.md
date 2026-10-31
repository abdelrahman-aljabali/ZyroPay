# Cardano Address Intelligence (`@zyropay/seller`)

A paid data API on Cloudflare Workers. It sells one thing: a compact JSON report on a Cardano
**preprod** address. Buyers pay for each request with **x402 v2** (`exact` scheme), at 2 tADA
by default.

The report is computed by code from Blockfrost data. It contains:

- balance, native-token count, UTxO count and transaction count;
- first-seen and last-seen times, and recent activity;
- stake registration and delegation;
- risk flags and a 0-100 score.

No LLM is involved.

The service is the seller for the hackathon flow:

1. A user's AI calls ZyroPay's MCP tool `pay_x402`.
2. The user approves with a passkey.
3. ZyroPay sends a signed Cardano transaction in `PAYMENT-SIGNATURE`.
4. The facilitator (embedded in this worker by default) verifies it. The handler then runs,
   and the facilitator submits the transaction.

5. The seller signs the exact response body with its `payTo` payment key and sends the
   receipt in `X-Delivery-Receipt`. ZyroPay verifies it independently and shows the user
   "Delivery verified".

On the default route the seller never touches the chain itself. Its only key is the
optional `SELLER_SIGNING_KEY`, the payment key of `SELLER_ADDRESS`: it signs receipts and,
on the escrow route, the Masumi quotes and the seller's escrow transactions. It can spend
what that address holds: keep it as secret as the mnemonic.

## Routes

| Route                                          | Paid | What it returns                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /` and `GET /health`                      | no   | Service description: price, `payTo`, network, facilitator, `simulated:false`, config status (rule names only, never values)                                                                                                                        |
| `GET /v1/address-report/escrow?address=…`      | yes  | The same report, paid into **Masumi escrow** (x402 `assetTransferMethod: "masumi"`, refundable). See [Escrow route](#escrow-route-masumi). `503` without `SELLER_SIGNING_KEY`                                                                      |
| `GET /v1/escrow/:id`                           | no   | An escrow's state from chain. `id` = the lock transaction id (`<tx>` or `<tx>#<ix>`) or the `blockchainIdentifier`                                                                                                                                 |
| `GET /v1/address-report?address=addr_test1...` | yes  | The report. Responses: `400` for an invalid address (sent _before_ any 402), `402` with `PAYMENT-REQUIRED`, `200` with `PAYMENT-RESPONSE` (and `X-Delivery-Receipt` when receipts are on), `503` when Blockfrost or the facilitator is unavailable |

### The 402

The decoded `PAYMENT-REQUIRED` header:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "<exact requested URL incl. query>",
    "description": "Cardano address intelligence report",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "cardano:preprod",
      "amount": "2000000",
      "asset": "lovelace",
      "payTo": "<SELLER_ADDRESS>",
      "maxTimeoutSeconds": 600,
      "extra": { "confirmationPolicy": { "l1Confirmations": 0 }, "areFeesSponsored": false }
    }
  ]
}
```

`resource.url` is the full request URL, query string included. It comes from `@x402/core`,
which uses `c.req.url` when no `resource` override is set. ZyroPay binds the payment to that
exact string.

### Order of operations

Requests to the paid route are handled in this order:

1. **Config guard.** A misconfigured seller answers 503 and never asks for payment.
2. **Address validation.** Anything other than a bech32 `addr_test1…` Shelley payment address
   gets a 400.
3. **Facilitator initialisation** (`/supported`). If the facilitator is down, the answer is 503.
4. **`@x402/hono`.**
   - Without a valid payment, it returns a 402.
   - With one, it calls `verify`, runs the handler, then calls `settle`.

**Settlement happens only if the handler answers with a status below 400.** This is the
Cardano `authorization` flow: verify comes before the handler, settle after it. See
`paymentFlows` in `@x402/cardano/exact/server` and the `res.status >= 400` branch in
`@x402/hono`.

So if Blockfrost fails (402, 403, 418, 429, 5xx or a timeout), the buyer gets a 503 and is
**not charged**. The handler has no side effects and is deterministic for a given chain state,
so a second run for the same payment is harmless.

### Delivery receipt

Every settled paid response (200 with a successful `PAYMENT-RESPONSE`) carries
`X-Delivery-Receipt`: base64 of
`{v:1, resourceUrl, payTo, paymentTx, contentSha256, signedAt, publicKey, signature}`.

- `contentSha256` is the SHA-256 (hex) of the exact body bytes sent.
- `signature` is Ed25519 with the `payTo` payment key over
  `"zyropay-x402-receipt-v1\n" + resourceUrl + "\n" + payTo + "\n" + (paymentTx ?? "") + "\n" + contentSha256 + "\n" + signedAt`.
- `publicKey` is the 32-byte verification key; blake2b-224 of it is `payTo`'s payment credential.

The format and verifier are in `packages/shared/src/x402-receipt.ts` (see
`docs/CARDANO_X402.md`). The middleware wraps `@x402/hono`, so it signs only bodies that
were paid and settled.

Without `SELLER_SIGNING_KEY`, or with a key that is not the payment key of
`SELLER_ADDRESS`, the seller logs that once (rule only, never the value) and serves paid
requests **without** a receipt. A receipt problem never fails a paid request. `GET /`
shows `deliveryReceipts.enabled`.

### Risk flags

`riskScore = min(100, sum of the weights of the raised flags)`. The score measures how much
caution to apply before paying or trusting the address. It is not a fraud verdict.

| Code             | Weight | Rule                                                      |
| ---------------- | ------ | --------------------------------------------------------- |
| `NO_HISTORY`     | 30     | Never in a transaction (Blockfrost 404: a valid result)   |
| `NEW_ADDRESS`    | 20     | First transaction less than 7 days ago                    |
| `LOW_ACTIVITY`   | 10     | Fewer than 5 transactions                                 |
| `DORMANT`        | 10     | No transaction in 90 days                                 |
| `SCRIPT_ADDRESS` | 15     | Script payment credential                                 |
| `MANY_TOKENS`    | 15     | 50 or more distinct native tokens (possible airdrop spam) |
| `DRAINED`        | 15     | Received at least 10 ADA in total, now holds under 1 ADA  |
| `BURST_ACTIVITY` | 10     | The last 20 transactions all fall within 24 h             |

Each report costs 4 to 6 Blockfrost calls, each with an 8 s timeout:

- `/addresses/{a}`
- `/addresses/{a}/total`
- `/addresses/{a}/transactions?order=desc&count=20`
- `/addresses/{a}/utxos?count=100`
- `/addresses/{a}/transactions?order=asc&count=1`, only when the address has more than 20
  transactions
- `/accounts/{stake}`, only when the address has a stake part

## Escrow route (Masumi)

`GET /v1/address-report/escrow?address=…` sells the same report, but the buyer's payment is
locked in the Masumi payment-v2 `vested_pay` escrow
(`addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`, =
`masumiEscrowAddress("cardano:preprod")`) instead of paid to `SELLER_ADDRESS`. The seller
earns it by putting the result hash on chain, and the buyer can get a refund. The default
route is unchanged.

**The 402.** `@x402/cardano`'s resource-server scheme issues a fresh, seller-signed quote for
every 402 (`ExactCardanoScheme({ masumi: { seller } })`). The signer is
`SELLER_SIGNING_KEY` (CIP-8/COSE over `termsDigest`). `accepts[0]`:
`scheme: "exact"`, `payTo` = the escrow address, `amount` = `ESCROW_PRICE_LOVELACE`
(default 5 tADA), `maxTimeoutSeconds` 300, and `extra`:
`{ assetTransferMethod: "masumi", inputCommitment, terms, referenceKey, referenceSignature, blockchainIdentifier, confirmationPolicy, areFeesSponsored }`.
The input commitment is the exact request URL, so `resource.url` binding is unchanged.
Tests check the quote with `@x402/cardano`'s own `validateMasumiExtra` and
`verifyMasumiAuthorization` (the checks a buyer runs).

- **Price ≥ 4 tADA.** The escrow output must clear min-UTxO for the post-result datum, about
  3.7 tADA. At 4 tADA or more, the buyer's `collateral_return_lovelace` is 0 and the lock is
  exactly the price (checked with `buildMasumiLock`). Lower prices are refused at startup.
- **Deadlines** (from the 402): payBy +5 min, submitResult +15, unlock +30, externalDispute
  +45. `vested_pay` enforces no gaps, but `@x402/cardano` (issuer, client and facilitator)
  does. It requires payBy→submit ≥ 5 min, submit→unlock ≥ 15 min and unlock→dispute ≥ 15
  min, and its issuer requires submit ≥ now + 15 min. So the faster
  +5/+15/+20/+30 timeline cannot be issued. The config bounds are exactly these rules.
- **Isolates.** The scheme remembers issued quotes in memory only. A paid retry that lands on
  another Worker isolate is still let in if its quote verifies as this seller's. The checks:
  the COSE signature is valid under the key whose hash is `SELLER_ADDRESS`'s payment
  credential, the commitment URL is the requested URL, price, `payTo` and timeout match, and
  payBy has not passed (`src/escrow/terms.ts`).

**Registry identity.** With `MASUMI_AGENT_IDENTIFIER` set, every escrow 402 claims that
Masumi registry entry (terms `agentIdentifier`, datum `agent_identifier`). The live seller
claims `67ab0c92…bf8000000`, "Cardano Address Intelligence (x402)": a registry V2 NFT
minted 2026-10-30 (23:28 UTC) by our Masumi Payment Service straight to `SELLER_ADDRESS`
(`recipientWalletAddress`), with `api_base_url` https://address-intel.zyropay.online and a
Fixed 5 tADA price on the V2 escrow (`infrastructure/masumi/EVIDENCE.md` §3). Masumi has no
seller key in the metadata: the seller is whoever holds the NFT, so the key that signs the
quotes must hold it. `@x402/cardano` refuses a claim nobody vouches for. The seller
vouches for its own configured identity only (`ownRegistryClaim`: this identifier, this
seller address, the escrow price), in the paid-retry check and in the embedded facilitator;
a hosted facilitator cannot, so the claim needs `FACILITATOR_MODE=embedded`. Buyers check
the claim on chain themselves (ZyroPay: the NFT is live, held by the signing key, and its
metadata names this endpoint and price). The default route (`/v1/address-report`, direct
payment) carries no identity claim: x402 `exact` has no field for one.

**Settlement.** The embedded facilitator is the stock `@x402/cardano` 2.29 facilitator. It
advertises and verifies masumi locks (`verifyMasumiLock`: one inline-datum output to the
escrow, exact value, datum = the signed terms, TTL ≤ payBy), then submits the lock. The
offline test builds the lock the way ZyroPay does (`planCardanoEscrowLock`) and runs it
through that facilitator.

**Result hash and receipt.** The result hash is `sha256(exact response body)`. That is the
same value the delivery receipt signs as `contentSha256`, so the receipt proves the
on-chain `result_hash`. The paid 200 also carries:

- `X-Escrow-Result-Hash`
- `X-Escrow-Id` (the `blockchainIdentifier`)
- `X-Escrow-Status` (the status URL for the lock transaction)

**SubmitResult.** After the response (`ctx.waitUntil`), the seller does this:

1. It waits up to about 20 s for the lock to appear on chain.
2. It builds the SubmitResult with the Evolution SDK, ported from the x402-cardano-demo
   Masumi agent:
   - redeemer `Constr 5`;
   - the applied script inline;
   - the continuing output with the same value, `result_hash` set, seller cooldown
     `slotStart(upper) + 7 min`, buyer cooldown 0 and state `ResultSubmitted`;
   - the seller as required signer;
   - validity `[tip − 1 min, min(tip + 5 min, submit − 2 min)]`.
3. Blockfrost evaluates the script during the build.
4. The seller signs with `SELLER_SIGNING_KEY` and submits to Blockfrost `/tx/submit`.

If the lock is not on chain yet, the cron sweeper retries from the KV record.

**Cron sweeper** (`triggers.crons: ["* * * * *"]`, `src/escrow/sweeper.ts`). Each run does
this:

1. It rediscovers escrows from chain: the newest `ESCROW_SCAN_PAGES` × 100 UTxOs at the
   escrow address whose datum names this seller, plus the lock of every KV record still
   waiting for its SubmitResult.
2. It runs at most 3 transactions, chained so they never share an input.

| Datum state          | Action                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `FundsLocked`        | SubmitResult, if we delivered for this exact lock (KV record) and the submit window is open                   |
| `RefundRequested`    | **AuthorizeRefund** (`Constr 6`) when `AUTO_AUTHORIZE_REFUNDS` (default true; demo policy), else SubmitResult |
| `Disputed`           | AuthorizeRefund when auto (after our 7-min cooldown from SubmitResult), else wait for the admins              |
| `ResultSubmitted`    | **Withdraw** (`Constr 0`) once chain time ≥ `unlock_time`                                                     |
| `WithdrawAuthorized` | Withdraw                                                                                                      |
| `RefundAuthorized`   | nothing (the buyer withdraws)                                                                                 |

Anyone can create an output at the escrow address, so before paying a fee the sweeper
checks:

- this seller's key is the datum seller and is in the COSE reference key;
- there is no `seller_return_address`;
- at least 4 tADA is locked;
- there is no reference script.

**Seller wallet.** Every spend is paid from `SELLER_ADDRESS`: about 0.6–0.8 tADA in fees
with the 10 KB script inline. It also needs a pure-ADA UTxO of **at least 5 tADA** as Plutus
collateral (Evolution's default). Fund the seller address before using the escrow route.

**State (KV, optional).** The `ESCROW_KV` binding stores `escrow:<sellerNonce>` → `{ lockTx,
resultHash, blockchainIdentifier, resourceUrl, resultTx? }` for 3 days. Escrow state itself
always comes from chain. Without the binding everything still works, but a SubmitResult that
could not run right after the response is lost (the buyer refunds after
`submit_result_time`). `wrangler.jsonc` declares the binding with a **placeholder id**.
Create the namespace and paste its id before deploying:

```sh
cd apps/seller
pnpm exec wrangler kv namespace create ESCROW_KV   # prints the id; put it in wrangler.jsonc
```

**Status route.** `GET /v1/escrow/<lockTx>` follows the lock through every spend (Blockfrost
`consumed_by_tx`). It returns one of:

- `pending`
- `locked`
- `result_submitted`
- `refund_requested`
- `disputed`
- `withdraw_authorized`
- `refund_authorized`
- `withdrawn`
- `refunded`
- `dispute_settled`

It also returns the deadlines, the result hash, the live UTxO and the history.

## Config

The template is `.env.example`. Copy it to `.dev.vars` for `wrangler dev` and to `.env` for
`pnpm buy`. Both files are git-ignored.

| Variable                          | Required               | Rule                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SELLER_ADDRESS`                  | yes                    | Preprod (`addr_test1`) Shelley address with a **key-hash** payment credential. This is the rule ZyroPay enforces on `payTo` (`isValidCardanoPaymentAddress`).                                                                                                                                                                                                                       |
| `BLOCKFROST_PROJECT_ID`           | yes (secret)           | Starts with `preprod`                                                                                                                                                                                                                                                                                                                                                               |
| `FACILITATOR_MODE`                | no                     | `embedded` (default): this worker runs the `@x402/cardano` facilitator itself (all verification checks, then submission through Blockfrost) and answers as soon as the transaction is submitted. `hosted`: use `FACILITATOR_URL`. The hosted preprod facilitator waits for a block behind a ~60 s gateway timeout, so a payment could land while the buyer got a 504 and no report. |
| `FACILITATOR_URL`                 | no                     | Used in `hosted` mode. Default `https://x402.preprod.dev.ecosyseng.cf-deployments.org`. Must be https; http is allowed only for localhost.                                                                                                                                                                                                                                          |
| `PRICE_LOVELACE`                  | no                     | Default `2000000`. Integer between `1000000` (the min-UTxO floor) and `100000000`.                                                                                                                                                                                                                                                                                                  |
| `L1_CONFIRMATIONS`                | no                     | Default `0`. Range 0 to 20, which is what the hosted facilitator advertises.                                                                                                                                                                                                                                                                                                        |
| `SELLER_SIGNING_KEY`              | no (secret)            | Payment signing key of `SELLER_ADDRESS`, hex: 64 bytes (the BIP32-Ed25519 extended key `pnpm receipt-key` writes) or a 32-byte Ed25519 seed. Turns on delivery receipts. Its verification key must hash to the address's payment credential, or it is ignored.                                                                                                                      |
| `BLOCKFROST_BASE_URL`             | no                     | A Blockfrost-compatible base URL. Defaults to Blockfrost preprod.                                                                                                                                                                                                                                                                                                                   |
| `ESCROW_PRICE_LOVELACE`           | no                     | Escrow route price. Default `5000000`; `4000000`..`100000000` (≥ 4 tADA keeps the buyer's collateral at 0).                                                                                                                                                                                                                                                                         |
| `ESCROW_MAX_TIMEOUT_SECONDS`      | no                     | payBy = 402 time + this. Default `300`; 60..900.                                                                                                                                                                                                                                                                                                                                    |
| `ESCROW_SUBMIT_AFTER_PAYBY_MIN`   | no                     | Default `10`; ≥ 5, and timeout + this ≥ 15 min.                                                                                                                                                                                                                                                                                                                                     |
| `ESCROW_UNLOCK_AFTER_SUBMIT_MIN`  | no                     | Default `15`; ≥ 15.                                                                                                                                                                                                                                                                                                                                                                 |
| `ESCROW_DISPUTE_AFTER_UNLOCK_MIN` | no                     | Default `15`; ≥ 15.                                                                                                                                                                                                                                                                                                                                                                 |
| `AUTO_AUTHORIZE_REFUNDS`          | no                     | `true` (default, preprod demo policy) or `false`.                                                                                                                                                                                                                                                                                                                                   |
| `ESCROW_SCAN_PAGES`               | no                     | Escrow-address pages (100 UTxOs, newest first) the sweeper scans. Default `3`; 1..10.                                                                                                                                                                                                                                                                                               |
| `MASUMI_AGENT_IDENTIFIER`         | no                     | The Masumi registry identity escrow 402s claim (120 hex, V2 policy). Its NFT must be held by `SELLER_ADDRESS`; needs `FACILITATOR_MODE=embedded`. See [Escrow route](#escrow-route-masumi).                                                                                                                                                                                         |
| `ESCROW_KV`                       | no (binding)           | KV namespace for delivery records; see [Escrow route](#escrow-route-masumi).                                                                                                                                                                                                                                                                                                        |
| `DEMO_DISHONEST_MODE`             | no                     | Off unless exactly `enabled`. Then `?demo=tamper` or `?demo=nodelivery` on the escrow route makes this seller dishonest on purpose; see [Demo switch](#dishonest-seller-demo-switch).                                                                                                                                                                                               |
| `SUBHIRE_ENABLED`                 | no                     | `true` turns on sub-hiring Cardano Token Intelligence; see [Sub-hiring](#sub-hiring-agents-hiring-agents). Anything else: off.                                                                                                                                                                                                                                                      |
| `SPECIALIST_URL`                  | with sub-hire          | Base URL of `apps/specialist` (https; http only for localhost).                                                                                                                                                                                                                                                                                                                     |
| `SPECIALIST_PAY_TO`               | no                     | Pin: pay only this payTo (the specialist's `SELLER_ADDRESS`). Receipts are always checked against the payTo actually paid.                                                                                                                                                                                                                                                          |
| `SUBHIRE_MAX_LOVELACE`            | no                     | Per-job cap. Default `3000000`; `1000000`..`3000000`.                                                                                                                                                                                                                                                                                                                               |
| `SELLER_BUYER_MNEMONIC`           | with sub-hire (secret) | BIP-39 mnemonic of the seller's **own small budget wallet** (not the payTo wallet): `pnpm --filter @zyropay/seller wallet subhire`.                                                                                                                                                                                                                                                 |

Invalid config is logged once and shown on `GET /`, by rule name only. While the config is
invalid, the paid route answers 503.

## Run locally

From the repo root:

```sh
pnpm install
pnpm --filter @zyropay/seller wallet seller      # writes .secrets/seller.mnemonic (0600); prints the address
cp apps/seller/.env.example apps/seller/.dev.vars # set SELLER_ADDRESS and BLOCKFROST_PROJECT_ID
pnpm --filter @zyropay/seller receipt-key        # optional: .secrets/seller.signing-key (0600)
# then add SELLER_SIGNING_KEY=<contents of that file> to .dev.vars for receipts locally
pnpm --filter @zyropay/seller dev                 # http://localhost:8790
curl -i "http://localhost:8790/v1/address-report?address=addr_test1..."   # -> 402 + PAYMENT-REQUIRED
```

Checks (all offline):

```sh
pnpm --filter @zyropay/seller typecheck
pnpm --filter @zyropay/seller lint
pnpm --filter @zyropay/seller test
pnpm --filter @zyropay/seller build    # wrangler deploy --dry-run
```

The tests stub `fetch` for both the facilitator and Blockfrost, so they need no network. The
Blockfrost inputs are labelled fixtures in `test/fixtures/*.fixture.json`. They are synthetic
data in the documented response shapes.

## Deploy (Cloudflare Workers)

```sh
pnpm --filter @zyropay/seller receipt-key    # derive the receipt key from .secrets/seller.mnemonic
cd apps/seller
pnpm exec wrangler secret put BLOCKFROST_PROJECT_ID
pnpm exec wrangler secret put SELLER_SIGNING_KEY < .secrets/seller.signing-key
pnpm exec wrangler deploy
curl -s https://address-intel.zyropay.online/ | jq .deliveryReceipts   # {"enabled": true, …}
```

`receipt-key` derives the payment key from `.secrets/seller.mnemonic` exactly as `wallet`
derives the address (Evolution SDK, account 0), checks that blake2b-224 of its verification
key is the payment credential of `SELLER_ADDRESS` (env, else `.dev.vars`, else
`wrangler.jsonc`), and writes the key to `.secrets/seller.signing-key` (mode 0600). It
prints only the address and the public key. Piping the file keeps the key out of shell
history and the terminal. Remove the secret (`wrangler secret delete SELLER_SIGNING_KEY`)
to turn receipts off.

The worker is served only on its Cloudflare custom domain https://address-intel.zyropay.online (`routes` in `wrangler.jsonc`, `workers_dev: false`). `SELLER_ADDRESS` is a plain var in `wrangler.jsonc`. No tunnel is
needed, and ZyroPay's MCP worker can reach it, which it cannot do with `localhost`.

## Live steps (NOT yet verified live)

These steps need a Blockfrost preprod key and a funded buyer wallet. None of them has been run
yet: there is no live transaction to point to.

1. Create a Blockfrost **preprod** project and put its id in `.dev.vars` / `.env`, and in the
   deployed secret.
2. Run `pnpm --filter @zyropay/seller wallet seller` and set `SELLER_ADDRESS`. The seller
   address needs no funds to receive a payment.
3. Deploy, as described above.
4. Check `curl https://<worker>/` and confirm `config.ok:true`.
5. Check that `curl -i "https://<worker>/v1/address-report?address=<any addr_test1>"` returns
   a 402.
6. Make a test payment with the safety-net buyer:
   1. Run `pnpm --filter @zyropay/seller wallet buyer`.
   2. Fund the printed address with at least 5 tADA from
      https://docs.cardano.org/cardano-testnets/tools/faucet.
   3. Set `SELLER_URL=https://<worker>` in `apps/seller/.env`.
   4. Run `pnpm --filter @zyropay/seller buy --yes`.

   **This spends about 2.2 tADA** (the price plus the fee). It prints the HTTP status, the
   report, the `PAYMENT-RESPONSE` tx id and a `https://preprod.cardanoscan.io/transaction/<id>`
   link. If it ends in a 402 after about a minute, the settlement may be pending: check
   cardanoscan before running it again.

7. Make the ZyroPay payment: the user's AI calls `pay_x402` with the exact
   `https://<worker>/v1/address-report?address=...` URL.

### Escrow live steps

**Verified on preprod (2026-10-30):** lock `630f2012…c653`, SubmitResult `ee7b142e…5361` and
the cron sweeper's Withdraw `c59d85cf…16d3` (39 s after unlock_time), with blocks, fees and
what each proves in `infrastructure/masumi/EVIDENCE.md`. A sweep costs 37-81 ms CPU since it
skips other sellers' escrow datums without decoding them (before: 0.9-2.05 s, one
`exceededCpu`). AuthorizeRefund and the dishonest-seller demo are still offline-tested only.

The original pre-flight list, kept for the parts not yet exercised live:

- the real script evaluation (ex-units) and the script_data_hash against live cost models;
- the slot rounding of the validity bounds;
- Blockfrost indexing delays.

1. Create the KV namespace and put its id in `wrangler.jsonc` (above). Make sure
   `SELLER_SIGNING_KEY` is set (`GET /` shows `escrowRoute.enabled: true`).
2. Fund `SELLER_ADDRESS` with at least 10 tADA, including one pure-ADA UTxO of 5 tADA or more.
3. Deploy, then confirm that
   `curl -i "https://<worker>/v1/address-report/escrow?address=<addr_test1…>"` returns a 402
   with `extra.assetTransferMethod: "masumi"`.
4. Pay it from ZyroPay (`pay_x402` with that exact URL; ZyroPay must support the masumi
   method). This locks 5 tADA in the escrow. Watch `wrangler tail`. Expect
   `escrow <lockTx>: SubmitResult <tx>`, or a sweeper line within a few minutes.
5. Check `GET /v1/escrow/<lockTx>`. Expect `result_submitted`, then `withdrawn` after
   `unlock_time` (+30 min).
6. Refund path: the buyer requests a refund (`SetRefundRequested`). Within about a minute the
   sweeper authorizes it and the status shows `refund_authorized`. The buyer then
   `WithdrawRefund`s, and the status shows `refunded`.

## Dishonest-seller demo switch

This switch makes refunds demonstrable. It is **off by default**, and both of these are
needed to turn it on:

1. the worker has `DEMO_DISHONEST_MODE=enabled`, and
2. the request goes to the **escrow** route with `&demo=tamper` or `&demo=nodelivery`.

Other uses of `demo` get a 400 before any 402: `demo` on the default route, an unknown
value, a repeated `demo`, or any `demo` while the switch is off. A request never falls back
silently. Every response to a demo request, the 402 included, carries `X-Demo-Mode: <mode>`.
`GET /` shows `demoDishonestMode`. `demo` is part of the paid URL, so it is also in the
seller-signed input commitment.

| Mode         | What the seller does                                                                                                                                                                                                                                                              | What the buyer can see                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tamper`     | Computes the real report, puts `sha256(real report)` on chain (`X-Escrow-Result-Hash`, KV record, SubmitResult), then **delivers different bytes**: the same JSON with `riskFlags: []`, `riskScore: 0` and a `demo` note. The delivery receipt signs what was actually delivered. | `sha256(body)` = `receipt.contentSha256` ≠ the on-chain `result_hash`. Grounds for `SetRefundRequested`.                         |
| `nodelivery` | Lets the lock settle, then returns `{delivered:false, demo:{…}}` instead of the report. It stores no record and **never submits a result**. Sub-hiring is skipped.                                                                                                                | No `X-Escrow-Result-Hash`; `/v1/escrow/<lockTx>` stays `locked`. The buyer refunds after `submit_result_time` (or requests one). |

With `AUTO_AUTHORIZE_REFUNDS=true` (the default), the cron sweeper authorizes any refund
request it finds, for demo escrows as well. Tests: `test/escrow-app.test.ts`, "dishonest-seller
demo switch". **Live: NOT verified.**

## Sub-hiring (agents hiring agents)

When `SUBHIRE_ENABLED=true` and the queried address holds native tokens, the report handler
**pays** Cardano Token Intelligence (`apps/specialist`) through x402 for a report on the top
token, before it answers. The top token is the largest quantity; ties go to the lowest
unit. The handler then adds `subcontracted`:

```jsonc
"subcontracted": [{
  "status": "delivered",                      // or "failed" (with "reason")
  "service": "Cardano Token Intelligence",
  "unit": "<policy+name hex>",
  "resourceUrl": "<SPECIALIST_URL>/v1/token-report?unit=<unit>",
  "payTo": "<specialist payTo>", "priceLovelace": "1500000",
  "paymentTx": "<the seller's sub-payment tx id>",
  "receiptVerified": true,                    // false + "receiptProblem" when it fails
  "receipt": { "v": 1, "contentSha256": "…", "signature": "…", … },  // the specialist's X-Delivery-Receipt
  "report": { … }                             // the specialist's report, as delivered
}]
```

This seller then signs its own body with its `X-Delivery-Receipt`, and that body contains the
specialist's receipt. That gives a **receipt chain**: Claude → Address Intelligence → Token
Intelligence, with both payments on chain. `subcontracted` is `[]` for an address without
tokens, and absent when sub-hiring is off.

The specialist's receipt is checked with `verifyDeliveryReceipt` (`src/receipt.ts`), using the
same rules as `packages/shared` `verifyX402Receipt`:

- `blake2b-224(publicKey)` is the paid payTo's payment credential;
- the Ed25519 signature is valid;
- the receipt names the URL, the payTo and the transaction that were paid;
- `contentSha256` is the SHA-256 of the bytes received.

`JSON.stringify(report)` reproduces those bytes (Hono's `c.json` emits compact JSON). So a
third party can re-check the inner link from the embedded data alone; `apps/specialist`'s
`test/chain.test.ts` does exactly that.

**Spending rules** (`src/subhire.ts`):

- **Wallet.** Payments come from `SELLER_BUYER_MNEMONIC`, a separate hot wallet the seller
  funds with a small budget, through the reference `toClientCardanoSigner` (`@x402/fetch` +
  `@x402/cardano/exact/client`). It is derived lazily, on the first sub-hire of an isolate.
- **Limits.** One sub-payment per job; at most `SUBHIRE_MAX_LOVELACE` (≤ 3 tADA); lovelace
  only, `exact` default transfers only, on `cardano:preprod`; and only to
  `SPECIALIST_PAY_TO` when that is set. An unacceptable 402 is never signed.
- **Fail-soft.** On a timeout (25 s for the whole sub-hire), an unreachable specialist, an
  HTTP error, a refused 402 or bad JSON, the main report is still delivered with
  `{status: "failed", reason}`, plus `paymentTx` if a sub-payment did settle.
- **Known risk.** The sub-payment happens after the buyer's payment is _verified_ but before
  it is _settled_. If the main settlement then fails, the seller has spent up to the cap for
  nothing. The cap and the small wallet bound that loss.
- **CPU.** `wrangler check startup` measures about 111 ms active locally, with nothing new at
  startup. On the request path, the reference signer derives the wallet (about 90 ms in Node)
  and builds the payment transaction with the Evolution SDK. That cost has **not** been
  measured on Cloudflare.

Tests: `test/subhire.test.ts` covers a fake specialist with real receipts, the cap, the pin,
fail-soft paths and a tampered receipt. `apps/specialist/test/chain.test.ts` runs both real
apps.

### Sub-hiring live steps (NOT verified live)

None of this has been run on preprod. No sub-payment transaction exists yet.

1. Deploy `apps/specialist` (its README) and note its `SELLER_ADDRESS` and URL.
2. Run `pnpm --filter @zyropay/seller wallet subhire`. Fund the printed address with about
   10 tADA from the faucet: each sub-hire costs the price plus about 0.2 tADA in fees.
3. Run `cd apps/seller && pnpm exec wrangler secret put SELLER_BUYER_MNEMONIC < .secrets/subhire.mnemonic`.
4. In `wrangler.jsonc` vars, set `SUBHIRE_ENABLED: "true"`, `SPECIALIST_URL` and
   `SPECIALIST_PAY_TO`. Deploy, then check that `GET /` shows `subcontracting.enabled: true`.
5. Buy a report on an address that holds a token. Then check:
   - `subcontracted[0].status` is `delivered`;
   - `receiptVerified` is `true`;
   - `paymentTx` appears on https://preprod.cardanoscan.io.

## Layout

- `src/address.ts` — CIP-19 / bech32 parsing.
- `src/config.ts` — config validation.
- `src/blockfrost.ts` — client and error mapping.
- `src/report.ts` — flags and score.
- `src/app.ts` — Hono app and x402 wiring.
- `src/receipt.ts` — delivery receipt signing (`X-Delivery-Receipt`) and verification of another seller's receipt.
- `src/demo.ts` — the dishonest-seller demo switch.
- `src/subhire.ts` — sub-hiring Cardano Token Intelligence (`subcontracted`).
- `src/escrow/` — Masumi escrow: `config.ts` (deadlines, price), `terms.ts` (quote signer and
  admission), `delivery.ts` (result hash, post-response SubmitResult), `spend.ts`
  (SubmitResult / Withdraw / AuthorizeRefund with the Evolution SDK), `sweeper.ts` (cron
  decisions), `status.ts` (`/v1/escrow/:id`), `chain.ts` (Blockfrost), `store.ts` (KV),
  `datum.ts`, `script.ts` (the applied vested_pay v2 script).
- `src/index.ts` — Worker entry (`fetch` + `scheduled` sweeper).
- `scripts/wallet.ts` (`seller|buyer|specialist|subhire`), `scripts/buy.ts`, `scripts/receipt-key.ts` (`[specialist]`) — the wallet, buyer and receipt-key scripts.
- `package.json` `exports` (`./app`, `./config`, `./facilitator`, `./receipt`, `./blockfrost`) — reused by `apps/specialist`.
- `test/` — vitest suite, with labelled fixtures in `test/fixtures`.

Versions: `@x402/*` 2.29.0 exactly. Version 2.26 re-encoded the transaction CBOR in the
facilitator and broke the body hash (x402-foundation/x402#3674).
