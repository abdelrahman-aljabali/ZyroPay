# Cardano Token Intelligence (`@zyropay/specialist`)

A second, minimal paid data API on Cloudflare Workers. It sells one thing: a deterministic
JSON report on a Cardano **preprod** native token. Buyers pay per request with **x402 v2**
(`exact` scheme, `cardano:preprod`), 1.5 tADA by default.

Its main buyer is another agent. Cardano Address Intelligence (`apps/seller`) can
**sub-hire** it while building an address report: it pays for a report on the address's
top token and embeds that report, this service's delivery receipt and the sub-payment
transaction. The result is a receipt chain: Claude → Address Intelligence → Token
Intelligence. See "Sub-hiring" in `apps/seller/README.md`.

No LLM is involved. The payment stack is the seller's, imported from `@zyropay/seller`:

- config rules (`loadConfig`);
- the embedded `@x402/cardano` facilitator;
- the signed `X-Delivery-Receipt`;
- Blockfrost error mapping;
- the Evolution shim (the `wrangler.jsonc` alias).

## Routes

| Route                                      | Paid | What it returns                                                                                                                                                                                        |
| ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /` and `GET /health`                  | no   | Service description: price, `payTo`, network, config status (rule names only)                                                                                                                          |
| `GET /v1/token-report?unit=<policy[name]>` | yes  | The report. `400` for an invalid `unit` (sent before any 402), `402` with `PAYMENT-REQUIRED`, `200` with `PAYMENT-RESPONSE` and `X-Delivery-Receipt`, `503` when Blockfrost or the facilitator is down |

`unit` is a 56-hex policy id, or a policy id followed by a hex asset name of up to 32 bytes
(Blockfrost's `unit`). For a policy id, the report covers the policy's largest-supply asset
(ties go to the lowest unit), and `policy.assetCount` counts the policy's assets, up to 100.

Settlement follows the same rule as the seller: it happens only when the handler answers
below 400. A Blockfrost failure therefore returns 503 and the buyer is not charged.

## The report

The report has these fields: `query`, `queryKind`, `found`, `policy`, `asset` (unit,
fingerprint, supply, decimals, `nftLike`), `holders` (count, `countIsLowerBound`,
`topHolderPercent`, top 5), `mintHistory` (`mintOrBurnCount`, initial mint tx and time, the
last 10 actions), `metadata` (name, ticker, on-chain standard, registry), `riskFlags`,
`riskScore` and `generatedAt`.

`riskScore = min(100, sum of the weights of the raised flags)`:

| Code            | Weight | Rule                                                         |
| --------------- | ------ | ------------------------------------------------------------ |
| `UNKNOWN_ASSET` | 40     | No such asset or policy on preprod (a valid, flagged result) |
| `OPEN_MINTING`  | 20     | More than one mint/burn transaction                          |
| `SINGLE_HOLDER` | 20     | One address holds the whole supply (fungible tokens)         |
| `CONCENTRATED`  | 15     | The largest holder has 90% or more                           |
| `RECENT_MINT`   | 15     | First minted less than 7 days ago                            |
| `NO_METADATA`   | 10     | No on-chain (CIP-25/68) and no registry (CIP-26) metadata    |
| `FEW_HOLDERS`   | 10     | Fewer than 5 holders (fungible tokens)                       |
| `BURNED_OUT`    | 5      | Current supply is 0                                          |

Holder figures cover the first Blockfrost page (100 holders). Each report makes 4 or 5
Blockfrost calls (8 s timeout each):

- `/assets/policy/{p}`, only for a policy query;
- `/assets/{u}`;
- `/assets/{u}/addresses?count=100`;
- `/assets/{u}/history?order=desc&count=20`;
- `/txs/{initial mint}`.

## Config

The variable names are the seller's, because the config code is the seller's. Here
`SELLER_ADDRESS` is **this specialist's own** payTo.

| Variable                                                                         | Required     | Rule                                                                                                  |
| -------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `SELLER_ADDRESS`                                                                 | yes          | Preprod key-hash address: the specialist's own wallet (`wrangler.jsonc` holds a placeholder)          |
| `BLOCKFROST_PROJECT_ID`                                                          | yes (secret) | Starts with `preprod`                                                                                 |
| `PRICE_LOVELACE`                                                                 | no           | Default `1500000` (Address Intelligence refuses more than its `SUBHIRE_MAX_LOVELACE`, at most 3 tADA) |
| `SELLER_SIGNING_KEY`                                                             | no (secret)  | Payment key of `SELLER_ADDRESS` (hex). Turns on delivery receipts, which the sub-hire chain checks    |
| `FACILITATOR_MODE`, `FACILITATOR_URL`, `L1_CONFIRMATIONS`, `BLOCKFROST_BASE_URL` | no           | As in `apps/seller`                                                                                   |

## Checks (offline)

```sh
pnpm --filter @zyropay/specialist typecheck
pnpm --filter @zyropay/specialist lint
pnpm --filter @zyropay/specialist test
pnpm --filter @zyropay/specialist build    # wrangler deploy --dry-run
```

The tests use a fake facilitator, fixture Blockfrost data (synthetic, in the documented
shapes) and test keys. `test/chain.test.ts` runs the real Address Intelligence app against
the real Token Intelligence app and checks both receipts of the chain.
`wrangler check startup`: about 107 ms active locally.

## Deploy

The worker is `cardano-token-intel`, served only on its custom domain https://token-intel.zyropay.online (`routes` in `wrangler.jsonc`, `workers_dev: false`). Deployed 2026-10-30; `GET /` answers 200 and the report route 402.

```sh
pnpm --filter @zyropay/seller wallet specialist          # apps/seller/.secrets/specialist.mnemonic; prints the address
# put that address in apps/specialist/wrangler.jsonc vars.SELLER_ADDRESS
pnpm --filter @zyropay/seller receipt-key specialist     # apps/seller/.secrets/specialist.signing-key
cd apps/specialist
pnpm exec wrangler secret put BLOCKFROST_PROJECT_ID
pnpm exec wrangler secret put SELLER_SIGNING_KEY < ../seller/.secrets/specialist.signing-key
pnpm exec wrangler deploy
curl -s https://token-intel.zyropay.online/ | jq '.config, .deliveryReceipts'
curl -i "https://token-intel.zyropay.online/v1/token-report?unit=<policy id>"   # -> 402
```

The specialist's wallet needs no funds to receive payments.
