//// ZyroPay agent allowance validator (Plutus V3). All rules live in `zyropay/allowance`.

use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{OutputReference, Transaction}
use zyropay/allowance as rules

validator allowance(owner: VerificationKeyHash) {
  spend(
    datum: Option<Data>,
    action: rules.Action,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    rules.validate(owner, datum, action, own_ref, self)
  }

  else(_) {
    fail
  }
}
