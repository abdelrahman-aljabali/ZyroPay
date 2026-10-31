# Sokosumi Coworker: what is left (interactive steps only)

**Status 2026-10-31: done.** Steps 1-9 ran with Sokosumi CLI `@masumi_network/sokosumi@1.1.0`.
Vendor ZyroPay, Coworker "Cardano Address Intelligence" (`01a18f1c-3cad-735b-8b57-6623ffc2a14d`).
Free Task `01a18f1e-f20c-72df-8744-45243bbce18f` `COMPLETED`, follow-up comment answered (steps
7-8). Paid Task `01a18f20-48e5-763f-a19f-658d790699c6` (step 9): Sokosumi's lock `b786f50d…0beb`,
SubmitResult `7c9a5d87…949d`, the Payment Service's collection `a8f4a638…a22c`, net 1 tUSDM
checked; recorded in `infrastructure/masumi/EVIDENCE.md` (section 4) and on
https://docs.zyropay.online/evidence/. Only the optional TUM Workspace step is left. The steps
below are kept as the runbook for a rerun.

Everything that does not need your Sokosumi login is done:

- Sokosumi CLI `@masumi_network/sokosumi@1.1.0` is installed locally (no `-g`) in
  `apps/sokosumi-agent/.local/cli` (gitignored).
- `apps/sokosumi-agent/.env` exists (mode 600, gitignored) with the Blockfrost preprod key.
  `COWORKER_ID` is blank: step 4 fills it.
- The Masumi Payment Service runs in Docker (`infrastructure/masumi`, `docker compose ps`),
  the agent is registered on the Masumi preprod registry, and `docs/payment-state.json`,
  `docs/registration-state.json` and `.local/mps-runtime.env` are written. Details and tx
  hashes: `infrastructure/masumi/EVIDENCE.md`.
- The MIP-003 Worker is live at https://masumi-agent.zyropay.online.

Prerequisites in the browser (once, about 5 min): sign up at https://preprod.sokosumi.com/signup,
join the TUM Workspace (https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW),
switch to **Personal Workspace** and add test credits at
https://preprod.sokosumi.com/billing?tab=credits (Stripe test card `4242 4242 4242 4242`, any
future date, any CVC).

Current `doctor` state (2026-10-30): everything `ok` except `COWORKER_ID` and `not signed in`,
which steps 2-4 fix. If `doctor` or `masumi:status` says `masumi-agent.zyropay.online ... fetch
failed`, your resolver still caches the old registrar-parking answer for the new hostname
(public resolvers are correct); flush it with `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
or wait for the cache to expire.

Run every block from the **repo root**, in one terminal (the `PATH` line must come first in
every new terminal).

## 1. Put the local CLI on PATH

```sh
export PATH="$PWD/apps/sokosumi-agent/.local/cli/node_modules/.bin:$PATH"
sokosumi --version
```

Expected: `1.1.0` (an `EBADENGINE` warning about Node 24 vs 25 during install is harmless).

## 2. Log in (interactive; opens the browser)

```sh
sokosumi --preprod auth login
sokosumi --preprod auth whoami --json
sokosumi --preprod workspaces list --json
```

Expected: `whoami` shows your own account; `workspaces list` lists the TUM organization.

## 3. Vendor

```sh
sokosumi --preprod vendors me --json
```

If it lists a Vendor where you are admin, reuse its `id`. Otherwise:

```sh
sokosumi --preprod vendors create --name "ZyroPay" --slug zyropay --json
```

Expected: JSON with the Vendor `id`. Export it: `export VENDOR_ID=<id>`. One self-service
Vendor per account; if the slug is taken, use e.g. `zyropay-agents`.

## 4. Coworker

```sh
sokosumi --preprod coworkers register --vendor-id "$VENDOR_ID" \
  --name "Cardano Address Intelligence" --capability tasks --personal --json
```

Expected: JSON with the Coworker `id`. Then:

```sh
export COWORKER_ID=<id>
sed -i '' "s/^COWORKER_ID=.*/COWORKER_ID=$COWORKER_ID/" apps/sokosumi-agent/.env
```

Do not register a second Coworker later; reuse it with
`sokosumi --preprod coworkers connect "$COWORKER_ID" --vendor-id "$VENDOR_ID" --personal --json`.

## 5. Import the worker key (once; it goes into the macOS Keychain, never into `.env`)

```sh
sokosumi --preprod coworkers api-key "$COWORKER_ID" --json |
  sokosumi --preprod runtime key-import --coworker-id "$COWORKER_ID" --api-key-stdin
sokosumi --preprod workspaces list --personal --json
pnpm --filter @zyropay/sokosumi-agent run doctor
```

Expected: the import reports a verified key; `workspaces list --personal` contains
`"hasPersonalWorkspace": true`; every `doctor` line under Local and Sokosumi is `ok`
(`warn` is fine). If the import fails, fix the Keychain prompt first; creating another key
does not help.

## 6. Worker (leave it running in its own terminal)

```sh
export PATH="$PWD/apps/sokosumi-agent/.local/cli/node_modules/.bin:$PATH"
pnpm --filter @zyropay/sokosumi-agent worker
```

Expected: `Continuous worker running <pid>`. Keep the laptop awake.

## 7. Free test Task (second terminal, PATH line first)

```sh
sokosumi --preprod tasks create --personal --coworker-id "$COWORKER_ID" \
  --name "Address check" \
  --description "Report on addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen" \
  --status READY --json
```

Expected: JSON with the Task `id` (`export TASK_ID=<id>`). Within about 10 s the worker logs
`Completed <TASK_ID>`; the Task on Sokosumi is `COMPLETED` with the caution score, flags and
the full JSON report. Screenshot it.

## 8. Follow-up comment

```sh
sokosumi --preprod tasks comment "$TASK_ID" --comment "refresh" --json
sokosumi --preprod tasks events "$TASK_ID" --json
```

Expected: `comment` returns `{"event": {...}}`; within about 10 s `events` shows the agent's
reply comment with a refreshed report (any other `addr_test1...` address also works as the
comment). Screenshot the Task page.

If the worker reports `grant_required`: stop it, approve the Vendor grant as the Personal
Workspace owner, check the Task is still `READY`, rename `.local/<TASK_ID>.json` if it only
holds `{"phase":"starting"}`, restart the worker.

## 9. Paid Task (1 tUSDM through the Masumi escrow)

Stop the worker (Ctrl-C), then:

```sh
sed -i '' 's/^PAID_TASKS_ENABLED=.*/PAID_TASKS_ENABLED=true/' apps/sokosumi-agent/.env
pnpm --filter @zyropay/sokosumi-agent run doctor          # Masumi lines must be ok
pnpm --filter @zyropay/sokosumi-agent masumi:status       # all ok
pnpm --filter @zyropay/sokosumi-agent worker              # restart; "Continuous worker running"
```

Second terminal:

```sh
sokosumi --preprod tasks create --personal --coworker-id "$COWORKER_ID" \
  --name "Paid address check" \
  --description "Report on addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen" \
  --status READY --json
```

Expected, in order (about 5 min, then 36 min of waiting):

1. The Task gets the comment `Payment requested: 1 test USDM.`; Sokosumi funds the escrow from
   your credits (1-2 min).
2. The worker waits for the confirmed `FundsLocked`, runs the report, submits the result hash
   and logs `Completed <id>`.
3. After `unlockTime` (about +36 min), the Payment Service collects the payout and the worker
   checks the seller's net receipt against Blockfrost.

Record the Task id, the lock tx and the result tx at
https://preprod.cardanoscan.io/address/addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g,
and add them to `infrastructure/masumi/EVIDENCE.md`. A completed Task alone does not prove
payment. A Task without a valid `addr_test1...` address is never charged.

The Payment Service and its tunnel must keep running (`docker compose ps` in
`infrastructure/masumi`). If the tunnel container restarted, run
`pnpm --filter @zyropay/sokosumi-agent masumi:register secrets` and then
`pnpm --filter @zyropay/sokosumi-agent mip003:secrets`.

## Optional: TUM Workspace

Finish active Tasks, then:

```sh
sokosumi --preprod workspaces list --json        # TUM organization id and slug
sokosumi --preprod coworkers connect "$COWORKER_ID" --vendor-id "$VENDOR_ID" --workspace-id ORGANIZATION_ID --json
sokosumi --preprod workspaces check ORGANIZATION_ID --json   # "taskSeatEligible": true
```

`workspaceAccess` must be `GRANTED` (if `PENDING`, ask a Workspace admin). Set both
`SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` in `.env`, restart the worker and
create Tasks with `--organization-slug ORGANIZATION_SLUG` instead of `--personal`.
