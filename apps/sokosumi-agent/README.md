# Cardano Address Intelligence on Sokosumi

This package makes our x402 seller (`apps/seller`, live at https://address-intel.zyropay.online) hireable on **Sokosumi Preprod** in two ways:

1. **Coworker** (Tasks in a Workspace, the TUM path). A local worker answers Tasks under your Vendor. No registration is needed.
2. **Registered Masumi agent** (Sokosumi catalog and any Masumi buyer). It is registered on the Masumi registry with Fixed pricing of 1 tUSDM, and its MIP-003 API is a Cloudflare Worker (`mip003/`). Setup is in `infrastructure/masumi/README.md`. The same registration also turns on **paid Coworker Tasks**.

A request such as `Report on addr_test1...` is answered with the seller's own deterministic report:

- The code is shared (`apps/seller/src/report.ts`), and the data comes from Blockfrost preprod.
- No language model decides the result. An optional model can add a short summary, labelled as model-written.

**How each path is paid:**

- **Coworker Tasks:** Sokosumi credits.
- **Paid Coworker Tasks and catalog hires:** 1 tUSDM locked in the Masumi V2 escrow through our own Payment Service.
- **x402 buyers:** they keep paying the seller Worker directly, per request.

Adapted from the official [TUM quickstart](https://github.com/masumi-network/tum-hackathon-quickstart) at commit `d93783b`. It was checked against `@masumi_network/sokosumi@1.1.0`:

- The runtime adapter imports `coworker/runtime-credentials.js`, `api/http-client.js` and `api/services/task-service.js`, and these exist with the exports used.
- These commands and flags exist in 1.1.0:
  - `tasks list|create` with `--coworker-id --organization-slug --personal --name --description --status`;
  - `runtime start|complete` with `--personal --organization-id --coworker-id --result-file`;
  - `runtime key-import --api-key-stdin`.
- `--organization-slug` is accepted by task commands only.

| File                                                                   | What it does                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.mjs`                                                           | Finds the address, fetches Blockfrost data, runs the seller's `computeReport` and formats the result. It also holds the optional summarizer and the follow-up comment routing.                        |
| `worker.mjs`, `comments.mjs`                                           | The template's continuous worker and follow-up replies. Results come from `report.mjs`.                                                                                                               |
| `doctor.mjs`                                                           | `pnpm --filter @zyropay/sokosumi-agent run doctor` runs one read-only preflight for everything below. It prints the exact fix for each failure.                                                       |
| `start.mjs`                                                            | `npm start` is the offline preflight (Node 24+, CLI 1.1.0, `.env`).                                                                                                                                   |
| `report-cli.mjs`                                                       | `npm run report -- addr_test1...` prints a result locally.                                                                                                                                            |
| `mip003/`                                                              | The MIP-003 agent API Worker (`app.mjs` holds the logic, `worker.mjs` the Durable Object). It is the registered `apiBaseUrl`. `mip003:build` runs a dry-run bundle, and `mip003:dev` runs it locally. |
| `paid-task.mjs`, `settlement.mjs`, `standard-hash.mjs`                 | The template's paid Coworker path. It now omits `RequestedFunds` when the registration is Fixed-priced.                                                                                               |
| `agent-api.mjs`, `payment-registration.mjs`, `registration-config.mjs` | The template's local agent API and registration. Superseded by `mip003/` and `infrastructure/masumi` but kept so the template's own tests still run.                                                  |
| `masumi-lib.test.ts`, `masumi-gateway.test.mjs`                        | Tests for `infrastructure/masumi` (registration body, node client, gateway allow-list).                                                                                                               |
| `task-target.mjs`, `worker-lock.mjs`, `sokosumi-runtime.mjs`           | Unchanged from the template.                                                                                                                                                                          |

## 0. Before you start (5 min)

**Status (2026-10-30):** steps 0 and 5 are done on this machine; only the interactive Sokosumi login and what follows it remain. `NEXT_STEPS.md` lists those commands in order, with the expected outputs.

You need:

- Node.js 24 or newer and pnpm;
- a Blockfrost **preprod** project id (https://blockfrost.io; the seller's works);
- a system credential vault (macOS Keychain is fine).

```sh
pnpm install                                            # repo root
cp apps/sokosumi-agent/.env.example apps/sokosumi-agent/.env
chmod 600 apps/sokosumi-agent/.env                      # then set BLOCKFROST_API_KEY_PREPROD
npm install --prefix apps/sokosumi-agent/.local/cli @masumi_network/sokosumi@1.1.0   # pinned: the worker loads 1.1.0 internals (1.0.4 calls a route preprod removed); no -g needed
export PATH="$PWD/apps/sokosumi-agent/.local/cli/node_modules/.bin:$PATH"            # in every terminal that runs sokosumi or the worker
sokosumi --version                                      # must print 1.1.0
pnpm --filter @zyropay/sokosumi-agent report -- "Report on addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen"
```

Run `pnpm --filter @zyropay/sokosumi-agent run doctor` after every step below. It never writes anything. Keep the word `run`: `pnpm doctor` on its own is a built-in pnpm command. Add `--offline` to skip the network and CLI checks.

## 1. Account and TUM Workspace (5 min, in the browser)

1. Sign up at https://preprod.sokosumi.com/signup with your own email.
2. Join the TUM Workspace: https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW. You must belong to an organization to create a Vendor.
3. In the Workspace switcher, select **Personal Workspace**. Add test credits at https://preprod.sokosumi.com/billing?tab=credits with the Stripe test card `4242 4242 4242 4242`, any future date and any CVC.

## 2. CLI login, Vendor, Coworker, key import (5 min)

```sh
sokosumi --preprod auth login                    # opens the browser
sokosumi --preprod auth whoami --json            # check it is YOUR account
sokosumi skills                                  # read once (the template asks for it)
sokosumi --preprod workspaces list --json        # the TUM organization must be listed
sokosumi --preprod vendors me --json             # reuse a Vendor where you are admin; else:
sokosumi --preprod vendors create --name "ZyroPay" --slug zyropay --json
```

Save the Vendor `id` as `VENDOR_ID`. Each account can create only one self-service Vendor. If the slug is taken, pick another one.

```sh
sokosumi --preprod coworkers register --vendor-id VENDOR_ID \
  --name "Cardano Address Intelligence" --capability tasks --personal --json
```

Save the Coworker `id` as `COWORKER_ID`. On a later run, reuse it with `coworkers connect COWORKER_ID --vendor-id VENDOR_ID --personal --json`; do not register a second one.

Import the worker key **once**. The key goes into the CLI vault; never put it in `.env`:

```sh
sokosumi --preprod coworkers api-key COWORKER_ID --json |
  sokosumi --preprod runtime key-import --coworker-id COWORKER_ID --api-key-stdin
sokosumi --preprod workspaces list --personal --json   # {"hasPersonalWorkspace": true}
```

If the import fails, fix the vault first. Creating another key will not help.

Set `COWORKER_ID=...` in `.env`. Keep `PAID_TASKS_ENABLED=false`, and leave both `SOKOSUMI_ORGANIZATION_*` blank. Then run `doctor`; every line under Local and Sokosumi must be `ok` (`warn` is fine).

## 3. Worker and first Task in the Personal Workspace (5 min)

```sh
pnpm --filter @zyropay/sokosumi-agent worker     # leave running; wait for "Continuous worker running"
```

This Coworker needs no model server; the template's Eve terminal is gone. Run **one** worker per Coworker, and keep the laptop awake. In a second terminal:

```sh
sokosumi --preprod tasks create --personal --coworker-id COWORKER_ID \
  --name "Address check" \
  --description "Report on addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen" \
  --status READY --json
```

Save the Task `id`. Within about 10 s the worker logs `Completed <taskId>`. Open the Task on Sokosumi: it should be `COMPLETED`, with the score, the flags and the full JSON.

Then post a follow-up comment on the Task: either `refresh` or another `addr_test1...` address. Wait for the reply; the submission checklist asks for it.

If the worker reports `grant_required`:

1. Stop the worker and approve the Vendor grant as the Personal Workspace owner.
2. Check that the Task is still `READY`.
3. Look at `.local/TASK_ID.json`. If it only holds `{"phase":"starting"}`, rename it to a backup name.
4. Restart the worker.

## 4. TUM Workspace (5 min)

Finish active Tasks first. Then:

```sh
sokosumi --preprod workspaces list --json                    # read the TUM organization id and slug
sokosumi --preprod coworkers connect COWORKER_ID --vendor-id VENDOR_ID --workspace-id ORGANIZATION_ID --json
#   -> workspaceAccess must be GRANTED; if PENDING, ask a Workspace admin to approve, then connect again
sokosumi --preprod workspaces check ORGANIZATION_ID --json   # -> "taskSeatEligible": true
```

Stop the worker. In `.env`, set **both** `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG`. Then run `doctor`, restart the worker, select the TUM Workspace on the website, check its credits, and create a Task:

```sh
sokosumi --preprod tasks create --organization-slug ORGANIZATION_SLUG --coworker-id COWORKER_ID \
  --name "TUM demo: address check" --description "Report on addr_test1..." --status READY --json
```

To go back to Personal Workspace Tasks, finish active work, clear both organization values, and restart the worker.

## 5. Registered agent and paid Tasks (about 30-40 min, mostly waiting)

Follow `infrastructure/masumi/README.md`. In short:

1. Fill in `infrastructure/masumi/.env`.
2. `docker compose up -d`, then save the mnemonics.
3. `masumi:register check`, then fund the printed selling wallet with 100 tADA.
4. `masumi:register`.
5. `mip003:deploy` and `mip003:secrets`.
6. `masumi:status`.

`masumi:register` also writes `docs/payment-state.json`, `docs/registration-state.json` and `.local/mps-runtime.env`, so paid Coworker Tasks need no manual copying. Then:

1. In `.env`, set `MPS_URL=http://127.0.0.1:3001` (the default) and `PAID_TASKS_ENABLED=true`.
2. Run `doctor`; the Masumi lines must be `ok`.
3. Restart the worker.
4. Create a Task with a valid `addr_test1...` address. A Task without a valid address is never charged.

The worker:

1. asks our Payment Service for terms;
2. posts `Payment requested: 1 test USDM.` on the Task, and Sokosumi funds the escrow from credits;
3. waits for the confirmed `FundsLocked`, runs the report and submits the result hash;
4. completes the Task;
5. after `unlockTime` (about 36 min), checks the seller's net receipt against Blockfrost (`settlement.mjs`).

If a payment write has an uncertain outcome, the journal in `.local/` stops automatic retries. Inspect it before you do anything else.

## 6. What to record for the submission

| Item                        | Where                                                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coworker ID                 | The `coworkers register` output, or `sokosumi --preprod coworkers list --scope owned --json`.                                                                                                                                      |
| Task ID and result          | The `tasks create --json` output, and the worker log `Completed <id>`. `.local/<taskId>.txt` holds the result and `.json` the completion. Take a screenshot of the Task.                                                           |
| Follow-up                   | Your comment and the agent's reply on the Task page.                                                                                                                                                                               |
| agentIdentifier and mint tx | The output of `masumi:register` and `masumi:status` (a preprod.cardanoscan.io link).                                                                                                                                               |
| Paid evidence               | The completed Task ID (or catalog job), the escrow lock tx and the result tx at the V2 escrow address, and the seller's net tUSDM receipt after unlock. A completed Task alone does **not** prove payment.                         |
| Method                      | Public Blockfrost preprod data and a code-computed score (`apps/seller/src/report.ts`). It is a caution score, not a fraud verdict: preprod only, one address per Task, and a UTxO count of 100 or more is shown as a lower bound. |

## Tests

```sh
pnpm --filter @zyropay/sokosumi-agent test
```

The tests use no network, no CLI and no keys. They cover:

- the report and address parsing;
- the outage retry;
- follow-ups and the preflight;
- the doctor (read-only commands only);
- the template's paid path, Workspace targeting and worker lock;
- Fixed vs Dynamic payment requests;
- the MIP-003 Worker: input and result hashes, idempotent `start_job`, payment only after a confirmed lock, deadline guards, uncertain submits and failure states;
- the registration body, against the Payment Service 0.29 V2 limits;
- the gateway allow-list.
