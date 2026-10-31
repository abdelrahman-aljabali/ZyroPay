# ZyroPay agent allowance (Aiken, Plutus V3)

**Status: live on Cardano preprod, not audited, not wired into the app.** One full cycle ran on
preprod on 2026-10-30 (see [Deployments](#deployments)): an owner locked a budget, an agent key
paid from it twice without the owner's signature, the validator refused three out-of-limit
payments, and the owner revoked the rest. Nothing in ZyroPay's signing path builds or signs these
transactions yet: every Cardano payment the app makes still needs the passkey.

## Why

ZyroPay is a non-custodial passkey wallet: an AI agent asks to pay, and you approve each payment
with your passkey. On Solana and EVM, "autonomous mode" lets a delegated key pay small amounts
without a tap, bounded by a Turnkey policy. Cardano cannot use that, because Turnkey signs Cardano
transactions as an opaque 32-byte hash and so cannot bound what a delegated key signs.

The allowance moves the bound onto the chain. You lock a budget at a script address with **one
passkey tap**. A separate agent key can then pay from that budget **without a tap**, and the
**ledger itself** refuses any payment outside the limits. Your passkey stays the master key: your
owner key alone can take everything back at any time. If the agent key leaks, the most an attacker
can take is what the limits allow before you revoke.

## Model

The validator is parameterized by the **owner's payment key hash**, so each owner has their own
script hash and address. Each UTxO at that address is one allowance. Its inline datum is:

| Field             | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `agent`           | The only key that may spend with `AgentPay`                            |
| `per_payment_max` | Lovelace per transaction (only one allowance input per tx is allowed)  |
| `period_ms`       | Accounting window length (> 0)                                         |
| `period_cap`      | Lovelace per window                                                    |
| `period_start`    | Start of the current window; windows are aligned to `start + k*period` |
| `spent_in_period` | Lovelace spent in the current window                                   |
| `allowed_payees`  | Payment credentials (key or script) the agent may pay; `[]` = anyone   |
| `expires_at`      | The agent path closes once a transaction's validity reaches past this  |

Redeemers:

- **`Owner`** (Constr 1): accepted when the owner key signed, with nothing else checked. This one
  path covers revoke, withdraw, top-up and changing the limits; the off-chain builders recreate the
  output when the owner wants one to remain. The datum is not even decoded, so the owner can also
  recover a UTxO whose datum is missing or malformed.
- **`AgentPay`** (Constr 0, no fields): with `paid` = own input lovelace minus continuing output
  lovelace, every one of these must hold:
  1. the agent key signed (`extra_signatories`);
  2. every other input is key-locked: no second allowance and no other script input (this blocks
     double satisfaction, including two owners' allowances for the same agent paid by one output);
  3. exactly one output pays this script credential. It goes to the same full address (same stake
     part), carries no reference script, and holds the same non-ADA assets;
  4. `0 < paid <= per_payment_max`;
  5. the validity range is finite, `lower >= period_start`, `upper <= expires_at`, and
     `period_ms > 0`;
  6. roll-over: once `lower >= period_start + period_ms`, the window moves to the latest aligned
     start `<= lower` and the counter resets. `spent + paid <= period_cap` must still hold;
  7. the continuing inline datum is exactly that next datum, with every other field unchanged;
  8. if `allowed_payees` is not empty, outputs to listed payees (never this script) hold
     `>= paid` lovelace.

The fee never comes from the allowance. It would count as `paid` and would need a payee, so the
agent key pays fees and posts collateral from its own small ADA balance.

Time comes from the transaction's validity lower bound. The ledger only accepts a transaction once
the current slot has reached that bound, so an agent cannot roll the window over early. Choosing an
older lower bound only keeps the old window, which can only hurt the agent.

## Threat model and known limits

- **The agent key leaks:** the loss is bounded by `per_payment_max` per transaction and
  `period_cap` per window, and only to listed payees, until `expires_at` or until you revoke.
  With `allowed_payees = []`, the agent can pay itself up to those limits; that is the meaning of
  "anyone".
- **ZyroPay's server is compromised:** it holds neither the owner key nor the limits, so it can't
  move funds beyond what the agent key could.
- **Creation is not validated on chain.** Anyone can create a UTxO at your allowance address with
  any datum, funded with their own money. Off-chain code must only treat as yours an allowance that
  you funded, whose datum it decoded and checked (`decodeAllowanceDatum`, `assertAllowanceDatum`).
- **Each allowance UTxO is independent.** Two UTxOs for the same agent are two separate budgets,
  and one transaction can spend only one of them.
- **Contention:** one UTxO means one payment per block, sequentially.
- **The residue below the min-UTxO** cannot be spent by the agent; you withdraw it.
- **The parameter is applied without a UPLC library**: the program becomes
  `[[(lam a (lam f [f a])) (con data owner)] T]`. The wrapper ends byte-aligned, so the compiled
  body is copied verbatim. The script hash therefore differs from `aiken blueprint apply` (which
  substitutes into the body), but it is deterministic and precomputable per owner, and the tests
  evaluate it with the real validator.
- **Not audited.** Preprod only until it is.

## Tests

```sh
aiken check   # 49 unit + 8 property tests (100 random cases each)
aiken build   # regenerates plutus.json (committed)
```

From the repo root, `pnpm contracts:check` runs `aiken check` and verifies that `plutus.json` is
current; without aiken installed it skips. `packages/blockchain/src/__tests__/cardano-allowance.test.ts`
builds create / agent-pay / revoke / top-up transactions with the TypeScript planners
(`packages/blockchain/src/cardano/allowance.ts`). When aiken is installed it also runs them through
`aiken tx simulate` against this validator: honest payments, a period roll-over, a payment into a
Masumi escrow payee and a revoke are accepted, while transactions built from forged datums are
rejected by the script, and so are unchecked spends that each break exactly one limit. A measured
agent payment uses about 0.27 M memory units and 0.11 G CPU steps. `aiken tx simulate` checks
scripts only (phase 2); the preprod cycle under [Deployments](#deployments) also passed the
ledger's phase-1 rules (fees, min-UTxO, collateral) on a real node.

The network-backed `createCardanoAllowanceBuilder` reads UTxOs and parameters from Blockfrost and
builds spends with measured units (`measureAllowanceSpend`): a placeholder build is evaluated with
`/utils/txs/evaluate/utxos`, rebuilt with the measured units, and re-evaluated until what the
transaction declares covers what it uses. A script failure throws before anything is signed.

Every `AgentPay` rule was also mutation-checked once by hand: each rule was disabled in turn, and a
test failed for every mutant.

## Deployments

### Cardano preprod, 2026-10-30

`packages/blockchain/scripts/allowance-preprod.ts` ran the cycle with two fresh keys (kept in
`.secrets/`, git-ignored) and wrote [`deployments/preprod.json`](deployments/preprod.json): every
hash, block, fee and the evaluator's raw replies. Re-run it with
`BLOCKFROST_PROJECT_ID=preprod... pnpm --filter @zyropay/blockchain allowance:preprod --yes`.

| What             | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Owner (key hash) | `addr_test1vp728c73kcswazpl89vv44phxrglcksh9fwllqs2hkvr22sg399v3` (`7ca3e3d1…352a`)                               |
| Agent (key hash) | `addr_test1vru7fmgv4vyyqfj53t4nvkhgylrh09tlwx89xvpj8qnerhq3yr2xv` (`f9e4ed0c…91dc`)                               |
| Script hash      | `2e6f46a3598b59a61bb66fc66360e8104b159d494de56bddaeb9a037` (owner-applied, PlutusV3, 1,920 bytes, inline witness) |
| Script address   | `addr_test1wqhx734rtx94nfsmkehuvcmqaqgyk9vaf9x7267a46u6qdcw7x4js`                                                 |
| Payee (only one) | The x402 seller `addr_test1qr954…kaen`, payment credential `cb4ab9d1…ec4e`                                        |
| Limits           | 3 tADA per payment, 5 tADA per 1-day window, expiry 7 days after creation (`expires_at` 1794008156000)            |

| Step                  | Transaction                                                        | Block   | Fee (lovelace) | Units (mem / steps)   |
| --------------------- | ------------------------------------------------------------------ | ------- | -------------- | --------------------- |
| Create: lock 20 tADA  | `71ca615d2703dac9df230d2c991c54af9924b08a8cc689885fed99af67cb95f0` | 5354958 | 172,365        | no script             |
| Agent pays 2 tADA     | `caea37ca0c0f7b035ccef7a4f71c7d940fc641b4658f507cbcdf6fead8f0f5e7` | 5354960 | 291,123        | 264,349 / 106,417,209 |
| Agent pays 2 tADA     | `f3aec34444a1a2e1b92746bf0e604a6011ff3bef6d2a792e0e27d0dbb2c7a2fb` | 5354962 | 291,123        | 264,349 / 106,417,209 |
| Owner revokes 16 tADA | `e8d6b563b1b595ed15c7f1ba6824a52a96d7f8cef7433eeb226108c48f9b4284` | 5354963 | 259,217        | 28,095 / 7,961,098    |

Each agent payment carries only the agent's signature; the owner key signed only the create and
the revoke. The units are what Blockfrost's evaluator measured on the final transaction, declared
exactly (no margin), so the script part of each fee is 22,926 lovelace for a payment and 2,196 for
the revoke. With the 14 M / 10 G placeholder budget used for the first evaluation it would have
been about 1.53 tADA.

**Refused, never submitted.** Three agent payments were built without the off-chain checks
(`planAllowanceUncheckedSpend`), each breaking exactly one limit with an otherwise honest
continuing datum, and sent only to Blockfrost's evaluator. Each came back as Ogmios error 3010 with
the allowance's own redeemer (`spend`, index 0) failing with 3012 ("The machine terminated because
of an error"):

| Case                  | Payment                    | Spent before | Unsigned tx id (never on chain)                                    |
| --------------------- | -------------------------- | ------------ | ------------------------------------------------------------------ |
| Over per-payment max  | 4 tADA to the seller       | 0            | `8600bddc5038071953a633c250945ca28371044ea44314cc1478961aeafc7476` |
| Payee not on the list | 2 tADA to the agent itself | 0            | `c48043561bb97429a250272d738d30d0c2576a159c40712855c6420fbe5fc381` |
| Over the period cap   | 2 tADA after 2 + 2 (6 > 5) | 4 tADA       | `bd181ba07d19b4091ff81f4f90ffe6fdd2bcf1d9cb3bc7792e4fccbf0a0f1795` |

An earlier run of the same script against the same address minutes before was interrupted after
its first payment (Blockfrost's address index lagged a block; the script now waits for it) and was
finished by a re-run: create `9f7e5a4d…738b`, payments `c60bf980…ac24` and `de88ed86…3032`, revoke
`8286f5aa…24a7`. The cycle above is the complete, uninterrupted one.
