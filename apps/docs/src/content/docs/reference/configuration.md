---
title: "Configuration"
description: "The settings that shape ZyroPay's agent payments on Cardano, for the API, the MCP worker and the demo seller, with their staging values. Secrets are named, never shown."
---

Plain settings live in each worker's `wrangler.jsonc`; secrets are set with `wrangler secret put` and
never appear in the repository. `.env.example` at the repository root lists every name.

## API worker (`apps/api`)

| Setting                                                                        | Kind   | Staging                                | What it does                                                                                 |
| ------------------------------------------------------------------------------ | ------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ZYROPAY_MODE`                                                                 | var    | `development`                          | `development` serves test networks only, `production` mainnets only                          |
| `ZYROPAY_USE_MOCK_ADAPTERS`                                                    | var    | `false`                                | Mock chain and Turnkey adapters (labelled `simulated`); refused in production                |
| `BLOCKFROST_PROJECT_ID_PREPROD` / `_MAINNET`                                   | secret | preprod set                            | Turns Cardano on for that network; a project of the wrong network refuses to start           |
| `CARDANO_CONFIRMATIONS`                                                        | var    | default 3                              | Confirmations before a Cardano request is `CONFIRMED`                                        |
| `X402_CAPS`                                                                    | var    | `{"cardano-preprod:native":"5000000"}` | Highest x402 amount per asset, in base units; an asset without a cap is refused              |
| `X402_MAX_TIMEOUT_SECONDS`                                                     | var    | default 600                            | Highest `maxTimeoutSeconds` accepted from a 402                                              |
| `PRICE_MAX_AGE_SECONDS`                                                        | var    | `120`                                  | Older price quotes are dropped (no valuation, fail closed)                                   |
| `VALUE_TESTNETS_AT_MAINNET_PRICES`                                             | var    | `true`                                 | Value test-network assets at mainnet prices, labelled `mainnet_proxy`; refused in production |
| `AGENT_CONNECTION_CODE_TTL_SECONDS`                                            | var    | `600`                                  | Lifetime of the code you enter to connect an agent                                           |
| `SESSION_ACCESS_TOKEN_TTL_SECONDS` / `_REFRESH_…`                              | var    | `900` / `2592000`                      | App session lifetimes                                                                        |
| `CORS_ALLOWED_ORIGINS`                                                         | var    | the app and landing origins            | Exact browser origins allowed                                                                |
| `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY` | secret | set                                    | The parent organization and its key, used read-only towards sub-orgs                         |
| `INTERNAL_SERVICE_TOKEN`                                                       | secret | set                                    | Shared with the MCP worker; authenticates `/internal/*`                                      |
| `DELEGATED_KEY_ENCRYPTION_KEY`                                                 | secret | set                                    | Encrypts delegated-signer keys (Autonomous); changing it makes existing keys unreadable      |
| `DATABASE_URL`                                                                 | secret | Neon pooled URL                        | The database                                                                                 |

## MCP worker (`apps/mcp`)

| Setting                                  | Kind     | What it does                                                              |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL`                         | var      | Bare origin; the issuer is the origin and the resource is origin + `/mcp` |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`     | var      | 60 to 3600, default 900                                                   |
| `MCP_ALLOWED_ORIGINS`                    | var      | Extra browser origins for `/mcp` beyond its own, Claude, ChatGPT and Grok |
| `MCP_AUDIT_SINK`                         | var      | `log` (default) or `api`                                                  |
| `INTERNAL_SERVICE_TOKEN` (+ `_PREVIOUS`) | secret   | The API's value; `_PREVIOUS` allows rotation without downtime             |
| `MCP_OAUTH_COOKIE_SECRET`                | secret   | HMAC for the consent page's poll tickets                                  |
| `OAUTH_KV`, rate-limit bindings          | bindings | Grants and hashed tokens; per-token and per-IP limits                     |

## Demo seller (`apps/seller`)

| Setting                                                                                              | Default              | What it does                                                               |
| ---------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `SELLER_ADDRESS`                                                                                     | required             | The `payTo` preprod key-hash address                                       |
| `PRICE_LOVELACE`                                                                                     | `2000000`            | Direct route price                                                         |
| `FACILITATOR_MODE`                                                                                   | `embedded`           | Run the `@x402/cardano` facilitator in the worker, or `hosted`             |
| `SELLER_SIGNING_KEY` (secret)                                                                        | unset                | Payment key of `SELLER_ADDRESS`; turns on receipts and the escrow route    |
| `ESCROW_PRICE_LOVELACE`                                                                              | `5000000`            | Escrow route price; at least 4 tADA                                        |
| `ESCROW_MAX_TIMEOUT_SECONDS`                                                                         | `300`                | payBy = 402 time + this                                                    |
| `ESCROW_SUBMIT_AFTER_PAYBY_MIN`, `ESCROW_UNLOCK_AFTER_SUBMIT_MIN`, `ESCROW_DISPUTE_AFTER_UNLOCK_MIN` | `10`, `15`, `15`     | Escrow deadlines                                                           |
| `AUTO_AUTHORIZE_REFUNDS`                                                                             | `true`               | Preprod demo policy: authorize every refund request                        |
| `DEMO_DISHONEST_MODE`                                                                                | off                  | `enabled` allows `?demo=tamper` and `?demo=nodelivery` on the escrow route |
| `SUBHIRE_ENABLED`, `SPECIALIST_URL`, `SPECIALIST_PAY_TO`, `SUBHIRE_MAX_LOVELACE`                     | off, —, —, `3000000` | Sub-hiring Token Intelligence                                              |

Every seller setting, with its rule, is in `apps/seller/README.md`.
