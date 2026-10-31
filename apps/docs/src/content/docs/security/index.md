---
title: "Threat model"
description: "What ZyroPay protects, who might attack it, and the control for each threat, with its status. Not audited."
---

:::caution[Not audited]
No external security review of ZyroPay has taken place, and the threat model has not been signed off.
Everything here runs on test networks. The status of each control is what the code and its tests
show, checked against the repository on 2026-10-30.
:::

## What is protected

1. **Your funds:** the keys in your Turnkey sub-organization.
2. **Signing capability:** your passkey, Turnkey session keys, the delegated key (Autonomous only), the
   internal service token and OAuth tokens.
3. **Integrity of approvals:** what you review must be exactly what is signed.
4. **Agent policy and spending state:** limits, reservations, the ledger.
5. **Personal data:** addresses linked to your account, push tokens.
6. **Integrity of a purchase:** you should get what you paid for, or a way to get the money back.

## Threats and controls

| #   | Threat                                                                      | Primary controls                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | A prompt-injected or malicious agent tries to drain funds                   | New agents: Always Ask, spending off; recipient allowlist; USD limits with reservations; Turnkey envelope; swaps never autonomous; Cardano only within an on-chain allowance; untrusted MCP data |
| T2  | The recipient or amount is swapped between approval and signing             | Approval bound to `payloadHash`; stamped body byte-equal to the reviewed bytes; independent decode; signed bytes re-checked before broadcast                                                     |
| T3  | The API worker is compromised                                               | No root credential; Always Ask gives it no signing capability; the delegated key is bounded by an envelope your passkey created. Gap: it controls the review text ([trust](/security/trust/))    |
| T4  | The MCP worker is compromised                                               | No Turnkey or database access; every internal call re-checks the agent; payments still pass policy and, on Cardano, your passkey or the ledger-enforced allowance                                |
| T5  | An OAuth token is stolen                                                    | 15-minute opaque tokens stored hashed; bound to one agent and to `/mcp`; rotating refresh; revocation pushed and checked lazily                                                                  |
| T6  | Concurrent requests race past a limit                                       | Row lock on the agent's policy; limits on spent plus reserved                                                                                                                                    |
| T7  | Replay or duplicate submission                                              | Idempotency key unique per user; payload nonce; one signature per approval (`SIGNING` first); a Cardano transaction's inputs spend once                                                          |
| T8  | A price is manipulated or missing                                           | Values rounded up; quotes older than 120 s dropped; no valuation means no autonomy                                                                                                               |
| T9  | A malicious app build or a spoofed review                                   | The server checks the stamped body is exactly the reviewed transaction; passkey user verification for every approval                                                                             |
| T10 | Phishing a user into approving                                              | Review with recipient, amount, fiat, agent and warnings; push deep links only into your own app                                                                                                  |
| T11 | Webhook spoofing                                                            | Signature over the raw body; unique event ids; reconciliation with our own RPC                                                                                                                   |
| T12 | Secrets leak through logs or a database dump                                | Only token hashes stored; delegated key encrypted; audit rows exclude secrets; error reports scrubbed                                                                                            |
| T13 | Mainnet and testnet confused                                                | The deployment mode partitions networks; addresses validated per network; one provider per network with a genesis check                                                                          |
| T14 | Turnkey's Auth Proxy creates a sub-org with an unexpected root              | Root quorum verified on first login                                                                                                                                                              |
| T15 | Lost passkey                                                                | Your own recovery authenticators (a second passkey); no ZyroPay override by design                                                                                                               |
| T16 | A Cardano signature cannot be bounded by Turnkey                            | No Turnkey autonomy on Cardano; auto-pay only from an allowance the ledger bounds (agent key encrypted per allowance, destroyed on revoke); body hash recomputed and signature verified          |
| T17 | A recovery phrase leaks during wallet import                                | On-device encryption to Turnkey's enclave only; the API and app refuse key material; screen capture blocked                                                                                      |
| T18 | Clickjacking: a hostile page frames the web app                             | `frame-ancestors` allows exactly the landing origins; no message channel into the app; browser-owned passkey prompts                                                                             |
| T19 | A 402 tries to redirect the payment (other URL, other `payTo`, script lock) | The 402 must be for the exact URL the agent asked for; `script` transfers refused; only the canonical Masumi escrow; amount ≤ the agent's `maxAmount` and the deployment cap                     |
| T20 | A seller takes the money and delivers nothing, or something else            | Escrow with a refund path; the seller's on-chain result hash compared with what the agent received; signed delivery receipts                                                                     |
| T21 | A seller claims a registry identity it does not hold                        | The claim is verified on chain at quote time (holder key hash equals the terms' signer, endpoint, price); any failure refuses                                                                    |
| T22 | A paid response carries instructions for the agent (prompt injection)       | The resource body is sanitized and wrapped as untrusted data; it cannot trigger a payment on its own, which still passes policy and your passkey                                                 |

Walkthroughs of the most important attacks are on [Attack walkthroughs](/security/attacks/); who
must be honest for these controls to hold, and what each party learns, is on
[Who you trust](/security/trust/).

## Open items

- **No audit, no threat-model sign-off.** Both are listed as launch blockers.
- **On-device decoding of the transaction** is not built: the review is the API's description of the
  bytes ([trust](/security/trust/#zyropays-api)).
- **The audit table is append-only by convention**; restricting the API's database role to insert
  and select on it is open.
- **The registry identity is checked at quote time only**, not again at approval.
- **No push notifications on staging:** the app finds approvals by polling (every 15 s, or on open).
- Reporting a vulnerability: privately to the maintainers, not in a public issue.

The control-by-control status (C1 to C24) is in `docs/SECURITY.md` in the repository.
