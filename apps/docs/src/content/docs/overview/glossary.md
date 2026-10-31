---
title: "Glossary"
description: "The terms these docs use, each in one or two sentences."
---

**Agent.** An AI client (Claude, ChatGPT, Claude Code, any MCP client) connected to one user. Each
connection is its own agent with its own policy and its own OAuth grant.

**MCP (Model Context Protocol).** The protocol AI clients use to call tools. ZyroPay's MCP server
exposes ten tools over Streamable HTTP, behind OAuth 2.1.

**Policy.** The rules for one agent: allowed tools, wallets, networks, recipients and protocols,
USD limits per payment, day and month, the escrow threshold, registered-sellers-only, mode
(Always Ask or Autonomous). See [Agent policy](/reference/policy/).

**Always Ask / Autonomous.** In Always Ask (the default) every payment waits for your passkey. In
Autonomous, payments within limits on Solana and EVM networks run without you; Cardano never does.

**Passkey.** A WebAuthn credential on your device (Face ID, Touch ID, device PIN). It is the only
root user of your Turnkey sub-organization.

**Turnkey sub-organization (sub-org).** Your own organization inside Turnkey, the key-custody
service. It holds your wallets; its keys never leave Turnkey's secure enclaves.

**Stamp.** Your passkey's signature over an exact Turnkey request body. ZyroPay can forward a
stamped request but cannot change it without breaking the stamp.

**Payload, payloadHash.** The canonical description of a payment (network, from, to, asset,
amount, fee cap, plugin, tool, plugin data, nonce, expiry, idempotency key) and the SHA-256 of its
canonical JSON. An approval binds to the hash; any material change makes a new hash.

**Body hash.** The Blake2b-256 hash of a Cardano transaction body: the transaction id, and the
32 bytes your passkey signs on Cardano (`SIGN_RAW_PAYLOAD_V2`).

**x402.** An open protocol for paying for HTTP resources: the server answers `402 Payment Required`
with machine-readable requirements, the client retries with a payment header.

**exact scheme.** The x402 payment scheme ZyroPay uses on Cardano: a transfer of exactly the
quoted amount to the quoted `payTo` address.

**Facilitator.** The x402 component that verifies a payment and submits it to the chain. The demo
seller runs the official `@x402/cardano` facilitator in its own worker.

**payTo.** The address the 402 asks to be paid. For an escrow payment it is the escrow script.

**Masumi escrow.** The `vested_pay` Plutus V3 script of Masumi's payment protocol (version 2). It
holds a payment until the seller records a result hash and an unlock time passes, or refunds it.

**Datum.** The data attached to the escrow output: buyer, seller, terms, deadlines, the result hash
and the state (`FundsLocked`, `ResultSubmitted`, …).

**Result hash.** `result_hash` in the escrow datum: the SHA-256 of the response body the seller
delivered, written on chain by its SubmitResult transaction.

**Proof before release.** ZyroPay's comparison of the on-chain result hash with the SHA-256 of the
bytes your agent received: `verified`, `mismatch`, `not_delivered`, …

**Delivery receipt.** The seller's Ed25519 signature, with the key behind `payTo`, over the paid
URL, `payTo`, the payment transaction and the SHA-256 of the exact body (`X-Delivery-Receipt`).

**Masumi registry, agentIdentifier.** A permissionless registry of agents on Cardano: each agent is
an NFT under the registry policy. `agentIdentifier` is policy id plus asset name (120 hex).

**Sokosumi.** Masumi's marketplace where people and agents hire registered agents.

**Reservation, ledger.** While a payment is in flight its USD value is reserved against the agent's
daily and monthly limits; once confirmed it moves to the spending ledger.

**preprod.** Cardano's public pre-production test network. Its ADA (tADA) has no value.
