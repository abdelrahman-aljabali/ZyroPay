# Setup

## Prerequisites

| Tool                   | Version            | Notes                                                                                                                                                                                    |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                | 24 LTS (`.nvmrc`)  | Node 25 also works: everything here was verified on 25.1.0. Vitest 5 declares `engines: ^22.12 \|\| ^24 \|\| >=26`; pnpm did not block or warn on 25, but 24 LTS is the supported target |
| pnpm                   | 10.30.x            | `corepack enable`. The version is pinned in `packageManager`                                                                                                                             |
| Wrangler               | from the workspace | `pnpm --filter @zyropay/api exec wrangler …`; no global install needed                                                                                                                   |
| Docker                 | any recent         | Optional. Runs the local Postgres for `pnpm dev`/`pnpm db:local` and the e2e smoke. Any Postgres 15+ works instead (see below)                                                           |
| Expo Go                | SDK 57             | Mock mode and the local API with the development passkey. Real passkeys need a development build (EAS), or the web app (`pnpm dev --web`)                                                |
| Xcode / Android Studio | current            | Only for local native builds and simulators                                                                                                                                              |

## First run

```sh
pnpm install
pnpm check          # typecheck + lint, then unit/integration tests, then the workerd e2e suites
pnpm smoke          # end-to-end: API + MCP under wrangler dev, local Postgres, a real agent flow
pnpm build          # wrangler --dry-run bundles for apps/api and apps/mcp
```

`pnpm check` runs in three phases on purpose: `typecheck`+`lint` for every package, then `test`, then `test:e2e` one package at a time. The API suites boot PGlite and the MCP e2e suites boot workerd (one of them waits out a real 62 s token expiry). Running all of that in one turbo graph next to tsc and type-aware eslint starved them of CPU and caused hook timeouts.

## Local development, step by step

### 1. UI only: mock mode in Expo Go (no backend, no credentials)

```sh
pnpm dev --mocks          # or: EXPO_PUBLIC_USE_MOCKS=1 pnpm --filter @zyropay/mobile start --go
pnpm dev --mocks --tunnel # behind a VPN or on isolated Wi-Fi (needs: npm i -g @expo/ngrok)
```

`expo-dev-client` is installed, so plain `expo start` targets a development build and Expo Go cannot open its QR code. `pnpm dev` passes `--go` unless real Turnkey passkeys are configured (then `--dev-client`); override with `--dev-client`. If the camera does not pick up the QR code, open Expo Go → "Enter URL manually" and type the `exp://…` address printed above it.

Scan the QR code with Expo Go. The app answers every API call from `apps/mobile/src/api/mock/transport.ts`: contract-valid fixtures, a "Simulated data" banner and "Simulated" badges, and a labelled simulated signer instead of a passkey. Mock mode is refused when `EXPO_PUBLIC_ZYROPAY_MODE=production`.

### 2. The whole stack locally: `pnpm dev`

```sh
pnpm dev:setup            # once: writes apps/api/.dev.vars and apps/mcp/.dev.vars (git-ignored)
pnpm dev                  # API :8787 + MCP :8788 (wrangler dev) + Expo dev server
```

`pnpm dev:setup` copies the `.dev.vars.example` templates and fills in freshly generated local secrets: `INTERNAL_SERVICE_TOKEN` (shared by both workers), `DELEGATED_KEY_ENCRYPTION_KEY`, `AUDIT_IP_HASH_SALT` and `MCP_OAUTH_COOKIE_SECRET`. It also points the API at the local Docker Postgres (`DATABASE_URL=postgres://zyropay:zyropay@127.0.0.1:55432/zyropay`, `DATABASE_DRIVER=pg`). It never overwrites existing files.

`pnpm dev` then:

1. starts the local Postgres container (`zyropay-dev-pg`, data kept in a Docker volume) when the API uses it, and applies pending migrations with drizzle-kit;
2. starts the API and MCP workers with `wrangler dev`. The API binds to your LAN address so a phone can reach it; pass `--localhost` for simulators only;
3. starts Expo, pointed at the local API with **no mock transport**:
   - **Turnkey configured on both sides** (`TURNKEY_*` in `apps/api/.dev.vars`, plus `EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID`, `EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID` and `EXPO_PUBLIC_PASSKEY_RP_ID` in `apps/mobile/.env`): real passkeys. This needs a development build (step 4).
   - **No Turnkey** (the default after `dev:setup`): the API uses `MockTurnkey`, and the app signs with the development `dev-*` passkey (`EXPO_PUBLIC_DEV_PASSKEY=mock-turnkey`). MockTurnkey accepts it and auto-provisions a sub-org with one Solana, one EVM and one Cardano account. This works in Expo Go. Chain, prices, portfolio and push use the `Mock*` adapters (`ZYROPAY_USE_MOCK_ADAPTERS=true` in `apps/api/wrangler.jsonc`), and everything is labelled simulated. Autonomous mode and recovery-phrase export need real Turnkey, so they are refused here.
   - **No local secrets**: the app falls back to the mock transport and tells you to run `pnpm dev:setup`.

Flags: `--mocks` (force the mock transport), `--no-mobile` (workers only), `--localhost`, `--web` (real mode in the browser, §2b).

Connect an agent to the local MCP server (for example in Claude Code: `claude mcp add --transport http zyropay http://localhost:8788/mcp`). The authorize page shows a code: enter it in the app under Agents → Connect, pick wallets and networks, and approve.

### 2b. Real mode in the browser: `pnpm dev --web` (web app / PWA, testnets)

```sh
pnpm dev --web                          # API (mocks off) + MCP + Expo web on http://localhost:8081
ZYROPAY_WEB_PORT=8085 pnpm dev --web    # when 8081 is taken (for example by Expo Go's dev server)
pnpm dev --web --no-mobile              # workers only
```

No mocks anywhere: a real passkey in your browser, a real Turnkey sub-organization per user, real testnet balances.

- **API:** `wrangler dev --env-file apps/api/.dev.vars.web`. That file is regenerated on every run (git-ignored, mode 600) from `apps/api/.dev.vars`. Every secret left empty there is filled from the repo-root `.env.local`: `DATABASE_URL`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `HELIUS_API_KEY`, `HELIUS_API_KEY_SECONDARY`, `HELIUS_API_KEYS`, `ALCHEMY_API_KEY`, `BLOCKFROST_PROJECT_ID_PREPROD` and `COINGECKO_API_KEY`. It sets `ZYROPAY_USE_MOCK_ADAPTERS=false`, keeps `ZYROPAY_MODE=development` (testnets only: Solana devnet, Ethereum Sepolia, Base Sepolia, Cardano preprod when `BLOCKFROST_PROJECT_ID_PREPROD` is set), sets `DATABASE_DRIVER=neon` and sets `CORS_ALLOWED_ORIGINS` to the web origin. `apps/api/.dev.vars` itself is not touched, so plain `pnpm dev` keeps MockTurnkey and Expo Go. The script prints which variable names it filled, never values. It stops if Turnkey, Helius, Alchemy or the database is missing.
- **Web app:** `expo start --web` with `EXPO_PUBLIC_USE_MOCKS=0`, the API at `http://localhost:8787`, `EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID` and `EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID` from `.env.local` (public ids), and `EXPO_PUBLIC_PASSKEY_RP_ID=localhost`. WebAuthn allows plain http only on `localhost`, so open `http://localhost:8081`, not `127.0.0.1` and not a LAN IP.
- **Turnkey:** the parent-org org id must match on both sides. The Auth Proxy's **Allowed Origins** must include `http://localhost:8081` (or your `ZYROPAY_WEB_PORT`); see `docs/DEPLOY.md` §3.
- **Signing on the web** (`apps/mobile/src/lib/turnkey/web-signer.ts`, loaded lazily by `TurnkeyBridge.web.tsx`): `@turnkey/core` 2.12.2, the same core the native Wallet Kit wraps. Sign-up and login use the Auth Proxy (no ZyroPay backend, no Turnkey secret in the browser). Every send, approval, wallet creation, import, export and policy envelope is stamped with the passkey (`X-Stamp-Webauthn`). Only the read-only whoami behind `POST /v1/auth/session` uses Turnkey's session key, a non-extractable P-256 key in IndexedDB. `web-requests.test.ts` runs the web stamper's output through the API's own verifiers.
- **Web storage:** the ZyroPay session tokens live in `sessionStorage` (this tab only, gone when it closes; a new tab means a new passkey login). Preferences live in `localStorage`. Browsers cannot block screenshots, so the export and import screens show a warning instead.

Checks you can run against it:

```sh
node scripts/verify-real.mjs                                     # Turnkey parent-org whoami + API /health (mocks:false)
node apps/mobile/scripts/web-e2e.mjs --url http://localhost:8081 # Chromium + CDP virtual authenticator: REAL sign-up,
                                                                 # onboarding, portfolio, watch-address reads, sign-out, login
E2E_REAL_URL=http://localhost:8081 pnpm --filter @zyropay/mobile test:web:real   # the same real passkey path as a Playwright test
pnpm health --api http://localhost:8787 --mcp http://localhost:8788 --web http://localhost:8081   # docs/MONITORING.md
```

### 2c. Cross-browser web E2E: `pnpm test:web`

```sh
pnpm --filter @zyropay/mobile exec playwright install chromium webkit firefox   # once
pnpm test:web                                  # 3 engines x 3 viewports, mock mode, ~3-5 min
E2E_WEB_REBUILD=1 pnpm test:web                # re-export the web build first (after app changes)
pnpm --filter @zyropay/mobile test:web --project webkit-iphone   # one engine and size
```

`apps/mobile/e2e-web/` (Playwright 1.64). The server (`e2e-web/server.mjs`) exports the app once in mock mode into `e2e-web/.build` and serves it like the static host (SPA fallback). Projects: `chromium|webkit|firefox` x `iphone` (393x852, touch) | `android` (412x915, touch) | `desktop` (1440x900). The journey covers onboarding, home, wallets (create, watch with per-chain validation, import), send, receive, approvals (press-and-hold approve, reject), agents (connect with a code, policy editor), plugins, settings (dark mode) and the dark colour scheme, plus keyboard focus, the desktop column and number/date formatting. On every screen it passes it asserts no horizontal overflow, no touch target under 24 px and (on phones) no text field under 16 px, and it fails on any uncaught page error.

Real passkeys run only on Chromium (`chromium-real-passkey`, needs `E2E_REAL_URL`): WebKit and Firefox have no WebAuthn automation API (CDP `WebAuthn.*` is Chromium-only), so their passkey path has to be checked by hand on devices. The test also asserts that the lazy Turnkey chunk is not loaded on the first page. CI runs the mock journey as the `web-e2e` job.

`web-e2e.mjs` creates one real (test) sub-organization in your Turnkey org per run, with the user name `zyropay-e2e-<date>` (`--name` overrides it). Without `--persist`, its passkey exists only in that run's virtual authenticator, so the sub-org cannot be used again afterwards. The script prints the sub-org id and saves screenshots to `apps/mobile/screenshots/real-web/`.

**Reusing one test user across runs (`--persist <file>`).** The virtual passkey is a normal WebAuthn credential whose private key Chromium can export, so a test user can outlive the run:

```sh
STAGING="--url https://app.zyropay.online --api https://api.zyropay.online"
# once: real sign-up + onboarding; the credential is saved right after sign-up
node apps/mobile/scripts/web-e2e.mjs $STAGING --name zyropay-e2e-money --persist .secrets/e2e-passkey-staging.json
# later: log in as the same user in a fresh browser, read /v1/wallets and /v1/portfolio
node apps/mobile/scripts/web-e2e.mjs $STAGING --persist .secrets/e2e-passkey-staging.json [--keep-open 600]
# REAL testnet send of the native asset through the UI (Send -> review -> passkey -> status)
node apps/mobile/scripts/web-e2e.mjs $STAGING --persist .secrets/e2e-passkey-staging.json \
  --send solana-devnet --to <address> --amount 0.01          # or ethereum-sepolia / base-sepolia
```

With `--send`, the run fails unless the submitted sign request carries a passkey stamp (`X-Stamp-Webauthn`), the status screen reaches "Payment confirmed" within 3 minutes and `GET /v1/transactions` lists the transaction as `confirmed`.

- **File missing:** the full sign-up run (no watch wallets are created). Right after sign-up the credential is exported with CDP `WebAuthn.getCredentials` (`credentialId`, `rpId`, `privateKey`, `userHandle`, `signCount`) and written with the ZyroPay user id, the Turnkey sub-org id and, after onboarding, the wallet addresses.
- **File present:** login only. A new virtual authenticator gets the credential back with `WebAuthn.addCredential`, the app logs in, the run checks that the session belongs to the saved sub-org, walks the onboarding screens again if this browser has not seen them (onboarding progress is per browser, in `localStorage`), then reads wallets and portfolio. `--keep-open <s>` leaves the signed-in page open.
- After each run the credential is exported again, so the stored `signCount` keeps increasing. The file is refused when its `rpId` is not the `--url` host (passkeys are bound to the rpId, §6.5 of `docs/DEPLOY.md`).
- `.secrets/` is git-ignored; the directory is mode 700 and the file 600. The file holds the passkey's **private key**, which controls that sub-org's (testnet) wallets: never commit it, paste it or print it. The script logs only the first characters of the credential id. Deleting the file makes the sub-org unreachable.

The credential of a test user created this way lives only in the local `.secrets/e2e-passkey-staging.json` of the machine that created it.

### 3. Running the workers by hand

```sh
pnpm db:local                                   # Postgres in Docker + migrations (down | reset)
pnpm --filter @zyropay/api dev                  # wrangler dev on :8787, reads apps/api/.dev.vars
pnpm --filter @zyropay/mcp dev -- --port 8788 --inspector-port 9230
curl localhost:8787/cdn-cgi/local/scheduled     # run the cron (expiry sweeper, re-polls) once
```

- **Database driver.** Neon's serverless driver speaks WebSockets to Neon only. For a plain Postgres, set `DATABASE_DRIVER=pg`: node-postgres over workerd TCP sockets, allowed in development only. Any Postgres works; with Docker, `pnpm db:local` is the shortest path.
- **Worker to worker.** Locally, the workers call each other through `API_INTERNAL_URL` (MCP → API) and `MCP_INTERNAL_URL` (API → MCP, agent revocation pushes). Deployed, they use service bindings.
- **Queues and cron.** Miniflare runs the API's queue (`zyropay-api-jobs`: signing, broadcast, confirmation, push) inside `wrangler dev`. Cron triggers only run when you call `/cdn-cgi/local/scheduled`.

### 4. Development build with real passkeys (EAS)

Passkeys need the native Turnkey/passkey modules and an associated domain, so Expo Go cannot run them.

1. Configure Turnkey (see [Turnkey setup](#turnkey-setup)) and host `apple-app-site-association` and `assetlinks.json` on the relying-party domain. Templates are in `apps/mobile/well-known/`.
2. In `apps/mobile/.env`, set `EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID`, `EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID`, `EXPO_PUBLIC_PASSKEY_RP_ID` and, for push, `EXPO_PROJECT_ID`.
3. Set the build-time values for `app.config.ts`: `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE_NAME`, `EXPO_OWNER` and `EXPO_PROJECT_ID`.
4. Build and install:

   ```sh
   cd apps/mobile
   eas build --profile development --platform ios        # or android; development-simulator for the iOS simulator
   ```

5. Put the same parent organization in `apps/api/.dev.vars` (`TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`), then run `pnpm dev` and open the project in the development build.

### 5. Neon (the hosted database)

Staging uses Neon project `zyropay-online` (`icy-hill-73941166`), branch `main`, region `aws-eu-central-1` (docs/DEPLOY.md §6). `neon deploy` / `neon env pull` write the credentials into the git-ignored `.env.local`:

- `DATABASE_URL`: the **pooled** endpoint (`-pooler` host). Application traffic: the API's `@neondatabase/serverless` driver (WebSockets, interactive transactions and `FOR UPDATE`).
- `DATABASE_URL_UNPOOLED`: the **direct** endpoint. Migrations only. PgBouncer in transaction mode breaks session state, so drizzle-kit must not use the pooled one.

```sh
neon env pull       # refresh .env.local after changing branches or credentials
pnpm db:migrate     # apply pending migrations over DATABASE_URL_UNPOOLED (refuses a -pooler host)
pnpm dev:setup      # with .env.local present, writes apps/api/.dev.vars with the Neon DATABASE_URL and DATABASE_DRIVER=neon
```

drizzle-kit records applied migrations in `drizzle.__drizzle_migrations`. To change the schema: edit `infrastructure/database/src/schema.ts`, run `pnpm --filter @zyropay/db db:generate`, commit the new migration, then `pnpm db:migrate`. Never edit an existing migration. CI runs `drizzle-kit check` plus a drift check. Prefer a Neon branch (`neon checkout <name>`, auto-expires after 7 days per `neon.ts`) for risky schema work.

Production hosting note: Neon's guidance for Cloudflare Workers is node-postgres through Cloudflare Hyperdrive. The API keeps the Neon serverless driver (supported on Workers, proven by the smoke test below); evaluate Hyperdrive when the Cloudflare account exists.

### 6. The end-to-end smoke test

```sh
pnpm smoke                                       # Docker, or:
# against Neon on the production driver (creates and drops a throwaway database):
#   set -a; . ./.env.local; set +a
#   SMOKE_DATABASE_URL="$DATABASE_URL_UNPOOLED" SMOKE_DATABASE_DRIVER=neon pnpm smoke
SMOKE_DATABASE_URL=postgres://user:pass@host:5432/postgres pnpm smoke   # role needs CREATEDB
```

`tests/integration/e2e-smoke` creates a throwaway database and applies the migrations with drizzle-kit. It starts both workers under `wrangler dev` on free ports with throwaway secrets, Mock adapters and MockTurnkey. Then it plays every party over real HTTP:

1. the app creates a session with a `dev-*` passkey;
2. an agent connects through MCP OAuth with the official MCP SDK client (discovery, DCR, PKCE) while the app claims and approves the code;
3. the app enables spending (Always Ask);
4. the agent calls `get_balance`, then `send` (which waits for approval);
5. the app sees the approval and approves it with the mock passkey stamp;
6. the queue signs, broadcasts and confirms, and `get_approval_status` reports `CONFIRMED`;
7. the approval push carried the shared `PushData`.

Everything is torn down at the end. Worker logs are kept, with their path printed, when a step fails. CI runs it against its Postgres service.

## Environment

1. `cp .env.example .env` for tooling such as drizzle-kit. `.env.example` lists every variable.
2. Worker secrets go in `apps/<worker>/.dev.vars` (git-ignored, `KEY=value`). `pnpm dev:setup` creates both files.
3. App variables go in `apps/mobile/.env` (Expo inlines `EXPO_PUBLIC_*` into the bundle, so never put secrets there).
4. Non-secret worker vars belong in `wrangler.jsonc`.
5. In deployed environments, set every secret with `wrangler secret put NAME`.

## Which credential unlocks which feature

Nothing below is needed for mock mode or for `pnpm dev` with MockTurnkey. Each row is what changes once you add it.

| Credential (env vars)                                                                                                                                          | Unlocks                                                                                                                      | Without it                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Postgres (`DATABASE_URL`, `DATABASE_DRIVER`)                                                                                                                   | Every API route except `/health`                                                                                             | API answers 503 except `/health`; the app can only use the mock transport                             |
| `INTERNAL_SERVICE_TOKEN` (both workers), `MCP_OAUTH_COOKIE_SECRET`                                                                                             | The MCP worker and agent connections                                                                                         | MCP refuses to start                                                                                  |
| `DELEGATED_KEY_ENCRYPTION_KEY`                                                                                                                                 | Autonomous mode (delegated signer keys encrypted at rest)                                                                    | `POST /v1/delegated-signer` answers 403; Always Ask only                                              |
| Turnkey parent org (`TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`) + app `EXPO_PUBLIC_TURNKEY_*`, `EXPO_PUBLIC_PASSKEY_RP_ID` | Real sign-up/login with passkeys, real signatures, autonomous mode (delegated user + policy envelope created by the passkey) | MockTurnkey (`dev-*` credentials, development only)                                                   |
| Relying-party domain + `APPLE_TEAM_ID` / Android SHA-256                                                                                                       | Passkeys on device (associated domains)                                                                                      | Passkey prompts fail                                                                                  |
| `HELIUS_API_KEY`, `ALCHEMY_API_KEY` (with `ZYROPAY_USE_MOCK_ADAPTERS=false`)                                                                                   | Real balances, history, transaction building and broadcast on devnet/Sepolia (mainnet in production)                         | Mock chain adapters (simulated)                                                                       |
| `HELIUS_API_KEY_SECONDARY`, `HELIUS_API_KEYS` (comma-separated)                                                                                                | Helius key failover (below)                                                                                                  | One key: a spent plan (429 "max usage reached") fails every Solana read and send                      |
| `SENTRY_DSN_API`, `SENTRY_DSN_MCP`, `EXPO_PUBLIC_SENTRY_DSN`                                                                                                   | Error monitoring, strictly scrubbed (`docs/MONITORING.md`)                                                                   | Sentry off                                                                                            |
| `BLOCKFROST_PROJECT_ID_PREPROD` (development) / `BLOCKFROST_PROJECT_ID_MAINNET` (production)                                                                   | Cardano balances, history, sends and confirmations (ADR-002)                                                                 | Cardano is not served (requests fail `NETWORK_NOT_SUPPORTED`, balances omit it)                       |
| `COINGECKO_API_KEY` (+ `VALUE_TESTNETS_AT_MAINNET_PRICES`, default `true` in development)                                                                      | USD valuations for policy limits and the price-history chart (testnet assets only through the labelled mainnet-price proxy)  | Testnet valuations are absent: every agent payment needs approval; chart shows "unavailable"          |
| `HELIUS_WEBHOOK_SECRET`, `ALCHEMY_WEBHOOK_SIGNING_KEY`                                                                                                         | Incoming-payment and confirmation webhooks                                                                                   | Webhooks refused; confirmations come from RPC polling                                                 |
| `JUPITER_API_KEY`                                                                                                                                              | Swaps (Solana mainnet only) and Solana prices                                                                                | No swaps; Solana prices on the keyless tier. Test networks never swap (`SWAP_UNAVAILABLE_ON_NETWORK`) |
| `X402_CAPS`                                                                                                                                                    | x402 payments for the listed assets                                                                                          | Every x402 payment refused                                                                            |
| `TRANSAK_API_KEY`, `TRANSAK_API_SECRET`, `TRANSAK_WEBHOOK_SECRET`                                                                                              | On-ramp quotes and checkout (staging in development)                                                                         | On-ramp endpoints refuse                                                                              |
| `EXPO_PROJECT_ID` (+ optional `EXPO_ACCESS_TOKEN`)                                                                                                             | Push notifications to real devices                                                                                           | No push; the app polls approvals every 15 s                                                           |

### Helius key failover

Helius keys are tried in order: `HELIUS_API_KEY`, `HELIUS_API_KEY_SECONDARY`, then `HELIUS_API_KEYS` (comma-separated, duplicates dropped). Each must look like a Helius key (letters, digits, dashes); the API refuses to start otherwise and names the variable, never the value. Any one key is enough to start.

Every Helius request (Solana RPC for building, broadcasting and confirming, DAS `getAssetsByOwner`, `getTransactionsForAddress`, and the x402/Jupiter/Kamino Solana RPC) goes through a failover fetch (`packages/blockchain/src/key-failover.ts`, wired in `apps/api/src/providers.ts`). When a key answers:

| Answer                                       | Treated as        | That key rests for                     |
| -------------------------------------------- | ----------------- | -------------------------------------- |
| 429 with "max usage reached" (credits spent) | `quota_exhausted` | 1 hour                                 |
| 429 otherwise                                | `rate_limited`    | 10 s, or `Retry-After` (at most 5 min) |
| 401 / 403                                    | `unauthorized`    | 15 minutes                             |

the same request (same method and body) is replayed at once with the next available key, and later requests skip the resting key until its cooldown ends. When every key rests, the one whose cooldown ends first is tried once and the provider's error goes back to the caller (`RATE_LIMITED`, retried by the normal backoff). Other errors (5xx, JSON-RPC errors) are the node's answer and do not switch keys.

**Scope of the cooldown:** plain memory of the worker isolate (the pool is cached per isolate, because the API rebuilds its dependencies per request). Other isolates, other locations and every cold start do not share it, so each of them spends one extra round trip per resting key before it learns. That costs latency, never a wrong answer, so no KV or Durable Object is involved. Concurrent requests that start before the first failure is recorded can each hit the resting key once.

Keys never appear in logs or errors: `helius.key_failover` warnings carry only the key's index (`keyIndex`, `keyCount`), the status, the reason and the cooldown, and the logger also masks `api-key=` values and Alchemy `/v2/<key>` paths in any string. Tests: `packages/blockchain/src/__tests__/key-failover.test.ts` (stubbed fetch) and `apps/api/test/integration/providers.test.ts`. Live: `LIVE_TESTS=1 pnpm --filter @zyropay/blockchain test:live:helius` with both keys in the environment (read-only devnet calls).

## Credentials to obtain

None of these are in the repo. Each one must be created by the team in the provider's console.

| Credential                                                                                                                   | Where                            | Env vars                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Turnkey parent organization, API key pair, Auth Proxy config                                                                 | dashboard.turnkey.com            | `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_AUTH_PROXY_CONFIG_ID` |
| Passkey relying-party domain, with `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` hosted on it | your domain                      | `PASSKEY_RP_ID`, `PASSKEY_ALLOWED_ORIGINS`                                                                     |
| Apple Developer Team ID and bundle id                                                                                        | developer.apple.com              | `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`                                                                               |
| Android signing-cert SHA-256 (EAS credentials or Play App Signing)                                                           | Play Console / `eas credentials` | `ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_CERT_FINGERPRINTS`                                                     |
| Expo account and EAS project                                                                                                 | expo.dev                         | `EXPO_OWNER`, `EXPO_PROJECT_ID`, `EXPO_ACCESS_TOKEN` (optional)                                                |
| Neon project                                                                                                                 | console.neon.tech                | `DATABASE_URL`                                                                                                 |
| Helius (a second account or plan for failover is recommended)                                                                | helius.dev                       | `HELIUS_API_KEY`, `HELIUS_API_KEY_SECONDARY`, `HELIUS_WEBHOOK_SECRET`                                          |
| Blockfrost: one "Cardano preprod" and one "Cardano mainnet" project                                                          | blockfrost.io                    | `BLOCKFROST_PROJECT_ID_PREPROD`, `BLOCKFROST_PROJECT_ID_MAINNET`                                               |
| Alchemy (Ethereum and Base, mainnet and Sepolia)                                                                             | alchemy.com                      | `ALCHEMY_API_KEY`, `ALCHEMY_WEBHOOK_SIGNING_KEY`                                                               |
| CoinGecko                                                                                                                    | coingecko.com/api                | `COINGECKO_API_KEY`                                                                                            |
| Jupiter                                                                                                                      | portal.jup.ag                    | `JUPITER_API_KEY`                                                                                              |
| Transak (staging/sandbox)                                                                                                    | transak.com partner dashboard    | `TRANSAK_API_KEY`, `TRANSAK_API_SECRET`, `TRANSAK_WEBHOOK_SECRET`                                              |
| Sentry (`docs/MONITORING.md`), PostHog                                                                                       | sentry.io, posthog.com           | `SENTRY_DSN_API`, `SENTRY_DSN_MCP`, `EXPO_PUBLIC_SENTRY_DSN`, `POSTHOG_*`                                      |

Generate these yourself, each as 32 random bytes in base64 (`openssl rand -base64 32`). `pnpm dev:setup` does it for local development:

- `INTERNAL_SERVICE_TOKEN`
- `DELEGATED_KEY_ENCRYPTION_KEY`
- `MCP_OAUTH_COOKIE_SECRET`
- `AUDIT_IP_HASH_SALT`

There is no token-signing secret: app session tokens and MCP OAuth tokens are opaque random values stored only as hashes.

## Turnkey setup

Status: the parent org exists and its API key is verified (`node scripts/verify-real.mjs`: whoami succeeds; the key belongs to the org's "Auth Proxy User"). The Auth Proxy config works from `http://localhost`.

1. Create the parent org. Then create an API key for the API worker; this key needs read access only.
2. Enable the Auth Proxy with the passkey auth method and copy the config id. Set **Allowed Origins** to the exact web origins (`docs/DEPLOY.md` §3).
3. Passkeys: web builds use `EXPO_PUBLIC_PASSKEY_RP_ID` = the site's host (`localhost` in development). Native builds use `PASSKEY_RP_ID` and need the association files hosted on that domain.
4. Check your plan's policy limit. Free, Pay-as-you-go and Pro allow 5 policies per organization (see ADR-001). The autonomous-mode envelope uses up to 3.

## Conventions

- **TypeScript:** strict, with `noUncheckedIndexedAccess`. Internal packages export their TypeScript source directly (`"exports": "./src/index.ts"`), and bundlers (Wrangler, Metro, Vitest) compile it.
- **Dependency versions:** add new dependencies to `catalog:` in `pnpm-workspace.yaml` and reference them as `"catalog:"`.
- **Contract changes:** changes to `packages/shared` and `infrastructure/database` need coordinator approval (`ARCHITECTURE.md` §5). Regenerate `docs/API.md`/`docs/MCP.md` with `pnpm --filter @zyropay/shared docs:generate`.
