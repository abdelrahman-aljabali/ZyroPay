---
title: "Deploy runbook"
description: "How ZyroPay's workers, the web app, the landing page and this docs site are deployed to Cloudflare, how to check a deployment and how to roll back."
---

Every worker's `wrangler.jsonc` has a local top level and named environments; every deploy names an
environment, and the plain `deploy` scripts refuse to run. Staging is the only deployed environment.

## Staging, one command

```sh
pnpm check                              # typecheck, lint, tests, workerd e2e: all green first
pnpm deploy:staging                     # migrations on Neon, then API, MCP, web build and deploy
pnpm deploy:staging --skip-migrate      # code only
pnpm deploy:staging --only web          # one of api | mcp | web
pnpm deploy:landing                     # the landing page
pnpm --filter @zyropay/docs build && pnpm --filter @zyropay/docs deploy:staging   # this site
pnpm health                             # health check of the deployed API, MCP and web app
```

`scripts/deploy-staging.mjs` takes the direct database URL from the Neon CLI and stops if that fails.
It needs `wrangler login` and Neon CLI authentication on the machine, and never touches secrets.

The API and MCP workers bind to each other, and Cloudflare refuses a service binding to a worker that
does not exist yet, so a first deploy goes MCP (without its binding), then API, then MCP again.

## The docs site

`apps/docs` is a static Astro Starlight build served by Workers static assets (`zyropay-online-docs`,
custom domain `docs.zyropay.online`, no `workers.dev` route). `pnpm build`:

1. copies the generated `docs/API.md` and `docs/MCP.md` in as reference pages;
2. checks every pre-rendered diagram is up to date with its source (`pnpm diagrams` re-renders them
   with a headless Chromium);
3. builds the site, validating every internal link and anchor;
4. writes `dist/_headers` (CSP with hashes of the few inline scripts, `noindex`, caching) and checks
   every `href` and `src` in the output resolves to a file.

## After a deploy

1. `curl https://api.zyropay.online/health` answers `{"ok":true,"mode":"development","mocks":false}`.
2. Open the web app, create a passkey, and check the session starts.
3. Point an agent at `https://mcp.zyropay.online/mcp` and run a paid request
   ([user guide](/guides/users/)).

## Roll back

```sh
pnpm --filter @zyropay/api exec wrangler deployments list --env staging
pnpm --filter @zyropay/api exec wrangler rollback <version-id> --env staging -m "reason" -y
# the same for @zyropay/mcp, @zyropay/web-host and @zyropay/docs
```

A rollback restores that version's code, settings and secrets. It does not touch the database:
migrations are forward-only, so roll a schema back with a new migration or Neon's point-in-time
restore.
