# ZyroPay Architecture

ZyroPay is a non-custodial crypto wallet for iOS and Android with AI-agent payments. Users hold their keys in Turnkey behind their own passkey. AI agents connect through a remote MCP server. They can read balances and request payments, and every payment goes through ZyroPay's policy engine. By default it also needs the user's passkey approval in the app.

The public documentation site, https://docs.zyropay.online (`apps/docs`), explains this system in reading order with live evidence; this document is the engineering source it is built from.

Contracts live in `@zyropay/shared` (Zod schemas, pure domain logic, ports) and `@zyropay/db` (Postgres schema). Every other package implements against them.

---

## 1. System overview

```
                     ┌────────────────────────────────────────────────┐
                     │                 Turnkey (TEE)                  │
                     │  parent org ── sub-org per user                │
                     │     root user = end user (passkey)             │
                     │     [optional] delegated non-root API-key user │
                     │     policies (bound the delegated user only)   │
                     └──────▲──────────────────────▲──────────────────┘
       passkey-stamped      │ forwarded unmodified │ delegated-key signing
       requests (sign-up,   │ (whoami, sign_tx)    │ (autonomous only)
       login via Auth Proxy)│                      │
┌──────────────────┐        │        ┌─────────────┴──────────────┐      ┌──────────────┐
│  Mobile app      │  HTTPS │        │  API  (apps/api)           │ SQL  │ Neon Postgres│
│  (apps/mobile,   ├────────┴───────►│  Cloudflare Worker, Hono   ├─────►│ (@zyropay/db)│
│  Expo, RN Wallet │  user session   │  policy engine, state      │      └──────────────┘
│  Kit, passkeys)  │◄────────────────┤  machine, reservations,    │
└──────▲───────────┘  push (Expo)    │  audit, webhooks           ├────► Helius / Alchemy
       │                             └─────────────▲──────────────┘      (RPC, broadcast)
       │ deep link / code entry                    │ /internal/v1/*      Jupiter, x402
       │                                           │ INTERNAL_SERVICE_   facilitator,
┌──────┴───────────┐  OAuth 2.1 + MCP   ┌──────────┴─────────────┐       CoinGecko,
│ AI agent / MCP   ├───────────────────►│  MCP server (apps/mcp) │       Transak, Expo push
│ client (Claude…) │  streamable HTTP   │  Worker, OAuth provider│
└──────────────────┘                    │  NEVER signs, no DB    │
                                        └────────────────────────┘
```

### Components

| Component    | Location                                                | Runtime                                                                                           | Responsibility                                                                                                                                               |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mobile app   | `apps/mobile` (Expo SDK 57, Expo Router), `packages/ui` | Expo / React Native                                                                               | Sign-up/login with passkey (Turnkey RN Wallet Kit + Auth Proxy), portfolio, send/receive, approvals, agent management and activity, autonomous setup, push   |
| API          | `apps/api`, `packages/wallet`                           | Cloudflare Worker (Hono)                                                                          | System of record. Auth sessions, contracts in `api`, policy evaluation, state machine, spending reservations, Turnkey forwarding, broadcast, webhooks, audit |
| MCP server   | `apps/mcp`                                              | Cloudflare Worker (MCP SDK 1.32 stateless Streamable HTTP + `@cloudflare/workers-oauth-provider`) | OAuth for agent clients; exposes `mcpTools`; translates tool calls into `/internal/v1/*` API calls                                                           |
| Chain layer  | `packages/blockchain`                                   | library                                                                                           | `TransactionBuilder` (Solana via `@solana/kit`, EVM via `viem`, Cardano via an own CBOR codec + Blockfrost, ADR-002), `Broadcaster`, `PortfolioProvider`     |
| Integrations | `packages/integrations`                                 | library                                                                                           | `PluginAdapter` (Jupiter, x402), `PriceProvider`, `OnrampProvider` (Transak), `Notifier` (Expo), plus `Mock*` versions                                       |
| Contracts    | `packages/shared`                                       | library (no runtime deps beyond zod, @noble/hashes)                                               | Schemas, money, addresses, networks, state machine, canonical payload + hash, policy engine, plugin registry, MCP + REST contracts, ports                    |
| Database     | `infrastructure/database`                               | Drizzle + Neon                                                                                    | Schema, migrations, `createDb()`                                                                                                                             |

### Non-negotiable rules

1. **The MCP server never signs.** It holds no Turnkey credentials and no database URL. Its only credential toward ZyroPay is `INTERNAL_SERVICE_TOKEN`, and it only calls the API's `/internal/v1/*` endpoints. On every internal call the API checks that the agent is still active and not revoked, so a token left over in MCP storage cannot act on its own.
2. **The API never holds a user's root credential.** The user's passkey is the only root of their sub-organization. The parent organization can read sub-orgs but cannot write to them (Turnkey docs: https://docs.turnkey.com/features/organizations).
3. **An approval binds to `payloadHash`.** The hash is the SHA-256 of the canonical JSON of the payload: network, from, to, asset, amount, fee cap, plugin, tool, nonce, expiry and idempotency key. Any material change produces a new hash, and the old approval no longer applies.
4. **Amounts are base-unit integer strings plus decimals. Arithmetic is bigint.** Floats are banned by lint rules for `parseFloat`.
5. **Fail closed.** If there is no valuation, a price is stale, an amount is malformed, policy evaluation throws, or a Turnkey result is unexpected, the request is never auto-allowed.
6. **Mainnet and testnet are never mixed.** `ZYROPAY_MODE=production` means mainnets only; `development` means testnets only (`networksForMode`). Mock adapters are refused in production.
7. **Mocks are labelled.** Every fake implementation is named `Mock*` and returns `simulated: true`. The UI shows a badge for it.

---

## 2. Data flows

### 2.1 Sign-up and login

1. The app calls `signUpWithPasskey` (`@turnkey/react-native-wallet-kit`) with `authProxyConfigId`. Turnkey's Auth Proxy creates the passkey, the user's **sub-organization** and a default HD wallet with one Solana, one EVM and one Cardano account (`createSubOrgParams`; the Cardano account is ADR-002's `CARDANO_TURNKEY_ACCOUNT`). No ZyroPay backend is involved. Sources:
   - https://docs.turnkey.com/generated-docs/react-native-wallet-kit/client-context-type-sign-up-with-passkey
   - https://docs.turnkey.com/features/authentication/auth-proxy
2. The app stamps a Turnkey `get_whoami` request with the passkey and calls `POST /v1/auth/session`. The API forwards the stamped request to Turnkey unmodified, as in Turnkey's proxying-signed-requests pattern (https://docs.turnkey.com/features/authentication/proxying-signed-requests). Turnkey verifies the stamp and returns the `organizationId` and `userId`.
3. **First login only:** the API uses its parent-org read access to read the sub-org's root quorum. It refuses to activate the account unless the quorum is exactly `{the user's own Turnkey user}` with threshold 1. This guards the non-custodial property against Auth Proxy defaults that could change; the Auth Proxy's root layout is not documented, see the ADR.
4. The API upserts `users`, `auth_identities`, `wallets` and `wallet_addresses`, then issues a session: an opaque random access token (`zp_at_…`, 256 bits, default 15 min, `SESSION_ACCESS_TOKEN_TTL_SECONDS`) and an opaque random refresh token (`zp_rt_…`, default 30 days). Neither is a JWT and there is no signing secret. The API stores only their sha256: the access-token hash in `session_access_tokens`, the refresh-token hash in `sessions`. Every request looks the hash up, so revoking a session takes effect at once.
5. `POST /v1/auth/refresh` rotates the refresh token and revokes the old session and its access tokens. Presenting a rotated or revoked refresh token again revokes every session of the user (reuse detection).
6. **More wallets** (`apiWallets`, `docs/API.md`). The app creates another wallet in the sub-org with the passkey, then calls `POST /v1/wallets`. The API re-reads the sub-org and links only a wallet that is really there. Removing a wallet only unlinks it (`wallets.archived_at`). Its keys stay in Turnkey, and an archived wallet is invisible to every read, send, agent and MCP path. Watch wallets are read-only addresses in a separate table (`watch_wallets`) that no signing path reads.

### 2.2 Portfolio

1. The app calls `GET /v1/portfolio`.
2. The API loads the user's addresses and calls `PortfolioProvider.getSnapshot`: Helius for Solana, Alchemy for EVM, Blockfrost for Cardano.
3. The API calls `PriceProvider.getPrices` and computes values with bigint math.
4. It returns a `PortfolioSnapshot` with `asOf`, `stale` and `unpricedAssetCount`. Unknown prices stay `null` and are never guessed.

### 2.3 User send (in-app)

1. `POST /v1/send/quote` validates the input:
   - the address is valid for the network;
   - `decimals` match the asset;
   - the network is allowed in this mode.
2. The API then builds the `CanonicalTransactionPayload` and the unsigned transaction (`TransactionBuilder.buildTransfer`). It stores a `transaction_request` in state `CREATED` and returns a `SigningReview`.
3. The app shows the review. The user confirms with the passkey: the app builds a Turnkey `SIGN_TRANSACTION_V2` body for exactly `review.unsignedTransaction` and stamps it with `StamperType.Passkey`. Cardano instead stamps `SIGN_RAW_PAYLOAD_V2` over `review.rawPayload` (the body hash; ADR-002).
4. `POST /v1/send/:requestId/submit` sends `{payloadHash, signRequest}`. The API checks each of the following and rejects otherwise:
   - the stamp header is `X-Stamp-Webauthn` (passkey), not a session API key;
   - `organizationId` in the stamped body is the user's sub-org, and `signWith` is the wallet address;
   - `unsignedTransaction` is byte-equal to the stored unsigned transaction;
   - `payloadHash` matches the stored one;
   - `TransactionBuilder.verifyMatchesPayload` passes (an independent decode);
   - the request has not expired.
5. The state machine runs `CREATED → POLICY_CHECK → APPROVED`. User sends have no agent policy and pass the policy check trivially.
6. The request moves to `SIGNING` (event `START_SIGNING`) before the API forwards the stamped request to Turnkey, which returns the signed transaction.
7. `Broadcaster.broadcast` sends it through our own RPC, and the request moves to `BROADCAST`.
8. A confirmation watcher (Cron Trigger plus Helius/Alchemy webhooks) records `CONFIRMED` or `FAILED`, updates `executed_transactions` and sends a push notification.

### 2.4 Agent connect (OAuth)

1. The agent client discovers the MCP server, identifies itself with a Client ID Metadata Document (CIMD, preferred; Claude and ChatGPT use it) or registers dynamically (RFC 7591 DCR, the fallback), and starts OAuth 2.1 with PKCE against `apps/mcp` (`@cloudflare/workers-oauth-provider`).
2. The `/authorize` page in the MCP worker calls `POST /internal/v1/agent-connections` and shows a **user code** (`ABCD-1234`) with instructions. There is no QR code or deep link on that page.
3. In the app, the user enters or scans the code (`POST /v1/agent-connections/claim`), reviews the client name and redirect URI, and picks wallets and networks. `POST /v1/agent-connections/:id/approve` then creates an `agent` with `defaultAgentPolicy()` narrowed to those choices: `always_ask`, `spendingEnabled: false`, zero limits, restricted recipients, no protocols.
4. The MCP page polls `GET /internal/v1/agent-connections/:id`. Once approved, it calls `completeAuthorization` with props `{userId, agentId}`. The agent's OAuth access token only ever maps to that `agentId`.

### 2.5 Agent request → policy → approval → signing → broadcast → confirm

```
MCP tool call (send / swap / pay_x402)
  └─► POST /internal/v1/agents/:agentId/transaction-requests   [INTERNAL_SERVICE_TOKEN]
        1. idempotency: (user_id, idempotency_key) UNIQUE → replay returns the same request
        2. validate (address/network/decimals/mode), build CanonicalTransactionPayload, hash
        3. insert transaction_request CREATED → START_POLICY_CHECK
        4. BEGIN; SELECT agent_policies ... FOR UPDATE   (serializes this agent's requests)
             value in USD (PriceProvider, ceil)          → null if unavailable/stale
             spentWindows = ledger(day, month) + active reservations(day, month)
             evaluatePolicy(policy, request, valuation, spentWindows, {now})
             allow            → insert spending_reservation; → APPROVED
             require_approval → insert approval_request (+ reservation); → PENDING_APPROVAL
             deny             → REJECTED
           COMMIT
        5a. APPROVED (autonomous): → SIGNING, delegated-key sign (ADR-001) → BROADCAST
        5b. PENDING_APPROVAL: Expo push "approval_requested" → user opens /approvals/:id,
            reviews, signs with passkey → POST /v1/approvals/:id/approve (same checks as 2.3)
            → APPROVED → SIGNING, forward stamp → BROADCAST
        6. confirmations → CONFIRMED: reservation → settled, spending_ledger row inserted
           FAILED / EXPIRED / CANCELLED / REJECTED → reservation released
        (states are TX_REQUEST_STATES in @zyropay/shared state-machine.ts; events such as
         POLICY_ALLOWED or USER_APPROVED drive transition())
  ◄─ TransactionRequestResult { requestId, state, decision, reasons, approvalUrl, ... }
get_approval_status polls GET /internal/v1/agents/:agentId/transaction-requests/:requestId
```

**Concurrency.** Steps 4–5 run under a row lock on the agent's policy. Limits are computed as `spent + reserved + this`, so N concurrent requests can never jointly exceed a window. A unit test in `policy.test.ts` covers this.

**Optimistic locking.** `transaction_requests.version` is checked on every state change (`UPDATE … WHERE id=$1 AND version=$2`). The new state always comes from `transition()`. An illegal transition throws, and the API maps it to `ILLEGAL_STATE_TRANSITION`.

**Expiry.** A Cron Trigger moves requests that are past `expires_at` and still in `CREATED`, `POLICY_CHECK`, `PENDING_APPROVAL` or `APPROVED` to `EXPIRED`, and releases their reservations. Once signing has started, only the chain decides the outcome.

### 2.6 Autonomous mode setup (app flow, ADR-001 D6)

Switching an agent to Autonomous in the policy editor runs `apps/mobile/src/lib/autonomous.ts`:

1. `GET /v1/delegated-signer`, or `POST` it if there is none. The API generates the P-256 key pair, stores the private key AES-256-GCM encrypted, and returns only `apiPublicKey`.
2. While the signer is `pending`, the user's passkey creates the non-root API-key user that holds that public key, directly with Turnkey (`fetchOrCreateP256ApiKeyUser`, `StamperType.Passkey`). Then `POST /v1/delegated-signer/activate {turnkeyUserId}`: the API reads the sub-org with the parent key and requires exactly our key, no authenticators, and no root-quorum membership.
3. If no policy envelope is recorded for the sub-org yet, the passkey first deletes what a revoked earlier setup left there (its delegated user and `zyropay-delegated-*` policies, which would otherwise count against the 5-policy limit), then the app builds it with the shared deterministic builder `buildDelegatedPolicyEnvelope` (`@zyropay/shared` `delegated-policy.ts`: P1 EVM native ALLOW, P2 Solana System/ComputeBudget ALLOW, P3 DENY on address lookup tables). The builder takes the policy being saved and native USD prices from the portfolio. The passkey stamps (does not submit) `ACTIVITY_TYPE_CREATE_POLICIES`.
4. `PUT /v1/agents/:id/policy` with `mode: "autonomous"` and `turnkeyPolicyRequest`. The API verifies that every ALLOW policy's consensus is exactly the delegated user, forwards the stamped request to Turnkey unmodified, records the policy ids, and saves the policy.

There is one envelope per sub-org (one delegated user serves every autonomous agent), so later agents reuse it without passkey prompts. The v1 envelope covers native transfers only: autonomous token transfers are refused by Turnkey (fail closed) and need the passkey. Without a passkey signer (Turnkey not configured, Expo Go) the editor refuses Autonomous.

### 2.7 Push notifications

Every push's `data` is the shared `PushData` (`@zyropay/shared` `push.ts`): `{ v: "1", type, url, approvalId?, requestId?, agentId?, orderId?, transferId? }`. `type` is the precise `NotificationEvent`, the ids are UUIDs, and `url` is a deep link `<scheme>://<route>` from a closed route set (`approvals/<id>`, `approvals`, `activity`, `agents/<id>`, `settings`). The schema is strict, so amounts and addresses cannot ride along; titles and bodies are short generic text without amounts.

- **API:** builds the data with `buildPushData`.
- **Expo adapter:** sends it only if it validates, otherwise the push goes out with empty data.
- **App:** opens only routes that `parsePushData` accepts, and the screens reload everything from the API.

### 2.8 Webhooks

Transak, Helius and Alchemy webhooks are handled the same way:

1. Verify the signature over the raw body.
2. Insert into `webhook_events`. The unique `(provider, event_id)` constraint means a duplicate is acknowledged and not processed again.
3. Process the event asynchronously with retries (`attempts`).
4. Reconcile with our own RPC reads; never trust a webhook as the only source of truth for a balance or confirmation.

### 2.9 Local development

The API's default database driver is Neon's serverless driver (WebSockets to Neon). With `DATABASE_DRIVER=pg` (development only) it uses node-postgres over workerd TCP sockets, so `wrangler dev` can run against a plain local Postgres (`pnpm db:local`).

- **Without Turnkey credentials,** development mode uses `MockTurnkey`: `dev-*` passkey credentials auto-provision a sub-org.
- **The app** can sign for it with the development passkey stand-in (`EXPO_PUBLIC_DEV_PASSKEY=mock-turnkey`, refused outside development).
- **`pnpm dev`** wires this together, and `pnpm smoke` exercises the whole agent payment flow on it. See `docs/SETUP.md`.

---

## 3. Trust boundaries

| Boundary                   | Crossing credential                                                                                                      | Controls                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Device ↔ Turnkey           | Passkey (WebAuthn, platform authenticator) or session API key stored on device                                           | Turnkey verifies stamps; approvals require the passkey stamp (`X-Stamp-Webauthn`) |
| App ↔ API                  | Opaque access token (15 min, hashed at rest) + rotating refresh token                                                    | Zod validation of every request; ownership checks on every id; rate limits        |
| API ↔ Turnkey              | Forwarded user stamps (cannot be altered); parent-org read key; delegated non-root key (autonomous only, policy-bounded) | Byte-equality checks on stamped bodies; encrypted key at rest                     |
| Agent ↔ MCP                | OAuth 2.1 access token (PKCE, per agent)                                                                                 | Token → `{userId, agentId}` props only; scopes                                    |
| MCP ↔ API                  | `INTERNAL_SERVICE_TOKEN`                                                                                                 | `/internal/*` only; per-call agent active check; MCP has no DB or Turnkey access  |
| API ↔ chains/providers     | Provider API keys                                                                                                        | Fail-closed valuations; independent decode of transactions before signing         |
| Providers → API (webhooks) | HMAC/signature                                                                                                           | Signature check, idempotent storage, RPC reconciliation                           |

---

## 4. ADR-001: Turnkey signing model

**Status:** Accepted. **Deciders:** founding architect, to be reviewed by the coordinator. **Sources:** Turnkey docs; each claim cites its page.

### Context

ZyroPay must be non-custodial: no ZyroPay system may be able to move user funds on its own. Agents need two modes:

- **Always Ask:** the user approves every payment.
- **Autonomous:** bounded payments with no human in the loop.

Turnkey provides per-user sub-organizations, passkey authenticators, non-root users with API keys, and a policy engine.

### Facts from Turnkey's documentation

1. **Sub-orgs.** The parent org creates them, and you can create as many as you like. The parent can read sub-orgs but not write to them, and only a root user inside a sub-org can delete it.
   - https://docs.turnkey.com/features/sub-organizations
   - https://docs.turnkey.com/features/organizations
2. **Root quorum bypasses policies.** "Actions approved by the root quorum do not go through the policy engine"; root actions cannot be limited by any policy. Turnkey suggests a 1/2 business+user root quorum for low-value orgs; that layout would make us custodial, and we reject it. https://docs.turnkey.com/features/users/root-quorum
3. **The Auth Proxy** creates sub-orgs, OTP and OAuth logins without a backend. It "has no access to funds", and we enable it per org with an `authProxyConfigId`. https://docs.turnkey.com/features/authentication/auth-proxy
4. **The RN Wallet Kit signs with a session API key by default.** You must pass `StamperType.Passkey` to force a passkey prompt for a given request. https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react-native/advanced-api-requests
5. **Stamped requests can be proxied.** The stamp covers the exact POST body, so a backend can inspect it but not modify it. Stamp timestamps are valid for at most 1 hour.
   - https://docs.turnkey.com/features/authentication/proxying-signed-requests
   - https://docs.turnkey.com/api-reference/overview/stamps
   - https://docs.turnkey.com/api-reference/activities/overview
6. **Delegated access.** A business-controlled **non-root** API-key user inside the user's sub-org starts with no permissions and is scoped by policies. The recommended setup runs from the frontend, under the end user's own session: `fetchOrCreateP256ApiKeyUser`, then `fetchOrCreatePolicies`.
   - https://docs.turnkey.com/features/policies/delegated-access/overview
   - https://docs.turnkey.com/features/policies/delegated-access/frontend
   - https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets
7. **Policy language.** A policy has an `effect` (ALLOW or DENY), a `consensus` (who) and a `condition` (what). It is evaluated per request, with no short-circuiting, and `int` is limited to 128 bits.
   - https://docs.turnkey.com/features/policies/overview
   - https://docs.turnkey.com/features/policies/language
8. **Solana conditions** (https://docs.turnkey.com/features/policies/language and https://docs.turnkey.com/features/policies/examples/solana):
   - **Native transfers:** `solana.tx.transfers[*].{from,to,amount}` covers direct System Program transfers only.
   - **SPL transfers:** `solana.tx.spl_transfers[*].{from,to,amount,owner,token_mint}` covers top-level `Transfer`, `TransferChecked` and `TransferCheckedWithFee` only. The mint is filled only for the Checked variants, and `to` is the recipient's _token account_, not their wallet.
   - **Other fields:** `program_keys`, `account_keys`, `instructions`, and `recent_blockhash`.
   - **Lookup tables:** addresses resolved through address lookup tables appear as `'ADDRESS_TABLE_LOOKUP'` and must be denied.
9. **EVM conditions** (https://docs.turnkey.com/features/policies/language, https://docs.turnkey.com/features/policies/examples/ethereum and https://docs.turnkey.com/features/policies/smart-contract-interfaces):
   - **Fields:** `eth.tx.{to,value,chain_id,data,gas,max_fee_per_gas,nonce,…}`.
   - **ERC-20 arguments:** `eth.tx.function_name` and `eth.tx.contract_call_args[...]` are available only after you upload an ABI for the contract. Without one, match the selector with `eth.tx.data[0..10] == '0xa9059cbb'`.
   - **Typed data:** `eth.eip_712.*` is available.
10. **Not released.** Velocity controls (cumulative SUM/COUNT over windows) appear in the API schema but are **not released**. The public OpenAPI has no endpoint for them, and a go-sdk changeset dated 2026-08-31 removed the "unreleased velocity control endpoints". https://docs.turnkey.com/api-reference/queries/get-activity
11. **Plan limit.** Free, Pay-as-you-go and Pro allow **5 policies per organization**. https://docs.turnkey.com/reference/resource-limits
12. **Sign-only vs sign-and-send.** Turnkey can sign only (`ACTIVITY_TYPE_SIGN_TRANSACTION_V2`) or sign and broadcast (`ETH_SEND_TRANSACTION`, `SOL_SEND_TRANSACTION`). With sign-and-send, Turnkey fills nonce, gas, blockhash and fees, and for sponsored Solana sends some fee fields are filled after the policy check. Non-sponsored Solana mainnet sends are not clearly documented.
    - https://docs.turnkey.com/api-reference/activities/sign-transaction
    - https://docs.turnkey.com/features/transaction-management/broadcasting

### Decision

**D1. One sub-org per user. The user's passkey is the sole root.** The root quorum is `{end-user Turnkey user}` with threshold 1, and there is no ZyroPay root user. Sub-orgs are created by the app through the Auth Proxy (`signUpWithPasskey`). The API checks the root quorum on first login and refuses to activate any sub-org whose quorum contains anything else (§2.1). Recovery is the user's responsibility, for example a second passkey or email OTP added as the user's own authenticator. ZyroPay has no recovery override; that is the cost of being non-custodial.

**D2. Every user-approved signature uses a passkey stamp, forwarded by the API.** The steps:

1. The API builds the unsigned transaction.
2. The app stamps `SIGN_TRANSACTION_V2` with `StamperType.Passkey`.
3. The API checks that the header is `X-Stamp-Webauthn`, and that `organizationId`, `signWith` and a byte-equal `unsignedTransaction` match, along with `payloadHash`, expiry and an independent decode (`verifyMatchesPayload`).
4. The API forwards the request to Turnkey.
5. The API broadcasts through its own RPC.

Session-key stamps (`X-Stamp`) are accepted only for read-only queries such as `get_whoami`. Because the stamp covers the body, the API cannot change what the user signed. Because the API checks the body, a malicious app build cannot slip a different transaction past the review either, since the review and the stamped body must match.

**D3. Use sign-only, not Turnkey sign-and-send, in v1.** `SIGN_TRANSACTION_V2` signs exactly the bytes the user reviewed. Sign-and-send fills nonce, gas and fees after review, so the signed transaction would differ from the reviewed one. Our `Broadcaster` gives one confirmation path for both families. We will revisit this for gas sponsorship.

**D4. Solana blockhash expiry.** An unsigned Solana transaction is valid for about 60–90 seconds, while an approval can sit for minutes. So `GET /v1/approvals/:id` rebuilds the unsigned transaction when the stored one is near expiry. The `payloadHash` never covers the blockhash, so the material terms stay identical. Approval must sign the latest stored bytes, and the stamp must be fresh (under 1 hour by Turnkey's rule; we use 5 minutes). Durable nonces are a later option.

**D5. Always Ask, the default, grants ZyroPay no signing capability at all.** No delegated user exists in the sub-org until the user enables autonomous mode for at least one agent.

**D6. Autonomous mode uses one delegated non-root API-key user per sub-org, created by the user's own passkey session.** The steps:

1. The API generates a P-256 key pair. It encrypts the private key with AES-256-GCM using `DELEGATED_KEY_ENCRYPTION_KEY` and stores it in `delegated_signers`.
2. The API returns the public key.
3. The app, stamping with the passkey, calls `fetchOrCreateP256ApiKeyUser` and `fetchOrCreatePolicies`. The user therefore creates both the delegated user and its bounds; ZyroPay never holds root.
4. Turnkey policies form a coarse **envelope**, which must fit in the 5-policy limit:
   - **P1, EVM ALLOW:**
     - consensus: `approvers.any(u, u.id == '<DA>')`;
     - `eth.tx.chain_id` is in the allowed chains;
     - either `eth.tx.to` is in the recipient allowlist with `eth.tx.data == '0x'` and `eth.tx.value <= <native cap>`, or `eth.tx.to` is an allowed token contract with selector `0xa9059cbb` (with an uploaded ABI, `contract_call_args` bounds the recipient and amount).
   - **P2, Solana ALLOW:**
     - consensus: the same delegated user;
     - `program_keys.all(p, p in [System, Token, Token-2022, ATA, ComputeBudget])`;
     - `transfers.all(t, t.to in allowlist && t.amount <= cap)`;
     - `spl_transfers.all(t, t.token_mint in allowed mints && t.to in allowlisted ATAs && t.amount <= cap)`.
   - **P3, DENY:** any transaction with `'ADDRESS_TABLE_LOOKUP'` in its account keys, as a circuit breaker.
   - **P4 (reserved), x402 EIP-712 `TransferWithAuthorization`:** the exact `eth.eip_712` field syntax must be verified before it is enabled.
5. Per-transaction native caps are derived from the USD per-transaction limit at policy-setting time, plus a price margin. They are a backstop; the precise USD limits are enforced by the server.
6. One delegated user serves all of a user's autonomous agents. The per-agent distinction is enforced only in the API, because the 5-policy limit makes per-agent Turnkey users impractical. **Honest framing for the product:** in autonomous mode the user grants ZyroPay's server a revocable signing capability. Turnkey bounds it per transaction, and ZyroPay bounds it per agent, per window and in USD. In Always Ask, ZyroPay can sign nothing.

**D7. Swaps are never autonomous in v1.** A router such as Jupiter can move any token the transaction touches, and Turnkey cannot constrain downstream program behaviour (https://docs.turnkey.com/features/policies/delegated-access/overview warns about this). This is encoded in `AUTONOMY_ELIGIBLE_TOOLS` in `@zyropay/shared/policy.ts`.

**D8. Revocation.** Revoking an agent sets `revoked`, revokes OAuth grants, cancels pending requests and releases reservations immediately on the server. When the last autonomous agent goes (or the user calls `DELETE /v1/delegated-signer`), the API revokes the delegated signer and destroys the encrypted key at once; every other autonomous agent falls back to `always_ask`. That is the effective revocation: the API was the only holder of the key, so nothing can sign with it any more. The Turnkey-side user and its `zyropay-delegated-*` policies are left in the sub-org, because only the user's passkey can delete them. They are inert, and the next autonomous setup deletes them with the passkey before it creates a new envelope (§2.6), so they never block Turnkey's 5-policy limit.

### What Turnkey policies can and cannot enforce

| Requirement                                                           | Turnkey                                                                  | Where enforced                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Allowed chains (EVM chain_id)                                         | **Yes**                                                                  | Turnkey + API                                       |
| Recipient allowlist, EVM native and ERC-20 (via ABI args or calldata) | **Yes**                                                                  | Turnkey + API                                       |
| Recipient allowlist, Solana SOL                                       | **Yes** (`transfers[*].to`)                                              | Turnkey + API                                       |
| Recipient allowlist, SPL                                              | **Partly**: sees the token account, not the owner. Allowlist the ATA     | Turnkey (ATA) + API (owner)                         |
| Per-transaction amount cap in token/native units                      | **Yes** (≤128-bit ints)                                                  | Turnkey + API                                       |
| Allowed programs / contracts                                          | **Yes** (`program_keys`, `eth.tx.to`)                                    | Turnkey + API                                       |
| Allowed token mints                                                   | **Yes** for Checked SPL instructions; plain `Transfer` has an empty mint | Turnkey (require Checked) + API                     |
| **USD-denominated limits**                                            | **No** (no price oracle)                                                 | **API only**, fail closed on missing price          |
| **Daily or monthly cumulative limits, rate limits**                   | **No** (velocity controls unreleased)                                    | **API only** (ledger + reservations under row lock) |
| Per-agent distinctions across one delegated user                      | **No**                                                                   | **API only**                                        |
| Session expiry per agent                                              | Partly (`time` / `Timestamp` on policies; key expiry)                    | API, plus optional Turnkey expiring API keys        |
| Indirect transfers (CPI, routers, internal EVM calls)                 | **No**                                                                   | Not allowed autonomously (D7)                       |
| Fees added after the policy check (sponsored Solana sends)            | **No**                                                                   | Avoided by using sign-only (D3)                     |
| Anything signed by the root user (passkey)                            | **No**: root bypasses policies                                           | By design: the user is sovereign                    |

**Consequence:** every USD, cumulative, per-agent and expiry rule lives in `evaluatePolicy` together with the reservation transaction. These rules fail closed. Turnkey policies are a second, coarser line of defence, so a fully compromised API still cannot exceed the per-transaction envelope or pay a non-allowlisted recipient.

### Open items (verify before implementation)

- The root-user layout of Auth Proxy `signup_v2` sub-orgs is not documented. The D1 check handles any deviation.
- The exact policy syntax for `eth.eip_712` message fields, needed for x402 on EVM. Until it is verified, x402 on EVM is **approval-only**: the API builds the EIP-3009 typed data, the user's passkey signs its digest with `SIGN_RAW_PAYLOAD_V2` (hexadecimal payload, no hashing), and the delegated key never signs a raw digest, because a Turnkey policy cannot bound one (policy reason `AUTONOMY_NOT_SUPPORTED`).
- Whether non-sponsored `SOL_SEND_TRANSACTION` is supported. This does not matter while D3 holds.
- A live check that a real Turnkey org accepts the delegated-signer envelope (`buildDelegatedPolicyEnvelope`) and that a delegated-key payment within it confirms. The envelope builder and its refusals are tested offline.
- If Turnkey ships velocity controls, add them as a third line of defence. They work in token units, so they can never replace USD limits.

---

## 4a. ADR-002: Cardano keys and signing (addendum to ADR-001)

**Status:** Accepted, pending one live check against a real Turnkey org (see Open items). **Sources:** https://docs.turnkey.com/features/networks/cardano, https://docs.turnkey.com/features/wallets, https://docs.turnkey.com/api-reference/activities/sign-raw-payload, Turnkey's example https://github.com/tkhq/sdk/tree/main/examples/chain-integrations/with-cardano, CIP-19 (https://cips.cardano.org/cip/CIP-0019), CIP-1852 (https://cips.cardano.org/cip/CIP-1852), CIP-3 (https://cips.cardano.org/cip/CIP-0003).

### Facts

1. Turnkey has no Cardano address format or transaction type. It supports Cardano at the curve level: an `ADDRESS_FORMAT_COMPRESSED` account on `CURVE_ED25519` whose address is the raw Ed25519 public key, and `SIGN_RAW_PAYLOAD` with `HASH_FUNCTION_NOT_APPLICABLE` over the 32-byte transaction body hash. The signature is `r || s` (64 bytes).
2. Turnkey policies cannot parse Cardano transactions; a raw-payload signature is opaque to them.
3. Cardano wallets (Daedalus, Yoroi, Eternl, Lace) derive keys with BIP32-Ed25519 from the mnemonic's entropy (Icarus, CIP-3) at `m/1852'/1815'/account'/role/index` with soft role/index, and show **base** addresses (payment key hash + stake key hash). Turnkey derives from the BIP-39 seed and does not document its Ed25519 scheme.

### Decision

**C1. One Cardano account per wallet:** `ADDRESS_FORMAT_COMPRESSED`, `CURVE_ED25519`, `PATH_FORMAT_BIP32`, path `m/1852'/1815'/0'/0'/0'` (`CARDANO_TURNKEY_ACCOUNT` in `@zyropay/shared`). Every level is hardened, because a soft Ed25519 step is not defined under SLIP-10 and Turnkey does not document what it does with one. New sub-orgs get it from the Auth Proxy sign-up params; existing wallets add it with the user's own passkey (`createWalletAccounts`, receive screen) and then `POST /v1/wallets/sync`. ZyroPay never writes to the sub-org.

**C2. The address is the CIP-19 enterprise address (type 6) of Blake2b-224(public key)** on the deployment's network: `addr1v…` in production, `addr_test1v…` in development. Wallet sync stores it with the public key (`wallet_addresses.public_key`), because the witness and Turnkey's `signWith` need the key and the address carries only its hash. There is no stake credential, so funds there do not earn staking rewards; delegation would need a second (stake) key and is out of scope.

**C3. Honest consequence:** this is **not** the address a Daedalus/Yoroi/Eternl wallet shows for the same recovery phrase, and importing the phrase into one of them will not show these funds (certainly a different path and address type, enterprise instead of base; very likely a different root derivation too, since Turnkey derives from the BIP-39 seed while those wallets use CIP-3 Icarus from the entropy). Recovery of Cardano funds is through Turnkey (passkey/export), or by deriving the same Turnkey key with a tool that reproduces Turnkey's derivation at that path. The receive screen and these docs say so; the app must not suggest otherwise.

**C4. User signing:** the review carries `rawPayload { payload: body hash, signWith: stored key }`; the app stamps `SIGN_RAW_PAYLOAD_V2` with the passkey. The API checks the stamp (passkey, URL, sub-org, `signWith` = stored key whose hash is the sender's payment credential, payload = the body hash it recomputes from the stored bytes, `HASH_FUNCTION_NOT_APPLICABLE`, freshness) plus `payloadHash` and the independent decode, forwards it, verifies the returned Ed25519 signature over the body hash, attaches the vkey witness, re-checks C7 and broadcasts. The signed bytes contain the reviewed body unchanged, so D2's byte equality holds for the part that is signed.

**C5. Cardano is never autonomous.** Because of fact 2, a delegated key could sign any Cardano transaction. `AUTONOMY_ELIGIBLE_FAMILIES` excludes Cardano in the policy engine (decision `require_approval`, reason `AUTONOMY_NOT_SUPPORTED`), `executeAutonomous` refuses Cardano defensively, and `TurnkeyClient.signWithDelegatedKey` refuses Cardano.

**C6. Mainnet/testnet separation:** one Blockfrost project id per network; production reads only `BLOCKFROST_PROJECT_ID_MAINNET`, development only `BLOCKFROST_PROJECT_ID_PREPROD`; an id of the wrong network refuses to start, and every Blockfrost client checks the genesis network magic. A deployment without the id for its mode does not serve Cardano (its requests fail `NETWORK_NOT_SUPPORTED`, balances omit it).

### Open items

- Verify against a real Turnkey org that the Auth Proxy and `createWalletAccounts` accept C1's account spec and that `list_wallet_accounts` returns the public key as the address (ZyroPay skips a Cardano account whose address is not a 32-byte hex key). MockTurnkey implements the documented behaviour.
- **Resolved 2026-10-30:** preprod end-to-end payments ran live, signed by a real Turnkey org (`docs/CARDANO_X402.md`, "Verified live"). The signing account was a C1 account on a real sub-org.
- UTxO reservation for concurrent sends from one address (today the second one fails with `inputs_spent`).

---

## 4b. ADR-003: Importing a wallet (recovery phrase or private key)

**Status:** Accepted, pending one live run against a real Turnkey org (see Open items). **Sources**:

- Turnkey, Import wallets: https://docs.turnkey.com/wallets/import-wallets (three steps; `INIT_IMPORT_WALLET` / `IMPORT_WALLET` / `INIT_IMPORT_PRIVATE_KEY` / `IMPORT_PRIVATE_KEY`; "The client encrypts the wallet mnemonic or private key to the TEK public key before it leaves the user's device"; "Neither Turnkey nor your application ever sees the plaintext").
- Turnkey, Enclave secure channels: https://docs.turnkey.com/security/enclave-secure-channels (HPKE `KEM_P256_HKDF_SHA256` / `KDF_HKDF_SHA256` / `AEAD_AES256GCM`, info `turnkey_hpke`; the client must verify that the target key is signed by the enclave before encrypting).
- Turnkey, React Native embedded wallets (import section): https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react-native/using-embedded-wallets (`importWallet({ mnemonic, walletName, accounts })`, `importPrivateKey({ privateKey, privateKeyName, addressFormats, curve, keyFormat: "HEXADECIMAL" | "SOLANA" })`).
- Turnkey API, list private keys: https://docs.turnkey.com/api-reference/queries/list-private-keys.
- Code read in this repo's lockfile: `@turnkey/react-native-wallet-kit` 2.3.9 `TurnkeyProvider.importWallet/importPrivateKey`, and `@turnkey/crypto` 2.13.2 `encryptWalletToBundle/encryptPrivateKeyToBundle` (https://www.npmjs.com/package/@turnkey/crypto).

### Facts

1. Wallet Kit 2.3 `importWallet` runs `initImportWallet` (stamped with `stampWith`), then `encryptWalletToBundle` from `@turnkey/crypto` on the device, then `importWallet` with the ciphertext (stamped with `stampWith`). `importPrivateKey` is the same with `initImportPrivateKey` / `encryptPrivateKeyToBundle`.
2. `encryptWalletToBundle` verifies the import bundle's signature against Turnkey's production signer key (`PRODUCTION_SIGNER_SIGN_PUBLIC_KEY`), checks that the signed data names the expected `organizationId` **and** `userId`, then HPKE-encrypts to the enclave's target public key. On any mismatch it throws before encrypting.
3. A private-key import accepts EVM keys as hex (`HEXADECIMAL`) and Solana keys as the base58 64-byte keypair (`SOLANA`; only the 32-byte secret half is encrypted). An imported private key is a Turnkey **private key**, not an HD wallet: it has no recovery phrase, no derivation path and no further accounts, and `list_wallets` does not return it.
4. Both need the passkey module and the Turnkey client, so neither runs in Expo Go.

### Decision

**I1. The secret only ever goes from the device to Turnkey's import enclave, as HPKE ciphertext.** The app checks it locally first: a phrase against the BIP-39 English wordlist and checksum (`@scure/bip39`), a key by format and curve (`@noble/curves`). Then `TurnkeyBridge` calls Wallet Kit `importWallet` / `importPrivateKey` with `StamperType.Passkey`, so both activities carry the user's passkey stamp (two passkey prompts). The secret is never sent to the ZyroPay API, logged, put into analytics or crash reports, stored in React Query, Zustand (persisted or not), navigation params, AsyncStorage or SecureStore, or written to the clipboard. It lives in a screen-local `SecretDraft` (`apps/mobile/src/lib/import/secret.ts`) that is wiped after a successful import, when the user switches between phrase and key, and when the screen unmounts. JavaScript strings cannot be zeroed, so "wiped" means that no reference is kept; the byte buffers of seeds and keys are zeroed.

**I2. Addresses are confirmed before anything leaves the device.** For Solana (`m/44'/501'/0'/0'`, SLIP-10 Ed25519) and EVM (`m/44'/60'/0'/0/0`, BIP-32), the app derives the addresses on the device and shows them. These are the standard paths, so they match Phantom/Solflare and MetaMask. After the import, the app compares Turnkey's accounts with that preview. On any difference it does **not** register the wallet (fail closed).

**I3. Cardano is opt-in and labelled honestly.** An imported phrase gets ZyroPay's ADR-002 account (`CARDANO_TURNKEY_ACCOUNT`, enterprise address). That is not the address Yoroi, Eternl or Daedalus shows for the same phrase (ADR-002 C3), so ADA held there does not appear. The chain picker says so, Cardano is off by default, and its address is shown only after Turnkey creates the key.

**I4. Registration uses the existing `POST /v1/wallets` with the Turnkey id only.** For a phrase, that is the new HD wallet id. For a raw key, it is the Turnkey private-key id: the API looks it up with a parent-org `list_private_keys` read (`TurnkeyDirectory.listPrivateKeyAccounts`) when the id is not a wallet, and links it as a one-account wallet whose `derivationPath` is `IMPORTED_KEY_DERIVATION_PATH` (`"imported-private-key"`, shared). Signing is unchanged, because Turnkey's `signWith` accepts a private-key address. Export of such a wallet uses Turnkey `EXPORT_PRIVATE_KEY` (decrypted on device and shown in the format it was imported in). No contract field, DB column or migration was added.

**I5. Defence in depth against key material reaching ZyroPay.** `findSecretMaterial` (`@zyropay/shared`) flags reserved key names (`mnemonic`, `seedPhrase`, `privateKey`, `secretKey`, `encryptedBundle`, …) and string values that are valid BIP-39 phrases (wordlist **and** checksum). The API refuses such bodies on every route with `BAD_REQUEST` before parsing, and logs only the reason, never the value or path. The app's `ApiClient` refuses to send them. A shared test walks every request schema (REST, internal, MCP tools) and asserts that none has such a field. Hex/base58 values are not inspected, because hashes, signatures and public keys share those shapes.

**I6. Screen hardening.** Screen capture is blocked with the export screen's hook (`usePreventScreenCapture`: Android `FLAG_SECURE`, iOS hidden from recordings), and a screenshot triggers a warning. A cover hides the screen when the app is inactive or in the background. Inputs turn off autocorrect, spellcheck, autofill and the copy menu (Android uses `visible-password`, which stops keyboard learning), and the key field is masked. Wordlist suggestions come from the app, not the keyboard. Paste is an explicit button, followed by a "Clear clipboard" step; on Android the copy tells the user that keyboard clipboard histories keep their own copy.

**I7. Where it runs.**

- **Development/production build** with Turnkey configured: the real import.
- **Expo Go** (not mock): a clear "Import needs the ZyroPay app build (not available in Expo Go)" state, with no inputs.
- **Local dev passkey** (`EXPO_PUBLIC_DEV_PASSKEY`): refused, because it cannot encrypt to Turnkey's enclave.
- **Mock mode** (`EXPO_PUBLIC_USE_MOCKS=1`, including Expo Go): typing and pasting are disabled. The only inputs are public test vectors (the BIP-39 "abandon … about" phrase, Hardhat account #0, and that phrase's Solana keypair). The simulated signer refuses anything else, and the result is labelled "simulated".

### Open items

- Run the import once against a real Turnkey org in a development build: two passkey prompts, the shape of the `getWalletAccounts` / `getPrivateKey` responses, and that `IMPORT_WALLET` accepts the `CARDANO_TURNKEY_ACCOUNT` spec (ADR-002 open item).
- Whether Turnkey requires unique wallet/private-key names per org is not documented. The app appends a short suffix to the Turnkey-side name, and the ZyroPay label is sent separately.
- Wallet Kit's `importWallet` refreshes the kit's wallet list afterwards; ZyroPay does not rely on that.

---

## 5. Repository layout and OWNERSHIP

```
apps/
  api/                 API worker (Hono)                         → API engineer
  mcp/                 MCP worker (OAuth + MCP tools)            → MCP engineer
  mobile/              Expo app (iOS, Android, web/PWA)          → Mobile engineer
  web-host/            static host for the web build (CSP, _headers) → Mobile engineer
  landing/             marketing site (Astro)                    → Brand
  docs/                public documentation site (Astro Starlight) → docs
packages/
  config/              tsconfig / eslint / prettier              → coordinator
  shared/              contracts (@zyropay/shared)               → coordinator approval required
  ui/                  RN components, tokens, brand marks        → Mobile engineer
  wallet/              Turnkey client, stamp verifiers, MockTurnkey → API engineer
  blockchain/          builders, broadcaster, portfolio, prices  → Chain engineer
  integrations/        plugins, on-ramp, push                    → Chain engineer
infrastructure/
  database/            Drizzle schema + migrations               → coordinator approval required
assets/brand/          ZyroPay mark (source of every icon)       → Brand
docs/                  architecture + ADRs, security, setup, deploy, generated contract docs
scripts/               local development, deploy, health check   → coordinator
tests/integration/
  e2e-smoke/           end-to-end local smoke (pnpm smoke)       → coordinator
```

| Engineer   | Owns                                           |
| ---------- | ---------------------------------------------- |
| **Mobile** | `apps/mobile`, `packages/ui`                   |
| **API**    | `apps/api`, `packages/wallet`                  |
| **MCP**    | `apps/mcp`                                     |
| **Chain**  | `packages/blockchain`, `packages/integrations` |

**Any change to `packages/shared`, `infrastructure/database` or `packages/config` needs coordinator approval.** These are the contracts every team builds against. Propose the change in a PR that touches only those packages, regenerate `docs/API.md` and `docs/MCP.md` with `pnpm --filter @zyropay/shared docs:generate`, and add a new Drizzle migration with `pnpm --filter @zyropay/db db:generate`. Never edit an existing migration. CI fails if the generated docs are stale (`docs.test.ts`).

Dependency versions are pinned once in the `catalog:` section of `pnpm-workspace.yaml`. Packages reference them as `"catalog:"`.
