# ZyroPay

A non-custodial crypto wallet where your AI can ask to pay, and you decide.

- **Your keys stay yours.** Each user's keys live in their own Turnkey sub-organization, behind their own passkey. ZyroPay holds no root credential and cannot move funds on its own.
- **Agents ask, policy decides.** AI assistants (Claude, ChatGPT, Grok, any MCP client) connect over OAuth to ZyroPay's MCP server. They can read balances and request payments. Every request goes through ZyroPay's policy engine; by default the user approves it with their passkey in the app.
- **Optional autonomy, bounded twice.** An agent can be switched to Autonomous within dollar limits. ZyroPay enforces the USD, daily and monthly limits; a Turnkey policy envelope, created by the user's own passkey, caps every single payment.
- **Chains:** Solana, Ethereum and Base, plus Cardano (ADR-002). Development and staging run on test networks only; production on mainnets only.

## Architecture at a glance

```
 Mobile / web app ──HTTPS──► API (Cloudflare Worker) ──► Neon Postgres
 (Expo, passkeys)            policy engine, state       Helius · Alchemy · Blockfrost
        │ passkey-stamped    machine, reservations,     CoinGecko · Jupiter · Transak
        ▼ requests           signing forward, audit
     Turnkey  ◄──────────────────┘ ▲
 (user's sub-org)                  │ /internal/v1/* (service token)
                                   │
 AI agent ──OAuth 2.1 + MCP──► MCP server (Cloudflare Worker, never signs)
```

The details, trust boundaries and the signing ADRs are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository map

| Path                      | What it is                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| `apps/api`                | REST API worker (Hono): auth, wallets, sends, approvals, agents, policy, webhooks |
| `apps/mcp`                | MCP server worker: OAuth for agent clients and the 10 tools                       |
| `apps/mobile`             | The app (Expo SDK 57, Expo Router) for iOS, Android and the web (PWA)             |
| `apps/web-host`           | Static host for the web build (CSP, headers, SPA fallback)                        |
| `apps/seller`             | Example x402 seller on Cardano preprod: a paid address-intelligence API (Worker)  |
| `apps/landing`            | Marketing site (Astro)                                                            |
| `apps/docs`               | Public documentation site (Astro Starlight), https://docs.zyropay.online          |
| `packages/shared`         | Contracts every package builds against: schemas, money, policy engine, REST/MCP   |
| `packages/wallet`         | Turnkey client, stamp verifiers, MockTurnkey                                      |
| `packages/blockchain`     | Transaction builders and verifiers, broadcasters, portfolio and price providers   |
| `packages/integrations`   | Plugins (Jupiter, x402, Aave, Kamino, Hyperliquid), Transak on-ramp, Expo push    |
| `packages/ui`             | React Native design system: tokens, components, brand marks                       |
| `packages/config`         | Shared tsconfig, ESLint and Prettier presets                                      |
| `infrastructure/database` | Drizzle schema and migrations                                                     |
| `tests/integration`       | End-to-end smoke test (`pnpm smoke`)                                              |
| `scripts`                 | Local development, migrations, staging deploy, health check                       |
| `assets/brand`            | The ZyroPay mark, source of every icon                                            |
| `docs`                    | Architecture, security, setup, deploy, API and MCP references                     |

## Quick start

Node 24 (`.nvmrc`) and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev --mocks        # the app alone in Expo Go, simulated data, no credentials needed
pnpm dev:setup          # once: local secrets for the workers
pnpm dev                # API + MCP (wrangler dev) + Expo, against a local Postgres
pnpm dev --web          # real mode in the browser: real passkeys, Turnkey, testnet balances
```

Credentials, Turnkey, Neon and every mode are explained in [docs/SETUP.md](docs/SETUP.md).

## Scripts

| Command                        | Does                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm check`                   | Typecheck and lint, then unit/integration tests, then the workerd e2e suites  |
| `pnpm test:web`                | Cross-browser web E2E (Playwright: Chromium, WebKit, Firefox)                 |
| `pnpm smoke`                   | Full agent payment flow against local workers and Postgres                    |
| `pnpm build`                   | Worker bundles (`wrangler deploy --dry-run`)                                  |
| `pnpm format` / `pnpm knip`    | Prettier; dead files, exports and dependencies                                |
| `pnpm db:local` / `db:migrate` | Local Postgres in Docker / apply migrations to Neon                           |
| `pnpm deploy:staging`          | Deploy API, MCP and web to staging (`--skip-migrate`, `--only api\|mcp\|web`) |
| `pnpm deploy:landing`          | Build and deploy the landing page to staging                                  |
| `pnpm health`                  | Health check of a deployment (`--api`, `--mcp`, `--web`)                      |

## Documentation

The public documentation site is **https://docs.zyropay.online** (`apps/docs`): how it works in reading order, architecture, security and trust, live evidence on Cardano preprod, guides and generated references. The engineering documents in `docs/`:

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): system, data flows, trust boundaries, ADR-001/002/003, ownership
- [SECURITY.md](docs/SECURITY.md): threat model, controls and their status, framing
- [SETUP.md](docs/SETUP.md): local development, credentials, the persisted e2e test user
- [DEPLOY.md](docs/DEPLOY.md): Cloudflare deploy runbook, staging resources and what was verified
- [API.md](docs/API.md) and [MCP.md](docs/MCP.md): generated contract references plus implementation guides
- [INTEGRATIONS.md](docs/INTEGRATIONS.md): chain adapters, prices and plugins
- [CARDANO_X402.md](docs/CARDANO_X402.md): agent payments on Cardano over x402, configuration and live verification
- [MONITORING.md](docs/MONITORING.md): Sentry and health checks
- [BRAND_ASSETS.md](docs/BRAND_ASSETS.md): brand marks and third-party logo rules
- [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md): what is done, partial and open

## Staging

Test networks only, no real funds: landing https://zyropay.online, web https://app.zyropay.online, API https://api.zyropay.online, MCP https://mcp.zyropay.online/mcp. The demo x402 sellers are separate workers operated by the ZyroPay team: https://address-intel.zyropay.online (`apps/seller`), https://token-intel.zyropay.online (`apps/specialist`) and the Masumi agent endpoint https://masumi-agent.zyropay.online. Production is not deployed yet.
