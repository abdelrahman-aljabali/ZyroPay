# Deploy runbook (Cloudflare)

ZyroPay ships as three Cloudflare Workers plus the hosted services they call:

| Worker                                                | Source          | What it is                                                                                     |
| ----------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `zyropay-web-<env>`                                   | `apps/web-host` | The web app (PWA): the Expo web export served as **static assets**, with `_headers` (CSP etc.) |
| `zyropay-api-<env>`                                   | `apps/api`      | REST API (Hono), queue consumer, cron                                                          |
| `zyropay-mcp-<env>`                                   | `apps/mcp`      | MCP server + OAuth for AI agents                                                               |
| Neon, Turnkey, Helius, Alchemy, Blockfrost, CoinGecko | external        | Database, key custody (user passkeys), chain data                                              |

`<env>` is `staging` (real adapters on **testnets**, `ZYROPAY_MODE=development`) or `production` (mainnets). The top level of every `wrangler.jsonc` is local development only; every deploy names an environment, and the plain `deploy` scripts refuse to run.

**Staging is deployed** on zyropay.online with Workers custom domains; §6 lists every resource, the one redeploy command and rollback. **Production has not been deployed.** Every config was also validated with `wrangler deploy --dry-run --env …` (`pnpm --filter @zyropay/api check:deploy`, same for `mcp` and `web-host`).

## 0. Cloudflare plan: do Queues need Workers Paid?

**No, not any more.** Since 4 February 2026, Cloudflare Queues is included in the Workers **Free** plan ([changelog: "Cloudflare Queues now available on Workers Free plan"](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/)). The [Queues pricing page](https://developers.cloudflare.com/queues/platform/pricing/) (last updated 21 April 2026, checked 19 October 2026) lists:

| Plan         | Operations                                              | Retention                                  |
| ------------ | ------------------------------------------------------- | ------------------------------------------ |
| Workers Free | 10,000 operations/day (reads + writes + deletes)        | 24 hours, not configurable                 |
| Workers Paid | 1,000,000 operations/month included, then $0.40/million | 4 days by default, configurable to 14 days |

What that means for ZyroPay: each queued job costs about 3 operations (write, read, delete), and a retry costs more. The API's queue (signing/broadcast, confirmation polling, push, webhooks) fits the Free allowance for a pilot. For real users, use Workers Paid. The 24-hour retention on Free also bounds how long a failed job can wait in the DLQ before it is gone. Cron triggers, KV and the rate-limit bindings are available on Free too. Workers Paid ($5/month) also raises the CPU-time limit per request, which the API's signing path benefits from.

## 1. One-time setup

```sh
pnpm install
pnpm --filter @zyropay/api exec wrangler login        # opens the browser; one login serves all three workers
pnpm --filter @zyropay/api exec wrangler whoami       # note the account id
```

### Domains

Pick the hosts. The examples below use the placeholders in the `wrangler.jsonc` files; replace every `*.zyropay.example` with your own:

| Purpose | staging                       | production            |
| ------- | ----------------------------- | --------------------- |
| Web app | `app-staging.zyropay.example` | `app.zyropay.example` |
| API     | `api-staging.zyropay.example` | `api.zyropay.example` |
| MCP     | `mcp-staging.zyropay.example` | `mcp.zyropay.example` |

1. Add the zone (your domain) to the Cloudflare account.
2. In `apps/web-host/wrangler.jsonc`, `apps/api/wrangler.jsonc` and `apps/mcp/wrangler.jsonc`, replace the placeholder hosts and un-comment the `routes` entry (`"custom_domain": true`) of each environment. Without a route, a worker answers at `https://<worker-name>.<account-subdomain>.workers.dev`, which also works for a first staging run.
3. The API's `CORS_ALLOWED_ORIGINS` must be the web app's exact origin (`https://app-staging.zyropay.example`). The API's `API_PUBLIC_URL` and the MCP's `MCP_PUBLIC_URL` are their own https origins.

### Queues and KV

```sh
cd apps/api
pnpm exec wrangler queues create zyropay-api-jobs-staging
pnpm exec wrangler queues create zyropay-api-jobs-staging-dlq
pnpm exec wrangler queues create zyropay-api-jobs-production
pnpm exec wrangler queues create zyropay-api-jobs-production-dlq

cd ../mcp
pnpm exec wrangler kv namespace create OAUTH_KV --env staging       # paste the id into env.staging.kv_namespaces
pnpm exec wrangler kv namespace create OAUTH_KV --env production    # paste the id into env.production.kv_namespaces
```

The rate-limit bindings (`namespace_id` 4401-4403 for staging, 4301-4303 for production) need no creation step.

### Database (Neon)

Staging uses Neon project `zyropay-online` (§6). Production has no database yet: create its own Neon project before the first production deploy. For each deploy that adds a migration:

```sh
set -a; . ./.env.local; set +a            # DATABASE_URL_UNPOOLED (direct endpoint)
pnpm db:migrate                           # drizzle-kit; refuses a -pooler host
```

Run migrations **before** deploying an API version that needs them. For a separate production database, create a Neon branch (`neon branches create`) and use its URLs for the production secrets. Staging and production must not share a database.

## 2. Secrets (`wrangler secret put`)

Secrets never go into `wrangler.jsonc` or the repo. Each command prompts for the value. Run each one with `--env staging`, then again with `--env production` and that environment's values.

**API** (`cd apps/api`):

| Secret                                                                                                                                                            | Value                                                        | Required                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| `DATABASE_URL`                                                                                                                                                    | Neon **pooled** URL (`-pooler` host)                         | yes                            |
| `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`                                                                                    | Parent org + its API key (read-only use)                     | yes                            |
| `INTERNAL_SERVICE_TOKEN`                                                                                                                                          | `openssl rand -base64 32`, **same value as the MCP's**       | yes                            |
| `DELEGATED_KEY_ENCRYPTION_KEY`                                                                                                                                    | `openssl rand -base64 32`                                    | yes in production (autonomous) |
| `AUDIT_IP_HASH_SALT`                                                                                                                                              | `openssl rand -base64 32`                                    | yes in production              |
| `HELIUS_API_KEY`, `ALCHEMY_API_KEY`                                                                                                                               | Provider keys                                                | yes (mocks are off)            |
| `BLOCKFROST_PROJECT_ID_PREPROD` (staging) / `BLOCKFROST_PROJECT_ID_MAINNET` (production)                                                                          | Blockfrost project id of that network                        | for Cardano                    |
| `COINGECKO_API_KEY`                                                                                                                                               | CoinGecko key                                                | yes in production              |
| `JUPITER_API_KEY`, `TRANSAK_API_KEY`, `TRANSAK_API_SECRET`, `TRANSAK_WEBHOOK_SECRET`, `HELIUS_WEBHOOK_SECRET`, `ALCHEMY_WEBHOOK_SIGNING_KEY`, `EXPO_ACCESS_TOKEN` | See `docs/SETUP.md` "Which credential unlocks which feature" | optional                       |

```sh
cd apps/api
for s in DATABASE_URL TURNKEY_ORGANIZATION_ID TURNKEY_API_PUBLIC_KEY TURNKEY_API_PRIVATE_KEY \
         INTERNAL_SERVICE_TOKEN DELEGATED_KEY_ENCRYPTION_KEY AUDIT_IP_HASH_SALT \
         HELIUS_API_KEY ALCHEMY_API_KEY BLOCKFROST_PROJECT_ID_PREPROD COINGECKO_API_KEY; do
  pnpm exec wrangler secret put "$s" --env staging
done
```

**MCP** (`cd apps/mcp`): `INTERNAL_SERVICE_TOKEN` (the API's value), `MCP_OAUTH_COOKIE_SECRET` (`openssl rand -base64 32`).

```sh
cd apps/mcp
pnpm exec wrangler secret put INTERNAL_SERVICE_TOKEN --env staging
pnpm exec wrangler secret put MCP_OAUTH_COOKIE_SECRET --env staging
```

**Web app**: no secrets. Its build-time values are public (`EXPO_PUBLIC_*`, inlined in the bundle). The build refuses to finish if any secret value from the local env files (`.env.local`, `.env`, both `.dev.vars`) shows up in the output.

The API refuses to start in production without `TURNKEY_*`, `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, `DELEGATED_KEY_ENCRYPTION_KEY`, `AUDIT_IP_HASH_SALT`, https `API_PUBLIC_URL`, `HELIUS_API_KEY`, `ALCHEMY_API_KEY` and `COINGECKO_API_KEY`. `/health` then answers 503 and names what is missing (names only, never values).

## 3. Turnkey dashboard settings (exact values)

dashboard.turnkey.com → your parent organization → **Embedded Wallets / Auth → Auth Proxy** (config id = `EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID`):

| Setting                                                                     | Value                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth Proxy                                                                  | Enabled                                                                                                                                                                                                                                                              |
| Auth methods                                                                | **Passkey** on. ZyroPay does not use email or SMS OTP, so turn those off unless you want them (the config currently reports `enabledProviders: ["email"]`)                                                                                                           |
| **Allowed Origins** (exact, one per entry, no trailing slash, no wildcards) | Development: `http://localhost:8081` (`pnpm dev --web`). Staging: `https://app-staging.zyropay.example`. Production: `https://app.zyropay.example`. Add `http://localhost:8085` only if you use `ZYROPAY_WEB_PORT=8085` or `pnpm --filter @zyropay/web-host preview` |
| Session expiration                                                          | `900` seconds (the current value; it is the Turnkey session behind the read-only whoami stamp, not the ZyroPay session)                                                                                                                                              |

With Allowed Origins left at `*`, the Auth Proxy answers a request carrying an arbitrary `Origin`. Once restricted (§6.4), a listed origin such as `http://localhost:8081` is accepted, and an unlisted one such as `https://evil.example` gets `403 origin not allowed` on `POST /v1/signup_v2` and `/v1/wallet_kit_config`. A request **without** an `Origin` header is still processed (it reaches body validation): Allowed Origins is a browser control, not authentication, so any non-browser client can call the Auth Proxy. Rate limits and the captcha option are the server-side defence. Turnkey documents that partial wildcards such as `https://*.example.com` are not supported ([Auth Proxy reference](https://docs.turnkey.com/reference/auth-proxy)).

**Passkey relying party (rpId)** is set at build time, not in the dashboard: `EXPO_PUBLIC_PASSKEY_RP_ID` must equal the web app's host or a registrable parent of it:

| Where the app runs                    | `EXPO_PUBLIC_PASSKEY_RP_ID`                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http://localhost:<port>`             | `localhost`                                                                                                                                                                             |
| `https://app-staging.zyropay.example` | `app-staging.zyropay.example` (passkeys bound to staging only)                                                                                                                          |
| `https://app.zyropay.example`         | `zyropay.example` lets the same passkey also work on other subdomains and in the native apps' associated domain. **Pick once: changing the rpId later orphans every existing passkey.** |

Passkeys are bound to the rpId, so a passkey made on localhost or staging never works in production. That is intended.

## 4. Build and deploy (staging first)

```sh
# API and MCP
pnpm --filter @zyropay/api check:deploy                  # dry-run both environments
pnpm --filter @zyropay/api deploy:staging
pnpm --filter @zyropay/mcp deploy:staging
curl https://api-staging.zyropay.example/health          # {"ok":true,"mode":"development","mocks":false}

# Web app: build with the public values, then deploy the static assets
cat > apps/web-host/.env.staging <<'EOF'                 # git-ignored
EXPO_PUBLIC_API_URL=https://api-staging.zyropay.example
EXPO_PUBLIC_MCP_URL=https://mcp-staging.zyropay.example/mcp
EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID=<your Turnkey parent organization id>
EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID=<Auth Proxy config id>
EXPO_PUBLIC_PASSKEY_RP_ID=app-staging.zyropay.example
EOF
pnpm --filter @zyropay/web-host build:web -- --env staging
pnpm --filter @zyropay/web-host deploy:staging
```

The web build (`apps/web-host/scripts/build.mjs`) runs `expo export --platform web` of `apps/mobile` into `apps/web-host/dist`. It writes `dist/_headers` with a Content-Security-Policy whose `connect-src` is exactly `'self'`, the API origin, `https://api.turnkey.com` and `https://authproxy.turnkey.com`, plus `frame-ancestors` (staging: exactly the landing page, `https://zyropay.online` and `http://localhost:4321`; production: `'none'` with `X-Frame-Options: DENY`; see `docs/SECURITY.md` "Framing"), HSTS, `Permissions-Policy` (WebAuthn for self and the allowed landing origins only) and immutable caching for hashed bundles. Then it scans the output for secrets. Workers static assets serve `index.html` for unknown paths (`not_found_handling: "single-page-application"`), so deep links such as `/approvals/<id>` work.

Production is the same with `--env production`, `apps/web-host/.env.production`, mainnet secrets and `deploy:production`. Production refuses mock adapters and testnet keys (`ZYROPAY_MODE=production` serves mainnets only).

## 5. After the deploy

1. Open the web app on a phone, create a passkey, and check that `POST /v1/auth/session` succeeds. To rehearse the whole flow against a deployed stack: `node apps/mobile/scripts/web-e2e.mjs --url https://app-staging.zyropay.example --api https://api-staging.zyropay.example`. It creates one labelled test sub-org per run.
2. Point the agent clients at `https://mcp-staging.zyropay.example/mcp`.
3. Webhooks (optional): register Helius and Alchemy webhooks at `https://api-staging…/v1/webhooks/...` with their secrets.
4. Rollback: `pnpm exec wrangler rollback --env staging` in the worker's directory. Migrations are forward-only; roll a schema back with a new migration.

## Local rehearsal of the production build

```sh
ZYROPAY_WEB_PORT=8085 pnpm dev --web --no-mobile           # API (real mode) + MCP; CORS http://localhost:8085
pnpm --filter @zyropay/web-host build:web -- --env local    # http://localhost API, rpId localhost
pnpm --filter @zyropay/web-host preview                     # wrangler dev serves dist/ with _headers on :8085
node apps/mobile/scripts/web-e2e.mjs --url http://localhost:8085
```

This is how the static export is verified: a real passkey sign-up and login through the Auth Proxy, with the CSP enforced and no violations reported.

## 6. Staging: the testnet deployment on zyropay.online (created 2026-10-30)

Testnets only (`ZYROPAY_MODE=development`, `ZYROPAY_USE_MOCK_ADAPTERS=false`). A fresh instance with an empty database. Wrangler's environment is still called `staging`; the workers have explicit names.

### 6.1 What exists

| Resource            | Name                                                                             | Id / URL                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare account  | The team's Cloudflare account                                                    | (from `wrangler whoami`)                                                                                                                                                 |
| Domain              | `zyropay.online` (registrar Porkbun, DNS on Cloudflare)                          | landing `zyropay.online` + `www`, web `app.`, API `api.`, MCP `mcp.` (Workers custom domains)                                                                            |
| Landing             | `zyropay-online-landing`                                                         | https://zyropay.online                                                                                                                                                   |
| Docs                | `zyropay-online-docs` (static assets, `apps/docs`)                               | https://docs.zyropay.online                                                                                                                                              |
| Web app             | `zyropay-online-web` (static assets)                                             | https://app.zyropay.online                                                                                                                                               |
| API worker          | `zyropay-online-api`                                                             | https://api.zyropay.online (`/health`); cron `* * * * *`                                                                                                                 |
| MCP worker          | `zyropay-online-mcp`                                                             | https://mcp.zyropay.online (`/mcp`, `/health`)                                                                                                                           |
| Queues              | `zyropay-online-jobs`, dead letters `zyropay-online-jobs-dlq`                    | API producer and consumer                                                                                                                                                |
| KV                  | `zyropay-online-oauth` (MCP `OAUTH_KV`)                                          | `794bed5db991452287ba76cf6e335242`                                                                                                                                       |
| Rate limits (MCP)   | `MCP_RATE_LIMITER`, `AUTH_RATE_LIMITER`, `OAUTH_ENDPOINT_RATE_LIMITER`           | namespace ids `4401`–`4403` (no creation step)                                                                                                                           |
| Service bindings    | API `MCP` → `zyropay-online-mcp`; MCP `API` → `zyropay-online-api`               | internal calls authenticated with the shared `INTERNAL_SERVICE_TOKEN`                                                                                                    |
| Neon                | project `zyropay-online` (`icy-hill-73941166`), branch `main`, eu-central-1      | endpoint `ep-small-union-b9vbotlw`; migrations `0000`–`0008` applied (created empty with `0000`–`0005`)                                                                  |
| x402 sellers (demo) | `cardano-address-intel`, `cardano-token-intel`, MIP-003 worker                   | https://address-intel.zyropay.online, https://token-intel.zyropay.online, https://masumi-agent.zyropay.online (demo sellers run by the ZyroPay team as separate workers) |
| Masumi node         | Masumi Payment Service 0.29.0 (`infrastructure/masumi`, Docker on a workstation) | reached by the MIP-003 worker through a `cloudflared` quick tunnel and an allow-list gateway; registry entry and evidence in `infrastructure/masumi/EVIDENCE.md`         |

The API uses the **pooled** URL; migrations use the direct one (`neon connection-string --project-id icy-hill-73941166`).

**Passkey rpId: `zyropay.online`** (`EXPO_PUBLIC_PASSKEY_RP_ID`, set by `scripts/deploy-staging.mjs`): the registrable domain, so a passkey works on `app.` and in the landing page's embed. It cannot change later without every user re-registering.

**Secrets** (`wrangler secret put|bulk --env staging`, piped, never in the repo):

- API: `DATABASE_URL` (pooled), `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `INTERNAL_SERVICE_TOKEN`, `DELEGATED_KEY_ENCRYPTION_KEY`, `AUDIT_IP_HASH_SALT`, `HELIUS_API_KEY`, `HELIUS_API_KEY_SECONDARY`, `ALCHEMY_API_KEY`, `COINGECKO_API_KEY`, `JUPITER_API_KEY`, `BLOCKFROST_PROJECT_ID_PREPROD` (Cardano preprod is on).
- MCP: `INTERNAL_SERVICE_TOKEN` (same value as the API's), `MCP_OAUTH_COOKIE_SECRET`.
- Seller: `BLOCKFROST_PROJECT_ID`.
- `INTERNAL_SERVICE_TOKEN`, `DELEGATED_KEY_ENCRYPTION_KEY`, `AUDIT_IP_HASH_SALT` and `MCP_OAUTH_COOKIE_SECRET` were generated for this instance (32 random bytes, base64) and are stored nowhere else. To change one, `put` a new value (the internal token on **both** workers; `INTERNAL_SERVICE_TOKEN_PREVIOUS` allows a rotation without downtime). Changing `DELEGATED_KEY_ENCRYPTION_KEY` makes existing delegated-signer keys unreadable.
- Not set: webhook, Transak, Expo push and Sentry secrets.

**Turnkey:** the same parent organization as before. `https://app.zyropay.online` and `https://zyropay.online` (landing embed) must be on the Auth Proxy's **Allowed Origins**, otherwise sign-up fails with `403 origin not allowed`.

### 6.2 Redeploy (one command)

```sh
pnpm deploy:staging                    # migrations on Neon zyropay-online, API, MCP, web build + deploy
pnpm deploy:staging --skip-migrate     # code only
pnpm deploy:staging --only web         # just one of api | mcp | web
pnpm deploy:landing                    # the landing page
pnpm --filter @zyropay/docs build && pnpm --filter @zyropay/docs deploy:staging   # the docs site
pnpm --filter @zyropay/seller exec wrangler deploy   # the x402 seller (apps/seller)
```

`scripts/deploy-staging.mjs` gets the **direct** URL from the `neon` CLI and stops if that fails. It needs `wrangler login` and `neon auth` on the machine, and never touches secrets.

First-deploy note: the API and MCP bind to each other, and Cloudflare refuses a service binding to a worker that does not exist (`code: 10143`), so the first deploy was MCP without its `API` binding, then the API, then MCP again. A custom domain needs the zone to be active on the account.

### 6.3 Roll back

```sh
pnpm --filter @zyropay/api exec wrangler deployments list --env staging   # find the previous version id
pnpm --filter @zyropay/api exec wrangler rollback <version-id> --env staging -m "reason" -y
# same with @zyropay/mcp and @zyropay/web-host
```

A rollback restores that version's code, vars and secrets. It does not touch the database: migrations are forward-only, so roll a schema back with a new migration, or restore with Neon's point-in-time restore (`neon branches restore main ^self@<timestamp> --project-id icy-hill-73941166`).
