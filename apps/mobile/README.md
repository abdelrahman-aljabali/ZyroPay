# @zyropay/mobile

Expo SDK 57 app (React Native 0.86.3, React 19.2.3, New Architecture, Expo Router with native tabs, React Compiler). UI comes from `@zyropay/ui`; every API call goes through the typed client in `src/api/client.ts`, which is built on the shared `api` contracts.

## Run

```sh
pnpm install                                    # repo root
pnpm dev --mocks                                # UI work in Expo Go, simulated data (mock transport)
pnpm dev:setup && pnpm dev                      # API + MCP + Expo; the app talks to the local API
pnpm dev --web                                  # real mode in the browser: real passkeys, Turnkey, testnet balances
EXPO_PUBLIC_USE_MOCKS=1 pnpm --filter @zyropay/mobile start   # the app alone, mock transport
```

`pnpm dev` decides how the app runs (details in `docs/SETUP.md`):

- **Local secrets and Turnkey on both sides:** the local API with real passkeys. This needs a development build: `eas build --profile development`.
- **Local secrets, no Turnkey:** the local API with the development `dev-*` passkey that the API's MockTurnkey accepts. Works in Expo Go.
- **No local secrets:** the mock transport.

| Env                                                                                                            | Purpose                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_URL`                                                                                          | API base URL (`pnpm dev` uses your LAN address so a phone can reach it)                                                                                                           |
| `EXPO_PUBLIC_MCP_URL`                                                                                          | MCP server URL shown on the agent-connect screens (default `http://localhost:8788/mcp`)                                                                                           |
| `EXPO_PUBLIC_ZYROPAY_MODE`                                                                                     | `development` (testnets only) or `production` (mainnets only)                                                                                                                     |
| `EXPO_PUBLIC_USE_MOCKS`                                                                                        | `1` turns on the DEV mock transport. It is refused when the mode is production                                                                                                    |
| `EXPO_PUBLIC_DEV_PASSKEY`                                                                                      | `mock-turnkey`: development `dev-*` passkey for a local API running MockTurnkey. Refused outside development                                                                      |
| `EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID`, `EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID`, `EXPO_PUBLIC_PASSKEY_RP_ID` | Turnkey and passkeys (all three needed). On the web the rpId is the site's host (`localhost` locally); `EXPO_PUBLIC_TURNKEY_API_BASE_URL`, `EXPO_PUBLIC_PASSKEY_RP_NAME` optional |
| `EXPO_PUBLIC_DEEP_LINK_SCHEME`                                                                                 | Deep-link scheme (default `zyropay`); must match the API's `APP_DEEP_LINK_SCHEME`                                                                                                 |
| `APP_VARIANT`, `EXPO_OWNER`, `EXPO_PROJECT_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE_NAME`, `APPLE_TEAM_ID`       | Build-time values (`app.config.ts`); `EXPO_PROJECT_ID` is also needed for push tokens                                                                                             |

Every variable is declared in `src/env.d.ts`. That keeps `process.env.X` typed `string | undefined`, because expo-modules-core otherwise widens it to `any`. It is also listed in the repo-root `.env.example`.

## Autonomous mode

Switching an agent to Autonomous asks for the passkey on save (`src/lib/autonomous.ts`, ADR-001 D6):

1. The app fetches or creates the API's delegated signer, which returns only its public key.
2. The passkey creates the non-root Turnkey API-key user holding that key, and the API activates it.
3. If an earlier, revoked setup left its Turnkey user and `zyropay-delegated-*` policies in the sub-organization, the passkey deletes them first (they count against Turnkey's 5-policy limit).
4. The app builds the Turnkey CREATE_POLICIES envelope with the shared `buildDelegatedPolicyEnvelope`, using caps from the portfolio's USD prices, and the passkey stamps it.
5. The policy is saved with `turnkeyPolicyRequest`. The API verifies the envelope and forwards it.

That is two passkey prompts on a first setup and up to four when old leftovers are removed. Later autonomous agents reuse the envelope without prompts. Without a passkey signer (Turnkey not configured, Expo Go) Autonomous cannot be saved.

## Push

The push `data` is the shared `PushData` (type, ids, deep link `zyropay://approvals/<id>` and other routes from a closed set). `src/lib/push-data.ts` parses it with `parsePushData`, and a tap opens only those screens.

## Mock mode

When `EXPO_PUBLIC_USE_MOCKS=1` is set, `src/api/mock/transport.ts` answers the shared REST contracts with fixtures that are valid against the contracts and marked `simulated: true`. The same `ApiClient` validates those responses. While the mock is active:

- the app shows a "Simulated data" banner that cannot be dismissed;
- every simulated value carries a "Simulated" badge;
- signatures come from a labelled simulated signer, so no passkey is used.

## Add wallet

The "+" on the Wallets tab offers two kinds of wallet. Every chain list comes from the shared network registry filtered to the build's mode, so a network added there shows up without UI changes.

- **Create new wallet.** The passkey creates a new HD wallet with one account for the picked chain's family in the user's own Turnkey sub-organization (`PasskeySigner.createWallet`, `StamperType.Passkey`). The app then calls `POST /v1/wallets`; the API re-reads the sub-organization and refuses a wallet id that is not in it. The idempotency key is kept for the screen visit, and if only registration failed, the retry reuses the wallet the passkey already made.
- **Watch an address.** Read only: paste or scan (expo-camera, QR only) an address. It is validated with the shared address helpers for the picked chain and stored as a watch wallet. Watch wallets have their own table and schema, so sends, signing and agent policies cannot reach them. Every surface labels them "Watch only — can't send or be used by agents", and they are not part of the total balance.
- **Rename / remove.** Remove unlinks the wallet from ZyroPay. Keys are never deleted, and the API refuses to remove the last wallet, a wallet an agent can use, or one with a request in flight.

## Web app (PWA)

The same app runs in the browser as a real, mobile-first PWA: passkeys in the browser, real Turnkey and the real API.

```sh
pnpm dev --web                                          # repo root: API (mocks off) + MCP + Expo web, http://localhost:8081
node scripts/web-e2e.mjs --url http://localhost:8081    # real passkey sign-up/login with a CDP virtual authenticator
pnpm --filter @zyropay/web-host build:web -- --env staging   # static export + _headers for Cloudflare (docs/DEPLOY.md)
```

Web-only files (`*.web.ts(x)`) replace the native-only pieces; iOS and Android never load them:

| File                                                                | Web behaviour                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/turnkey/TurnkeyBridge.web.tsx`, `lib/turnkey/web-signer.ts`    | `@turnkey/core` 2.12.2 (same core as the native Wallet Kit), loaded lazily: the bridge is a thin signer that imports `web-signer.ts` on first use or when a signing screen mounts (`useSigner()` preloads). Auth Proxy passkey sign-up/login; every value-moving request stamped with `StamperType.Passkey` (`X-Stamp-Webauthn`) |
| `lib/fonts.web.ts`, `public/fonts/`                                 | Inter as Latin WOFF2 subsets declared and preloaded in `public/index.html` (`node scripts/subset-fonts.mjs` regenerates them; needs `pip install fonttools brotli`)                                                                                                                                                              |
| `lib/live-activity/index.web.ts`, `lib/monitoring.web.ts`           | No Live Activity on the web (keeps `@expo/ui`/`expo-widgets` out); Sentry via `@sentry/react`, lazily, only with a DSN (`docs/MONITORING.md`)                                                                                                                                                                                    |
| `lib/turnkey/web-requests.ts`                                       | The stamped requests the API verifies; `web-requests.test.ts` runs them through `@turnkey/webauthn-stamper` and `@zyropay/wallet`'s verifiers                                                                                                                                                                                    |
| `state/storage.web.ts`                                              | Session tokens in `sessionStorage` (per tab, cleared on close; no key material exists in ZyroPay); preferences in `localStorage`                                                                                                                                                                                                 |
| `lib/screen-capture.web.ts`                                         | Browsers cannot block capture: `SCREEN_CAPTURE_BLOCKED=false`, so export/import show `ScreenCaptureWarning`                                                                                                                                                                                                                      |
| `components/WebFrame.web.tsx`, `lib/embed-runtime.web.ts`           | Phone-width column (max 480 px), centred on wider screens. Inside the landing page's iframe it posts `{type:"zyropay:ready"}` or `{type:"zyropay:passkey-unavailable"}` to the allowlisted parent's exact origin and offers "Open ZyroPay in full screen" when the frame cannot use passkeys (`docs/SECURITY.md` "Framing")      |
| `lib/color-scheme.web.ts`                                           | Keeps `<html data-theme>`, `color-scheme` and `theme-color` in step with the in-app theme (native: pins the OS appearance to the in-app choice)                                                                                                                                                                                  |
| `components/PriceChart.web.tsx`                                     | SVG chart instead of Skia                                                                                                                                                                                                                                                                                                        |
| `public/index.html`, `public/manifest.webmanifest`, `public/icons/` | PWA template (light by default; `theme-boot.js` applies a stored Dark choice before the bundle runs), manifest and icons. `pnpm icons` regenerates every icon, the splash and the favicon from `assets/brand/zyropay-mark.svg`                                                                                                   |

`metro.config.js` resolves the native-only Turnkey modules to empty modules on the web, points `tslib` at its ES build (the default ESM wrapper breaks under Metro's web interop) and resolves zod's `locales` namespace to an English-only shim (`src/shims/zod-locales-en.ts`). `babel.config.js` adds, for web builds only, `scripts/babel-inline-vendor-imports.js`: it turns `import()` inside node_modules into a lazy `require`, because Metro's chunk splitting on SDK 57 otherwise moves everything two async chunks share (all of viem, ethers and WalletConnect) into the eagerly loaded `__common.js`.

### Web performance

First-load JS (production export, real mode): 3.58 MB raw / 0.91 MB gzip, down from 7.39 MB / 1.84 MB; the Turnkey chunk (4.0 MB) loads only for signing. Lighthouse mobile, median of 5 on a local production export: performance 41 -> 64, LCP 12.0 s -> 5.7 s. What is left in the entry is mostly reanimated, expo-router, react-native-web and react-dom. Measure with `npx expo export --platform web --source-maps` and source-map-explorer. The web host should serve `/fonts/*` and `/assets/*` with `Cache-Control: public, max-age=31536000, immutable` (names are versioned or hashed), like `/_expo/static/*`.

### Visual QA (mock mode)

```sh
npx playwright install chromium                 # once
node scripts/screenshots.mjs                    # web export (mock mode) + every screen, light and dark, 393×852 @3x
node scripts/screenshots.mjs --url http://localhost:8081 --only home,wallets --scheme dark
```

Images go to `screenshots/<scheme>/<screen>.png` (git-ignored). The run fails if a screen throws.

## Working on the app

- **Expo changes every SDK.** Read the `expo` major version in `package.json` and use the docs for that version (`https://docs.expo.dev/versions/v57.0.0/`, index at https://docs.expo.dev/llms.txt) rather than memory.
- **Add native packages with `npx expo install <package>`** (it picks the SDK-compatible version), then pin it in this `package.json`. A package with native code needs a development build; Expo Go only has its bundled modules.
- **Routes live in `src/app/`** (Expo Router: every file is a screen, `_layout.tsx` defines a navigator). Components, hooks and helpers stay outside it.
- **`ios/` and `android/` are generated** (Continuous Native Generation from `app.config.ts` and config plugins); never edit them by hand.
- Before you finish: `pnpm --filter @zyropay/mobile typecheck lint test`, and `pnpm test:web` for screen changes.

## Library decisions

- **Styling: typed tokens with `StyleSheet` instead of NativeWind.** The stable NativeWind release is 4.2.7. It needs Tailwind v3, and it depends on `react-native-css-interop`, which v5 replaces; v5 is still `5.0.0-rc.0`. I did not verify NativeWind against SDK 57. A shared component package that exports TypeScript source would also need every consumer to run the NativeWind Babel and Metro transforms. Unistyles 3 needs Nitro modules, so it does not run in Expo Go.
- **Storage: `expo-sqlite/kv-store` instead of MMKV.** MMKV v4 needs `react-native-nitro-modules`, which Expo Go does not include. Preferences go to `expo-sqlite/kv-store`; session tokens go to `expo-secure-store`.
- **Live Activity: `expo-widgets` (SDK 57).** It provides `createLiveActivity` with the `'widget'` directive and `@expo/ui/swift-ui`. It is iOS-only, needs a development build, and is lazy-loaded behind a guard. The Lock Screen shows no amounts.
- **Turnkey: `@turnkey/react-native-wallet-kit` 2.3.9 (native), `@turnkey/core` 2.12.2 (web).** The Wallet Kit is required lazily only in dev or production builds where `EXPO_PUBLIC_TURNKEY_*` is set, because its native modules (passkey, device-info, in-app browser) crash Expo Go. On the web, `@turnkey/core` (Turnkey's TypeScript frontend SDK, the core the Wallet Kit wraps) is used directly rather than `@turnkey/react-wallet-kit`, which adds UI modals the app does not use. Shared request-building lives in `bridge-common.ts`. Signatures use `StamperType.Passkey` (ADR-001 D2).

## Tests

- `pnpm --filter @zyropay/mobile test` runs the Vitest unit tests: client, mock transport, stores, validation, the autonomous setup flow, push parsing and the dev passkey (pinned to `@zyropay/wallet`'s mock stamp).
- `pnpm test:web` (repo root or here) runs the Playwright web E2E in `e2e-web/` on Chromium, WebKit and Firefox at phone and laptop sizes in mock mode, with layout checks on every screen (overflow, touch targets, iOS zoom-inducing text fields). `E2E_REAL_URL=http://localhost:8081 pnpm test:web:real` runs the real passkey sign-up/login on Chromium against `pnpm dev --web` (`docs/SETUP.md` §2c).
- `tests/e2e/*.yaml` holds the Maestro flows. Run them with `maestro test -e APP_ID=app.zyropay.mobile.dev tests/e2e` on a development build that has `EXPO_PUBLIC_USE_MOCKS=1`.
