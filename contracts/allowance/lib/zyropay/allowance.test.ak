//// Tests for the agent allowance rules: unit tests for every rule, then property tests.

use aiken/collection/list
use aiken/fuzz
use aiken/interval.{Finite, Interval, IntervalBound, NegativeInfinity, PositiveInfinity}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use zyropay/allowance.{
  AgentPay, AllowanceDatum, Owner, current_period, next_datum, validate,
}

// --- fixtures ----------------------------------------------------------------------------

const owner = #"0000000000000000000000000000000000000000000000000000000a"

const agent = #"0000000000000000000000000000000000000000000000000000000b"

const stranger = #"0000000000000000000000000000000000000000000000000000000c"

const script_hash = #"000000000000000000000000000000000000000000000000000000aa"

const other_script = #"000000000000000000000000000000000000000000000000000000bb"

const payee_key = #"00000000000000000000000000000000000000000000000000000001"

const other_payee_key = #"00000000000000000000000000000000000000000000000000000002"

const policy = #"000000000000000000000000000000000000000000000000000000cc"

const day = 86_400_000

const start = 1_800_000_000_000

const ada = 1_000_000

const balance = 50_000_000

const own_ref =
  OutputReference {
    transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
    output_index: 0,
  }

const agent_ref =
  OutputReference {
    transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
    output_index: 1,
  }

fn datum() -> AllowanceDatum {
  AllowanceDatum {
    agent,
    per_payment_max: 5 * ada,
    period_ms: day,
    period_cap: 20 * ada,
    period_start: start,
    spent_in_period: 0,
    allowed_payees: [VerificationKey(payee_key)],
    expires_at: start + 30 * day,
  }
}

fn script_address() -> Address {
  address.from_script(script_hash)
}

fn as_data(d: AllowanceDatum) -> Data {
  let raw: Data = d
  raw
}

fn garbage() -> Data {
  let raw: Data = #"deadbeef"
  raw
}

fn escrow_datum() -> Data {
  let raw: Data = 42
  raw
}

fn script_output(value: Int, d: AllowanceDatum) -> Output {
  Output {
    address: script_address(),
    value: assets.from_lovelace(value),
    datum: InlineDatum(as_data(d)),
    reference_script: None,
  }
}

fn key_output(key: ByteArray, value: Int) -> Output {
  Output {
    address: address.from_verification_key(key),
    value: assets.from_lovelace(value),
    datum: NoDatum,
    reference_script: None,
  }
}

fn allowance_input(d: AllowanceDatum) -> Input {
  Input { output_reference: own_ref, output: script_output(balance, d) }
}

fn agent_input() -> Input {
  Input { output_reference: agent_ref, output: key_output(agent, 10 * ada) }
}

fn range(lo: Int, hi: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lo), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(hi), is_inclusive: False },
  }
}

/// A well-formed agent payment of `paid` at time `lo` (validity [lo, lo + 10 min)).
fn pay_tx(d: AllowanceDatum, paid: Int, lo: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [allowance_input(d), agent_input()],
    outputs: [
      script_output(balance - paid, next_datum(d, paid, lo)),
      key_output(payee_key, paid),
      key_output(agent, 10 * ada - 200_000),
    ],
    fee: 200_000,
    validity_range: range(lo, lo + 600_000),
    extra_signatories: [agent],
  }
}

fn agent_ok(d: AllowanceDatum, tx: Transaction) -> Bool {
  validate(owner, Some(as_data(d)), AgentPay, own_ref, tx)
}

fn with_outputs(tx: Transaction, outputs: List<Output>) -> Transaction {
  Transaction { ..tx, outputs: outputs }
}

// --- happy paths -------------------------------------------------------------------------

test agent_pays_an_allowed_payee() {
  agent_ok(datum(), pay_tx(datum(), 3 * ada, start + 1_000))
}

test agent_pays_exactly_the_per_payment_max() {
  agent_ok(datum(), pay_tx(datum(), 5 * ada, start + 1_000))
}

test agent_reaches_exactly_the_period_cap() {
  let d = AllowanceDatum { ..datum(), spent_in_period: 15 * ada }
  agent_ok(d, pay_tx(d, 5 * ada, start + 1_000))
}

test any_payee_when_the_list_is_empty() {
  let d = AllowanceDatum { ..datum(), allowed_payees: [] }
  let tx = pay_tx(d, 2 * ada, start)
  let outputs =
    [
      script_output(balance - 2 * ada, next_datum(d, 2 * ada, start)),
      key_output(stranger, 2 * ada),
    ]
  agent_ok(d, with_outputs(tx, outputs))
}

test payment_split_over_two_allowed_payees() {
  let d =
    AllowanceDatum {
      ..datum(),
      allowed_payees: [VerificationKey(payee_key), VerificationKey(other_payee_key)],
    }
  let tx = pay_tx(d, 4 * ada, start)
  let outputs =
    [
      script_output(balance - 4 * ada, next_datum(d, 4 * ada, start)),
      key_output(payee_key, 1 * ada),
      key_output(other_payee_key, 3 * ada),
    ]
  agent_ok(d, with_outputs(tx, outputs))
}

test pays_a_script_payee_such_as_an_escrow() {
  let d = AllowanceDatum { ..datum(), allowed_payees: [Script(other_script)] }
  let tx = pay_tx(d, 4 * ada, start)
  let escrow =
    Output {
      address: address.from_script(other_script),
      value: assets.from_lovelace(4 * ada),
      datum: InlineDatum(escrow_datum()),
      reference_script: None,
    }
  let outputs =
    [script_output(balance - 4 * ada, next_datum(d, 4 * ada, start)), escrow]
  agent_ok(d, with_outputs(tx, outputs))
}

test validity_may_end_exactly_at_expiry() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  agent_ok(d, Transaction { ..tx, validity_range: range(start, d.expires_at) })
}

// --- limits ------------------------------------------------------------------------------

test over_the_per_payment_max() {
  !agent_ok(datum(), pay_tx(datum(), 5 * ada + 1, start + 1_000))
}

test over_the_period_cap() {
  let d = AllowanceDatum { ..datum(), spent_in_period: 15 * ada + 1 }
  !agent_ok(d, pay_tx(d, 5 * ada, start + 1_000))
}

test zero_payment_is_refused() {
  !agent_ok(datum(), pay_tx(datum(), 0, start))
}

test adding_funds_through_agent_pay_is_refused() {
  !agent_ok(datum(), pay_tx(datum(), -ada, start))
}

test zero_period_is_refused() {
  let d = AllowanceDatum { ..datum(), period_ms: 0 }
  let tx = pay_tx(datum(), ada, start)
  let outputs =
    [
      script_output(balance - ada, AllowanceDatum { ..d, spent_in_period: ada }),
      key_output(payee_key, ada),
    ]
  !agent_ok(d, with_outputs(tx, outputs))
}

// --- period roll-over --------------------------------------------------------------------

test rolls_over_into_the_next_period() {
  let d = AllowanceDatum { ..datum(), spent_in_period: 20 * ada }
  let lo = start + day + 3_600_000
  let next = next_datum(d, 5 * ada, lo)
  and {
    next.period_start == start + day,
    next.spent_in_period == 5 * ada,
    agent_ok(d, pay_tx(d, 5 * ada, lo)),
  }
}

test rolls_over_several_periods_aligned() {
  let d = AllowanceDatum { ..datum(), spent_in_period: 20 * ada }
  let lo = start + 3 * day + day / 2
  and {
    current_period(d, lo) == (start + 3 * day, 0),
    agent_ok(d, pay_tx(d, ada, lo)),
  }
}

test no_roll_over_one_ms_before_the_boundary() {
  let d = AllowanceDatum { ..datum(), spent_in_period: 20 * ada }
  !agent_ok(d, pay_tx(d, ada, start + day - 1))
}

test cannot_skip_the_roll_over_reset() {
  // In a new period, but the agent keeps the old window and its spent counter low.
  let d = AllowanceDatum { ..datum(), spent_in_period: 2 * ada }
  let lo = start + day + 1
  let stale = AllowanceDatum { ..d, spent_in_period: 2 * ada + ada }
  let tx = pay_tx(d, ada, lo)
  let outputs =
    [script_output(balance - ada, stale), key_output(payee_key, ada)]
  !agent_ok(d, with_outputs(tx, outputs))
}

test cannot_reset_the_counter_without_a_new_period() {
  let d = AllowanceDatum { ..datum(), spent_in_period: 18 * ada }
  let lo = start + 1_000
  let reset = AllowanceDatum { ..d, spent_in_period: 5 * ada }
  let tx = pay_tx(d, 5 * ada, lo)
  let outputs =
    [script_output(balance - 5 * ada, reset), key_output(payee_key, 5 * ada)]
  !agent_ok(d, with_outputs(tx, outputs))
}

test lower_bound_before_the_period_start() {
  !agent_ok(datum(), pay_tx(datum(), ada, start - 1))
}

// --- expiry and validity range -----------------------------------------------------------

test expired_allowance() {
  let d = datum()
  !agent_ok(d, pay_tx(d, ada, d.expires_at))
}

test validity_reaching_past_expiry() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  !agent_ok(d, Transaction { ..tx, validity_range: range(start, d.expires_at + 1) })
}

test infinite_upper_bound() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let open =
    Interval {
      ..tx.validity_range,
      upper_bound: IntervalBound {
        bound_type: PositiveInfinity,
        is_inclusive: True,
      },
    }
  !agent_ok(d, Transaction { ..tx, validity_range: open })
}

test infinite_lower_bound() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let open =
    Interval {
      ..tx.validity_range,
      lower_bound: IntervalBound {
        bound_type: NegativeInfinity,
        is_inclusive: True,
      },
    }
  !agent_ok(d, Transaction { ..tx, validity_range: open })
}

// --- signers -----------------------------------------------------------------------------

test agent_pay_without_the_agent_signature() {
  let tx = pay_tx(datum(), ada, start)
  !agent_ok(datum(), Transaction { ..tx, extra_signatories: [stranger] })
}

test agent_pay_signed_by_the_owner_only() {
  let tx = pay_tx(datum(), ada, start)
  !agent_ok(datum(), Transaction { ..tx, extra_signatories: [owner] })
}

test owner_may_withdraw_everything() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [allowance_input(datum())],
      outputs: [key_output(owner, balance - 200_000)],
      extra_signatories: [owner],
    }
  validate(owner, Some(as_data(datum())), Owner, own_ref, tx)
}

test owner_action_needs_the_owner_signature() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [allowance_input(datum())],
      outputs: [key_output(agent, balance - 200_000)],
      extra_signatories: [agent],
    }
  !validate(owner, Some(as_data(datum())), Owner, own_ref, tx)
}

test owner_recovers_a_utxo_without_datum() {
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [owner] }
  validate(owner, None, Owner, own_ref, tx)
}

test owner_recovers_a_utxo_with_a_malformed_datum() {
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [owner] }
  validate(owner, Some(garbage()), Owner, own_ref, tx)
}

test agent_pay_without_datum_fails() fail {
  validate(owner, None, AgentPay, own_ref, pay_tx(datum(), ada, start))
}

test agent_pay_with_a_malformed_datum_fails() fail {
  validate(
    owner,
    Some(garbage()),
    AgentPay,
    own_ref,
    pay_tx(datum(), ada, start),
  )
}

// --- payees ------------------------------------------------------------------------------

test pays_a_payee_not_on_the_list() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let outputs =
    [
      script_output(balance - ada, next_datum(d, ada, start)),
      key_output(stranger, ada),
    ]
  !agent_ok(d, with_outputs(tx, outputs))
}

test underpays_the_allowed_payee() {
  // 3 ADA leave the allowance; only 2 reach the payee, 1 goes to the agent's change.
  let d = datum()
  let tx = pay_tx(d, 3 * ada, start)
  let outputs =
    [
      script_output(balance - 3 * ada, next_datum(d, 3 * ada, start)),
      key_output(payee_key, 2 * ada),
      key_output(agent, ada),
    ]
  !agent_ok(d, with_outputs(tx, outputs))
}

test own_script_listed_as_payee_does_not_count() {
  let d =
    AllowanceDatum { ..datum(), allowed_payees: [Script(script_hash)] }
  let tx = pay_tx(d, ada, start)
  let outputs =
    [
      script_output(balance - ada, next_datum(d, ada, start)),
      key_output(agent, ada),
    ]
  !agent_ok(d, with_outputs(tx, outputs))
}

// --- value theft through the continuing output -------------------------------------------

test continuing_output_missing() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  !agent_ok(
    d,
    with_outputs(tx, [key_output(payee_key, ada), key_output(agent, balance - ada)]),
  )
}

test continuing_output_split_in_two() {
  // The second script output would be a fresh allowance with agent-chosen limits.
  let d = datum()
  let fresh = AllowanceDatum { ..d, per_payment_max: balance, period_cap: balance }
  let tx = pay_tx(d, ada, start)
  let outputs =
    [
      script_output(balance - ada - 10 * ada, next_datum(d, ada, start)),
      script_output(10 * ada, fresh),
      key_output(payee_key, ada),
    ]
  !agent_ok(d, with_outputs(tx, outputs))
}

test continuing_output_moves_the_stake_credential() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let moved =
    Output {
      ..script_output(balance - ada, next_datum(d, ada, start)),
      address: Address {
        payment_credential: Script(script_hash),
        stake_credential: Some(Inline(VerificationKey(agent))),
      },
    }
  !agent_ok(d, with_outputs(tx, [moved, key_output(payee_key, ada)]))
}

test continuing_output_with_a_reference_script() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let bloated =
    Output {
      ..script_output(balance - ada, next_datum(d, ada, start)),
      reference_script: Some(other_script),
    }
  !agent_ok(d, with_outputs(tx, [bloated, key_output(payee_key, ada)]))
}

test tokens_cannot_leave_the_allowance() {
  let d = datum()
  let with_tokens = assets.add(assets.from_lovelace(balance), policy, "T", 100)
  let input =
    Input {
      output_reference: own_ref,
      output: Output { ..script_output(balance, d), value: with_tokens },
    }
  let continuing =
    Output {
      ..script_output(balance - ada, next_datum(d, ada, start)),
      value: assets.add(assets.from_lovelace(balance - ada), policy, "T", 99),
    }
  let tx =
    Transaction {
      ..pay_tx(d, ada, start),
      inputs: [input, agent_input()],
      outputs: [continuing, key_output(payee_key, ada)],
    }
  !agent_ok(d, tx)
}

test tokens_kept_on_the_continuing_output_are_fine() {
  let d = datum()
  let with_tokens = assets.add(assets.from_lovelace(balance), policy, "T", 100)
  let input =
    Input {
      output_reference: own_ref,
      output: Output { ..script_output(balance, d), value: with_tokens },
    }
  let continuing =
    Output {
      ..script_output(balance - ada, next_datum(d, ada, start)),
      value: assets.add(assets.from_lovelace(balance - ada), policy, "T", 100),
    }
  let tx =
    Transaction {
      ..pay_tx(d, ada, start),
      inputs: [input, agent_input()],
      outputs: [continuing, key_output(payee_key, ada)],
    }
  agent_ok(d, tx)
}

// --- datum tampering ---------------------------------------------------------------------

fn tampered(changed: AllowanceDatum) -> Bool {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let outputs =
    [script_output(balance - ada, changed), key_output(payee_key, ada)]
  agent_ok(d, with_outputs(tx, outputs))
}

test tamper_agent() {
  !tampered(AllowanceDatum { ..next_datum(datum(), ada, start), agent: stranger })
}

test tamper_per_payment_max() {
  !tampered(
    AllowanceDatum { ..next_datum(datum(), ada, start), per_payment_max: balance },
  )
}

test tamper_period_cap() {
  !tampered(
    AllowanceDatum { ..next_datum(datum(), ada, start), period_cap: balance },
  )
}

test tamper_period_ms() {
  !tampered(AllowanceDatum { ..next_datum(datum(), ada, start), period_ms: 1 })
}

test tamper_expiry() {
  !tampered(
    AllowanceDatum {
      ..next_datum(datum(), ada, start),
      expires_at: start + 365 * day,
    },
  )
}

test tamper_payees() {
  !tampered(AllowanceDatum { ..next_datum(datum(), ada, start), allowed_payees: [] })
}

test tamper_spent_counter() {
  !tampered(AllowanceDatum { ..next_datum(datum(), ada, start), spent_in_period: 0 })
}

test continuing_datum_as_a_hash_is_refused() {
  let d = datum()
  let tx = pay_tx(d, ada, start)
  let hashed =
    Output {
      ..script_output(balance - ada, next_datum(d, ada, start)),
      datum: transaction.DatumHash(
        #"0000000000000000000000000000000000000000000000000000000000000000",
      ),
    }
  !agent_ok(d, with_outputs(tx, [hashed, key_output(payee_key, ada)]))
}

// --- double satisfaction -----------------------------------------------------------------

test two_allowance_inputs_one_payment() {
  // Both UTxOs would each see "one continuing output" only if outputs were shared; the
  // single-script-input rule refuses the transaction outright.
  let d = datum()
  let second_ref = OutputReference { ..own_ref, output_index: 1 }
  let second = Input { output_reference: second_ref, output: script_output(balance, d) }
  let tx = pay_tx(d, ada, start)
  !agent_ok(d, Transaction { ..tx, inputs: [allowance_input(d), second, agent_input()] })
}

test another_script_input_alongside() {
  // E.g. another owner's allowance for the same agent, satisfied by the same payee output.
  let d = datum()
  let foreign =
    Input {
      output_reference: OutputReference { ..agent_ref, output_index: 7 },
      output: Output {
        ..script_output(balance, d),
        address: address.from_script(other_script),
      },
    }
  let tx = pay_tx(d, ada, start)
  !agent_ok(d, Transaction { ..tx, inputs: [allowance_input(d), foreign, agent_input()] })
}

// --- properties --------------------------------------------------------------------------

test prop_accepts_iff_within_both_limits(
  sample via fuzz.both(
    fuzz.int_between(0, 20_000_000),
    fuzz.int_between(1, 8_000_000),
  ),
) {
  let (spent, paid) = sample
  let d = AllowanceDatum { ..datum(), spent_in_period: spent }
  let within = paid <= d.per_payment_max && spent + paid <= d.period_cap
  agent_ok(d, pay_tx(d, paid, start + 1_000)) == within
}

test prop_rolled_window_is_aligned_and_contains_the_spend(
  offset via fuzz.int_between(0, 2_505_600_000),
) {
  let d = datum()
  let lo = start + offset
  let (s, _) = current_period(d, lo)
  and {
    s <= lo,
    lo < s + d.period_ms,
    (s - d.period_start) % d.period_ms == 0,
  }
}

test prop_any_later_spend_after_a_full_period_is_fresh(
  offset via fuzz.int_between(86_400_000, 2_505_600_000),
) {
  // Whatever was spent before, a spend a full period later starts from zero.
  let d = AllowanceDatum { ..datum(), spent_in_period: 20 * ada }
  agent_ok(d, pay_tx(d, 5 * ada, start + offset))
}

test prop_skimming_to_change_is_refused(skim via fuzz.int_between(1, 3_000_000)) {
  // paid = 3 ADA + skim leaves the allowance, the payee still gets 3 ADA.
  let d = datum()
  let paid = 3 * ada + skim
  let tx = pay_tx(d, paid, start)
  let outputs =
    [
      script_output(balance - paid, next_datum(d, paid, start)),
      key_output(payee_key, 3 * ada),
      key_output(agent, skim),
    ]
  !agent_ok(d, with_outputs(tx, outputs))
}

test prop_only_the_agent_key_can_pay(signer via fuzz.bytearray_fixed(28)) {
  let tx = pay_tx(datum(), ada, start)
  agent_ok(datum(), Transaction { ..tx, extra_signatories: [signer] }) == (
    signer == agent
  )
}

test prop_only_the_owner_key_controls(signer via fuzz.bytearray_fixed(28)) {
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [signer] }
  validate(owner, None, Owner, own_ref, tx) == ( signer == owner )
}

test prop_expiry_is_a_hard_edge(hi via fuzz.int_between(1_800_000_000_001, 1_805_184_000_000)) {
  let d = datum()
  let tx = Transaction { ..pay_tx(d, ada, start), validity_range: range(start, hi) }
  agent_ok(d, tx) == ( hi <= d.expires_at )
}

test prop_payee_lists_are_respected(
  sample via fuzz.both(
    fuzz.list_between(fuzz.bytearray_fixed(28), 1, 4),
    fuzz.bytearray_fixed(28),
  ),
) {
  let (payees, payee) = sample
  let d =
    AllowanceDatum {
      ..datum(),
      allowed_payees: list.map(payees, fn(k) { VerificationKey(k) }),
    }
  let tx = pay_tx(d, ada, start)
  let outputs =
    [
      script_output(balance - ada, next_datum(d, ada, start)),
      key_output(payee, ada),
    ]
  agent_ok(d, with_outputs(tx, outputs)) == list.has(payees, payee)
}
