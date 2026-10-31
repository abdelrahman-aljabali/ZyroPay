---
title: "Trust boundaries"
description: "Every boundary in ZyroPay, the credential that crosses it and the controls on it."
---

A trust boundary is where one party's code hands something to another's. For each, the credential
that crosses it and what checks it.

| Boundary                   | Crossing credential                                                                                                        | Controls                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Your device ↔ Turnkey      | Your passkey (WebAuthn) or a session key stored on the device                                                              | Turnkey verifies stamps; approvals require a passkey stamp (`X-Stamp-Webauthn`)                                                    |
| App ↔ API                  | Opaque access token (15 min, stored hashed) and a rotating refresh token with reuse detection                              | Zod validation of every request; ownership check on every id; rate limits                                                          |
| API ↔ Turnkey              | Your forwarded stamps (cannot be altered); a read-only parent-org key; the delegated key (Autonomous only, policy-bounded) | Byte-equality checks on stamped bodies; the delegated key encrypted at rest                                                        |
| AI client ↔ MCP worker     | OAuth 2.1 access token (PKCE, one agent)                                                                                   | Token maps to `{userId, agentId}` only; audience bound to `/mcp`; Origin allowlist; rate limits                                    |
| MCP worker ↔ API           | The internal service token                                                                                                 | `/internal/*` only; the API re-checks the agent on every call; the MCP worker has no database or Turnkey access                    |
| MCP worker ↔ x402 seller   | None (public HTTPS); the signed payment rides in `PAYMENT-SIGNATURE`                                                       | Public `https` only, no redirects, exact bound URL, size and time caps; responses sanitized and wrapped as untrusted               |
| Seller → ZyroPay           | The seller's Ed25519 key behind `payTo` (receipts) and its COSE signature on escrow terms                                  | Receipts verified against the paid address and the MCP worker's own hash; terms verified before anything is signed                 |
| API ↔ chains and providers | Provider API keys (Blockfrost, Helius, Alchemy, CoinGecko)                                                                 | One provider per network, genesis or chain-id checked; independent decode before signing; fail-closed valuations                   |
| API ↔ Masumi registry      | None (public chain data through Blockfrost)                                                                                | Size and time caps; identity verified on chain; any failure refuses the quote                                                      |
| Providers → API (webhooks) | HMAC or provider signature                                                                                                 | Signature over the raw body, idempotent storage, reconciliation with our own RPC before any state change                           |
| Landing page ↔ web app     | None; the landing page frames the app on desktop                                                                           | CSP `frame-ancestors` allowlist of exactly the landing origins; no message channel into the app; passkey prompts are browser-owned |

What each party can see and what happens if one of them lies is on [Who you trust](/security/trust/).
