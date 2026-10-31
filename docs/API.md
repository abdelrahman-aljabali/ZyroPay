# ZyroPay REST API

<!-- GENERATED from packages/shared/src/api/{contracts,ext,wallet-management,internal}.ts by packages/shared/scripts/contract-docs.ts. Do not edit by hand. -->

Source of truth: `api`, `apiExt`, `apiWallets` and `mcpInternal` in `@zyropay/shared`. Field tables show top-level fields only; see the Zod schemas for nested shapes and constraints.

Auth: `user` = app session bearer token; `internal` = `INTERNAL_SERVICE_TOKEN` (service to service only); `webhook` = provider signature; `none` = public.

Amounts are base-unit integer strings plus `decimals`. Errors always have the shape `{ "error": { "code", "message", "details?" } }`.

## Endpoints

| name | method | path | auth |
| --- | --- | --- | --- |
| [createSession](#createsession) | POST | `/v1/auth/session` | none |
| [refreshSession](#refreshsession) | POST | `/v1/auth/refresh` | none |
| [deleteSession](#deletesession) | DELETE | `/v1/auth/session` | user |
| [getMe](#getme) | GET | `/v1/me` | user |
| [listWallets](#listwallets) | GET | `/v1/wallets` | user |
| [syncWallets](#syncwallets) | POST | `/v1/wallets/sync` | user |
| [getWallet](#getwallet) | GET | `/v1/wallets/:walletId` | user |
| [getPortfolio](#getportfolio) | GET | `/v1/portfolio` | user |
| [listTransactions](#listtransactions) | GET | `/v1/transactions` | user |
| [getTransaction](#gettransaction) | GET | `/v1/transactions/:transactionId` | user |
| [quoteSend](#quotesend) | POST | `/v1/send/quote` | user |
| [submitSend](#submitsend) | POST | `/v1/send/:requestId/submit` | user |
| [cancelRequest](#cancelrequest) | POST | `/v1/transaction-requests/:requestId/cancel` | user |
| [getX402Escrow](#getx402escrow) | GET | `/v1/transaction-requests/:requestId/escrow` | user |
| [prepareX402RefundRequest](#preparex402refundrequest) | POST | `/v1/transaction-requests/:requestId/escrow/refund-request` | user |
| [submitX402RefundRequest](#submitx402refundrequest) | POST | `/v1/transaction-requests/:requestId/escrow/refund-request/submit` | user |
| [prepareX402RefundWithdrawal](#preparex402refundwithdrawal) | POST | `/v1/transaction-requests/:requestId/escrow/withdraw-refund` | user |
| [submitX402RefundWithdrawal](#submitx402refundwithdrawal) | POST | `/v1/transaction-requests/:requestId/escrow/withdraw-refund/submit` | user |
| [getReceiveInfo](#getreceiveinfo) | GET | `/v1/receive` | user |
| [listAgents](#listagents) | GET | `/v1/agents` | user |
| [getAgent](#getagent) | GET | `/v1/agents/:agentId` | user |
| [updateAgent](#updateagent) | PATCH | `/v1/agents/:agentId` | user |
| [revokeAgent](#revokeagent) | DELETE | `/v1/agents/:agentId` | user |
| [getAgentPolicy](#getagentpolicy) | GET | `/v1/agents/:agentId/policy` | user |
| [getAgentAllowance](#getagentallowance) | GET | `/v1/agents/:agentId/allowance` | user |
| [createAgentAllowance](#createagentallowance) | POST | `/v1/agents/:agentId/allowance` | user |
| [topUpAgentAllowance](#topupagentallowance) | POST | `/v1/agents/:agentId/allowance/top-up` | user |
| [revokeAgentAllowance](#revokeagentallowance) | POST | `/v1/agents/:agentId/allowance/revoke` | user |
| [submitAgentAllowance](#submitagentallowance) | POST | `/v1/agents/:agentId/allowance/submit` | user |
| [listAgentAllowanceSpends](#listagentallowancespends) | GET | `/v1/agents/:agentId/allowance/spends` | user |
| [updateAgentPolicy](#updateagentpolicy) | PUT | `/v1/agents/:agentId/policy` | user |
| [claimAgentConnection](#claimagentconnection) | POST | `/v1/agent-connections/claim` | user |
| [approveAgentConnection](#approveagentconnection) | POST | `/v1/agent-connections/:connectionId/approve` | user |
| [rejectAgentConnection](#rejectagentconnection) | POST | `/v1/agent-connections/:connectionId/reject` | user |
| [listApprovals](#listapprovals) | GET | `/v1/approvals` | user |
| [getApproval](#getapproval) | GET | `/v1/approvals/:approvalId` | user |
| [approveApproval](#approveapproval) | POST | `/v1/approvals/:approvalId/approve` | user |
| [rejectApproval](#rejectapproval) | POST | `/v1/approvals/:approvalId/reject` | user |
| [listMasumiAgents](#listmasumiagents) | GET | `/v1/masumi/agents` | user |
| [getMasumiAgent](#getmasumiagent) | GET | `/v1/masumi/agents/:agentIdentifier` | user |
| [listPlugins](#listplugins) | GET | `/v1/plugins` | user |
| [setPluginEnabled](#setpluginenabled) | PUT | `/v1/plugins/:pluginId` | user |
| [quoteOnramp](#quoteonramp) | POST | `/v1/onramp/quote` | user |
| [createOnrampSession](#createonrampsession) | POST | `/v1/onramp/session` | user |
| [onrampWebhook](#onrampwebhook) | POST | `/v1/webhooks/onramp/:provider` | webhook |
| [registerDevice](#registerdevice) | POST | `/v1/notifications/devices` | user |
| [unregisterDevice](#unregisterdevice) | DELETE | `/v1/notifications/devices/:deviceId` | user |
| [internalCreateAgentConnection](#internalcreateagentconnection) | POST | `/internal/v1/agent-connections` | internal |
| [internalGetAgentConnection](#internalgetagentconnection) | GET | `/internal/v1/agent-connections/:connectionId` | internal |
| [internalGetAgentContext](#internalgetagentcontext) | GET | `/internal/v1/agents/:agentId/context` | internal |
| [internalGetAgentPortfolio](#internalgetagentportfolio) | GET | `/internal/v1/agents/:agentId/portfolio` | internal |
| [internalListAgentTransactions](#internallistagenttransactions) | GET | `/internal/v1/agents/:agentId/transactions` | internal |
| [internalCreateTransactionRequest](#internalcreatetransactionrequest) | POST | `/internal/v1/agents/:agentId/transaction-requests` | internal |
| [internalGetTransactionRequest](#internalgettransactionrequest) | GET | `/internal/v1/agents/:agentId/transaction-requests/:requestId` | internal |
| [internalFindMasumiAgents](#internalfindmasumiagents) | GET | `/internal/v1/agents/:agentId/masumi/agents` | internal |
| [internalVerifyMasumiAgent](#internalverifymasumiagent) | POST | `/internal/v1/agents/:agentId/masumi/verify` | internal |
| [internalGetX402Payment](#internalgetx402payment) | POST | `/internal/v1/agents/:agentId/transaction-requests/:requestId/x402-payment` | internal |
| [internalReportX402Delivery](#internalreportx402delivery) | POST | `/internal/v1/agents/:agentId/transaction-requests/:requestId/x402-delivery` | internal |

### createSession

`POST /v1/auth/session` (auth: none)

Sign in or sign up. The app stamps a Turnkey `get_whoami` request with the passkey; the API forwards it to Turnkey, learns the sub-organization, and issues a session.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `whoamiRequest` | object | yes |  |
| `email` | string (email) | no |  |
| `displayName` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `user` | object | yes |  |
| `isNewUser` | boolean | yes |  |
| `session` | object | yes |  |

### refreshSession

`POST /v1/auth/refresh` (auth: none)

Rotate the refresh token and issue a new access token.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `refreshToken` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |

### deleteSession

`DELETE /v1/auth/session` (auth: user)

Log out (revokes the current session).

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### getMe

`GET /v1/me` (auth: user)

Current user.

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `user` | object | yes |  |

### listWallets

`GET /v1/wallets` (auth: user)

Wallets and addresses (mirrored from the user's Turnkey sub-organization).

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `wallets` | object[] | yes |  |

### syncWallets

`POST /v1/wallets/sync` (auth: user)

Re-read wallets/accounts from Turnkey (after creating an account in the app).

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `wallets` | object[] | yes |  |

### getWallet

`GET /v1/wallets/:walletId` (auth: user)

One wallet.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `wallet` | object | yes |  |

### getPortfolio

`GET /v1/portfolio` (auth: user)

Portfolio snapshot (may be stale; check `stale` and `asOf`).

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | no |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | no |  |
| `currency` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `portfolio` | object | yes |  |

### listTransactions

`GET /v1/transactions` (auth: user)

Normalized transaction history, newest first.

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | no |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `transactions` | object[] | yes |  |
| `nextCursor` | string \| null | yes |  |

### getTransaction

`GET /v1/transactions/:transactionId` (auth: user)

One transaction.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `transactionId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `transaction` | object | yes |  |

### quoteSend

`POST /v1/send/quote` (auth: user, idempotent)

Validate a send, build the unsigned transaction and canonical payload, create a transaction request (CREATED) and return what the user must review and sign.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `to` | string | yes |  |
| `assetId` | string | yes |  |
| `amount` | string | yes |  |
| `decimals` | integer | yes |  |
| `idempotencyKey` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `review` | object | yes |  |

### submitSend

`POST /v1/send/:requestId/submit` (auth: user)

Submit the passkey-stamped sign request. The API checks payloadHash and that the stamped body signs exactly the unsigned transaction it built, forwards to Turnkey, broadcasts.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `payloadHash` | string | yes |  |
| `signRequest` | object | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

### cancelRequest

`POST /v1/transaction-requests/:requestId/cancel` (auth: user)

Cancel a request that has not started signing.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

### getX402Escrow

`GET /v1/transaction-requests/:requestId/escrow` (auth: user)

Escrow state of a pay_x402 request paid into Masumi escrow, read live from the chain (the escrow UTxO's inline datum), with the buyer actions possible right now. 404 when the request has no escrow.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `escrow` | object | yes |  |

### prepareX402RefundRequest

`POST /v1/transaction-requests/:requestId/escrow/refund-request` (auth: user)

Build the Masumi SetRefundRequested spend of the escrow (script evaluated by the chain provider, verified independently) and return it for review. The passkey signs `review.rawPayload.payload` (the spend's body hash) with SIGN_RAW_PAYLOAD_V2, exactly like a Cardano approval. Allowed while the escrow is funds_locked, result_submitted or disputed, before the unlock time and after the buyer cooldown; 409 otherwise. Repeating the call rebuilds the spend.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `review` | object | yes |  |
| `escrow` | object | yes |  |

### submitX402RefundRequest

`POST /v1/transaction-requests/:requestId/escrow/refund-request/submit` (auth: user)

Submit the passkey-stamped signature of the reviewed refund request: the API re-verifies the stored spend, checks the stamp (sub-org, key, body hash, freshness), attaches the witness and broadcasts it; the escrow state follows the chain.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `payloadHash` | string | yes |  |
| `signRequest` | object | yes |  |
| `bodyHash` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `escrow` | object | yes |  |

### prepareX402RefundWithdrawal

`POST /v1/transaction-requests/:requestId/escrow/withdraw-refund` (auth: user)

Build the Masumi WithdrawRefund spend that returns the escrowed funds to the wallet, for review (as prepareX402RefundRequest). Allowed once the seller authorized the refund (refund_authorized), or after submitResultTime while no result was submitted (funds_locked, refund_requested); 409 otherwise.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `review` | object | yes |  |
| `escrow` | object | yes |  |

### submitX402RefundWithdrawal

`POST /v1/transaction-requests/:requestId/escrow/withdraw-refund/submit` (auth: user)

Submit the passkey-stamped signature of the reviewed refund withdrawal (same checks as submitX402RefundRequest), attach the witness and broadcast.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `requestId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `payloadHash` | string | yes |  |
| `signRequest` | object | yes |  |
| `bodyHash` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `escrow` | object | yes |  |

### getReceiveInfo

`GET /v1/receive` (auth: user)

Receive address and QR payload for a wallet on a network.

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `address` | string | yes |  |
| `qrPayload` | string | yes |  |
| `isTestnet` | boolean | yes |  |
| `warnings` | string[] | yes |  |

### listAgents

`GET /v1/agents` (auth: user)

Connected agents.

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agents` | object[] | yes |  |

### getAgent

`GET /v1/agents/:agentId` (auth: user)

One agent.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agent` | object | yes |  |

### updateAgent

`PATCH /v1/agents/:agentId` (auth: user)

Rename an agent.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agent` | object | yes |  |

### revokeAgent

`DELETE /v1/agents/:agentId` (auth: user)

Revoke an agent: policy.revoked=true, OAuth grants/tokens revoked, pending requests cancelled, Turnkey delegated key removed (see ADR-001).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agent` | object | yes |  |

### getAgentPolicy

`GET /v1/agents/:agentId/policy` (auth: user)

Agent policy.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `policy` | object | yes |  |

### getAgentAllowance

`GET /v1/agents/:agentId/allowance` (auth: user)

The agent's Cardano auto-pay allowance (null when none), with its on-chain state read live: balance, spent in the current window, what can be paid right now, and the agent's fee float.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `allowance` | object \| null | yes |  |

### createAgentAllowance

`POST /v1/agents/:agentId/allowance` (auth: user)

Create the agent's auto-pay allowance: fiat limits are converted to lovelace now, a fresh agent key is generated (encrypted at rest), and the create transaction (allowance output with the exact datum + the agent's fee float) is built for review. The passkey signs `review.rawPayload.payload`; check it on the device with checkCardanoAllowanceCreateTx. 409 when the agent already has a live allowance; repeating while pending rebuilds.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes |  |
| `network` | "cardano-preprod" | yes |  |
| `budget` | object \| object | yes |  |
| `perPayment` | object \| object | yes |  |
| `perDay` | object \| object | yes |  |
| `payees` | object \| object | yes |  |
| `expiresInDays` | integer | yes |  |
| `floatLovelace` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `allowance` | object | yes |  |
| `review` | object | yes |  |

### topUpAgentAllowance

`POST /v1/agents/:agentId/allowance/top-up` (auth: user)

Build an owner spend that adds `budget` to the active allowance (same limits, same window). Check with checkCardanoAllowanceOwnerSpendTx (action top_up).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `budget` | object \| object | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `allowance` | object | yes |  |
| `review` | object | yes |  |

### revokeAgentAllowance

`POST /v1/agents/:agentId/allowance/revoke` (auth: user)

Build the owner spend that returns everything in the allowance to the wallet. After it is submitted the agent's fee float is returned too and the agent key is destroyed. Check with checkCardanoAllowanceOwnerSpendTx (action revoke).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `allowance` | object | yes |  |
| `review` | object | yes |  |

### submitAgentAllowance

`POST /v1/agents/:agentId/allowance/submit` (auth: user)

Submit the passkey-stamped signature of the pending allowance transaction (create, top-up or revoke): re-verified, stamp checked like an approval, claimed once, witnessed, submitted and tracked. 409 when `bodyHash` is not the pending build.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `bodyHash` | string | yes |  |
| `signRequest` | object | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `allowance` | object | yes |  |

### listAgentAllowanceSpends

`GET /v1/agents/:agentId/allowance/spends` (auth: user)

Payments the agent made from its allowance, newest first.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `limit` | integer | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `spends` | object[] | yes |  |

### updateAgentPolicy

`PUT /v1/agents/:agentId/policy` (auth: user)

Replace the policy (optimistic locking via expectedVersion). Switching to autonomous additionally requires the passkey-stamped Turnkey policy update (ADR-001).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `expectedVersion` | integer | yes |  |
| `policy` | object | yes |  |
| `turnkeyPolicyRequest` | object | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `policy` | object | yes |  |

### claimAgentConnection

`POST /v1/agent-connections/claim` (auth: user)

User entered/scanned the code shown on the MCP authorize page.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `userCode` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connection` | object | yes |  |

### approveAgentConnection

`POST /v1/agent-connections/:connectionId/approve` (auth: user)

Create the agent with the default policy (always_ask, spending disabled) narrowed to the chosen wallets/networks.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connectionId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `walletIds` | string (uuid)[] | yes |  |
| `networks` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod"[] | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connection` | object | yes |  |
| `agent` | object | yes |  |

### rejectAgentConnection

`POST /v1/agent-connections/:connectionId/reject` (auth: user)

Decline the connection.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connectionId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connection` | object | yes |  |

### listApprovals

`GET /v1/approvals` (auth: user)

Approval requests, newest first.

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `status` | "pending" \| "approved" \| "rejected" \| "expired" \| "cancelled" | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approvals` | object[] | yes |  |
| `nextCursor` | string \| null | yes |  |

### getApproval

`GET /v1/approvals/:approvalId` (auth: user)

Everything needed to review: request, canonical payload, unsigned tx, policy reasons, agent. The unsigned tx is rebuilt on fetch when the stored one is near expiry (Solana blockhashes live ~60-90 s); payloadHash never changes, and approve must sign the latest built tx.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approvalId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approval` | object | yes |  |
| `review` | object | yes |  |
| `agent` | object \| null | yes |  |
| `x402` | object | no |  |

### approveApproval

`POST /v1/approvals/:approvalId/approve` (auth: user)

Approve = sign. The passkey-stamped sign request must sign exactly the reviewed unsigned transaction and quote the same payloadHash.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approvalId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `payloadHash` | string | yes |  |
| `signRequest` | object | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approval` | object | yes |  |
| `request` | object | yes |  |

### rejectApproval

`POST /v1/approvals/:approvalId/reject` (auth: user)

Reject the request.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approvalId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `reason` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `approval` | object | yes |  |
| `request` | object | yes |  |

### listMasumiAgents

`GET /v1/masumi/agents` (auth: user)

Discover live agents registered in the Masumi registry (V2 policy) of this deployment's Cardano network, newest first. Metadata strings are third-party content. UPSTREAM_UNAVAILABLE (502) when the registry cannot be read or is not configured.

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `q` | string | no |  |
| `capability` | string | no |  |
| `tag` | string | no |  |
| `maxPriceUnit` | string | no |  |
| `maxPriceAmount` | string | no |  |
| `limit` | integer | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agents` | object[] | yes |  |
| `scanned` | integer | yes |  |
| `truncated` | boolean | yes |  |

### getMasumiAgent

`GET /v1/masumi/agents/:agentIdentifier` (auth: user)

One registry entry by agentIdentifier (policy id + asset name).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentIdentifier` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `status` | "active" \| "burned" \| "not_found" \| "invalid" | yes |  |
| `agent` | object \| null | yes |  |
| `reason` | string \| null | yes |  |

### listPlugins

`GET /v1/plugins` (auth: user)

Registry with the user's enablement state.

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `plugins` | object[] | yes |  |

### setPluginEnabled

`PUT /v1/plugins/:pluginId` (auth: user)

Enable/disable a plugin for this user.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `pluginId` | string | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `enabled` | boolean | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `pluginId` | string | yes |  |
| `enabled` | boolean | yes |  |

### quoteOnramp

`POST /v1/onramp/quote` (auth: user)

Fiat -> crypto quote (Transak sandbox in development).

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `fiat` | object | yes |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `assetId` | string | yes |  |
| `walletId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `quote` | object | yes |  |

### createOnrampSession

`POST /v1/onramp/session` (auth: user)

Create a hosted on-ramp session; the app opens `url` in a browser.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `quoteId` | string | yes |  |
| `walletId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `url` | string (uri) | yes |  |
| `expiresAt` | string (date-time) | yes |  |
| `simulated` | boolean | yes |  |

### onrampWebhook

`POST /v1/webhooks/onramp/:provider` (auth: webhook)

Provider callbacks. Signature verified on the raw body; deduplicated by (provider, event_id).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `provider` | "transak" | yes |  |

**Body:** unknown

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### registerDevice

`POST /v1/notifications/devices` (auth: user)

Register an Expo push token (idempotent per token).

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `expoPushToken` | string | yes |  |
| `platform` | "ios" \| "android" | yes |  |
| `deviceName` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `deviceId` | string (uuid) | yes |  |

### unregisterDevice

`DELETE /v1/notifications/devices/:deviceId` (auth: user)

Stop push to a device.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `deviceId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### internalCreateAgentConnection

`POST /internal/v1/agent-connections` (auth: internal)

Called from the MCP OAuth authorize page: create a pending connection with a user code the user confirms in the app.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `oauthClientId` | string | yes |  |
| `clientName` | string | yes |  |
| `clientUri` | string (uri) \| null | yes |  |
| `redirectUri` | string (uri) | yes |  |
| `scopes` | string[] | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connection` | object | yes |  |

### internalGetAgentConnection

`GET /internal/v1/agent-connections/:connectionId` (auth: internal)

Poll a connection; once approved, MCP completes the OAuth grant with {userId, agentId}.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connectionId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `connection` | object | yes |  |
| `userId` | string (uuid) \| null | yes |  |

### internalGetAgentContext

`GET /internal/v1/agents/:agentId/context` (auth: internal)

Agent, policy and the wallets it may see. Fails with FORBIDDEN if revoked/expired.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agent` | object | yes |  |
| `wallets` | object[] | yes |  |

### internalGetAgentPortfolio

`GET /internal/v1/agents/:agentId/portfolio` (auth: internal)

get_balance on behalf of an agent (policy-filtered).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | no |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | no |  |
| `currency` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `portfolio` | object | yes |  |

### internalListAgentTransactions

`GET /internal/v1/agents/:agentId/transactions` (auth: internal)

get_transactions on behalf of an agent (policy-filtered).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | no |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `transactions` | object[] | yes |  |
| `nextCursor` | string \| null | yes |  |

### internalCreateTransactionRequest

`POST /internal/v1/agents/:agentId/transaction-requests` (auth: internal, idempotent)

send / swap / pay_x402 on behalf of an agent: validate, value, evaluate policy, reserve spend, and either execute (autonomous) or create an approval and push-notify the user.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body (variant 1):**

| field | type | required | notes |
| --- | --- | --- | --- |
| `tool` | "send" | yes |  |
| `input` | object | yes |  |

**Body (variant 2):**

| field | type | required | notes |
| --- | --- | --- | --- |
| `tool` | "swap" | yes |  |
| `input` | object | yes |  |

**Body (variant 3):**

| field | type | required | notes |
| --- | --- | --- | --- |
| `tool` | "pay_x402" | yes |  |
| `input` | object | yes |  |
| `paymentRequirements` | object | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

### internalGetTransactionRequest

`GET /internal/v1/agents/:agentId/transaction-requests/:requestId` (auth: internal)

get_approval_status. Only requests created by this agent are visible.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |
| `requestId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

### internalFindMasumiAgents

`GET /internal/v1/agents/:agentId/masumi/agents` (auth: internal)

find_agents on behalf of an agent: Masumi registry discovery (same query and result as listMasumiAgents).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `q` | string | no |  |
| `capability` | string | no |  |
| `tag` | string | no |  |
| `maxPriceUnit` | string | no |  |
| `maxPriceAmount` | string | no |  |
| `limit` | integer | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agents` | object[] | yes |  |
| `scanned` | integer | yes |  |
| `truncated` | boolean | yes |  |

### internalVerifyMasumiAgent

`POST /internal/v1/agents/:agentId/masumi/verify` (auth: internal)

verify_agent on behalf of an agent: check a registry identity (live NFT held by a key, canonical escrow source, public https endpoint covering resourceUrl, and the NFT holder = sellerAddress when given). Fail closed. pay_x402 repeats the check against the key that signs the seller's terms.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentIdentifier` | string | yes |  |
| `sellerAddress` | string | no |  |
| `resourceUrl` | string (uri) | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | boolean | yes |  |
| `reasons` | "invalid_identifier" \| "network_mismatch" \| "wrong_policy" \| "not_found" \| "burned" \| "multiple_holders" \| "metadata_invalid" \| "holder_not_key_address" \| "seller_missing" \| "seller_invalid" \| "seller_mismatch" \| "no_escrow_source" \| "endpoint_invalid" \| "endpoint_insecure" \| "endpoint_mismatch" \| "price_mismatch" \| "not_trusted" \| "upstream_unavailable"[] | yes |  |
| `details` | string[] | yes |  |
| `sellerChecked` | boolean | yes |  |
| `agent` | object \| null | yes |  |

### internalGetX402Payment

`POST /internal/v1/agents/:agentId/transaction-requests/:requestId/x402-payment` (auth: internal)

The signed payment of a pay_x402 request, as the header the MCP worker sends when it retries the resource. Only for the agent's own request once it is signed (409 before). Cardano: the request moves to BROADCAST under the transaction id derived from the signed bytes, and the API follows it on chain; repeating the call returns the same header (the same transaction cannot be spent twice).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |
| `requestId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `payment` | object | yes |  |

### internalReportX402Delivery

`POST /internal/v1/agents/:agentId/transaction-requests/:requestId/x402-delivery` (auth: internal)

Outcome of the paid retry, reported by the MCP worker. Recorded for display and audit only: settlement is decided by the chain (a transaction id that differs from the signed one is flagged, never adopted).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |
| `requestId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `httpStatus` | integer | yes |  |
| `settled` | boolean \| null | yes |  |
| `transaction` | string \| null | yes |  |
| `errorReason` | string \| null | yes |  |
| `receipt` | object | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `request` | object | yes |  |

## Additive endpoints (`apiExt`)

Served by the API next to `api`: delegated signer lifecycle, chain webhooks and the MCP audit sink.

| name | method | path | auth |
| --- | --- | --- | --- |
| [getDelegatedSigner](#getdelegatedsigner) | GET | `/v1/delegated-signer` | user |
| [createDelegatedSigner](#createdelegatedsigner) | POST | `/v1/delegated-signer` | user |
| [activateDelegatedSigner](#activatedelegatedsigner) | POST | `/v1/delegated-signer/activate` | user |
| [deleteDelegatedSigner](#deletedelegatedsigner) | DELETE | `/v1/delegated-signer` | user |
| [chainWebhook](#chainwebhook) | POST | `/v1/webhooks/chain/:provider` | webhook |
| [getPriceHistory](#getpricehistory) | GET | `/v1/prices/:assetId/history` | user |
| [listAgentRequests](#listagentrequests) | GET | `/v1/agents/:agentId/requests` | user |
| [internalRecordAuditEvent](#internalrecordauditevent) | POST | `/internal/v1/audit-events` | internal |

### getDelegatedSigner

`GET /v1/delegated-signer` (auth: user)

The user's delegated signer (autonomous mode), or null.

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `signer` | object \| null | yes |  |

### createDelegatedSigner

`POST /v1/delegated-signer` (auth: user)

Get or create a pending delegated signer: the API generates a P-256 key pair, stores the private key AES-256-GCM encrypted, and returns the public key for the app to register with its passkey (fetchOrCreateP256ApiKeyUser).

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `signer` | object | yes |  |

### activateDelegatedSigner

`POST /v1/delegated-signer/activate` (auth: user)

After the app created the delegated user in Turnkey: the API reads the sub-org (parent-org read key), checks the user holds exactly our public key and is NOT in the root quorum, then activates.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `turnkeyUserId` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `signer` | object | yes |  |

### deleteDelegatedSigner

`DELETE /v1/delegated-signer` (auth: user)

Revoke the delegated signer server-side (the encrypted key is destroyed at once) and switch every autonomous agent back to always_ask. The app should also delete the Turnkey user with its passkey.

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### chainWebhook

`POST /v1/webhooks/chain/:provider` (auth: webhook)

Helius (Solana) / Alchemy Notify (EVM) address-activity webhooks. Authenticated on the raw body, deduplicated by (provider, event_id), reconciled with RPC before any state change.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `provider` | "helius" \| "alchemy" | yes |  |

**Body:** unknown

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### getPriceHistory

`GET /v1/prices/:assetId/history` (auth: user)

Price history for one asset (asset detail chart). USD only. Fails closed: status "unavailable" with a reason when no trustworthy series exists (testnet assets, unknown tokens, provider down).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `assetId` | string | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `range` | "1D" \| "1W" \| "1M" \| "1Y" | no |  |
| `currency` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `history` | object \| object | yes |  |

### listAgentRequests

`GET /v1/agents/:agentId/requests` (auth: user)

Every transaction request one of the user's agents made, newest first, in all states (pending, approved, autonomous executions, rejected, expired, confirmed, failed).

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `state` | "CREATED" \| "POLICY_CHECK" \| "PENDING_APPROVAL" \| "APPROVED" \| "SIGNING" \| "BROADCAST" \| "CONFIRMED" \| "REJECTED" \| "EXPIRED" \| "FAILED" \| "CANCELLED" | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `nextCursor` | string \| null | yes |  |

### internalRecordAuditEvent

`POST /internal/v1/audit-events` (auth: internal)

Audit sink for the MCP worker (MCP_AUDIT_SINK=api): stores one OAuth or tool-call audit event in audit_logs (actor type mcp). Events carry ids, tool name, outcome and error code only.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `type` | "oauth.connection_started" \| "oauth.grant_created" \| "oauth.grant_denied" \| "oauth.grant_expired" \| "oauth.grant_revoked" \| "mcp.tool_call" | yes |  |
| `at` | string (date-time) | yes |  |
| `userId` | string (uuid) \| null | yes |  |
| `agentId` | string (uuid) \| null | yes |  |
| `clientId` | string \| null | yes |  |
| `connectionId` | string (uuid) \| null | yes |  |
| `tool` | string \| null | yes |  |
| `outcome` | "ok" \| "error" \| "denied" \| "expired" \| "revoked" | yes |  |
| `errorCode` | string \| null | yes |  |
| `requestId` | string (uuid) \| null | yes |  |
| `idempotencyKey` | string \| null | yes |  |
| `durationMs` | integer \| null | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

## Wallet management (`apiWallets`)

Served by the API next to `api`: link a wallet the app created with the passkey, rename, remove (unlink; keys stay in Turnkey) and read-only watch wallets. Watch wallets never sign, send or reach agents.

| name | method | path | auth |
| --- | --- | --- | --- |
| [createWallet](#createwallet) | POST | `/v1/wallets` | user |
| [renameWallet](#renamewallet) | PATCH | `/v1/wallets/:walletId` | user |
| [removeWallet](#removewallet) | DELETE | `/v1/wallets/:walletId` | user |
| [listWatchWallets](#listwatchwallets) | GET | `/v1/watch-wallets` | user |
| [createWatchWallet](#createwatchwallet) | POST | `/v1/watch-wallets` | user |
| [renameWatchWallet](#renamewatchwallet) | PATCH | `/v1/watch-wallets/:watchWalletId` | user |
| [removeWatchWallet](#removewatchwallet) | DELETE | `/v1/watch-wallets/:watchWalletId` | user |
| [getWatchWalletPortfolio](#getwatchwalletportfolio) | GET | `/v1/watch-wallets/:watchWalletId/portfolio` | user |

### createWallet

`POST /v1/wallets` (auth: user, idempotent)

Register a wallet the app just created or imported (ADR-003: a recovery phrase as an HD wallet, or a raw private key) with the passkey in the user's Turnkey sub-organization. The API re-reads the sub-org's wallets and private keys from Turnkey and refuses (FORBIDDEN) an id that is not there; a removed wallet is linked again. The API refuses (BAD_REQUEST) any request that carries a recovery phrase or private key. Audited.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `turnkeyWalletId` | string | yes |  |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `name` | string | no |  |
| `idempotencyKey` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `wallet` | object | yes |  |

### renameWallet

`PATCH /v1/wallets/:walletId` (auth: user)

Rename one of the user's wallets (ZyroPay label only). Audited.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `wallet` | object | yes |  |

### removeWallet

`DELETE /v1/wallets/:walletId` (auth: user)

Unlink a wallet from ZyroPay. Keys stay in the user's Turnkey sub-organization and nothing is deleted there. Refused (CONFLICT) for the last linked wallet, while an agent can use it, or while a request is in flight. Audited.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `walletId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### listWatchWallets

`GET /v1/watch-wallets` (auth: user)

Read-only (watch) addresses, oldest first.

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `watchWallets` | object[] | yes |  |

### createWatchWallet

`POST /v1/watch-wallets` (auth: user, idempotent)

Watch an address read-only. Validated for the network's family and the build's mode; the same address twice is a CONFLICT. Never signs, never sends, never visible to agents. Audited.

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `network` | "solana-mainnet" \| "solana-devnet" \| "ethereum-mainnet" \| "ethereum-sepolia" \| "base-mainnet" \| "base-sepolia" \| "cardano-mainnet" \| "cardano-preprod" | yes |  |
| `address` | string | yes |  |
| `name` | string | no |  |
| `idempotencyKey` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `watchWallet` | object | yes |  |

### renameWatchWallet

`PATCH /v1/watch-wallets/:watchWalletId` (auth: user)

Rename a watch wallet. Audited.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `watchWalletId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `watchWallet` | object | yes |  |

### removeWatchWallet

`DELETE /v1/watch-wallets/:watchWalletId` (auth: user)

Stop watching an address. Audited.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `watchWalletId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `ok` | true | yes |  |

### getWatchWalletPortfolio

`GET /v1/watch-wallets/:watchWalletId/portfolio` (auth: user)

Balances of one watch address on every network of its family in the build's mode. Balances carry the watch wallet's id as walletId. Not part of the main portfolio total.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `watchWalletId` | string (uuid) | yes |  |

**Query:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `currency` | string | no |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `portfolio` | object | yes |  |

## Served by the MCP worker (`mcpInternal`)

Called by the API over the `MCP` service binding (or `MCP_INTERNAL_URL` in local development).

| name | method | path | auth |
| --- | --- | --- | --- |
| [mcpRevokeAgentGrants](#mcprevokeagentgrants) | POST | `/internal/v1/agents/:agentId/revoke-grants` | internal |

### mcpRevokeAgentGrants

`POST /internal/v1/agents/:agentId/revoke-grants` (auth: internal)

Served by the MCP worker. Called by the API when a user revokes an agent: revokes every OAuth grant (and so every access and refresh token) that maps to the agent. Revocation also holds without this call, because the API refuses every internal call for a revoked agent.

**Path params:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string (uuid) | yes |  |

**Body:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `userId` | string (uuid) | yes |  |

**Response 2xx:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `revokedGrantCount` | integer | yes |  |

## Error codes

| code | HTTP status |
| --- | --- |
| `BAD_REQUEST` | 400 |
| `VALIDATION_FAILED` | 422 |
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `IDEMPOTENCY_CONFLICT` | 409 |
| `VERSION_CONFLICT` | 409 |
| `ILLEGAL_STATE_TRANSITION` | 409 |
| `PAYLOAD_HASH_MISMATCH` | 409 |
| `REQUEST_EXPIRED` | 410 |
| `POLICY_DENIED` | 403 |
| `NETWORK_NOT_SUPPORTED` | 400 |
| `NETWORK_MODE_MISMATCH` | 400 |
| `INVALID_ADDRESS` | 422 |
| `DECIMALS_MISMATCH` | 422 |
| `INSUFFICIENT_FUNDS` | 422 |
| `PLUGIN_DISABLED` | 403 |
| `SWAP_UNAVAILABLE_ON_NETWORK` | 422 |
| `VALUATION_UNAVAILABLE` | 503 |
| `RATE_LIMITED` | 429 |
| `UPSTREAM_UNAVAILABLE` | 502 |
| `SIGNING_FAILED` | 502 |
| `BROADCAST_FAILED` | 502 |
| `WEBHOOK_SIGNATURE_INVALID` | 401 |
| `INTERNAL_ERROR` | 500 |

<!-- HAND-WRITTEN BELOW -->
## Implementation notes

How `apps/api` implements the contracts above. This section is hand-written: the generator keeps everything after the marker and `docs.test.ts` ignores it.

### Conventions

- **Validation.** Every params/query/body is parsed with the contract's Zod schema (422 `VALIDATION_FAILED` with `details.issues`). Every response is parsed against the contract's response schema before it is sent. A drift is a 500 and a log line, never a malformed response.
- **Binding.** `apps/api/src/http/handlers.ts` exports one handler per contract name (`{ [N in keyof Api]: Handler<Api[N]> }`). A contract without a handler, or a handler whose return type drifts from the response schema, fails `tsc`. `test/integration/endpoints.test.ts` also checks at run time that every contract has a mounted route.
- **Errors.** Errors always use `{ "error": { "code", "message", "details?" } }` with the closed code set from `@zyropay/shared`. Unknown failures become `INTERNAL_ERROR` with a generic message, and nothing internal leaks: no stack, SQL, upstream body or secret.
- **Idempotency.** Endpoints marked `idempotent` (`quoteSend`, `internalCreateTransactionRequest`) require an `Idempotency-Key` header equal to the body's `idempotencyKey`.
  - A retry with the same key and the same material parameters returns the original request.
  - A retry with different parameters returns `409 IDEMPOTENCY_CONFLICT`.
- **Rate limits.** Limits are fixed windows counted in Postgres (`rate_limit_counters`). The defaults are:

  | Bucket                   | Limit                 |
  | ------------------------ | --------------------- |
  | `auth` (unauthenticated) | 20/min per IP         |
  | `user`                   | 120/min per user      |
  | `internal`               | 120/min per agent     |
  | `webhook`                | 600/min per IP        |
  | `connection-claim`       | 10 per 5 min per user |

  A blocked request gets `429 RATE_LIMITED` with a `Retry-After` header. Subjects (IPs, ids) are stored salted and hashed.

- **CORS.** Only origins listed in `CORS_ALLOWED_ORIGINS` (a new variable, comma-separated, empty by default) are allowed, and only on `/v1/*` routes other than webhooks. Internal and webhook routes never answer cross-origin requests. The native app sends no `Origin`.
- **Mode.** Every network in input is checked against `ZYROPAY_MODE` (`400 NETWORK_MODE_MISMATCH`). The service refuses to start in production with mocks or with missing Turnkey, DB, internal token, key-encryption key or IP salt. With mocks off (any mode) it also refuses to start without `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, Turnkey and `DATABASE_URL` (and `COINGECKO_API_KEY` in production): every route answers 503 and `/health` names the missing variables.
- **Swaps.** Jupiter routes on Solana mainnet only. A `swap` on any other network, every test network included, fails with `422 SWAP_UNAVAILABLE_ON_NETWORK` and the shared message ("Swaps are available on Solana mainnet only. This wallet is on Solana Devnet (test network), so no swap can be made."), `details.network`, before anything is created. Development deployments do not wire Jupiter, and nothing simulates a swap.

### Authentication

| Auth       | Credential                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`     | `Authorization: Bearer zp_at_…`: an opaque 256-bit access token (TTL `SESSION_ACCESS_TOKEN_TTL_SECONDS`, default 15 min); only its sha256 is stored |
| `internal` | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (or `_PREVIOUS` during rotation), compared in constant time; the agent is re-checked on every call |
| `webhook`  | Provider signature over the raw body (see below)                                                                                                    |
| `none`     | Rate-limited per IP                                                                                                                                 |

#### Sign-in (`POST /v1/auth/session`)

The body is `{ whoamiRequest: StampedTurnkeyRequest }`, a Turnkey `get_whoami` stamped on the device.

1. **Check the stamp.** The URL must be exactly `TURNKEY_API_BASE_URL + /public/v1/query/whoami`, and the body must be exactly `{organizationId}`. For `X-Stamp-Webauthn`, the WebAuthn `clientDataJSON.challenge` must equal `sha256hex(body)` (the format of `@turnkey/webauthn-stamper`).
2. **Use the stamp once.** A whoami body has no timestamp, so the stamp's hash is recorded in `login_stamp_replays` before forwarding. Replays get 401.
3. **Forward unmodified.** The stamp is forwarded to Turnkey, which verifies it and returns `{organizationId, userId}`. The parent organization itself is refused.
4. **Read the root quorum** with the parent-org API key (`get_organization_configs`). This fails for organizations that are not our sub-orgs.
   - **First login:** the quorum must be exactly `{userId}` with threshold 1, or the request gets 403 and no user is created.
   - **Later logins:** the user must be in the root quorum and must not be the delegated API-key user.
5. **Create the user and session.** On first login, the API creates the user and mirrors wallets (`list_wallets`, `list_wallet_accounts`). It then issues a session.

#### Session lifecycle

- **`POST /v1/auth/refresh`** rotates the refresh token (`zp_rt_…`, TTL `SESSION_REFRESH_TOKEN_TTL_SECONDS`) and revokes the old session and its access tokens. If a rotated or revoked refresh token is presented again, the API revokes every session of that user, writes the audit entry `security.refresh_token_reuse` and sends a security push.
- **`DELETE /v1/auth/session`** revokes the current session.

### Transaction requests

| Step                 | Where                           | Guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validate + value     | `services/requests.ts`          | Wallet ownership, address per network, asset network, `decimals` equal to the asset, balance ≥ amount (via `PortfolioProvider`). The USD valuation is computed server side from `PriceProvider` and rounded up. A missing, stale, non-USD or simulated-in-real-mode price gives `null`, which fails closed. Agent-supplied prices or amounts are never trusted (x402 price ≤ `maxAmount`, network/asset/resource must match).                                                                                                                                                                                                                                                                                                                           |
| Fee cap              | `services/requests.ts`          | A plain transfer's `feeCap` is the builder's `estimateTransferFee().recommendedFeeCap`, fixed **before** the payload is hashed and bounded by a static per-network ceiling (`FEE_CAPS`; above it the request fails closed with `UPSTREAM_UNAVAILABLE`). Plugin transactions fit their fees under the ceiling. A later fee change needs a new payload and a new approval. |
| Policy + reservation | one DB transaction              | `SELECT … FROM agent_policies WHERE agent_id=$1 FOR UPDATE`, then `evaluatePolicy(policy, request, valuation, spent+reserved windows)`. On `allow`, the API reserves the amount. On `require_approval`, it creates an `approval_request` and a reservation if the request is valued. On `deny`, the request ends `REJECTED`. If evaluation throws, the request is denied.                                                                                                                                                                                                                                                                                                                                                                               |
| State                | `services/tx-state.ts`          | Every change goes through shared `transition()` plus `UPDATE … WHERE id AND version`. A lost race gives `409 VERSION_CONFLICT`. An illegal transition gives `409 ILLEGAL_STATE_TRANSITION`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Approve = sign       | `services/approvals.ts`         | Every one of these must hold (for x402 on EVM the stamped body is `SIGN_RAW_PAYLOAD_V2` over the stored EIP-712 digest instead, checked by `verifySignRawPayloadRequest`):<br>• the body `payloadHash` equals the approval's, the request's, and the hash recomputed from the stored payload;<br>• the stamp is a passkey stamp over this body;<br>• the URL is `sign_transaction` and the body is `SIGN_TRANSACTION_V2`;<br>• `organizationId` is the user's sub-org and `signWith` is the wallet address;<br>• the tx type matches the family;<br>• `unsignedTransaction` is byte-equal to the stored one, the stamp is at most 5 minutes old, and the independent verifier passes: the network builder's `verifyMatchesPayload` for transfers, the plugin adapter's own `verifyTransaction` for plugin transactions (a swap is never checked against the transfer verifier; no verifier means not signable), `verifyTypedData` for x402 on EVM.<br>`PENDING_APPROVAL → APPROVED → SIGNING` is committed (with the approval row `pending → approved`) BEFORE forwarding to Turnkey, so a duplicate or concurrent approve can never sign twice. |
| Autonomous           | queue `execute`                 | Re-checks that the request is in `APPROVED` and not expired, and that the agent is not revoked and still autonomous. Rebuilds an expiring Solana transfer, then runs the same independent verifier. Typed data is never signed here. Moves `APPROVED → SIGNING` under the optimistic lock (one winner), then signs with the delegated key (`SIGN_TRANSACTION_V2` in the sub-org).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Broadcast            | inline, then queue `broadcast`  | Turnkey's output is normalized (hex Solana transactions become base64), `assertSignedMatchesUnsigned` checks the signed bytes against the reviewed bytes and signer (C7; a mismatch fails the request and writes `security.signed_transaction_mismatch`), and the tx hash is derived from the signed bytes and stored **before** sending. A rebroadcast re-sends the same bytes. When a send fails, the hash is looked up on chain: known or landed → `BROADCAST`; provably dead (Solana blockhash expired, EVM nonce replaced) → `FAILED`; after 5 attempts only a definitive send error (insufficient funds, blockhash expired, nonce taken) fails it, otherwise it stays `SIGNING` (`tx_request.broadcast_unresolved`) and the cron retries. x402 payments are not broadcast (see below). `executed_transactions` is UNIQUE per request. |
| Confirm              | queue `confirm`, cron, webhooks | Status comes from our own RPC read through the confirmation tracker (`expired` and `replaced` end the request; `rebroadcastSuggested` re-sends the same bytes). On `CONFIRMED`, the reservation becomes `settled` and one ledger row is written (UNIQUE). On `FAILED`, the reservation is released.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Expiry               | cron (`* * * * *`)              | `CREATED`, `POLICY_CHECK`, `PENDING_APPROVAL` and `APPROVED` past `expires_at` move to `EXPIRED`; the reservation is released and the approval set to `expired`. The same cron re-polls stuck `SIGNING`/`BROADCAST` requests and unprocessed webhooks, and cleans up rate-limit counters and login-stamp replays.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

ADR-001 D4: `GET /v1/approvals/:id` (and autonomous execution) calls the Solana builder's `rebuildIfExpiring` with the stored blockhash metadata; other stored transactions with a `validUntil` (plugin transactions) are rebuilt when it is within 20 s. The `payloadHash` is unchanged, and the approve call must sign the latest bytes.

**EVM nonces.** For EVM transfers the API allocates the nonce itself (`services/build.ts`): under a per-address advisory lock it takes the lowest nonce at or above the chain's pending nonce that no other in-flight request of that address holds, and stores it in `transaction_request_artifacts.evm_nonce`. Concurrent requests never share a nonce, and a request that ends before broadcast frees its nonce. In-app sends therefore insert the request before building it.

**x402.** On EVM, the payment is an EIP-3009 `TransferWithAuthorization`: the review carries `typedData` and its digest, the request always needs the passkey (`AUTONOMY_NOT_SUPPORTED`, because Turnkey policies cannot bound a raw digest), and the signature is stored as `0x‖r‖s‖v`. On Solana the facilitator pays the fee. In both cases the signed payment stays in `SIGNING`: it is meant for the resource server, which settles it through its facilitator.

On Cardano the payment is a plain transfer to `payTo` (the `default` transfer method), valid no longer than the requirement's `maxTimeoutSeconds`, signed with the passkey like any Cardano send. After signing, the C7 checks run and the tx id is derived from the signed bytes, but nothing is broadcast. Hand-off (`services/x402.ts`):

1. The agent's `get_approval_status` sees `x402.status: "ready"`; the MCP worker calls `internalGetX402Payment`, which returns the `PAYMENT-SIGNATURE` header and moves the request to `BROADCAST` under the derived tx id. Repeating it returns the same bytes, which can only be spent once.
2. The MCP worker retries the resource with the header and reports the answer (`internalReportX402Delivery`). A 2xx marks it `delivered`; anything else leaves it deliverable. The reported receipt is recorded for audit only: a different tx id writes `security.x402_receipt_mismatch` and is never adopted. **Verified delivery receipt:** on a 2xx the report may carry `receipt: {header, contentSha256}` — the seller's `X-Delivery-Receipt` (base64 JSON, ≤ 4 KiB) and the MCP worker's own SHA-256 of the body. The API checks, independently of both, that blake2b-224 of the receipt's `publicKey` is the payment key hash of `payload.to`, that the receipt names `payload.to`, the bound resource URL (WHATWG-normalised) and, when present, the signed tx id, that its `contentSha256` equals the worker's hash, and that the Ed25519 signature over the canonical message (`packages/shared/src/x402-receipt.ts`) is valid. The verdict (`verified`, `reason`) is stored in `transaction_request_artifacts.x402_report` (no migration), returned as `x402.receipt` (agent endpoints and `GET /v1/approvals/:id`), and audited as `x402.delivery_verified` or `security.x402_receipt_invalid` (`{reason}`). A missing receipt is recorded (`reason: "missing"`) but not audited; a later failed retry keeps the delivery's verdict.
3. The confirmation tracker follows the tx id on chain: `CONFIRMED` settles the reservation into the ledger; a TTL that passes without the transaction landing fails it and releases the reservation.

A signed x402 payment that is never handed off fails once its validity has passed (any family), so the cron does not re-queue it forever. EVM and Solana payments are not handed off yet (`x402.status: "unsupported"`).

### Webhooks

| Route                                   | Verification                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/webhooks/chain/helius` (ext)  | `Authorization` header equals `HELIUS_WEBHOOK_SECRET` (constant time). `event_id` = transaction signature.             |
| `POST /v1/webhooks/chain/alchemy` (ext) | `X-Alchemy-Signature` = HMAC-SHA256 hex of the raw body with `ALCHEMY_WEBHOOK_SIGNING_KEY`. `event_id` = payload `id`. |
| `POST /v1/webhooks/onramp/transak`      | `OnrampProvider.verifyWebhook(rawBody, headers)` (the integrations adapter). `event_id` from the adapter.              |

How events are handled:

- **Missing secret.** If the secret is not set, every event is refused.
- **Bad signature.** The API returns `401 WEBHOOK_SIGNATURE_INVALID` and writes the audit entry `security.webhook_signature_invalid`.
- **Storage and deduplication.** Events are stored under `UNIQUE(provider, event_id)` and processed through the queue. A duplicate is acknowledged and not processed again.
- **Chain events** are normalized into `incoming_transfers` for our addresses only, and only on this mode's networks. Each produces an `incoming_payment` push. When the hash matches one of our broadcasts, the API also schedules an RPC status poll.
- **On-ramp events** update `onramp_orders`.

### Async stages (Cloudflare Queue `zyropay-api-jobs`)

| Message     | Handler                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `execute`   | Autonomous signing                                                               |
| `broadcast` | (Re)broadcast of the stored signed bytes                                         |
| `confirm`   | Chain status poll with backoff (max 40 attempts, then the cron takes over)       |
| `notify`    | Expo push through the `Notifier` port, deduplicated in `notification_dispatches` |
| `webhook`   | Processing of a stored, verified webhook event                                   |
| `push_receipts` | Expo receipt check about 15 min after sending; `DeviceNotRegistered` disables the device |
| `mcp_revoke` | Retry of the revocation push to the MCP worker                                  |

Failed messages are retried with exponential backoff (max 10 retries), then sent to the DLQ `zyropay-api-jobs-dlq`.

Push events:

- `approval_requested`
- `approval_expired`
- `transaction_executed`
- `transaction_confirmed`
- `transaction_failed`
- `incoming_payment`
- `agent_connected`
- `onramp_completed`
- `security_event`

Each push is sent as the closest `Notification.kind`. Its `data` is the shared `PushData` (`@zyropay/shared` `push.ts`, built by `buildPushData`): `v`, `type` (the event above), opaque UUIDs (`approvalId`, `requestId`, `agentId`, `orderId`, `transferId`) and `url`, a deep link `<APP_DEEP_LINK_SCHEME>://<route>` from a closed set (`approvals/<id>`, `approvals`, `activity`, `agents/<id>`, `settings`). No amounts, addresses, URLs to elsewhere or secrets, and the text carries no amounts either. The Expo adapter sends `data` only if it validates against the schema.

### Additive endpoints (`apiExt` in `packages/shared/src/api/ext.ts`)

| Name                      | Method | Path                            | Auth    | Notes                                                                                                                                                                                                                                                       |
| ------------------------- | ------ | ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getDelegatedSigner`      | GET    | `/v1/delegated-signer`          | user    | Returns `{ signer \| null }`                                                                                                                                                                                                                                |
| `createDelegatedSigner`   | POST   | `/v1/delegated-signer`          | user    | Get or create. Generates the P-256 key with WebCrypto. The private key is stored AES-256-GCM encrypted (`DELEGATED_KEY_ENCRYPTION_KEY`, with the user id as AAD). Returns `apiPublicKey` for the app's passkey to register (`fetchOrCreateP256ApiKeyUser`). |
| `activateDelegatedSigner` | POST   | `/v1/delegated-signer/activate` | user    | `{ turnkeyUserId }`. The API reads the sub-org with the parent key. The user must hold exactly our public key, have no authenticators, and NOT be in the root quorum. The API records the policy ids that name the user.                                    |
| `deleteDelegatedSigner`   | DELETE | `/v1/delegated-signer`          | user    | Revokes the signer and destroys the ciphertext immediately. Every autonomous agent goes back to `always_ask`.                                                                                                                                               |
| `chainWebhook`            | POST   | `/v1/webhooks/chain/:provider`  | webhook | `provider` ∈ `helius`, `alchemy`                                                                                                                                                                                                                            |
| `internalRecordAuditEvent` | POST  | `/internal/v1/audit-events`     | internal | MCP audit sink (`MCP_AUDIT_SINK=api`). Stored in `audit_logs` as actor `mcp`; a user id is kept only if that user owns the agent. |
| `getPriceHistory`         | GET    | `/v1/prices/:assetId/history`   | user    | `PriceHistoryProvider` (CoinGecko `market_chart` in real mode: natives, and EVM/SPL tokens via the contract endpoints; a labelled simulated series with mocks). The asset's network must be in the mode (`NETWORK_MODE_MISMATCH`). Fails closed: `status: "unavailable"` with `UNSUPPORTED_ASSET`, `TESTNET_ASSET` (no testnet market price unless `VALUE_TESTNETS_AT_MAINNET_PRICES`, the development default; then `source` ends in `+testnet-proxy`), `CURRENCY_UNSUPPORTED` (USD only) or `PROVIDER_UNAVAILABLE`. A simulated series is never served in real mode. |
| `listAgentRequests`       | GET    | `/v1/agents/:agentId/requests`  | user    | Every transaction request of one of the user's agents, newest first, optional `state` filter, cursor `<createdAt>\|<id>`. Each item carries `approvalId` (when it needed the user) and `autonomous` (allowed outright by policy). Another user's agent is `NOT_FOUND`. |

Switching an agent to `autonomous` (`PUT /v1/agents/:id/policy`) requires two things:

- **An active delegated signer.** Without one, the request gets 403.
- **A Turnkey policy envelope.** Either one is already recorded, or `turnkeyPolicyRequest` is supplied. That request is a passkey-stamped `ACTIVITY_TYPE_CREATE_POLICIES` in the user's sub-org, and every ALLOW policy's consensus must be exactly `approvers.any(u, u.id == '<delegated user>')`. The API verifies it and forwards it unmodified.

Revoking the last autonomous agent also revokes the signer and destroys its key (ADR-001 D8); the inert Turnkey user and policies are deleted by the user's passkey at the next autonomous setup. Every revocation also pushes `mcpRevokeAgentGrants` to the MCP worker (service binding `MCP`, or `MCP_INTERNAL_URL` locally), retried from the queue if the worker is unreachable.

### Wallet management (`apiWallets` in `packages/shared/src/api/wallet-management.ts`)

Implemented in `apps/api/src/services/wallet-management.ts`. Every mutation is audited (`wallets.created`, `wallets.renamed`, `wallets.removed`, `watch_wallets.created`, `watch_wallets.renamed`, `watch_wallets.removed`).

- **`createWallet`.** The app creates the wallet with the passkey (ADR-001: the API cannot). The API checks the network is in the mode (`NETWORK_MODE_MISMATCH`), then re-reads the sub-org with `listWalletAccounts`. It refuses a `turnkeyWalletId` that is not in it (`FORBIDDEN`), a wallet with no account of the network's family (`NETWORK_NOT_SUPPORTED`) and a wallet linked to another user (`FORBIDDEN`). Only that wallet's accounts are upserted. A new wallet gets `name` or else Turnkey's name. A removed wallet is linked again (same id) and keeps its ZyroPay label unless `name` is given. Turnkey errors map like `syncWallets` (`UPSTREAM_UNAVAILABLE`). Idempotency: the `wallets.created` audit row stores the key and the material fields. A retry with the same key returns the wallet as it is now, without re-applying the name. The same key with another wallet, network or name is `IDEMPOTENCY_CONFLICT`. If the wallet was removed after the first call, the retry is `CONFLICT`.
- **`removeWallet` = unlink.** Nothing is deleted in Turnkey. The API sets `wallets.archived_at`, and `loadWallets` leaves archived wallets out. So list/get, portfolio, history, receive, sends, agent policies, agent connections, the MCP agent context and incoming-transfer pushes all treat the wallet as non-existent (`NOT_FOUND`, or `BAD_REQUEST` "unknown wallet" in policies). `syncWallets` and sign-in never un-archive. The API refuses with `CONFLICT` and gives `details.reason` in three cases. `last_wallet`: it is the only linked wallet. `agent_access`: a non-revoked agent's `allowedWalletIds` contains it. `request_in_flight`: a request for it is in a non-terminal state. A pre-signing request whose `expiresAt` has passed does not block. It is expired in the same transaction instead, the same lazy expiry the approval paths use.
- **Watch wallets** live in `watch_wallets`. No send, approval, agent or MCP path reads that table, so a watch wallet id is an unknown wallet id there. The address is validated with `isValidAddressForNetwork` (`INVALID_ADDRESS`) and stored canonical. The API refuses with `CONFLICT` for an address that is already watched (`already_watched`, any letter case) or is one of the user's linked wallets (`own_wallet`). The default name is `Watched <network display name>`. Removing sets `removed_at`. Re-adding a removed address creates a fresh row with a new id; removed rows stay as history, since the unique index covers live rows only. Idempotency: `watch_wallets.idempotency_key` is unique per user. A retry returns the same row, and the same key for another address or network is `IDEMPOTENCY_CONFLICT`. `getWatchWalletPortfolio` reads every network of the address's family in the mode through the same portfolio provider path as `/v1/portfolio`. Each balance's `walletId` is the watch wallet id, and the totals are not part of the main portfolio.

### Adapters (`apps/api/src/providers.ts`)

| Port | Mock mode (`ZYROPAY_USE_MOCK_ADAPTERS=true`, development only) | Real mode |
| --- | --- | --- |
| Builders, broadcasters, confirmations | `createMockChainAdapters` | Solana/EVM builders and broadcasters per network of the mode (`rpcUrlFor`: Helius, Alchemy), `createConfirmationTracker` |
| Portfolio, prices | `MockPortfolioProvider`, `MockPriceProvider` | `createCompositePortfolioProvider` over per-network Helius/Alchemy providers; `createPriceProvider` (Jupiter + CoinGecko) |
| Plugins | API `MockPluginAdapter` (x402 only; there is no mock swap) | `createPluginRegistry`: x402 (`X402_CAPS`), Aave, Hyperliquid; Jupiter (needs `JUPITER_API_KEY`) and Kamino on mainnet only |
| On-ramp | `MockOnrampProvider` | Transak with an encrypted Postgres token store (`provider_credentials`) shared by every isolate; without keys the endpoints refuse. `createSession` receives `CF-Connecting-IP` |
| Push | `MockNotifier` | Expo notifier (optional `EXPO_ACCESS_TOKEN`) |
| Turnkey | `MockTurnkey` when no org is configured | `TurnkeyClient` |

### Local development

- **Configuration.** `pnpm dev:setup` writes `apps/api/.dev.vars` (from `.dev.vars.example`) with generated local secrets. Then run `pnpm dev` (API + MCP + Expo) or `pnpm --filter @zyropay/api dev`.
- **Database.** `/health` works without a database in mock mode. Every other route needs `DATABASE_URL` with the migrations applied (`pnpm --filter @zyropay/db db:migrate`). For a plain local Postgres (`pnpm db:local`), set `DATABASE_DRIVER=pg`: node-postgres over workerd sockets instead of Neon's WebSocket driver, development only.
- **Mock adapters** are shared per isolate where their state matters: the dev `MockTurnkey` and the `MockBroadcaster`, whose tracker confirms only what it broadcast. Simulated pushes are logged as `push.simulated`.
- **End to end.** `pnpm smoke` runs the full agent payment flow against both workers under `wrangler dev` (`docs/SETUP.md` §6).
- **Turnkey.** Without Turnkey credentials, development mode uses `MockTurnkey`: passkey credentials named `dev-*` auto-provision a mock sub-org.
- **Tests.** `pnpm --filter @zyropay/api test` runs against PGlite (in-process Postgres) with every migration from drizzle's journal applied. `pnpm --filter @zyropay/api test:pg` runs the concurrency tests against real Postgres when `TEST_DATABASE_URL` is set (the role needs CREATEDB; each run uses and drops a throwaway database).
