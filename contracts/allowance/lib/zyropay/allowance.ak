//// ZyroPay agent allowance: a budget the owner locks at a script address, which one agent
//// key may spend only within limits this code enforces on chain.
////
//// The script is parameterized by the owner's payment key hash, so every owner has their own
//// script hash and address. Each UTxO at that address is one allowance; its inline datum
//// holds the agent key and the limits.
////
//// Two actions:
////  - `Owner`: signed by the owner key. Accepted unconditionally (revoke, withdraw, top up,
////    change the limits). The datum is not even decoded, so the owner can always recover a
////    UTxO with a missing or malformed datum.
////  - `AgentPay`: signed by the datum's agent key. One payment of `paid` lovelace, where
////    `paid` = own input lovelace - continuing output lovelace. See `agent_pay`.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use cardano/address.{PaymentCredential, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}

/// The state of one allowance. Times are POSIX milliseconds, amounts lovelace.
pub type AllowanceDatum {
  /// The only key that may spend with `AgentPay`.
  agent: VerificationKeyHash,
  /// Upper bound on one spend (per transaction: only one allowance input is allowed).
  per_payment_max: Int,
  /// Length of an accounting window; must be > 0.
  period_ms: Int,
  /// Upper bound on the sum of spends within one window.
  period_cap: Int,
  /// Start of the current window. Windows are aligned: start + k * period_ms.
  period_start: Int,
  /// Lovelace spent in the current window.
  spent_in_period: Int,
  /// Payment credentials the agent may pay. Empty means any recipient (the agent included).
  allowed_payees: List<PaymentCredential>,
  /// The agent path is closed for any transaction whose validity may reach past this.
  expires_at: Int,
}

pub type Action {
  AgentPay
  Owner
}

/// The whole spending rule; the validator in `validators/allowance.ak` only forwards here.
pub fn validate(
  owner: VerificationKeyHash,
  datum: Option<Data>,
  action: Action,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  when action is {
    Owner -> list.has(tx.extra_signatories, owner)
    AgentPay -> {
      expect Some(raw) = datum
      expect allowance: AllowanceDatum = raw
      agent_pay(allowance, own_ref, tx)
    }
  }
}

/// The window a spend at `lower_bound` falls into, and what was already spent in it:
/// the current one, or (once `lower_bound` reaches `period_start + period_ms`) the latest
/// aligned window that starts at or before `lower_bound`, with nothing spent yet.
pub fn current_period(d: AllowanceDatum, lower_bound: Int) -> (Int, Int) {
  let elapsed = lower_bound - d.period_start
  if elapsed >= d.period_ms {
    (d.period_start + elapsed / d.period_ms * d.period_ms, 0)
  } else {
    (d.period_start, d.spent_in_period)
  }
}

/// The datum the continuing output must carry after paying `paid` at `lower_bound`.
pub fn next_datum(d: AllowanceDatum, paid: Int, lower_bound: Int) -> AllowanceDatum {
  let (start, spent) = current_period(d, lower_bound)
  AllowanceDatum { ..d, period_start: start, spent_in_period: spent + paid }
}

/// Lovelace in outputs to an allowed payee (never counting this script's own outputs).
pub fn paid_to_payees(
  outputs: List<Output>,
  payees: List<PaymentCredential>,
  own: PaymentCredential,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      let cred = o.address.payment_credential
      if cred != own && list.has(payees, cred) {
        acc + assets.lovelace_of(o.value)
      } else {
        acc
      }
    },
  )
}

/// Every input is key-locked except `own_ref`: no second allowance (of this or any other
/// owner) and no other script input can be satisfied by the same payment outputs.
pub fn only_script_input(inputs: List<Input>, own_ref: OutputReference) -> Bool {
  list.all(
    inputs,
    fn(i) {
      when i.output.address.payment_credential is {
        VerificationKey(_) -> True
        Script(_) -> i.output_reference == own_ref
      }
    },
  )
}

/// An agent payment is valid when, all at once:
///  1. the agent key signed;
///  2. this is the only script-locked input (stops double satisfaction);
///  3. exactly one output pays this script credential, at the same full address, without a
///     reference script, with the same non-ADA assets: the continuing output;
///  4. 0 < paid <= per_payment_max, where paid = lovelace taken out of the allowance;
///  5. the validity range is finite, starts at or after `period_start`, ends at or before
///     `expires_at`; `period_ms` > 0;
///  6. spent in the (possibly rolled-over) window + paid <= period_cap;
///  7. the continuing inline datum is exactly `next_datum` (every other field unchanged);
///  8. when `allowed_payees` is not empty, outputs to allowed payees hold >= paid lovelace.
/// The fee is never taken from the allowance: it would count as `paid` and need a payee.
pub fn agent_pay(d: AllowanceDatum, own_ref: OutputReference, tx: Transaction) -> Bool {
  expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
  let own_address = own_input.output.address
  let own_credential = own_address.payment_credential
  expect Script(_) = own_credential
  let lower = tx.validity_range.lower_bound.bound_type
  let upper = tx.validity_range.upper_bound.bound_type
  when
    (
      list.filter(
        tx.outputs,
        fn(o) { o.address.payment_credential == own_credential },
      ),
      lower,
      upper,
    )
  is {
    ([continuing], Finite(lo), Finite(hi)) -> {
      let paid =
        assets.lovelace_of(own_input.output.value) - assets.lovelace_of(
          continuing.value,
        )
      and {
        list.has(tx.extra_signatories, d.agent),
        only_script_input(tx.inputs, own_ref),
        continuing.address == own_address,
        continuing.reference_script == None,
        assets.without_lovelace(continuing.value) == assets.without_lovelace(
          own_input.output.value,
        ),
        paid > 0,
        paid <= d.per_payment_max,
        d.period_ms > 0,
        lo >= d.period_start,
        hi <= d.expires_at,
        {
          let next = next_datum(d, paid, lo)
          let next_data: Data = next
          and {
            next.spent_in_period <= d.period_cap,
            continuing.datum == InlineDatum(next_data),
          }
        },
        or {
          d.allowed_payees == [],
          paid_to_payees(tx.outputs, d.allowed_payees, own_credential) >= paid,
        },
      }
    }
    _ -> False
  }
}
