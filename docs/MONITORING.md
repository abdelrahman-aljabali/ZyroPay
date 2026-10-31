# Monitoring

Two pieces: **error monitoring** with Sentry (opt-in, strictly scrubbed) and an **uptime / health check** script. Neither is on by default. Nothing here sends data anywhere until you configure a DSN.

## 1. Error monitoring (Sentry)

| Runtime              | SDK                                     | Turned on by                           | Where it is wired                                                                                                |
| -------------------- | --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| API worker           | `@sentry/cloudflare` 11.8               | `SENTRY_DSN_API` (worker secret)       | `apps/api/src/index.ts` (`withSentry`: fetch, queue, cron), `app.ts` `onError` (unexpected 5xx only)             |
| MCP worker           | `@sentry/cloudflare` 11.8               | `SENTRY_DSN_MCP` (worker secret)       | `apps/mcp/src/index.ts` (`withSentry`: fetch)                                                                    |
| App, iOS and Android | `@sentry/react-native` ~7.11 (Expo 57)  | `EXPO_PUBLIC_SENTRY_DSN` at build time | `apps/mobile/src/lib/monitoring.ts`, called from `app/_layout.tsx`                                               |
| App, web (PWA)       | `@sentry/react` 10.37 (same core as RN) | `EXPO_PUBLIC_SENTRY_DSN` at build time | `apps/mobile/src/lib/monitoring.web.ts` (dynamic import: a separate ~700 KB chunk loaded only when a DSN is set) |

Without a DSN, each runtime runs with Sentry disabled (`enabled: false`, no transport traffic). The app does not even load the SDK.

### What is sent, and what never is

Every event and breadcrumb passes through `scrubTelemetryEvent` / `scrubBreadcrumb` in `packages/shared/src/telemetry-scrub.ts` (`beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`). It fails closed:

- **Dropped structurally:** request body, headers, cookies, query string and env; the whole `user` object (no id, e-mail, IP or username); `server_name`. Request and breadcrumb URLs keep only scheme, host and path.
- **Keys:** any property named like a credential (`authorization`, `cookie`, `token`, `secret`, `password`, `private…`, `api key`, `stamp`, `signature`, `session`, `credential`, `mnemonic`, `seed`, `phrase`, `bundle`, `jwt`, `bearer`, plus every key-material name from `secret-material.ts`) is replaced with `[Filtered]` at any depth.
- **Values** (every string, at any depth): a valid BIP-39 phrase (`looksLikeRecoveryPhrase`, reused from `secret-material.ts`), any run of 12+ English-wordlist words even without a valid checksum, JWTs, `Bearer …`, ZyroPay `zp_at_`/`zp_rt_` tokens, PEM private keys, hex of 64+ chars (private keys, raw transactions, also transaction hashes), base58 of 80+ chars (Solana secret keys), base64 blobs of 120+ chars (stamps, bundles), provider keys in URLs (`api-key=`, `key=`, `token=`, `project_id=`, Alchemy `/v2/<key>`), e-mail addresses, IPv4 and IPv6 addresses.
- **Workers additionally** turn off every Sentry 11 data-collection category (`dataCollection`: user info, cookies, headers, bodies, query params, queue payloads, local variables) and send no traces (`tracesSampleRate: 0`).
- **App additionally:** `sendDefaultPii: false`, no traces, no screenshots or view hierarchy, no failed-request capture, no session replay.

What remains is what debugging needs: error type and message (scrubbed), stack frames, release, environment, route/tag names and scrubbed breadcrumbs.

Tests that prove it:

- `packages/shared/src/telemetry-scrub.test.ts`: a realistic dirty event (phrase in the message, keys in exceptions, bearer/cookie headers, body, query, user, nested tokens) comes out with none of them and keeps the debugging fields.
- `apps/api/test/security/sentry.test.ts` and `apps/mcp/tests/unit/sentry.test.ts`: a real `@sentry/cloudflare` client with a capturing transport (no network) wraps a handler that throws with secrets in the message, the URL, the headers and the body. The envelope that would be sent contains the event but none of the secrets. Without a DSN nothing is sent.
- `apps/mobile/src/lib/monitoring.test.ts`: the app options are off without a DSN, never send PII or traces, and scrub events and breadcrumbs.

### What you need to create (free Sentry account)

1. Sign up at sentry.io (the free Developer plan is enough to start). Pick the EU region (`de.sentry.io`) if you want data in the EU.
2. Create three projects: `zyropay-api` (platform: Cloudflare Workers), `zyropay-mcp` (Cloudflare Workers) and `zyropay-app` (React Native). Copy each project's DSN (Settings → Client Keys). A DSN is not a secret, it only allows sending events.
3. In each project: Settings → Security & Privacy → turn on **Data Scrubber** and **Use Default Scrubbers**, and turn **off** "Store IP addresses" (defence in depth on top of ours).
4. Configure:

   ```sh
   cd apps/api && pnpm exec wrangler secret put SENTRY_DSN_API --env staging     # and --env production
   cd apps/mcp && pnpm exec wrangler secret put SENTRY_DSN_MCP --env staging
   # optional: SENTRY_ENVIRONMENT (defaults to ZYROPAY_MODE), SENTRY_RELEASE (e.g. the git sha)
   ```

   App (native and web): set `EXPO_PUBLIC_SENTRY_DSN` to the `zyropay-app` DSN in the build environment (`apps/mobile/.env`, EAS env, or `apps/web-host/.env.<env>`); optional `EXPO_PUBLIC_SENTRY_ENVIRONMENT`.

5. **Web host CSP:** the web app's `connect-src` must include the DSN's ingest origin (for example `https://o123456.ingest.de.sentry.io`), otherwise the browser blocks the events. `apps/web-host/scripts/build.mjs` generates the CSP and is owned by the deploy work; add the origin there when you set the DSN.

Not set up (yet): source-map upload (`SENTRY_AUTH_TOKEN`, the `@sentry/react-native/expo` config plugin with org/project), release health, alerts. Stack traces are minified until source maps are uploaded.

### Local check

```sh
# API with Sentry against a real project (events appear under environment "development"):
echo 'SENTRY_DSN_API=https://…@o….ingest.de.sentry.io/…' >> apps/api/.dev.vars
pnpm dev
```

## 2. Uptime / health check

`scripts/health-check.mjs` (`pnpm health`) has no dependencies, so any scheduler can run it (cron, a scheduled GitHub Action, an uptime service that runs commands). Exit code 0 means healthy.

```sh
pnpm health --api https://api.zyropay.example --mcp https://mcp.zyropay.example --web https://app.zyropay.example
pnpm health --api http://localhost:8787 --json          # machine-readable
```

| Check | Request                                       | Healthy when                                                                |
| ----- | --------------------------------------------- | --------------------------------------------------------------------------- |
| api   | `GET /health`                                 | 200 and `{"ok":true}`; fails on `mode=production` with `mocks=true`         |
| mcp   | `GET /.well-known/oauth-authorization-server` | 200 JSON with an `issuer`                                                   |
| web   | `GET /`                                       | 200 HTML that references the app bundle (also reports a missing CSP header) |

Options: `--timeout <ms>` (default 10000), `--retries <n>` (default 1). The API's `/health` answers 503 with the names (never values) of missing configuration, which the check prints.

Verified against the local real-mode stack (`pnpm dev --web`): all three checks passed; an unreachable host exits 1 with the error.

## 3. Logs

The API logs structured JSON through `apps/api/src/lib/logger.ts`, which redacts credential-named keys and token/key-shaped values (now also provider keys inside URLs). Events worth alerting on:

- `helius.key_failover` (warn): a Helius key answered 401/403/429 and the request moved to the next key (`keyIndex`, `reason`: `unauthorized` | `quota_exhausted` | `rate_limited`, `cooldownMs`). Repeated `quota_exhausted` for index 0 means the primary plan is spent.
- `api.refusing_to_start` (fatal): configuration problem; `/health` is 503.
- `request.failed` (error): unexpected 5xx (also sent to Sentry when configured).
