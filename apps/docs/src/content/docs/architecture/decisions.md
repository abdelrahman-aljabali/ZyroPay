---
title: "Decisions (ADRs)"
description: "The three architecture decision records behind ZyroPay's signing model, summarized, with what Turnkey policies can and cannot enforce. The full records are docs/ARCHITECTURE.md in the repository."
---

The full decision records, with every source, are in `docs/ARCHITECTURE.md` (§4, §4a, §4b) in the
repository. This page summarizes what was decided and why.

## ADR-001: Turnkey signing model

**Accepted.** ZyroPay must be non-custodial, and agents need two modes: Always Ask and
bounded Autonomous.

| #   | Decision                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One Turnkey sub-org per user; your passkey is the sole root (quorum of one, threshold 1), and the API refuses to activate any other layout. No ZyroPay recovery override: that is the cost of being non-custodial.                      |
| D2  | Every approval is a passkey stamp the API forwards. The API checks the stamp type, sub-org, signing key, byte-equal bytes, `payloadHash`, expiry and an independent decode. Session-key stamps are accepted only for read-only queries. |
| D3  | Sign only, never Turnkey's sign-and-send, which fills nonce, gas and fees after review. The signed transaction is the reviewed one; one broadcaster serves every chain.                                                                 |
| D4  | Solana blockhashes expire in about a minute, approvals can wait longer: the unsigned transaction is rebuilt near expiry. The payload hash never covers the blockhash, so the material terms stay identical.                             |
| D5  | Always Ask grants ZyroPay no signing capability at all. No delegated user exists until you turn on Autonomous.                                                                                                                          |
| D6  | Autonomous uses one delegated non-root key user per sub-org, created by your own passkey together with a Turnkey policy envelope (within Turnkey's 5-policy limit). Per-agent and USD rules live in the API.                            |
| D7  | Swaps are never autonomous: a router can move any token the transaction touches.                                                                                                                                                        |
| D8  | Revoking the last autonomous agent destroys the delegated key at once; the inert Turnkey user and policies are removed by your passkey at the next setup.                                                                               |

### What Turnkey policies can and cannot enforce

| Requirement                                  | Turnkey                                           | Where enforced                               |
| -------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| Allowed chains (EVM chain id)                | Yes                                               | Turnkey and API                              |
| Recipient allowlist, EVM native and ERC-20   | Yes                                               | Turnkey and API                              |
| Recipient allowlist, SOL                     | Yes                                               | Turnkey and API                              |
| Recipient allowlist, SPL tokens              | Partly: sees the token account, not the owner     | Turnkey (token account) and API (owner)      |
| Per-transaction cap in token units           | Yes (128-bit integers)                            | Turnkey and API                              |
| Allowed programs and contracts               | Yes                                               | Turnkey and API                              |
| **USD limits**                               | **No** (no price oracle)                          | **API only**, fail closed on a missing price |
| **Daily and monthly totals, rate limits**    | **No** (velocity controls are not released)       | **API only** (ledger and reservations)       |
| Per-agent rules across one delegated user    | No                                                | API only                                     |
| Indirect transfers (routers, internal calls) | No                                                | Not allowed autonomously (D7)                |
| Anything your passkey signs as root          | No: root bypasses policies                        | By design: you are sovereign                 |
| **Anything on Cardano**                      | **No**: Turnkey cannot parse Cardano transactions | Cardano is never autonomous (ADR-002 C5)     |

## ADR-002: Cardano keys and signing

**Accepted.** Turnkey supports Cardano only at the curve level: an Ed25519 key whose
"address" is the raw public key, and a raw signature over the 32-byte transaction body hash.

| #   | Decision                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | One Cardano account per wallet, path `m/1852'/1815'/0'/0'/0'` with every level hardened (a soft Ed25519 step is undefined under SLIP-10).                        |
| C2  | The address is the CIP-19 enterprise address of Blake2b-224(public key) on the deployment's network. No stake credential, so no staking rewards.                 |
| C3  | Honest consequence: this is not the address Daedalus, Yoroi or Eternl show for the same phrase. Recovery is through Turnkey; the app and these docs say so.      |
| C4  | Approval is a passkey-stamped `SIGN_RAW_PAYLOAD_V2` over the body hash the API recomputes; the API verifies the returned signature before attaching the witness. |
| C5  | Cardano is never autonomous: excluded in the policy engine, refused by the autonomous executor and by the Turnkey client.                                        |
| C6  | One Blockfrost project per network; production reads only the mainnet id, development only preprod, and every client checks the genesis network magic.           |

Since accepted, the open item "a preprod end-to-end payment" is closed: see [Evidence](/evidence/).
Still open: UTxO reservation for concurrent sends from one address (today the second fails with
`inputs_spent`).

## ADR-003: Importing a wallet

**Accepted.** A recovery phrase or private key goes only from your device to Turnkey's
import enclave, encrypted on the device (HPKE) after the enclave's key is verified. It is never sent to
ZyroPay, logged or stored; the API and the app refuse any request body that looks like key material.
Addresses are derived on the device and compared with Turnkey's before the wallet is registered. A
Cardano account on an imported phrase is opt-in and labelled as different from other wallets'
addresses. Status: tested with mocks and unit tests, not yet run against a real Turnkey org on a
device.
