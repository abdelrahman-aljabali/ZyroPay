---
title: "Environments and migrations"
description: "Development, staging and production, which networks each serves, how secrets are handled and how database migrations are applied."
---

| Environment | Mode (`ZYROPAY_MODE`) | Networks                                                | Where                                                 |
| ----------- | --------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Local       | `development`         | Test networks, or mocks (`--mocks`, labelled simulated) | `pnpm dev`: workers in `wrangler dev`, local Postgres |
| Staging     | `development`         | Cardano preprod, Solana devnet, Sepolia, Base Sepolia   | `*.zyropay.online`, Neon project for staging          |
| Production  | `production`          | Mainnets only; mocks and testnet keys refused           | Not deployed                                          |

Mainnet and testnet never mix: the mode decides the networks, each Blockfrost project id belongs to
one network (checked against the genesis network magic), and an id of the wrong network refuses to
start.

## Secrets

Secrets are set with `wrangler secret put … --env staging` (piped, never typed into the shell history
or committed). The API refuses to start in production without its required secrets, and `/health`
then names what is missing, by name only. `INTERNAL_SERVICE_TOKEN`, the delegated-key encryption key,
the audit IP salt and the OAuth cookie secret were generated per instance and are stored nowhere
else.

## Passkey relying party

The passkey `rpId` is `zyropay.online`, the registrable domain, so a passkey works on `app.` and in the
landing page's embed. It is chosen once: changing it would orphan every existing passkey. Passkeys
from local development or staging never work in production, by design.

## Database migrations

The schema is Drizzle (`infrastructure/database`), migrations are forward-only SQL files. Staging has
`0000` to `0007` (x402 delivery, escrow, Masumi registry are `0005` to `0007`).

```sh
pnpm db:migrate        # applies pending migrations with the DIRECT (non-pooled) URL; refuses a -pooler host
```

Run migrations **before** deploying an API version that needs them; `pnpm deploy:staging` does this
first. Never edit an existing migration: add a new one with `pnpm --filter @zyropay/db db:generate`.
Staging and production must never share a database.
