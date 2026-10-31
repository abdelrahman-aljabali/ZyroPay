---
title: "States and codes"
description: "Every policy reason code, request state, x402 delivery status, escrow state, proof state, receipt failure reason and API error code, with its meaning. Sourced from packages/shared."
---

## Policy reason codes

`POLICY_REASON_CODES` in `packages/shared/src/policy.ts`. A decision lists every reason that applied.

| Code                             | Decision         | Meaning                                                                             |
| -------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `AGENT_REVOKED`                  | deny             | The agent was disconnected                                                          |
| `SESSION_EXPIRED`                | deny             | The agent's `sessionExpiresAt` has passed                                           |
| `TOOL_NOT_ALLOWED`               | deny             | The tool is not in `allowedTools`                                                   |
| `WALLET_NOT_ALLOWED`             | deny             | The wallet is not shared with this agent                                            |
| `NETWORK_NOT_ALLOWED`            | deny             | The network is not in `allowedNetworks`                                             |
| `SPENDING_DISABLED`              | deny             | `spendingEnabled` is off                                                            |
| `PROTOCOL_REQUIRED`              | deny             | `swap` or `pay_x402` without a protocol                                             |
| `PROTOCOL_NOT_ALLOWED`           | deny             | The protocol is not in `allowedProtocols` (or not `x402` for `pay_x402`)            |
| `RECIPIENT_REQUIRED`             | deny             | A send or payment without a recipient                                               |
| `RECIPIENT_NOT_ALLOWED`          | deny             | Recipients are restricted and this one is not on the allowlist                      |
| `AGENT_NOT_REGISTERED`           | deny             | Only registered Masumi agents may be paid, and this seller has no verified identity |
| `AGENT_NOT_TRUSTED`              | deny             | The seller is registered but not on the trusted list                                |
| `VALUATION_UNAVAILABLE`          | over limit       | No USD valuation; treated as exceeding every limit                                  |
| `PER_TRANSACTION_LIMIT_EXCEEDED` | over limit       | Above the per-payment limit                                                         |
| `DAILY_LIMIT_EXCEEDED`           | over limit       | Spent + reserved + this exceeds the daily limit                                     |
| `MONTHLY_LIMIT_EXCEEDED`         | over limit       | Spent + reserved + this exceeds the monthly limit                                   |
| `ESCROW_REQUIRED`                | over limit       | A direct x402 payment above the escrow threshold, or unvalued                       |
| `ALWAYS_ASK`                     | require approval | The agent is in Always Ask                                                          |
| `AUTONOMY_NOT_SUPPORTED`         | require approval | Swaps, and Cardano payments outside an auto-pay allowance, need approval            |
| `AUTO_PAY_ALLOWANCE`             | allow            | Paid from the agent's on-chain Cardano allowance, no tap (limits enforced on chain) |
| `ALLOWANCE_PAYEE_NOT_LISTED`     | require approval | Auto-pay fallback: the payee is not on the allowance's list                         |
| `ALLOWANCE_LIMIT_EXCEEDED`       | require approval | Auto-pay fallback: over the per-payment maximum or today's cap                      |
| `ALLOWANCE_INSUFFICIENT`         | require approval | Auto-pay fallback: the allowance or the agent's fee float holds too little          |
| `ALLOWANCE_EXPIRED`              | require approval | Auto-pay fallback: the allowance has expired                                        |
| `ALLOWANCE_BUSY`                 | require approval | Auto-pay fallback: the previous payment from the allowance is still confirming      |
| `ALLOWANCE_UNAVAILABLE`          | require approval | Auto-pay fallback: the chain could not be read, or not a direct ADA payment         |

"Over limit" becomes deny or require approval according to `overLimitBehavior`.

## Request states

`TX_REQUEST_STATES` in `packages/shared/src/state-machine.ts`:
`CREATED`, `POLICY_CHECK`, `PENDING_APPROVAL`, `APPROVED`, `SIGNING`, `BROADCAST`, `CONFIRMED`,
`REJECTED`, `EXPIRED`, `FAILED`, `CANCELLED`. The transitions are drawn on
[How it works](/how-it-works/#the-life-of-one-request).

## x402 delivery status

`x402.status` on a request: `awaiting_signature` (not signed yet), `ready` (signed; the next
`get_approval_status` delivers it), `delivered` (the resource answered the paid retry), `closed` (the
request ended before delivery), `unsupported` (this network's payments are not handed off yet: EVM and
Solana).

## Escrow states

`X402EscrowStateSchema`, read from the chain: `locking` (the lock is not on chain yet),
`funds_locked`, `result_submitted`, `refund_requested`, `disputed`, `withdraw_authorized`,
`refund_authorized` (the datum states), `refunded` (ZyroPay's refund withdrawal confirmed),
`withdrawn` (spent by another transaction: the seller collected, or the admins settled), `failed` (the
lock never landed), `unknown` (the chain could not be read just now). Buyer actions:
`request_refund`, `withdraw_refund`.

## Proof states

`X402ProofStateSchema`: `pending`, `verified`, `mismatch`, `not_delivered`, `unverifiable`,
`receipt_only`. Meanings and recommended refunds: [Proof before release](/how-it-works/proof/).

## Receipt failure reasons

`X402ReceiptFailureSchema`: `missing`, `malformed`, `body_unavailable`, `unsupported_network`,
`wrong_signer`, `wrong_resource`, `wrong_payment`, `content_mismatch`, `bad_signature`. Meanings:
[Delivery receipts](/how-it-works/receipts/#verification).

## API error codes

Every error has the shape `{"error": {"code", "message", "details?"}}`. The set is closed
(`ERROR_HTTP_STATUS` in `packages/shared/src/api/errors.ts`):

| Code                       | HTTP | Code                          | HTTP |
| -------------------------- | ---- | ----------------------------- | ---- |
| `BAD_REQUEST`              | 400  | `NETWORK_MODE_MISMATCH`       | 400  |
| `VALIDATION_FAILED`        | 422  | `INVALID_ADDRESS`             | 422  |
| `UNAUTHENTICATED`          | 401  | `DECIMALS_MISMATCH`           | 422  |
| `FORBIDDEN`                | 403  | `INSUFFICIENT_FUNDS`          | 422  |
| `NOT_FOUND`                | 404  | `PLUGIN_DISABLED`             | 403  |
| `CONFLICT`                 | 409  | `SWAP_UNAVAILABLE_ON_NETWORK` | 422  |
| `IDEMPOTENCY_CONFLICT`     | 409  | `VALUATION_UNAVAILABLE`       | 503  |
| `VERSION_CONFLICT`         | 409  | `RATE_LIMITED`                | 429  |
| `ILLEGAL_STATE_TRANSITION` | 409  | `UPSTREAM_UNAVAILABLE`        | 502  |
| `PAYLOAD_HASH_MISMATCH`    | 409  | `SIGNING_FAILED`              | 502  |
| `REQUEST_EXPIRED`          | 410  | `BROADCAST_FAILED`            | 502  |
| `POLICY_DENIED`            | 403  | `WEBHOOK_SIGNATURE_INVALID`   | 401  |
| `NETWORK_NOT_SUPPORTED`    | 400  | `INTERNAL_ERROR`              | 500  |

Per-endpoint errors are in the [REST and internal API reference](/reference/rest-api/).
