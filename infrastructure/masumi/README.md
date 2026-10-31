# Masumi registration: Cardano Address Intelligence on preprod

This directory makes our seller a **registered Masumi agent** that anyone on **Sokosumi** can hire. The seller is the Cloudflare Worker at https://address-intel.zyropay.online.

What you get:

- an on-chain registry entry (an NFT under the Masumi V2 registry policy) with an `agentIdentifier`;
- a price of 1 tUSDM per report, paid into the Masumi V2 escrow;
- a public MIP-003 API that Sokosumi calls.

Everything runs on Cardano **Preprod**, so no real money moves.

```
Sokosumi marketplace / any Masumi buyer
        |  MIP-003: /availability /input_schema /start_job /status
        v
masumi-agent.zyropay.online    (apps/sokosumi-agent/mip003, Cloudflare)
        |  3 payment routes only, wallet-scoped key
        v
https://<random>.trycloudflare.com -> gateway -> Masumi Payment Service 0.29.0   (this directory, Docker)
        |  signs terms, submits result hashes, collects the escrow
        v
Cardano preprod (Blockfrost)
```

The Sokosumi **Coworker** path uses the same registration for paid Tasks. It is described in `apps/sokosumi-agent/README.md`. That worker reaches the Payment Service on `127.0.0.1` and needs neither the tunnel nor the Worker.

## Why this design (options evaluated)

| Option                                                                                | Verdict                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Own Payment Service, official Docker quickstart (chosen)**                          | This is the documented registration path: `POST /registry` mints the NFT from our selling wallet. The same node must also sign the escrow terms for every hire (`POST /payment`) and submit the result hash (`POST /payment/submit-result`). A paid listing needs the node anyway, so registration through it costs nothing extra. |
| Mint the registry NFT directly (`smart-contracts/registry-v2`, permissionless policy) | Possible, but it saves nothing. Without a Payment Service nobody can pay the agent, because MIP-003 `start_job` must return node-signed terms. You would also have to reproduce the registry metadata standard by hand. The contract README says indexers trust entries minted through the operator API.                           |
| Railway template (hosted Payment Service)                                             | **Fallback.** It gives a stable public URL with no Docker and no tunnel, but needs a Railway account. Set `MPS_URL` and `PUBLIC_MPS_URL` to its URL and skip `docker compose`. The scripts work unchanged; the Railway variables hold its `ADMIN_KEY`.                                                                             |
| Masumi as a Service (app.masumi.network)                                              | Requires KYC/KYB. Too slow for the hackathon.                                                                                                                                                                                                                                                                                      |
| MIP-003 inside `apps/seller`                                                          | Rejected because another workstream owns the seller. A separate Worker keeps the x402 seller untouched and reuses its report code (`apps/seller/src/report.ts` through `apps/sokosumi-agent/report.mjs`). **The seller needs no change.**                                                                                          |

Facts checked in the sources (Payment Service 0.29.0, Sokosumi `apps/core`, Registry Service health check):

- **Price.** The Sokosumi catalog shows a V2 agent only with **Fixed** pricing in a unit it can bill (tUSDM on preprod). Dynamic-priced V2 agents stay hidden. With Fixed pricing the node rejects `RequestedFunds`, so `paid-task.mjs` and `agent-api.mjs` now omit it for Fixed registrations.
- **Online status.** The registry marks an entry `Online` when `GET {apiBaseUrl}/availability` returns HTTP 200 JSON with `type: "masumi-agent"` and does not redirect. The Worker deliberately omits `agentIdentifier` there: a registry update re-mints the asset, and a stale identifier would mark the entry `Invalid`.
- **Preprod listing.** On preprod, new agents appear automatically when Sokosumi's `SHOW_AGENTS_BY_DEFAULT` is on (the docs say they do). Mainnet needs Masumi's whitelisting form.
- **Hashes.** MIP-004 hashes: input `sha256(nonce;JCS(input_data))` and output `sha256(nonce;raw result)`.
- **Deadlines.** The node requires `submitResultTime >= now+15 min`, `unlock >= submit+15 min` and `dispute >= unlock+15 min`. We use +10/+20/+36/+52 min.

## What you must do yourself

| Item                            | Details                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Desktop                  | Compose v2.20 or newer. The Payment Service image is amd64-only; Docker Desktop on Apple silicon emulates it.                                                                                                                                                                                                                                                                                             |
| Blockfrost preprod key          | Free at https://blockfrost.io. The seller's existing preprod project id works.                                                                                                                                                                                                                                                                                                                            |
| **tADA for the selling wallet** | **At least 10 tADA, 100 recommended.** It pays the mint fee and the NFT's min-UTxO (~2 ADA, which stays in the wallet), plus fees and collateral for result submissions. Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet (choose Preprod, then paste the address; it gives about 10,000 tADA). Alternative: https://dispenser.masumi.network (needs the code from its registration email). |
| tUSDM                           | **None** needed to sell: buyers pay into escrow. You only need it to buy from your own purchasing wallet, which is optional (dispenser).                                                                                                                                                                                                                                                                  |
| Wallet mnemonics                | The first start prints them once (`docker logs zyropay-masumi-payment-setup`). On this machine they are saved, never printed, in `.local/wallet-mnemonics.env` (mode 600, gitignored): `docker logs zyropay-masumi-payment-setup > .local/setup.log`, keep only the two `*_MNEMONIC=` lines, delete the log.                                                                                              |
| Cloudflare                      | Wrangler is already logged in on this machine (the seller deploys from it). Deploying the MIP-003 Worker is your action.                                                                                                                                                                                                                                                                                  |
| Sokosumi account + credits      | Needed only to hire the agent yourself from the catalog. Top up preprod credits with the Stripe test card `4242 4242 4242 4242` (any future date and CVC).                                                                                                                                                                                                                                                |

Everything else is scripted: health and balance checks, creating a wallet-scoped key, registration, polling until the `agentIdentifier` exists, the Coworker state files and the Worker secrets.

## Runbook (about 30-40 minutes, mostly waiting)

Run every `pnpm` command from the repo root.

1. **Configure** (2 min):

   ```sh
   cd infrastructure/masumi
   cp .env.example .env && chmod 600 .env
   ```

   Then edit `.env`:

   ```sh
   ENCRYPTION_KEY=   # paste the output of: openssl rand -hex 32
   ADMIN_KEY=        # paste the output of: openssl rand -hex 24
   BLOCKFROST_API_KEY_PREPROD=preprod...
   AGENT_AUTHOR_NAME=ZyroPay   # public identity; leave AGENT_AUTHOR_EMAIL blank
   ```

2. **Start** the services. The first build takes 5-10 minutes; later starts take seconds.

   ```sh
   docker compose up -d
   docker compose ps -a               # payment-setup "Exited (0)"; payment-service "healthy"
   docker logs zyropay-masumi-payment-setup   # SAVE the two printed mnemonics now
   ```

3. **Find and fund the selling wallet** (2-5 min):

   ```sh
   pnpm --filter @zyropay/sokosumi-agent masumi:register check
   ```

   This prints `selling wallet addr_test1...` and its balance. Send 100 tADA to that address from the faucet, then wait about a minute.

4. **Register** (5-15 min on preprod; the script polls every 20 s):

   ```sh
   pnpm --filter @zyropay/sokosumi-agent masumi:register        # = key + register + secrets
   ```

   It does the following:
   - creates a ReadAndPay key scoped to the selling wallet and saves it to `.local/mps-runtime.env`, plus a copy for the Coworker;
   - mints the registry entry;
   - prints `RegistrationConfirmed: agentIdentifier ...` and the tx link;
   - writes `apps/sokosumi-agent/docs/{payment,registration}-state.json`;
   - writes `.local/mip003.secrets.json`, including the tunnel URL from `docker logs zyropay-masumi-tunnel`.

   Rerunning it is safe. It reuses the saved key and the existing entry, and it stops instead of guessing when a write has an unknown outcome.

5. **Deploy the MIP-003 Worker and its secrets** (1-2 min):

   ```sh
   pnpm --filter @zyropay/sokosumi-agent mip003:deploy
   pnpm --filter @zyropay/sokosumi-agent mip003:secrets
   ```

6. **Check** everything:

   ```sh
   pnpm --filter @zyropay/sokosumi-agent masumi:status
   ```

   It checks the containers, the node, the balance, the registration state, the tunnel, that `/admin` is not exposed, and the Worker's `/availability`. All lines must be `ok`.

7. **Sokosumi listing.** Open https://preprod.sokosumi.com/agents and search for "Cardano Address Intelligence". Listing follows the registry health check and Sokosumi's sync, so allow a few minutes. If it is still missing after 30 minutes while `masumi:status` is all `ok`, ask a Masumi mentor (hackathon Telegram) to publish it. Their catalog admin can show agents that `SHOW_AGENTS_BY_DEFAULT` left hidden.

8. **Paid hire** (evidence for the submission):
   1. Hire the agent from the catalog with input `addr_test1...`.
   2. Sokosumi's node locks 1 tUSDM in escrow (1-2 min).
   3. The Worker sees `FundsLocked`, computes the report and submits its hash.
   4. `/status` turns `completed` once `ResultSubmitted` confirms (1-3 min more).
   5. The Payment Service collects the payout after `unlockTime` (+36 min).

   Record the job, the lock tx and the result tx (`https://preprod.cardanoscan.io/address/addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`). Also record the selling wallet's tUSDM after the payout.

## Day to day

- **New tunnel URL.** The tunnel URL changes whenever the `tunnel` container restarts. The on-chain `apiBaseUrl` does not change. Run `masumi:register secrets` and then `mip003:secrets`; `masumi:status` tells you when.
- **Laptop must stay awake** while paid jobs run, because the Payment Service is local. If the laptop is off, the Worker still answers `/availability`, so the listing stays Online. `start_job` then answers HTTP 424 before any payment: the dead tunnel returns 530, or the gateway returns 503 when the node is down. Sokosumi reads a 4xx as "no job accepted" and refunds the credits. A timeout after the request was sent is reported as 500 (outcome unknown), so it is never retried blindly.
- **Changing metadata.** Payment Service 0.29 has `POST /api/v1/registry/update` for V2 entries. It re-mints with a new version, which gives a new `agentIdentifier`. Afterwards rerun `secrets` and `mip003:secrets`. Deregistration is in the admin UI at http://127.0.0.1:3001/admin.
- **Optional local Registry Service:** `docker compose --profile registry up -d` (http://127.0.0.1:3000/docs). It is not needed: Sokosumi reads the public Masumi registry.
- **Stop or reset.** `docker compose down` keeps all data. `docker compose down -v` **deletes the wallets**; do it only with the mnemonics saved.

## Why a gateway

A quick tunnel straight to the Payment Service would publish its admin UI and every admin route. The only protection would be `ADMIN_KEY`. The gateway (`gateway/gateway.mjs`, no dependencies) instead forwards only:

- `GET /api/v1/health`
- `POST /api/v1/payment`
- `POST /api/v1/payment/resolve-blockchain-identifier`
- `POST /api/v1/payment/submit-result`

Everything else answers 404. The Worker authenticates with the wallet-scoped key (`canAdmin: false`), and `ADMIN_KEY` never leaves the laptop.

## Files

| File                        | What it is                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`        | The official quickstart (commit `9b48523`, Payment Service 0.29.0 pinned by digest, Postgres 15.19), plus the gateway and the tunnel (`cloudflared` 2026.10.0). |
| `.env.example`              | Compose and script settings.                                                                                                                                    |
| `scripts/register-agent.ts` | `all` (default), `check`, `key`, `register` and `secrets`.                                                                                                      |
| `scripts/status.ts`         | The read-only end-to-end status.                                                                                                                                |
| `scripts/lib.ts`            | The registration body (V2, Fixed tUSDM), the node client, and pure helpers (tests: `apps/sokosumi-agent/masumi-lib.test.ts`).                                   |
| `gateway/gateway.mjs`       | The allow-list proxy (tests: `apps/sokosumi-agent/masumi-gateway.test.mjs`).                                                                                    |
| `.local/` (gitignored)      | `registration.json` (resumable state), `mps-runtime.env` and `mip003.secrets.json`, all mode 600.                                                               |

Tests run with the agent package: `pnpm --filter @zyropay/sokosumi-agent test`.

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build fails at `apt-get update` with `Hash Sum mismatch` | A Debian mirror or network proxy served a stale index (seen 2026-10-30). Rerun `docker compose up -d`; the second attempt succeeded.                                                                  |
| `payment-setup` exited 1                                 | `docker logs zyropay-masumi-payment-setup`. The usual cause is a missing or invalid Blockfrost key. Fix `.env`, then run `docker compose up -d` again (it seeds only an empty database).              |
| `No Preprod Web3CardanoV2 payment source`                | The seed did not run. See the line above.                                                                                                                                                             |
| `STOP the selling wallet holds 0 tADA`                   | Fund the printed address and wait about 1 minute.                                                                                                                                                     |
| `RegistrationFailed`                                     | The node's error text is printed. Usually the wallet is underfunded or a UTxO is still pending. Delete the entry in the admin UI, remove `registrationId` from `.local/registration.json`, and rerun. |
| `STOP a previous ... write has an unknown outcome`       | The node may have accepted it. Look in the admin UI (API keys / AI Agents), then remove the named `...Pending` flag from `.local/registration.json`.                                                  |
| Catalog shows the agent but hiring fails                 | Run `masumi:status`. Then `wrangler tail cardano-address-intel-masumi` (run it inside `apps/seller` with `--config ../sokosumi-agent/mip003/wrangler.jsonc`). The usual cause is a stale tunnel URL.  |
| `/availability` says `Not configured: ...`               | Run `mip003:secrets`. Secret changes apply immediately, with no redeploy.                                                                                                                             |

Verified live on preprod (2026-10-30; hashes in `EVIDENCE.md`): the registration (agentIdentifier
`67ab0c92…8f000000`, mint tx `11dcdf21…86e9`), `masumi:status` all `ok`, and a Worker `start_job`
that reached the node through `*.trycloudflare.com` and returned signed escrow terms.

Not verified yet:

- the Sokosumi catalog listing delay;
- a paid hire through to the payout (needs a buyer with tUSDM, e.g. a Sokosumi paid Task; `apps/sokosumi-agent/NEXT_STEPS.md`).

Sokosumi's `SHOW_AGENTS_BY_DEFAULT` value on preprod is not visible from its source.
