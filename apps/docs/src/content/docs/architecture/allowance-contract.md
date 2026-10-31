---
title: "Allowance contract"
description: "The on-chain agent allowance for Cardano: a Plutus V3 script that lets an agent key pay small amounts without a passkey tap, within limits the ledger enforces. Live on preprod, scripted and from the app as Auto-pay on Cardano."
---

**Status: the contract is live on preprod and not audited; the app uses it for Auto-pay on
Cardano, live on preprod since 2026-10-31 ([below](#how-the-app-uses-it)).** The contract ran one full cycle on Cardano
preprod on 2026-10-30 (below): an owner locked a budget, an agent key paid from it twice without
the owner's signature, the validator refused three out-of-limit payments, and the owner took the
rest back. That cycle was driven by a script with two test keys. The app now creates, tops up and
revokes allowances with your passkey and auto-pays from them; see
[How the app uses it](#how-the-app-uses-it) and [Autonomous mode](/how-it-works/autonomous/).

## The idea

Your passkey stays the master key. With one tap you lock a budget at a script address that belongs
to you. An agent key can then pay from it without asking, but the Cardano ledger refuses any
payment that breaks the limits written in the budget's datum. Your owner key alone can take
everything back at any time. If the agent key leaks, the loss is bounded by those limits until you
revoke.

| Limit            | Enforced by the script                                              |
| ---------------- | ------------------------------------------------------------------- |
| Per payment      | At most `per_payment_max` lovelace per transaction                  |
| Per period       | At most `period_cap` per aligned window of `period_ms`              |
| Recipients       | Only listed payment credentials (keys or scripts such as an escrow) |
| Expiry           | No agent payment whose validity reaches past `expires_at`           |
| Owner withdrawal | The owner key can always spend the whole UTxO, whatever its datum   |

## How a payment is checked

The validator (`contracts/allowance`, Aiken, parameterized by the owner's payment key hash) accepts
an agent payment only if all of these hold. Here `paid` is the lovelace taken out of the allowance.

1. The agent key signed.
2. The allowance is the only script-locked input. This stops double satisfaction: one payee output
   cannot settle two allowances.
3. Exactly one output returns to the same script address, with the same tokens and no reference
   script.
4. `0 < paid <= per_payment_max`.
5. The validity range is finite, starts at or after the period start, and ends by the expiry.
6. The period rolls over once the validity lower bound reaches the next window. Within the window,
   `spent + paid <= period_cap`.
7. The new datum is exactly the old one with the updated period start and counter.
8. When a payee list is set, outputs to listed payees hold at least `paid`.

The agent pays the network fee and posts collateral from its own small ADA balance. A fee taken
from the allowance would count as a payment and would need a payee.

## What is tested

- **Aiken:** 49 unit tests and 8 property tests (`aiken check`). They cover the happy paths, both
  limits, period roll-over, expiry and infinite bounds, wrong signers, wrong or underpaid payees,
  value theft through the continuing output (missing, split, moved stake key, reference script,
  tokens), every datum field tampered with, and double satisfaction. Each payment rule was
  disabled in turn once, and a test failed for every mutant.
- **TypeScript:** `packages/blockchain/src/cardano/allowance.ts` encodes the datum and redeemers,
  applies the owner parameter, derives the address, and plans create, agent-pay, revoke and top-up
  transactions; `createCardanoAllowanceBuilder` does the same against Blockfrost with measured
  execution units. With aiken installed, its tests run the built transactions through
  `aiken tx simulate` against the validator. Honest payments, a roll-over, a payment into a Masumi
  escrow and a revoke are accepted. Transactions built from forged datums are rejected by the
  script. An agent payment measured about 0.27 M memory units and 0.11 G CPU steps.

`aiken tx simulate` runs the scripts only. The preprod cycle below also passed the ledger's own
rules (fees, min-UTxO, collateral) on a real node.

## Live on preprod

`packages/blockchain/scripts/allowance-preprod.ts` ran the cycle with two fresh test keys. Its full
output, with the evaluator's raw replies, is `contracts/allowance/deployments/preprod.json`.

| What           | Value                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| Script hash    | `2e6f46a3598b59a61bb66fc66360e8104b159d494de56bddaeb9a037` (owner-applied, PlutusV3) |
| Script address | `addr_test1wqhx734rtx94nfsmkehuvcmqaqgyk9vaf9x7267a46u6qdcw7x4js`                    |
| Owner          | `addr_test1vp728c73kcswazpl89vv44phxrglcksh9fwllqs2hkvr22sg399v3`                    |
| Agent          | `addr_test1vru7fmgv4vyyqfj53t4nvkhgylrh09tlwx89xvpj8qnerhq3yr2xv`                    |
| Only payee     | The x402 demo seller `addr_test1qr954…kaen` (payment credential `cb4ab9d1…ec4e`)     |
| Limits         | 3 tADA per payment, 5 tADA per one-day window, expires 7 days after creation         |

| Step                  | Transaction                                                                                                                    | Block                                                   | Fee          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------ |
| Owner locks 20 tADA   | [`71ca615d…95f0`](https://preprod.cardanoscan.io/transaction/71ca615d2703dac9df230d2c991c54af9924b08a8cc689885fed99af67cb95f0) | [5354958](https://preprod.cardanoscan.io/block/5354958) | 0.172365 ADA |
| Agent pays 2 tADA     | [`caea37ca…f5e7`](https://preprod.cardanoscan.io/transaction/caea37ca0c0f7b035ccef7a4f71c7d940fc641b4658f507cbcdf6fead8f0f5e7) | [5354960](https://preprod.cardanoscan.io/block/5354960) | 0.291123 ADA |
| Agent pays 2 tADA     | [`f3aec344…a2fb`](https://preprod.cardanoscan.io/transaction/f3aec34444a1a2e1b92746bf0e604a6011ff3bef6d2a792e0e27d0dbb2c7a2fb) | [5354962](https://preprod.cardanoscan.io/block/5354962) | 0.291123 ADA |
| Owner revokes 16 tADA | [`e8d6b563…4284`](https://preprod.cardanoscan.io/transaction/e8d6b563b1b595ed15c7f1ba6824a52a96d7f8cef7433eeb226108c48f9b4284) | [5354963](https://preprod.cardanoscan.io/block/5354963) | 0.259217 ADA |

Each agent payment is signed by the agent key alone; the owner key signed only the lock and the
revoke. On the explorer, each payment spends the previous allowance output and recreates it with
2 tADA less and the counter (`spent_in_period`) at 2 and then 4 tADA.

**Measured units, exact fees.** The builder evaluates a draft with a placeholder budget through
Blockfrost (`/utils/txs/evaluate/utxos`), rebuilds with the measured units and re-evaluates until
the declared units cover what the transaction uses. Each payment declared 264,349 memory units and
106,417,209 CPU steps, the revoke 28,095 and 7,961,098. The script part of a payment's fee is
0.022926 ADA; the placeholder budget would have cost about 1.53 ADA.

**Refused by the validator, never submitted.** Three agent payments were built without the
off-chain checks, each breaking exactly one limit, and sent only to Blockfrost's evaluator. A
failing script in a submitted transaction would forfeit the agent's collateral, so none of them
went to the chain. Each came back as Ogmios error 3010, with the allowance's own redeemer failing
(3012, "The machine terminated because of an error"):

| Attempt                                   | Spent before | Refused because            |
| ----------------------------------------- | ------------ | -------------------------- |
| 4 tADA to the seller                      | 0            | Over the 3 tADA maximum    |
| 2 tADA to the agent's own address         | 0            | Payee not on the list      |
| 2 tADA to the seller, after the two above | 4 tADA       | 6 tADA over the 5 tADA cap |

Payments of the same shape within the limits were accepted by the evaluator and landed on chain
(the two payments above). Blockfrost's address index can lag a block behind its transaction index; the
script waits for the agent's change to appear before it builds the next payment. An earlier run
that hit this lag was finished by a re-run; it is listed in `contracts/allowance/README.md`.

## How the app uses it

**Live on preprod, 2026-10-31**, from the user's ZyroPay passkey wallet `addr_test1vqj6…3wa`:

- **Create**, one passkey tap:
  [`add08c9f…f8a8`](https://preprod.cardanoscan.io/transaction/add08c9fed47e3370c78088676cfc42f846e865f0ddd3e724faec73206e3f8a8)
  (block 5356488, fee 0.174037 ADA). 155.66391 ADA locked at the user's allowance address
  `addr_test1wrlx29…p9wn04` (script `fe651537…1aeb`) with the datum inline: $5 per payment
  (25943985 lovelace), 103775940 lovelace per one-day window, two payees (the x402 seller and an
  allowlisted address), expiry in 7 days; 5 ADA float to the agent key `addr_test1vr4fs7…e2r7jq`.
- **Auto-pay**, no tap: ChatGPT bought the address report on the direct x402 route, policy `allow`
  with `AUTO_PAY_ALLOWANCE`, `CONFIRMED`:
  [`987cb743…e93a`](https://preprod.cardanoscan.io/transaction/987cb74358846030b5b5dde30fd07c19fd06a1a5d69033118bf0448b1ff2e93a)
  (block 5356540, fee 0.293462 ADA). It spends the allowance (`AgentPay`, 274,101 memory units,
  110,909,110 CPU steps) and the agent's float, pays 2 ADA to the seller and returns
  153.66391 ADA to the allowance with `spent_in_period = 2000000`. The seller's receipt verified.
- Top-up and revoke from the app are tested offline; neither has run live yet.

Every check on the explorer is on [Evidence](/evidence/#auto-pay-the-agent-paid-with-no-tap-limits-enforced-by-cardano).

- **Create** (`POST /v1/agents/:agentId/allowance`): the API generates an Ed25519 agent key for this
  allowance, encrypts it (AES-256-GCM, `DELEGATED_KEY_ENCRYPTION_KEY`, AAD = user and allowance
  ids) and builds the lock plus a fee float to the agent key. The app checks the bytes with
  `checkCardanoAllowanceCreateTx` (script address derived on the device from the compiled
  validator, datum byte for byte) and signs the body hash with the passkey
  (`SIGN_RAW_PAYLOAD_V2`); `/submit` re-verifies the stamp against the stored build, attaches the
  witness and submits once.
- **Auto-pay**: for a Cardano `send` or direct x402 `exact` in ADA that the agent policy would
  only send to approval (Always Ask), `evaluateAutoPay` checks the allowance as read from the chain
  (payee, per-payment, today's cap after roll-over, balance above the minimum, float, expiry, one
  payment in flight). The executor builds the `AgentPay` spend with measured units, re-checks it
  independently (`checkAgentPayTx`: spends that UTxO, continuing output and next datum exactly as
  the validator requires, the payee paid exactly, fee cap), signs with the agent key and submits a
  send, or hands an x402 payment to the seller's facilitator. The request goes `APPROVED → SIGNING
→ BROADCAST → CONFIRMED` without an approval, with `autoPay` on its result.
- **One payment at a time**: the allowance is one UTxO, so a request while another spend is not yet
  confirmed falls back to the passkey (`ALLOWANCE_BUSY`). The check runs under the agent's policy
  row lock, so two concurrent requests cannot both be routed to the allowance.
- **Top-up and revoke** are owner spends (`Owner` redeemer) checked with
  `checkCardanoAllowanceOwnerSpendTx`. After a revoke the float is swept back and the agent key's
  ciphertext is destroyed.

## Limits

- **Creation is not checked on chain.** Anyone can send a UTxO with any datum to your allowance
  address, using their own funds. Off-chain code must trust only allowances you funded and whose
  datum it decoded and checked.
- **An empty payee list means anyone**, the agent included.
- **Each allowance UTxO is a separate budget**, and only one can be spent per transaction.
- **One payment per block** per allowance, because the UTxO is spent and recreated each time.
- **The agent key is held by the server**, encrypted, one per allowance, destroyed on revoke. A
  compromised server could spend up to the limits until you revoke, never more.
- **Fiat limits are fixed at creation.** The chain only knows lovelace; if ADA moves, the EUR or
  USD value of the limits moves with it.
- **Not audited.** An audit is on the [roadmap](/limits/) before any mainnet use. Preprod only.
