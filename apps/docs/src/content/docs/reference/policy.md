---
title: "Agent policy"
description: "Every field of an agent's policy, its default for a new agent, and what it does. Source of truth: AgentPolicySchema in packages/shared/src/domain/agents.ts."
---

One policy per agent. The app edits it with `PUT /v1/agents/:id/policy`; the agent reads it with
`get_agent_policy`. The engine that applies it is described in
[Policy decides](/how-it-works/policy/).

| Field                     | Default (new agent)     | Meaning                                                                                                                           |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                    | `always_ask`            | `always_ask`: every payment needs your passkey. `autonomous`: payments within limits run without you (never swaps, never Cardano) |
| `spendingEnabled`         | `false`                 | Master switch for value-moving tools; off denies every `send`, `swap` and `pay_x402`                                              |
| `allowedWalletIds`        | the wallets you picked  | Wallets the agent may see and use; empty means none                                                                               |
| `allowedNetworks`         | the networks you picked | Networks the agent may use                                                                                                        |
| `allowedTools`            | all eight policy tools  | MCP tools the agent may call (`find_agents` and `verify_agent` are not policy tools)                                              |
| `restrictRecipients`      | `true`                  | When on, value may only go to `recipientAllowlist`                                                                                |
| `recipientAllowlist`      | empty                   | Up to 200 `{family, address, label}`. For x402, list the seller (also for escrow, where the money first goes to the script)       |
| `allowedProtocols`        | empty                   | Plugins the agent may route through: `x402`, `jupiter`, …                                                                         |
| `limits`                  | all `"0"`               | USD cents: `perTransactionUsdMinor`, `dailyUsdMinor`, `monthlyUsdMinor`. Daily and monthly count spent plus reserved              |
| `overLimitBehavior`       | `require_approval`      | Above a limit, without a valuation or `ESCROW_REQUIRED`: `require_approval` (ask you) or `deny`                                   |
| `x402EscrowAboveUsdMinor` | `null`                  | x402 payments above this many USD cents must use Masumi escrow; `"0"` means all; `null` means no requirement                      |
| `requireRegisteredAgent`  | `false`                 | Only pay sellers with a Masumi registry identity ZyroPay verified on chain                                                        |
| `trustedAgentIdentifiers` | empty                   | With the previous rule, up to 50 `agentIdentifier`s; non-empty means only these                                                   |
| `sessionExpiresAt`        | `null`                  | The agent's access ends at this instant; `null` means until revoked                                                               |
| `revoked`                 | `false`                 | Set when you disconnect the agent                                                                                                 |
| `version`                 | `1`                     | Incremented on every change (optimistic locking)                                                                                  |

On update, an absent `x402EscrowAboveUsdMinor`, `requireRegisteredAgent` or `trustedAgentIdentifiers`
keeps its current value. Switching to `autonomous` also needs the passkey-stamped Turnkey envelope
request ([Autonomous mode](/how-it-works/autonomous/)); without a passkey signer the app refuses it.
