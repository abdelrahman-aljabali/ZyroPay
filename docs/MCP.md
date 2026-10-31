# ZyroPay MCP tools

<!-- GENERATED from packages/shared/src/mcp.ts by packages/shared/scripts/contract-docs.ts. Do not edit by hand. -->

Source of truth: `mcpTools` and `mcpDiscoveryTools` in `@zyropay/shared`. The MCP server registers exactly these tools with exactly these schemas. It never signs: value-moving tools create transaction requests through `POST /internal/v1/agents/:agentId/transaction-requests` and return the request state (often `PENDING_APPROVAL`; poll with `get_approval_status`).

| tool | moves value |
| --- | --- |
| [`get_balance`](#get_balance) | no |
| [`get_wallets`](#get_wallets) | no |
| [`get_transactions`](#get_transactions) | no |
| [`send`](#send) | yes |
| [`swap`](#swap) | yes |
| [`pay_x402`](#pay_x402) | yes |
| [`get_approval_status`](#get_approval_status) | no |
| [`get_agent_policy`](#get_agent_policy) | no |
| [`find_agents`](#find_agents) | no |
| [`verify_agent`](#verify_agent) | no |

`find_agents` and `verify_agent` (`mcpDiscoveryTools`) read the public Masumi agent registry on Cardano. They are not policy tools (`allowedTools`): every active agent with the read scope may call them.

## get_balance

Portfolio balances (base units + decimals) and fiat values for allowed wallets.

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | no |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | no |  |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `portfolio` | object | yes |  |

## get_wallets

Wallets and addresses this agent may use.

**Input:** object (empty object)

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `wallets` | object[] | yes |  |

## get_transactions

Recent normalized transactions for allowed wallets.

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | no |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `transactions` | object[] | yes |  |
| `nextCursor` | string \| null | yes |  |

## send

Request a transfer. Returns a transaction request; it may need the user's approval in the ZyroPay app.

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes | Wallet to spend from (see get_wallets). |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `idempotencyKey` | string | yes | Unique per logical payment; retries with the same key return the same request. |
| `to` | string | yes |  |
| `assetId` | string | yes |  |
| `amount` | string | yes | Integer amount in base units (e.g. lamports, wei, lovelace). |
| `decimals` | integer | yes | Decimals of the asset; must match the asset. |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

## swap

Request a token swap through the Jupiter plugin. Swaps are available on Solana mainnet only: on any other network, including every test network (Solana Devnet, Ethereum Sepolia, Base Sepolia, Cardano Preprod), the request fails with SWAP_UNAVAILABLE_ON_NETWORK and nothing is created. In that case tell the user that swaps are not available on that network; do not ask them for token mint addresses.

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes | Wallet to spend from (see get_wallets). |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `idempotencyKey` | string | yes | Unique per logical payment; retries with the same key return the same request. |
| `inputAssetId` | string | yes |  |
| `outputAssetId` | string | yes |  |
| `amount` | string | yes | Input amount in base units. |
| `decimals` | integer | yes | Decimals of the input asset. |
| `slippageBps` | integer | no |  |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

## pay_x402

Pay for an HTTP resource that responded 402 Payment Required (x402).

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes | Wallet to spend from (see get_wallets). |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `idempotencyKey` | string | yes | Unique per logical payment; retries with the same key return the same request. |
| `resourceUrl` | string (uri) | yes |  |
| `method` | "GET" \| "POST" | no |  |
| `maxAmount` | string | yes | Upper bound the agent accepts, base units. |
| `assetId` | string | yes |  |
| `decimals` | integer | yes |  |
| `escrow` | boolean | no | Cardano only. true: pay into Masumi escrow (the 402 must offer assetTransferMethod masumi); the seller is paid only after delivering, and the user can get a refund otherwise. false: pay directly. Omitted: escrow when the 402 offers it and the agent's policy requires escrow, else direct. |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

## get_approval_status

Current state of a transaction request created by this agent. For pay_x402, once the user has approved and the payment is signed, this call delivers the payment to the resource and returns the paid response in `resource` (exactly once).

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |
| `resource` | object | no |  |

## get_agent_policy

This agent's permissions, mode and spending limits.

**Input:** object (empty object)

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `policy` | object | yes |  |

## find_agents

Find AI agents registered in the Masumi agent registry on Cardano (on-chain NFTs), e.g. to buy a service from one. Returns name, description, endpoint (apiBaseUrl), capability, tags, pricing and whether it is payable through Masumi escrow.

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `query` | string | no | Words to look for in name, description, tags and capability. |
| `capability` | string | no | Exact capability name. |
| `tag` | string | no |  |
| `maxPrice` | object | no | Only agents whose fixed price is at most this (free agents included). |
| `limit` | integer | no |  |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agents` | object[] | yes |  |
| `scanned` | integer | yes |  |
| `truncated` | boolean | yes |  |

## verify_agent

Check a Masumi agent's on-chain registry identity before paying it: the registry NFT is live and held by a payment key, it advertises the canonical Masumi escrow, and its endpoint is public https (and covers resourceUrl, when given).

**Input:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentIdentifier` | string | yes | The agent's agentIdentifier from find_agents (120 hex characters). |
| `resourceUrl` | string (uri) | no | The paid URL you intend to call; must be under the agent's apiBaseUrl. |
| `sellerAddress` | string | no | The seller address of a 402 you received, to check it holds the NFT. |

**Output:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | boolean | yes |  |
| `reasons` | "invalid_identifier" \| "network_mismatch" \| "wrong_policy" \| "not_found" \| "burned" \| "multiple_holders" \| "metadata_invalid" \| "holder_not_key_address" \| "seller_missing" \| "seller_invalid" \| "seller_mismatch" \| "no_escrow_source" \| "endpoint_invalid" \| "endpoint_insecure" \| "endpoint_mismatch" \| "price_mismatch" \| "not_trusted" \| "upstream_unavailable"[] | yes |  |
| `details` | string[] | yes |  |
| `sellerChecked` | boolean | yes |  |
| `agent` | object \| null | yes |  |

<!-- HAND-WRITTEN BELOW -->
## Server guide

Hand-written guide for the remote MCP server (`apps/mcp`). The generator keeps everything after the marker and `docs.test.ts` ignores it.

Every external claim links its source.

---

### 1. What it is

`apps/mcp` is a Cloudflare Worker that lets an AI client (Claude, ChatGPT, Grok, Claude Code, any MCP client) act on a ZyroPay user's behalf. It has three jobs:

1. **OAuth 2.1 authorization server and protected resource** for one resource, `https://<mcp host>/mcp`.
2. **Device-code-style consent.** The browser shows a short user code, and the user approves in the ZyroPay app, with their passkey session. The app also sets the agent's initial policy: Always Ask, spending disabled.
3. **An MCP server over Streamable HTTP** that exposes the 8 shared tools and translates each call into one API call under `/internal/v1/*`.

It **never signs**. It holds no Turnkey credential, no database URL and no user session. Its only credential toward ZyroPay is `INTERNAL_SERVICE_TOKEN`. The API re-checks on every internal call that the agent is active, and the API is the policy authority.

```
 AI client (Claude / ChatGPT / Grok)                     ZyroPay app (passkey session)
   │  OAuth 2.1 + PKCE (S256), resource=/mcp                 │ enters user code, approves,
   │  Streamable HTTP, Bearer <opaque token>                 │ sets policy (always_ask)
   ▼                                                         ▼
 ┌───────────────────────── apps/mcp (Worker) ─────────┐   ┌──────────── apps/api ───────────┐
 │ index.ts      size limits · Origin check · rate lim │   │ /v1/agent-connections/claim     │
 │ OAuthProvider (@cloudflare/workers-oauth-provider)  │   │ /v1/agent-connections/:id/...   │
 │   /.well-known/*, /oauth/register, /oauth/token     │   │                                 │
 │ oauth/authorize.ts  /authorize, /authorize/status   │──►│ /internal/v1/agent-connections  │
 │ mcp/handler.ts      /mcp  (MCP SDK 1.32, stateless) │──►│ /internal/v1/agents/:id/*       │
 │ internal/revoke.ts  /internal/v1/agents/:id/revoke- │◄──│ (on agent revoke)               │
 │                     grants                          │   │ policy engine, approvals,       │
 │ OAUTH_KV: clients, grants, hashed tokens, encrypted │   │ signing (never in MCP)          │
 │           props {userId, agentId, connectionId}     │   └─────────────────────────────────┘
 └─────────────────────────────────────────────────────┘
```

| Path                                          | Owner    | Purpose                                                                        |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `/.well-known/oauth-protected-resource/mcp`   | provider | RFC 9728 protected resource metadata                                           |
| `/.well-known/oauth-authorization-server`     | provider | RFC 8414 authorization server metadata                                         |
| `/oauth/register`                             | provider | RFC 7591 dynamic client registration (DCR, the fallback; CIMD preferred)       |
| `/oauth/token`                                | provider | code exchange, refresh (rotating), RFC 7009 revocation (`revocation_endpoint`) |
| `/authorize` (GET, POST), `/authorize/status` | this app | consent: user code page, poll, completion                                      |
| `/mcp` (POST)                                 | this app | MCP Streamable HTTP; GET and DELETE answer 405 (stateless)                     |
| `/internal/v1/agents/:agentId/revoke-grants`  | this app | API → MCP revocation push (internal token)                                     |
| `/health`                                     | this app | liveness                                                                       |

### 2. Standards implemented

**Authorization: MCP 2026-07-28**, the current revision (https://modelcontextprotocol.io/specification/versioning, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). It is implemented through `@cloudflare/workers-oauth-provider` 1.2.3, which targets exactly this revision (its README "Standards" section). Each requirement and where it lives:

| Requirement                                                                                                                                                                              | How                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth 2.1 authorization code only; no implicit grant                                                                                                                                     | provider; tested (`response_type=token` is refused)                                                                                                                                                              |
| PKCE, S256 only ([security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations))                                        | `code_challenge_methods_supported: ["S256"]`. **We additionally require PKCE for every client**, confidential ones included (`oauth/authorize.ts`), although the library would let confidential clients skip it  |
| RFC 9728 protected resource metadata + `WWW-Authenticate: Bearer resource_metadata=…, scope=…` on 401                                                                                    | provider; tested                                                                                                                                                                                                 |
| RFC 8414 AS metadata                                                                                                                                                                     | provider; tested                                                                                                                                                                                                 |
| RFC 8707 resource indicators; token audience = `https://<host>/mcp`                                                                                                                      | every grant and token is bound to the one resource; other values give `invalid_target` (tested)                                                                                                                  |
| Client registration order: pre-registered, then CIMD, then DCR ([client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)) | CIMD enabled (`clientIdMetadataDocumentEnabled` + `global_fetch_strictly_public` flag; advertised, tested). DCR enabled as the fallback (deprecated by the spec, still needed). Pre-registration: see Open items |
| RFC 9207 `iss` in authorization responses                                                                                                                                                | always on, on success and error redirects (tested)                                                                                                                                                               |
| Exact redirect URI match; https or loopback only                                                                                                                                         | provider (RFC 8252 loopback port handling); tested for unregistered, prefix and remote-http cases                                                                                                                |
| Refresh token rotation for public clients                                                                                                                                                | rotate on use. The previous token stays valid until the new one is first used; tested                                                                                                                            |
| Token revocation (RFC 7009)                                                                                                                                                              | `revocation_endpoint` = token endpoint; tested                                                                                                                                                                   |

**Transport: Streamable HTTP via `@modelcontextprotocol/sdk` 1.32.1**, `WebStandardStreamableHTTPServerTransport`, stateless (no `Mcp-Session-Id`), JSON responses. SDK 1.32.1 speaks protocol versions up to **2025-11-25** (`LATEST_PROTOCOL_VERSION` in `sdk/types.js`), i.e. the `initialize` handshake that Claude, ChatGPT and Grok use today (Claude: https://zuplo.com/learn/mcp/compatibility/clients/claude-connectors.md, "still runs the initialize handshake").

Not served: the 2026-07-28 **transport** changes, which remove sessions and GET streams and add the `Mcp-Method`/`Mcp-Name` headers (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). They need the v2 SDK (`@modelcontextprotocol/server` 2.x) behind `agents`' `createMcpHandler()`. The brief pins SDK 1.32. A stateless 2025-11-25 server already behaves like a 2026-07-28 server in the parts that overlap: one POST endpoint, 405 on GET and DELETE, no sessions. **Upgrade path:** swap `mcp/handler.ts` to `createMcpHandler` with the v2 SDK, which serves both eras. The tool layer and the OAuth layer stay as they are.

**Why not `McpAgent`.** Cloudflare's `agents` package (0.28.1) documents `McpAgent` as "deprecated and feature-frozen". It needs a Durable Object per session, and our tools are stateless request/response. `createMcpHandler` requires the v2 SDK. So the worker uses the raw SDK 1.32 transport, which the same documentation lists as a supported approach, and does not depend on `agents` at all.

### 3. OAuth flow

```
Client                     MCP worker                          API (internal)            App (user)
  │ POST /mcp (no token)      │                                    │                        │
  │──────────────────────────►│ 401 WWW-Authenticate:              │                        │
  │◄──────────────────────────│  resource_metadata=…/oauth-protected-resource/mcp, scope=… │
  │ GET PRM, GET AS metadata  │                                    │                        │
  │ (CIMD client_id URL, or POST /oauth/register)                   │                        │
  │ browser → GET /authorize?response_type=code&client_id&redirect_uri&state               │
  │            &code_challenge(S256)&resource=…/mcp&scope           │                        │
  │                           │ parseAuthRequest: client, exact     │                        │
  │                           │ redirect URI, resource; PKCE S256   │                        │
  │                           │ POST /internal/v1/agent-connections ─►  pending, userCode     │
  │                           │ beginConsent → one-time handle +    │                        │
  │                           │ __Host- cookie bound to this browser│                        │
  │ page: "ABCD-1234 — Approve in the ZyroPay app"                 │                        │
  │                           │                                    │ claim(userCode) ◄──────│
  │ poll /authorize/status?ticket=<connId.HMAC>                    │ approve(wallets, nets)│
  │                           │ GET /internal/v1/agent-connections/:id ─► approved,          │
  │                           │                                    │ userId, agentId       │
  │ page auto-submits POST /authorize (handle + cookie)            │                        │
  │                           │ approveConsent (CSRF check) →       │                        │
  │                           │ completeAuthorization(props={userId,agentId,connectionId})  │
  │ 302 redirect_uri?code&state&iss                                 │                        │
  │ POST /oauth/token (code, code_verifier, resource)               │                        │
  │◄── access_token (900 s), refresh_token (rotating; 30 d, 7 d idle)                       │
  │ POST /mcp Bearer …  → tools                                     │                        │
```

- **Denial or expiry.** The app rejects, or the code expires (`AGENT_CONNECTION_CODE_TTL_SECONDS`). The POST then redirects with `error=access_denied`, `state` and `iss`.
- **Errors that cannot be redirected** render a local page and never redirect: unknown client, unregistered redirect URI, a used, expired or foreign consent handle.
- **CSRF and session fixation.** The form carries only an opaque one-time handle. The provider binds the handle to the opening browser with a `__Host-` cookie (Secure, HttpOnly). The authorization request itself is kept server-side.
  - The poll endpoint takes an HMAC ticket (`MCP_OAUTH_COOKIE_SECRET`), never the handle.
  - Tested: a post without the cookie, with another consent's cookie, and a second use of a handle are all refused.
- **Page hardening.** The page sets:
  - a strict CSP: `default-src 'none'`, a nonce'd script and style, `form-action` limited to self plus the redirect origin, and `frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`, `no-store` and `no-referrer`.
  - Client names and URIs are escaped. They come from DCR or CIMD and are attacker-chosen.
- **What the app shows.** The connection's `clientName` is the client's name, suffixed with ` · <verified domain>` for CIMD clients and ` (unverified)` for DCR clients. Its `redirectUri` is the exact redirect URI. The app should show both.
- **Each grant is one agent.** `revokeExistingGrants: false` means connecting a second Claude does not silently cut off the first. Each agent is disconnected in the app.

**Scopes:**

| Scope              | Meaning                           |
| ------------------ | --------------------------------- |
| `wallet:read`      | Read tools                        |
| `payments:request` | Create transaction requests       |
| `offline_access`   | Optional, requests refresh tokens |

- Both baseline scopes are granted together, because consent in the app is all-or-nothing.
- The real authority is the agent **policy** in the API, not the scope.

### 4. Tools

The schemas are exactly `mcpTools` (see [`MCP.md`](MCP.md)). Inputs are validated by the SDK with the shared Zod schemas, then again in our handler. Outputs are validated against the shared output schemas. A response from the API that violates the contract is never passed on (`UPSTREAM_UNAVAILABLE`).

| Tool                  | Annotations                                 | API call                                                                                                    |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `get_balance`         | readOnly, idempotent                        | `GET /internal/v1/agents/:id/portfolio`                                                                     |
| `get_wallets`         | readOnly, idempotent                        | `GET /internal/v1/agents/:id/context` (wallets)                                                             |
| `get_transactions`    | readOnly, idempotent                        | `GET /internal/v1/agents/:id/transactions`                                                                  |
| `get_agent_policy`    | readOnly, idempotent                        | `GET /internal/v1/agents/:id/context` (agent.policy)                                                        |
| `get_approval_status` | readOnly, idempotent, openWorld             | `GET /internal/v1/agents/:id/transaction-requests/:requestId`; for a signed x402 payment also `POST …/x402-payment`, the paid retry and `POST …/x402-delivery` |
| `send`                | destructive, idempotent (by key), openWorld | `POST /internal/v1/agents/:id/transaction-requests` `{tool:"send", input}`                                  |
| `swap`                | destructive, idempotent (by key), openWorld | same, `{tool:"swap", input}`                                                                                |
| `pay_x402`            | destructive, idempotent (by key), openWorld | probe the resource for its 402 requirements, then the same, `{tool:"pay_x402", input, paymentRequirements}` |

- **Value-moving tools only create requests.** The result is the API's `TransactionRequestResult`, usually `PENDING_APPROVAL` with an `approvalUrl`. The model is told to poll `get_approval_status`.
- **Idempotency.** The tool's `idempotencyKey` is sent both in the body and as the `Idempotency-Key` header. Tested: a retry returns the same request.
- **The x402 probe** is a single fetch of the agent-supplied URL. It is hardened:
  - public `https` hosts only; IP literals, `localhost` and `.internal`/`.local` hosts are refused;
  - no redirects, an 8 s timeout and a 64 KiB cap;
  - the `global_fetch_strictly_public` flag is set;
  - it accepts v1 (JSON body) and v2 (`PAYMENT-REQUIRED` header).
  - The requirements go to the API (the policy authority) and are never shown to the model.
- **x402 delivery** (`mcp/x402-delivery.ts`). When `get_approval_status` sees `x402.status: "ready"` (signed, Cardano today), it fetches the payment header from the API, retries the bound resource URL with it and reports the answer; the agent gets the paid response in `resource` once.
  - The retry is hardened like the probe (public `https`, the exact URL the API bound, no redirects, 64 KiB cap) with a 90 s timeout, which covers a facilitator waiting for confirmation.
  - It runs under `waitUntil` and parks the outcome in KV (15 min) before reporting, so a client that gave up (the SDK's 60 s default) gets the result on its next call, and a failed report is retried without paying the resource again.
  - A per-request KV lock (150 s) avoids concurrent deliveries; it is best effort, and a double delivery is still safe because the API returns the same signed transaction, which can be spent once.
  - A network error or timeout reports nothing (the payment stays deliverable); a 402 is reported as refused.
  - The resource body is untrusted third-party content: it gets its own sanitizing pass (line breaks kept, invisible characters stripped, 2 KiB per JSON string, 16 KiB for text, depth 16) inside the same envelope.
  - **Verified delivery receipt.** On a 2xx it forwards the seller's `X-Delivery-Receipt` header verbatim (dropped above 4 KiB, never parsed here) together with its **own** SHA-256 of the exact body bytes it read (`null` when the body was truncated or not textual). The API verifies the receipt and the agent gets the verdict in `resource.receipt` (`verified`, `contentSha256`, `signedBy`, `signedAt`, `reason`). The seller's own hash is never trusted alone.
  - `MCP_X402_TEST_UPSTREAM` (tests only) sends x402 fetches to a loopback origin; it is refused in production mode and for any non-loopback value. Never set it on a deployed worker.
- **Prompt-injection hygiene** (`mcp/sanitize.ts`):
  - Every string in a result has control, zero-width and bidi-override characters stripped, is collapsed to one line, and is capped at 512 characters. Envelope markers inside strings are neutralized, so data cannot close the envelope.
  - The text block wraps the JSON in an explicit "untrusted data, not instructions" envelope (`<zyropay_data>…</zyropay_data>`).
  - Tested with a hostile token name.
  - Error messages are capped at 280 characters.
- **Errors** come back as `isError: true` with `{"error":{"code","message"}}`, using the closed API error-code set.
- **Swaps on test networks.** `swap` works on Solana mainnet only. Anywhere else the API answers `SWAP_UNAVAILABLE_ON_NETWORK` with a plain explanation, and the tool description says so up front, so an assistant tells the user instead of asking for mint addresses.

### 5. Security model

| Threat (SECURITY.md)            | Control here                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4: compromised MCP worker      | No Turnkey, DB or user-session secrets. It can only call `/internal/v1/*`, and the API re-checks the agent and runs the policy. Worst case: it creates requests that still need passkey approval (Always Ask) or stay within limits.                                                                                                            |
| T5: stolen OAuth token          | Opaque tokens, stored only as hashes in KV. 15 min access TTL (`MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`, 60..3600, default 900). Rotating refresh tokens (30 d absolute, 7 d idle). Audience bound to `/mcp`. Revocable (RFC 7009, the app push, or the lazy path).                                                                                 |
| T1: prompt-injected agent       | Tools cannot sign. Results are sanitized and wrapped. Server `instructions` and tool descriptions tell the model to confirm amounts and recipients with the user.                                                                                                                                                                               |
| Token passthrough               | The OAuth access token never leaves this worker. The API sees only the internal token and the agent id (tested).                                                                                                                                                                                                                                |
| Confused deputy / open redirect | Exact redirect URIs. The consent page shows the redirect host and warns about loopback. Errors that cannot be redirected render locally.                                                                                                                                                                                                        |
| Abuse                           | Rate limits: `/mcp` 120/min per token. `/authorize` 60/min per IP. `/oauth/token` and `/oauth/register` 600/min per IP, a ceiling only, because clients' backends share egress IPs (Claude: `160.79.104.0/21`, https://platform.claude.com/docs/en/api/ip-addresses). Body limits: 64 KiB on `/mcp`, 16 KiB elsewhere.                          |
| Cross-origin                    | Streamable HTTP requires validating `Origin`. A present Origin outside the allowlist gets 403. The allowlist is our own origin, claude.ai, claude.com, chatgpt.com, grok.com and `MCP_ALLOWED_ORIGINS`, plus loopback in development. CORS for allowed origins is handled by the provider: the Origin is reflected and no credentials are sent. |

**Revocation** works on two paths, and both are tested:

- **Push.** When the user disconnects an agent, the API calls `POST /internal/v1/agents/:agentId/revoke-grants` with `{userId}` and the internal token. Every grant with that `agentId`, and therefore every access and refresh token, is revoked at once.
- **Lazy (fail-safe if the push is lost).** Any internal call for a revoked agent returns `FORBIDDEN`. The worker confirms this with `GET …/context`, revokes the grant, and tells the model to ask the user to reconnect. The next request gets 401, and a refresh gets `invalid_grant`.

**Audit.** Every grant event and every tool call is written to the Workers log as `{"audit": AuditEvent}`. The event types are:

- `oauth.connection_started`
- `oauth.grant_created`, `oauth.grant_denied`, `oauth.grant_expired`, `oauth.grant_revoked`
- `mcp.tool_call`, with its outcome, error code, `requestId`, `idempotencyKey` and duration

Events never contain tokens, addresses or amounts. With `MCP_AUDIT_SINK=api` the event is also posted to `POST /internal/v1/audit-events` (`internalRecordAuditEvent`, implemented by the API). Transaction requests are audited by the API itself in any case.

### 6. Adding the connector

The server URL users enter is **`https://<mcp host>/mcp`**. It must equal the PRM `resource` exactly.

#### Claude (claude.ai, Desktop, mobile; Claude Code)

**Verdict: supported.**

- **Where:** Settings → Connectors → Add custom connector, then enter the URL. Leave the OAuth client fields empty. Team and Enterprise: an Owner adds it, then members connect individually (https://claude.com/docs/connectors/custom/add-unlisted).
- **Plans:** Free (one custom connector), Pro, Max, Team, Enterprise.
- **Client registration:** Claude prefers CIMD. It picks CIMD only when the metadata advertises `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported` (https://claude.com/docs/connectors/building/authentication). We advertise both (tested), so Claude uses its CIMD client.
  - Its CIMD document is at `https://claude.ai/oauth/mcp-oauth-client-metadata`, with redirect `https://claude.ai/api/mcp/auth_callback`.
  - DCR is the fallback.
- **Token requests:** Claude sends `resource`, PKCE S256 and form-encoded token requests, and refreshes on 401 (https://claude.com/docs/connectors/building/troubleshooting).
- **Claude Code** uses CIMD `https://claude.ai/oauth/claude-code-client-metadata` with loopback redirects, which our RFC 8252 handling covers: `claude mcp add --transport http zyropay https://<host>/mcp`.
- **Anthropic Messages API MCP connector:** this has no OAuth flow. The developer passes an access token as `authorization_token` (https://platform.claude.com/docs/en/agents-and-tools/mcp-connector). It works with a token obtained through our flow, which expires after 15 min.

#### ChatGPT (Apps SDK / developer mode)

**Verdict: supported by design. Not yet verified against a live ChatGPT workspace.**

- **Where:** chatgpt.com → Plugins/Connectors → "Add custom MCP server", then enter the URL (https://developers.openai.com/plugins/deploy/connect-chatgpt.md).
- **Plans:** Developer mode and custom MCP require a plan or workspace that allows them. This is UNVERIFIED in the official help (https://help.openai.com/en/articles/12584461 was unreachable). Reports say Business, Enterprise and Edu.
- **Client registration:** ChatGPT prefers CIMD (https://developers.openai.com/apps-sdk/build/auth).
  - Its document is `https://chatgpt.com/oauth/client.json`. It offers `none` and `private_key_jwt`, and our provider supports both.
- **Redirect URI:** ChatGPT uses the stable `https://chatgpt.com/connector_platform_oauth_redirect` only when all three hold:
  - the AS advertises `authorization_response_iss_parameter_supported`;
  - `issuer` equals the PRM `authorization_servers` entry;
  - `iss` is returned on every authorization response.
  - All three hold here (tested). Otherwise ChatGPT uses `https://chatgpt.com/connector/oauth/{callback_id}`.
- **Other requirements:** ChatGPT sends `resource` on both requests. Our tool annotations (`readOnlyHint` / `destructiveHint`) drive its confirmation UX.

#### Grok (grok.com)

**Verdict: probably works, UNVERIFIED.**

- **Where:** grok.com/connectors → New Connector → Custom → URL. "If your MCP server requires OAuth … you will still complete that flow in Grok" (https://docs.x.ai/grok/connectors). Business and Enterprise need admin provisioning (https://docs.x.ai/grok/connector-management).
- **Not documented by xAI:** whether Grok uses DCR or CIMD, whether it sends `resource`, and whether it reads PRM.
- **Third-party evidence:** X's own Ads MCP docs show a manual Client ID form, with redirect `https://grok.com/connectors-oauth-exchange-code/` and auth method "none (PKCE only)" (https://docs.x.com/x-ads-api/mcp).
  - If Grok needs a manually entered client ID, ZyroPay must pre-register a public client with that redirect URI. The provider supports this (`OAuthHelpers.createClient`), but no admin path for it exists yet (see Open items).
- **xAI API "Remote MCP tools"** (https://docs.x.ai/developers/tools/remote-mcp) runs no OAuth flow. The developer supplies `authorization` (a bearer token), the same as Anthropic's API.

### 7. Configuration

| Name                                                                   | Kind                | Notes                                                                                  |
| ---------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `ZYROPAY_MODE`                                                         | var                 | `production` requires https everywhere and disables the loopback Origin allowance      |
| `MCP_PUBLIC_URL`                                                       | var                 | bare origin; issuer = origin, resource = origin + `/mcp`                               |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`                                   | var                 | 60..3600, default 900                                                                  |
| `INTERNAL_SERVICE_TOKEN` (+ `_PREVIOUS` for rotation)                  | secret              | ≥ 32 chars; also authenticates the API's revoke push                                   |
| `MCP_OAUTH_COOKIE_SECRET`                                              | secret              | ≥ 32 chars; HMAC for poll tickets                                                      |
| `API` service binding                                                  | binding             | production path to `zyropay-api`                                                       |
| `API_INTERNAL_URL`                                                     | var (dev/test)      | **new**: used instead of the binding when set                                          |
| `MCP_ALLOWED_ORIGINS`                                                  | var                 | **new**, optional: extra browser origins for `/mcp`                                    |
| `MCP_AUDIT_SINK`                                                       | var                 | **new**: `log` (default) or `api`                                                      |
| `OAUTH_KV`                                                             | KV                  | create with `wrangler kv namespace create OAUTH_KV` and put the id in `wrangler.jsonc` |
| `MCP_RATE_LIMITER`, `AUTH_RATE_LIMITER`, `OAUTH_ENDPOINT_RATE_LIMITER` | rate-limit bindings | declared in `wrangler.jsonc`                                                           |

There is no token-signing secret: tokens are opaque and stored hashed in KV, and no JWTs are issued.

Local: `pnpm --filter @zyropay/mcp dev` with `apps/mcp/.dev.vars` (`INTERNAL_SERVICE_TOKEN`, `MCP_OAUTH_COOKIE_SECRET`, `API_INTERNAL_URL=http://localhost:8787`).

### 8. Tests

`pnpm --filter @zyropay/mcp test`:

- `tests/unit`: sanitizer, x402 probe, limits, config, contract client (Node).
- `tests/e2e`: OAuth and tools, in workerd via wrangler `unstable_dev`.
- `tests/security`: cross-cutting OAuth attacks, plus a 62 s access-token expiry test.

The end-to-end tests drive the real worker with the official MCP SDK client against `tests/support/fake-api.ts`. That file is a **test double** of the API's internal endpoints and validates every request and response against the shared contracts.

`@cloudflare/vitest-pool-workers` 0.23.0 needs vitest ^4.1, and the repo pins vitest 5.0.5, so it is not used.

### 9. Open items

- **Pre-registered clients** (for Grok or any client that wants a manual client ID): add an internal admin path that calls `OAuthHelpers.createClient`.
- **2026-07-28 transport:** see §2, "Upgrade path".
- **QR code / deep link** on the authorize page: not implemented. The page shows the code and instructions.
