---
title: "Local development"
description: "Run ZyroPay on your machine, with mocks or against test networks, and the checks that must pass before a deploy."
---

Node 24 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev --mocks        # the app alone in Expo Go, simulated data, no credentials
pnpm dev:setup          # once: local secrets for the workers
pnpm dev                # API + MCP (wrangler dev) + Expo, against a local Postgres
pnpm dev --web          # real mode in the browser: real passkeys, Turnkey, testnet balances
```

Without Turnkey credentials, development uses `MockTurnkey`, and the app can sign with a development
passkey stand-in (refused outside development). `pnpm smoke` runs the whole agent payment flow against
the local workers and Postgres.

## Checks

| Command             | Runs                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| `pnpm check`        | Typecheck and lint, then unit and integration tests, then the workerd e2e suites |
| `pnpm test:web`     | Cross-browser web E2E (Chromium, WebKit, Firefox)                                |
| `pnpm smoke`        | The full agent payment flow locally                                              |
| `pnpm format:check` | Prettier                                                                         |
| `pnpm knip`         | Dead files, exports and dependencies                                             |

## This docs site

```sh
pnpm --filter @zyropay/docs dev          # http://localhost:4322
pnpm --filter @zyropay/docs diagrams     # re-render diagrams/*.mmd to public/diagrams (light + dark)
pnpm --filter @zyropay/docs build        # the checked production build
pnpm --filter @zyropay/docs preview      # serve dist/ with its _headers on :8788
```

Live evidence lives in `apps/docs/src/data/evidence.json`. To record a new run, fill its `txHash`
(and block, fee and checks) from the explorer; an empty hash renders as "Awaiting live run".
