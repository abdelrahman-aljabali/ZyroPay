/*
 * ZyroPay agent allowance (contracts/allowance, PlutusV3): codecs, the owner-applied script
 * and its address, and pure (offline) transaction planners. Nothing here submits a
 * transaction, and nothing in the app's signing path calls it yet. The network-backed
 * `createCardanoAllowanceBuilder` reads UTxOs and parameters from Blockfrost and measures
 * execution units with `/utils/txs/evaluate/utxos` (`measureAllowanceSpend`); submitting and
 * signing stay with the caller (see packages/blockchain/scripts/allowance-preprod.ts).
 *
 *  - The validator is parameterized by the owner's payment key hash. `allowanceScript`
 *    applies it without a UPLC library: the flat program `(program 1.1.0 T)` becomes
 *    `(program 1.1.0 [[(lam a (lam f [f a])) (con data owner)] T])`, which evaluates to
 *    `[T owner]`. The wrapper and the data constant end byte-aligned, so T's flat bits
 *    (and its own byte-aligned bytestrings) are copied verbatim. Its hash therefore
 *    differs from `aiken blueprint apply`, but it is deterministic, cheap (a few extra CEK
 *    steps) and precomputable per owner. Tests evaluate it with `aiken tx simulate`.
 *  - Create: an ordinary owner-signed payment to the allowance address with an inline
 *    `AllowanceDatum` (no script runs).
 *  - Agent pay (redeemer AgentPay = Constr 0): the allowance input, a continuing output
 *    (same address, value minus `paid`, datum = `nextAllowanceDatum`), the payee output,
 *    change to the agent. The agent key pays the fee, posts collateral and is the required
 *    signer. Validity [start, ttl] must end by `expiresAt`.
 *  - Owner spend (redeemer Owner = Constr 1): revoke/withdraw (everything to the owner) or,
 *    with `continuing`, top up / change the limits. The owner key is the required signer.
 *
 * Script spends use the escrow module's shape: body keys 0,1,2,3,8,11,13,14,16,17; witness
 * keys 5 (Conway map redeemers) and 7 (the applied script inline).
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "@zyropay/shared";
import { cardanoNetworkId, cardanoPaymentKeyHash, parseShelleyAddress } from "@zyropay/shared";
import { ChainError } from "../errors";
import { assertAddress, assertFamily } from "../networks";
import type { HttpOptions } from "../http";
import type {
  BlockfrostUtxo,
  EvaluatedRedeemer,
  ProtocolParams,
  ScriptProtocolParams,
} from "./blockfrost";
import { BlockfrostClient } from "./blockfrost";
import { minAdaFor, planCardanoPayment, subtract, utxoValue } from "./builder";
import { ALLOWANCE_UNAPPLIED_SCRIPT_HEX } from "./allowance-script";
import type { Cbor } from "./cbor";
import { array, bytes, CborError, decodeCbor, encodeCbor, tag, uint } from "./cbor";
import {
  cardanoScriptAddress,
  cardanoSlotToPosixMs,
  plutusV3ScriptHash,
  requiredCollateral,
  scriptExecutionFee,
} from "./escrow";
import type { CardanoInput, CardanoTxOutput, CardanoValue } from "./tx";
import {
  addValues,
  assembleTx,
  bodyHashHex,
  encodeBody,
  encodeRedeemers,
  plutusV3LanguageViews,
  REDEEMER_TAG,
  scriptDataHash,
  signedSizeOf,
  sortedInputs,
  valueSize,
} from "./tx";

// --- datum and redeemers -------------------------------------------------------------

/** A payment credential (`cardano/address.Credential`): key hash or script hash, hex. */
export interface AllowancePayee {
  readonly kind: "key" | "script";
  readonly hash: string;
}

/** Mirrors `zyropay/allowance.AllowanceDatum`. Times are POSIX ms, amounts lovelace. */
export interface AllowanceDatum {
  readonly agentKeyHash: string;
  readonly perPaymentMax: bigint;
  readonly periodMs: bigint;
  readonly periodCap: bigint;
  readonly periodStart: bigint;
  readonly spentInPeriod: bigint;
  /** Empty = any recipient (the agent included). */
  readonly allowedPayees: readonly AllowancePayee[];
  readonly expiresAt: bigint;
}

export type AllowanceAction = "AgentPay" | "Owner";

const KEY_HASH = /^[0-9a-f]{56}$/;

const constr = (index: number, fields: readonly Cbor[]): Cbor => tag(121 + index, array(fields));

function assertHash(value: string, field: string): void {
  if (!KEY_HASH.test(value))
    throw new ChainError("VALIDATION_FAILED", `${field} must be a 28-byte hex hash`);
}

/** Throws unless the datum is one the validator can ever accept a payment against. */
export function assertAllowanceDatum(d: AllowanceDatum): void {
  assertHash(d.agentKeyHash, "agentKeyHash");
  for (const p of d.allowedPayees) assertHash(p.hash, "allowedPayees[].hash");
  const nonNegative = [d.perPaymentMax, d.periodCap, d.periodStart, d.spentInPeriod, d.expiresAt];
  if (nonNegative.some((v) => v < 0n))
    throw new ChainError("VALIDATION_FAILED", "allowance amounts and times must be >= 0");
  if (d.periodMs <= 0n) throw new ChainError("VALIDATION_FAILED", "periodMs must be positive");
  if (d.perPaymentMax <= 0n || d.periodCap <= 0n)
    throw new ChainError("VALIDATION_FAILED", "limits must be positive");
  if (d.spentInPeriod > d.periodCap)
    throw new ChainError("VALIDATION_FAILED", "spentInPeriod exceeds periodCap");
  if (d.expiresAt <= d.periodStart)
    throw new ChainError("VALIDATION_FAILED", "expiresAt must be after periodStart");
}

/**
 * Plutus Data CBOR of the datum (definite lengths; the validator compares structurally).
 * `unchecked` skips `assertAllowanceDatum`: only for evaluation-only refusal evidence.
 */
export function encodeAllowanceDatum(
  d: AllowanceDatum,
  options: { readonly unchecked?: boolean } = {},
): Uint8Array {
  if (options.unchecked !== true) assertAllowanceDatum(d);
  return encodeCbor(
    constr(0, [
      bytes(hexToBytes(d.agentKeyHash)),
      uint(d.perPaymentMax),
      uint(d.periodMs),
      uint(d.periodCap),
      uint(d.periodStart),
      uint(d.spentInPeriod),
      array(
        d.allowedPayees.map((p) => constr(p.kind === "key" ? 0 : 1, [bytes(hexToBytes(p.hash))])),
      ),
      uint(d.expiresAt),
    ]),
  );
}

/** Decode an on-chain inline datum (any CBOR length style). Throws ChainError. */
export function decodeAllowanceDatum(datum: Uint8Array | string): AllowanceDatum {
  const raw = typeof datum === "string" ? hexToBytes(datum) : datum;
  const bad = (why: string) =>
    new ChainError("VALIDATION_FAILED", `not an allowance datum: ${why}`);
  let value: Cbor;
  try {
    value = decodeCbor(raw, { strict: false }).value;
  } catch (error) {
    throw bad(error instanceof CborError ? error.message : "malformed CBOR");
  }
  const fieldsOf = (v: Cbor | undefined, index: number, count: number): readonly Cbor[] => {
    if (v?.t !== "tag" || v.tag !== BigInt(121 + index) || v.v.t !== "array")
      throw bad(`expected constructor ${index}`);
    if (v.v.v.length !== count) throw bad(`expected ${count} fields`);
    return v.v.v;
  };
  const int = (v: Cbor | undefined): bigint => {
    if (v?.t !== "uint") throw bad("expected a non-negative integer");
    return v.v;
  };
  const hash = (v: Cbor | undefined): string => {
    if (v?.t !== "bytes" || v.v.length !== 28) throw bad("expected a 28-byte hash");
    return bytesToHex(v.v);
  };
  const f = fieldsOf(value, 0, 8);
  const payees = f[6];
  if (payees?.t !== "array") throw bad("expected a payee list");
  const decoded: AllowanceDatum = {
    agentKeyHash: hash(f[0]),
    perPaymentMax: int(f[1]),
    periodMs: int(f[2]),
    periodCap: int(f[3]),
    periodStart: int(f[4]),
    spentInPeriod: int(f[5]),
    allowedPayees: payees.v.map((p) => {
      if (p.t === "tag" && p.tag === 121n) return { kind: "key", hash: hash(fieldsOf(p, 0, 1)[0]) };
      return { kind: "script", hash: hash(fieldsOf(p, 1, 1)[0]) };
    }),
    expiresAt: int(f[7]),
  };
  return decoded;
}

/** `AgentPay` = Constr 0 [], `Owner` = Constr 1 []. */
export function allowanceRedeemer(action: AllowanceAction): Cbor {
  return constr(action === "AgentPay" ? 0 : 1, []);
}

/** TS mirror of `current_period`: (window start, already spent) for a spend at `lowerBoundMs`. */
export function allowanceCurrentPeriod(
  d: AllowanceDatum,
  lowerBoundMs: bigint,
): { periodStart: bigint; spent: bigint } {
  const elapsed = lowerBoundMs - d.periodStart;
  if (elapsed >= d.periodMs)
    return { periodStart: d.periodStart + (elapsed / d.periodMs) * d.periodMs, spent: 0n };
  return { periodStart: d.periodStart, spent: d.spentInPeriod };
}

/**
 * The continuing datum after paying `paid` at `lowerBoundMs`, checking every limit the
 * validator checks on the datum (signer, payee and output shape are the planner's job).
 */
export function nextAllowanceDatum(
  d: AllowanceDatum,
  paid: bigint,
  lowerBoundMs: bigint,
  upperBoundMs: bigint,
): AllowanceDatum {
  assertAllowanceDatum(d);
  if (paid <= 0n) throw new ChainError("VALIDATION_FAILED", "the payment must be positive");
  if (paid > d.perPaymentMax)
    throw new ChainError("VALIDATION_FAILED", "the payment exceeds the per-payment maximum");
  if (lowerBoundMs < d.periodStart)
    throw new ChainError("VALIDATION_FAILED", "validity starts before the allowance period");
  if (upperBoundMs > d.expiresAt)
    throw new ChainError(
      "REQUEST_EXPIRED",
      "the validity window reaches past the allowance expiry",
    );
  const { periodStart, spent } = allowanceCurrentPeriod(d, lowerBoundMs);
  if (spent + paid > d.periodCap)
    throw new ChainError("VALIDATION_FAILED", "the payment exceeds what is left in this period");
  return { ...d, periodStart, spentInPeriod: spent + paid };
}

// --- the owner-applied script --------------------------------------------------------

/** Witness-set (key 7) bytes of the UNAPPLIED validator (CBOR bytestring around flat). */
export const ALLOWANCE_UNAPPLIED_SCRIPT: Uint8Array = hexToBytes(ALLOWANCE_UNAPPLIED_SCRIPT_HEX);

class BitWriter {
  private readonly out: number[] = [];
  private cur = 0;
  private n = 0;
  bits(value: number, width: number): this {
    for (let i = width - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >> i) & 1);
      if (++this.n === 8) {
        this.out.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
    return this;
  }
  /** Flat filler `0* 1` up to the next byte boundary. */
  filler(): this {
    while (this.n !== 7) this.bits(0, 1);
    return this.bits(1, 1);
  }
  bytes(): number[] {
    if (this.n !== 0) throw new Error("unaligned");
    return this.out;
  }
}

/**
 * Apply one Plutus Data parameter to a PlutusV3 script given as its CBOR bytestring (the
 * blueprint's `compiledCode`). Returns the applied script in the same form.
 */
export function applyPlutusDataParam(compiledCode: Uint8Array, param: Cbor): Uint8Array {
  const wrapper = decodeCbor(compiledCode).value;
  if (wrapper.t !== "bytes") throw new ChainError("INTERNAL_ERROR", "script is not a bytestring");
  const flat = wrapper.v;
  if (flat[0] !== 1 || flat[1] !== 1 || flat[2] !== 0)
    throw new ChainError("INTERNAL_ERROR", "expected a UPLC 1.1.0 program");
  // Term tags (4 bits): var 0, lam 2, apply 3, const 4. De Bruijn vars: natural, 8 bits here.
  const head = new BitWriter()
    .bits(3, 4) // [ [ (lam a (lam f [f a])) arg ] T ]
    .bits(3, 4)
    .bits(2, 4)
    .bits(2, 4)
    .bits(3, 4)
    .bits(0, 4)
    .bits(1, 8) // f
    .bits(0, 4)
    .bits(2, 8) // a
    .bits(4, 4) // constant
    .bits(0b110000, 6) // type list: [data] = 1 1000 0
    .filler()
    .bytes();
  const data = encodeCbor(param);
  const chunks: number[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const chunk = data.subarray(at, at + 255);
    chunks.push(chunk.length, ...chunk);
  }
  chunks.push(0);
  const applied = Uint8Array.from([1, 1, 0, ...head, ...chunks, ...flat.subarray(3)]);
  return encodeCbor(bytes(applied));
}

export interface AllowanceScript {
  readonly ownerKeyHash: string;
  /** Witness-set (key 7) bytes of the owner-applied script. */
  readonly script: Uint8Array;
  readonly scriptHash: string;
  /** Enterprise script address on `network`. */
  readonly address: string;
}

/** The owner's allowance script and address. Pure; cache it per owner. */
export function allowanceScript(network: NetworkId, ownerKeyHash: string): AllowanceScript {
  assertFamily(network, "cardano");
  assertHash(ownerKeyHash, "ownerKeyHash");
  const script = applyPlutusDataParam(ALLOWANCE_UNAPPLIED_SCRIPT, bytes(hexToBytes(ownerKeyHash)));
  const scriptHash = plutusV3ScriptHash(script);
  return { ownerKeyHash, script, scriptHash, address: cardanoScriptAddress(network, scriptHash) };
}

// --- plans ---------------------------------------------------------------------------

export interface AllowancePlan {
  /** Unsigned transaction, hex (empty vkey witnesses; script witnesses for spends). */
  readonly serialized: string;
  /** blake2b-256 of the body: the tx id and what the signing key signs. */
  readonly bodyHash: string;
  readonly fee: bigint;
  readonly inputs: readonly CardanoInput[];
}

export interface AllowanceSpendPlan extends AllowancePlan {
  readonly redeemerIndex: number;
  readonly collateralInput: CardanoInput;
  readonly totalCollateral: bigint;
  readonly outputs: readonly CardanoTxOutput[];
}

/** An allowance UTxO as it sits on chain, with its decoded datum. */
export interface AllowanceUtxo {
  readonly txHash: string;
  readonly index: number;
  readonly value: CardanoValue;
  readonly datum: AllowanceDatum;
}

function keyHashOf(network: NetworkId, address: string, field: string): string {
  assertAddress(network, address, field);
  const kh = cardanoPaymentKeyHash(address);
  if (kh === null)
    throw new ChainError("VALIDATION_FAILED", `${field} must be a payment-key address`);
  return kh;
}

export interface AllowanceCreateInput {
  readonly network: NetworkId;
  /** The owner's payment-key address: funds the allowance; its key hash is the parameter. */
  readonly from: string;
  readonly lovelace: bigint;
  readonly datum: AllowanceDatum;
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ProtocolParams;
  readonly ttlSlot: bigint;
  /**
   * The agent key's fee float (auto-pay, docs/AUTOPAY.md): output 1, a plain ADA payment to
   * `float.address`, whose payment key hash must be the datum's agent.
   */
  readonly float?: { readonly address: string; readonly lovelace: bigint };
}

/** Owner funds a new allowance. An ordinary key-witnessed payment; no script runs. */
export function planAllowanceCreate(
  input: AllowanceCreateInput,
): AllowancePlan & { readonly address: string } {
  const owner = keyHashOf(input.network, input.from, "from");
  const { address } = allowanceScript(input.network, owner);
  const output = {
    address,
    value: { coin: input.lovelace, assets: new Map<string, bigint>() },
    inlineDatum: encodeAllowanceDatum(input.datum),
  };
  const min = minAdaFor(output, input.params.coinsPerUtxoByte);
  if (input.lovelace < min)
    throw new ChainError(
      "VALIDATION_FAILED",
      `the allowance needs at least ${min.toString()} lovelace`,
    );
  const extra: CardanoTxOutput[] = [];
  if (input.float !== undefined) {
    if (keyHashOf(input.network, input.float.address, "float.address") !== input.datum.agentKeyHash)
      throw new ChainError("VALIDATION_FAILED", "the float must go to the allowance's agent");
    const floatOutput = {
      address: input.float.address,
      value: { coin: input.float.lovelace, assets: new Map<string, bigint>() },
    };
    if (input.float.lovelace < minAdaFor(floatOutput, input.params.coinsPerUtxoByte))
      throw new ChainError("VALIDATION_FAILED", "the agent float is below the Cardano minimum");
    extra.push(floatOutput);
  }
  const plan = planCardanoPayment({
    recipient: output,
    unit: null,
    utxos: input.utxos,
    params: input.params,
    ttl: input.ttlSlot,
    from: input.from,
    maxInputs: 60,
    extra,
  });
  return {
    serialized: bytesToHex(assembleTx(plan.bodyBytes, [])),
    bodyHash: bodyHashHex(plan.bodyBytes),
    fee: plan.fee,
    inputs: plan.inputs,
    address,
  };
}

interface ScriptSpend {
  readonly params: ScriptProtocolParams;
  /** Pays the fee, posts collateral, receives change, is the only required signer. */
  readonly from: string;
  readonly signer: string;
  readonly scriptInput: CardanoInput & { readonly value: CardanoValue };
  readonly script: Uint8Array;
  readonly redeemer: Cbor;
  /** Outputs placed first, in order; change to `from` follows. */
  readonly fixed: readonly CardanoTxOutput[];
  readonly utxos: readonly BlockfrostUtxo[];
  readonly validityStartSlot: bigint;
  readonly ttlSlot: bigint;
  readonly exUnits: { readonly mem: bigint; readonly steps: bigint };
}

const isPureAda = (u: BlockfrostUtxo) => u.amount.every((a) => a.unit === "lovelace");

/** Coin selection + fee fixed point for one script input (same shape as the escrow spend). */
function planScriptSpend(s: ScriptSpend): AllowanceSpendPlan {
  const { params } = s;
  if (s.validityStartSlot > s.ttlSlot)
    throw new ChainError("VALIDATION_FAILED", "validity start is after the ttl");
  if (s.exUnits.mem > params.maxTxExMem || s.exUnits.steps > params.maxTxExSteps)
    throw new ChainError("VALIDATION_FAILED", "execution units exceed the per-transaction limit");
  for (const o of s.fixed) {
    if (o.value.coin < minAdaFor(o, params.coinsPerUtxoByte))
      throw new ChainError(
        "VALIDATION_FAILED",
        "an output is below the Cardano minimum per output",
      );
  }
  const scriptInput: CardanoInput = { txHash: s.scriptInput.txHash, index: s.scriptInput.index };
  const usable = s.utxos.filter(
    (u) =>
      u.reference_script_hash === null &&
      !(u.tx_hash === scriptInput.txHash && u.output_index === scriptInput.index),
  );
  const coin = (u: BlockfrostUtxo) => utxoValue(u).coin;
  const byCoinDesc = (a: BlockfrostUtxo, b: BlockfrostUtxo) =>
    coin(b) > coin(a) ? 1 : coin(b) < coin(a) ? -1 : 0;
  const collateralUtxo = usable.filter(isPureAda).sort(byCoinDesc)[0];
  if (collateralUtxo === undefined)
    throw new ChainError("INSUFFICIENT_FUNDS", "a pure-ADA UTxO is needed as Plutus collateral");
  const ordered = [
    ...usable.filter((u) => u !== collateralUtxo && isPureAda(u)).sort(byCoinDesc),
    ...usable.filter((u) => !isPureAda(u)).sort(byCoinDesc),
    collateralUtxo,
  ];
  const languageViews = plutusV3LanguageViews(params.plutusV3CostModel);
  const execFee = scriptExecutionFee(params, s.exUnits);
  const fixedValue = addValues(s.fixed.map((o) => o.value));

  const attempt = (wallet: readonly BlockfrostUtxo[]): AllowanceSpendPlan | string => {
    const inputs: CardanoInput[] = [
      scriptInput,
      ...wallet.map((u) => ({ txHash: u.tx_hash, index: u.output_index })),
    ];
    const redeemerIndex = sortedInputs(inputs).findIndex(
      (i) => i.txHash === scriptInput.txHash && i.index === scriptInput.index,
    );
    const redeemers = encodeRedeemers([
      { tag: REDEEMER_TAG.spend, index: redeemerIndex, data: s.redeemer, ...s.exUnits },
    ]);
    const sdh = scriptDataHash({ redeemers, languageViews });
    const total = addValues([s.scriptInput.value, ...wallet.map(utxoValue)]);
    const collateralCoin = utxoValue(collateralUtxo).coin;
    let fee = 0n;
    for (let round = 0; round < 8; round++) {
      const change = subtract(total, { coin: fixedValue.coin + fee, assets: fixedValue.assets });
      if (change === null) return "insufficient token balance";
      if (change.coin < 0n) return "insufficient ADA for the fee";
      const outputs: CardanoTxOutput[] = [...s.fixed];
      if (change.coin > 0n || change.assets.size > 0) {
        const changeOutput = { address: s.from, value: change };
        if (change.coin < minAdaFor(changeOutput, params.coinsPerUtxoByte))
          return "not enough ADA left for the change output (Cardano minimum per output)";
        if (valueSize(change) > params.maxValSize) return "change output holds too many tokens";
        outputs.push(changeOutput);
      }
      if (outputs.length === 0) return "nothing left to pay out";
      const totalCollateral = requiredCollateral(fee, params.collateralPercent);
      const collateralReturn = {
        address: s.from,
        value: { coin: collateralCoin - totalCollateral, assets: new Map<string, bigint>() },
      };
      if (collateralReturn.value.coin < minAdaFor(collateralReturn, params.coinsPerUtxoByte))
        return "the collateral UTxO is too small";
      const bodyBytes = encodeBody({
        inputs,
        outputs,
        fee,
        ttl: s.ttlSlot,
        validityStart: s.validityStartSlot,
        scriptDataHash: sdh,
        collateral: [{ txHash: collateralUtxo.tx_hash, index: collateralUtxo.output_index }],
        requiredSigners: [s.signer],
        collateralReturn,
        totalCollateral,
      });
      const scripts = { redeemers, plutusV3Scripts: [s.script] };
      const size = signedSizeOf(bodyBytes, scripts);
      if (size > params.maxTxSize) return "transaction would exceed the maximum size";
      const needed = params.minFeeA * BigInt(size) + params.minFeeB + execFee;
      if (fee > 0n && needed <= fee) {
        return {
          serialized: bytesToHex(assembleTx(bodyBytes, [], scripts)),
          bodyHash: bodyHashHex(bodyBytes),
          fee,
          inputs,
          redeemerIndex,
          collateralInput: { txHash: collateralUtxo.tx_hash, index: collateralUtxo.output_index },
          totalCollateral,
          outputs,
        };
      }
      fee = needed;
    }
    return "fee did not converge";
  };

  let reason = "insufficient balance";
  const selected: BlockfrostUtxo[] = [];
  for (let i = -1; i < ordered.length && selected.length < 20; i++) {
    const next = ordered[i];
    if (next !== undefined) selected.push(next);
    const result = attempt(selected);
    if (typeof result !== "string") return result;
    reason = result;
  }
  throw new ChainError("INSUFFICIENT_FUNDS", reason);
}

export interface AllowanceAgentPayInput {
  readonly network: NetworkId;
  readonly ownerKeyHash: string;
  readonly allowance: AllowanceUtxo;
  /** The agent's payment-key address (its key hash must be the datum's agent). */
  readonly agent: string;
  readonly payee: string;
  readonly lovelace: bigint;
  /** Agent wallet UTxOs (fee inputs and collateral). */
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ScriptProtocolParams;
  readonly validityStartSlot: bigint;
  readonly ttlSlot: bigint;
  readonly exUnits: { readonly mem: bigint; readonly steps: bigint };
}

/** The agent pays `lovelace` to `payee` from the allowance. Pre-checks every on-chain rule. */
export function planAllowanceAgentPay(
  input: AllowanceAgentPayInput,
): AllowanceSpendPlan & { readonly nextDatum: AllowanceDatum } {
  const { network, allowance } = input;
  const s = allowanceScript(network, input.ownerKeyHash);
  const agent = keyHashOf(network, input.agent, "agent");
  if (agent !== allowance.datum.agentKeyHash)
    throw new ChainError("VALIDATION_FAILED", "this key is not the allowance's agent");
  // Not assertAddress: a payee may be a script (e.g. a Masumi escrow) address.
  const parsed = parseShelleyAddress(input.payee);
  if (parsed === null || parsed.networkId !== cardanoNetworkId(network))
    throw new ChainError("INVALID_ADDRESS", `payee is not a Cardano address for ${network}`);
  const payment = parsed.payment;
  if (payment === null || payment.hash === s.scriptHash)
    throw new ChainError("VALIDATION_FAILED", "the payee cannot be paid from this allowance");
  const payees = allowance.datum.allowedPayees;
  if (payees.length > 0 && !payees.some((p) => p.kind === payment.kind && p.hash === payment.hash))
    throw new ChainError("VALIDATION_FAILED", "the payee is not on the allowance's list");
  const lower = cardanoSlotToPosixMs(network, input.validityStartSlot);
  const upper = cardanoSlotToPosixMs(network, input.ttlSlot);
  const nextDatum = nextAllowanceDatum(allowance.datum, input.lovelace, lower, upper);
  if (allowance.value.coin - input.lovelace < 0n)
    throw new ChainError("INSUFFICIENT_FUNDS", "the allowance holds less than the payment");
  const continuing: CardanoTxOutput = {
    address: s.address,
    value: { coin: allowance.value.coin - input.lovelace, assets: allowance.value.assets },
    inlineDatum: encodeAllowanceDatum(nextDatum),
  };
  const plan = planScriptSpend({
    params: input.params,
    from: input.agent,
    signer: agent,
    scriptInput: allowance,
    script: s.script,
    redeemer: allowanceRedeemer("AgentPay"),
    fixed: [
      continuing,
      { address: input.payee, value: { coin: input.lovelace, assets: new Map() } },
    ],
    utxos: input.utxos,
    validityStartSlot: input.validityStartSlot,
    ttlSlot: input.ttlSlot,
    exUnits: input.exUnits,
  });
  return { ...plan, nextDatum };
}

export interface AllowanceOwnerSpendInput {
  readonly network: NetworkId;
  /** The owner's payment-key address: signer, fee payer, collateral, receives the rest. */
  readonly owner: string;
  readonly allowance: Pick<AllowanceUtxo, "txHash" | "index" | "value">;
  /** Top up / update: the allowance that remains. Omit to revoke (withdraw everything). */
  readonly continuing?: { readonly lovelace: bigint; readonly datum: AllowanceDatum };
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ScriptProtocolParams;
  readonly validityStartSlot: bigint;
  readonly ttlSlot: bigint;
  readonly exUnits: { readonly mem: bigint; readonly steps: bigint };
}

/** Owner revoke (everything back to the owner), or top-up / limit change with `continuing`. */
export function planAllowanceOwnerSpend(input: AllowanceOwnerSpendInput): AllowanceSpendPlan {
  const owner = keyHashOf(input.network, input.owner, "owner");
  const s = allowanceScript(input.network, owner);
  const fixed: CardanoTxOutput[] =
    input.continuing === undefined
      ? []
      : [
          {
            address: s.address,
            value: { coin: input.continuing.lovelace, assets: new Map() },
            inlineDatum: encodeAllowanceDatum(input.continuing.datum),
          },
        ];
  return planScriptSpend({
    params: input.params,
    from: input.owner,
    signer: owner,
    scriptInput: input.allowance,
    script: s.script,
    redeemer: allowanceRedeemer("Owner"),
    fixed,
    utxos: input.utxos,
    validityStartSlot: input.validityStartSlot,
    ttlSlot: input.ttlSlot,
    exUnits: input.exUnits,
  });
}

// --- agent float sweep ------------------------------------------------------------------

export interface AllowanceFloatSweepInput {
  readonly network: NetworkId;
  /** The agent's payment-key address (signs; every pure-ADA UTxO of it is spent). */
  readonly from: string;
  /** Where everything goes (the owner's wallet). */
  readonly to: string;
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ProtocolParams;
  readonly ttlSlot: bigint;
}

/**
 * Return the agent's whole ADA float to the owner when an allowance is revoked: every
 * pure-ADA UTxO of `from` in, one output to `to` (total minus the fee), no change. Null when
 * nothing worth sending is left (below the fee plus the Cardano minimum per output).
 */
export function planAllowanceFloatSweep(input: AllowanceFloatSweepInput): AllowancePlan | null {
  keyHashOf(input.network, input.from, "from");
  assertAddress(input.network, input.to, "to");
  const spendable = input.utxos
    .filter((u) => u.reference_script_hash === null && isPureAda(u))
    .slice(0, 60);
  if (spendable.length === 0) return null;
  const inputs = spendable.map((u) => ({ txHash: u.tx_hash, index: u.output_index }));
  const total = spendable.reduce((sum, u) => sum + utxoValue(u).coin, 0n);
  let fee = 0n;
  for (let round = 0; round < 6; round++) {
    const output = { address: input.to, value: { coin: total - fee, assets: new Map() } };
    if (output.value.coin < minAdaFor(output, input.params.coinsPerUtxoByte)) return null;
    const bodyBytes = encodeBody({ inputs, outputs: [output], fee, ttl: input.ttlSlot });
    const needed = input.params.minFeeA * BigInt(signedSizeOf(bodyBytes)) + input.params.minFeeB;
    if (fee > 0n && needed <= fee)
      return {
        serialized: bytesToHex(assembleTx(bodyBytes, [])),
        bodyHash: bodyHashHex(bodyBytes),
        fee,
        inputs,
      };
    fee = needed;
  }
  return null;
}

// --- unchecked spends (evaluation-only evidence) -------------------------------------

export interface AllowanceUncheckedSpendInput {
  readonly network: NetworkId;
  readonly ownerKeyHash: string;
  readonly action: AllowanceAction;
  /** Fee payer, collateral, change; its key hash is the required signer. */
  readonly from: string;
  readonly allowance: Pick<AllowanceUtxo, "txHash" | "index" | "value">;
  /** Outputs placed first, exactly as given (no limit checks). */
  readonly outputs: readonly CardanoTxOutput[];
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ScriptProtocolParams;
  readonly validityStartSlot: bigint;
  readonly ttlSlot: bigint;
  readonly exUnits: { readonly mem: bigint; readonly steps: bigint };
}

/**
 * Build an allowance spend WITHOUT the off-chain limit checks: the validator alone decides.
 * Only for proving refusals through script evaluation (`evaluate`); never sign one, since a
 * failing phase-2 transaction submitted to the chain forfeits its collateral.
 */
export function planAllowanceUncheckedSpend(
  input: AllowanceUncheckedSpendInput,
): AllowanceSpendPlan {
  const s = allowanceScript(input.network, input.ownerKeyHash);
  return planScriptSpend({
    params: input.params,
    from: input.from,
    signer: keyHashOf(input.network, input.from, "from"),
    scriptInput: input.allowance,
    script: s.script,
    redeemer: allowanceRedeemer(input.action),
    fixed: input.outputs,
    utxos: input.utxos,
    validityStartSlot: input.validityStartSlot,
    ttlSlot: input.ttlSlot,
    exUnits: input.exUnits,
  });
}

// --- measured execution units (network-backed) ---------------------------------------

type ExUnits = { readonly mem: bigint; readonly steps: bigint };

/** First-build budget: far above a measured allowance spend (~0.3 M mem, ~0.12 G steps). */
export const ALLOWANCE_PLACEHOLDER_EX_UNITS: ExUnits = { mem: 14_000_000n, steps: 10_000_000_000n };

export type AllowanceMeasuredPlan<P extends AllowanceSpendPlan> = P & {
  /** The units declared in the redeemer (= measured, plus any margin). */
  readonly exUnits: ExUnits;
  /** What the evaluator measured for the final transaction. */
  readonly measured: ExUnits;
  readonly evaluations: number;
};

/**
 * Build a script spend with measured execution units: build with a placeholder budget,
 * evaluate, rebuild with the measured units (* (1 + marginPercent/100), default 0 = exact),
 * and re-evaluate the rebuilt transaction until what it declares covers what it uses (the
 * fee changes the script context, so the units can move by a few steps). A script failure
 * throws VALIDATION_FAILED from the evaluator: nothing that fails is ever returned.
 */
export async function measureAllowanceSpend<P extends AllowanceSpendPlan>(input: {
  readonly build: (exUnits: ExUnits) => P;
  readonly evaluate: (serialized: string) => Promise<readonly EvaluatedRedeemer[]>;
  readonly params: Pick<ScriptProtocolParams, "maxTxExMem" | "maxTxExSteps">;
  readonly marginPercent?: number;
  readonly maxRounds?: number;
}): Promise<AllowanceMeasuredPlan<P>> {
  const { params } = input;
  const cap = (u: ExUnits): ExUnits => ({
    mem: u.mem < params.maxTxExMem ? u.mem : params.maxTxExMem,
    steps: u.steps < params.maxTxExSteps ? u.steps : params.maxTxExSteps,
  });
  const margin = BigInt(Math.round((input.marginPercent ?? 0) * 100));
  const grow = (v: bigint) => (v * (10_000n + margin) + 9_999n) / 10_000n;
  const measure = async (plan: P): Promise<ExUnits> => {
    const found = (await input.evaluate(plan.serialized)).find(
      (r) => r.tag === "spend" && r.index === plan.redeemerIndex,
    );
    if (found === undefined)
      throw new ChainError(
        "UPSTREAM_UNAVAILABLE",
        "evaluation returned no budget for the allowance",
      );
    return { mem: found.mem, steps: found.steps };
  };
  let measured = await measure(input.build(cap(ALLOWANCE_PLACEHOLDER_EX_UNITS)));
  let evaluations = 1;
  const rounds = input.maxRounds ?? 4;
  for (let round = 0; round < rounds; round++) {
    const exUnits = cap({ mem: grow(measured.mem), steps: grow(measured.steps) });
    const plan = input.build(exUnits);
    const used = await measure(plan);
    evaluations++;
    if (used.mem <= exUnits.mem && used.steps <= exUnits.steps)
      return { ...plan, exUnits, measured: used, evaluations };
    measured = {
      mem: used.mem > measured.mem ? used.mem : measured.mem,
      steps: used.steps > measured.steps ? used.steps : measured.steps,
    };
  }
  throw new ChainError("UPSTREAM_UNAVAILABLE", "execution units did not converge");
}

export interface CardanoAllowanceBuilderConfig extends HttpOptions {
  readonly network: NetworkId;
  readonly blockfrostProjectId: string;
  readonly blockfrostBaseUrl?: string;
}

type Live<T> = Omit<T, "network" | "utxos" | "params" | "exUnits"> & {
  readonly exUnits?: ExUnits;
  readonly marginPercent?: number;
};

export interface CardanoAllowanceBuilder {
  readonly network: NetworkId;
  /** Unspent UTxOs at the owner's allowance address whose inline datum decodes. */
  readAllowances(ownerKeyHash: string): Promise<AllowanceUtxo[]>;
  /** Blockfrost evaluation of an (unsigned) transaction; throws when a script fails. */
  evaluate(serialized: string): Promise<EvaluatedRedeemer[]>;
  buildCreate(
    input: Omit<AllowanceCreateInput, "network" | "utxos" | "params">,
  ): Promise<AllowancePlan & { readonly address: string }>;
  /** Units: `exUnits` if given, else measured by `measureAllowanceSpend`. */
  buildAgentPay(
    input: Live<AllowanceAgentPayInput>,
  ): Promise<
    AllowanceSpendPlan & { readonly nextDatum: AllowanceDatum; readonly exUnits: ExUnits }
  >;
  buildOwnerSpend(
    input: Live<AllowanceOwnerSpendInput>,
  ): Promise<AllowanceSpendPlan & { readonly exUnits: ExUnits }>;
}

export function createCardanoAllowanceBuilder(
  config: CardanoAllowanceBuilderConfig,
): CardanoAllowanceBuilder {
  assertFamily(config.network, "cardano");
  const client = new BlockfrostClient({
    ...config,
    projectId: config.blockfrostProjectId,
    ...(config.blockfrostBaseUrl !== undefined ? { baseUrl: config.blockfrostBaseUrl } : {}),
  });
  const network = config.network;
  const evaluate = (serialized: string) => client.evaluateTx(serialized);

  async function measured<P extends AllowanceSpendPlan>(
    params: ScriptProtocolParams,
    exUnits: ExUnits | undefined,
    marginPercent: number | undefined,
    build: (units: ExUnits) => P,
  ): Promise<P & { readonly exUnits: ExUnits }> {
    if (exUnits !== undefined) return { ...build(exUnits), exUnits };
    return measureAllowanceSpend({
      build,
      evaluate,
      params,
      ...(marginPercent !== undefined ? { marginPercent } : {}),
    });
  }

  return {
    network,
    evaluate,

    async readAllowances(ownerKeyHash) {
      const { address } = allowanceScript(network, ownerKeyHash);
      const out: AllowanceUtxo[] = [];
      for (const u of await client.utxos(address)) {
        if (u.inline_datum === null) continue;
        let datum: AllowanceDatum;
        try {
          datum = decodeAllowanceDatum(u.inline_datum);
          assertAllowanceDatum(datum);
        } catch {
          continue; // anyone can send anything here: only well-formed allowances count
        }
        out.push({ txHash: u.tx_hash, index: u.output_index, value: utxoValue(u), datum });
      }
      return out;
    },

    async buildCreate(input) {
      const [params, utxos] = await Promise.all([
        client.protocolParams(),
        client.utxos(input.from),
      ]);
      return planAllowanceCreate({ ...input, network, utxos, params });
    },

    async buildAgentPay({ exUnits, marginPercent, ...input }) {
      const [params, utxos] = await Promise.all([
        client.scriptProtocolParams(),
        client.utxos(input.agent),
      ]);
      return measured(params, exUnits, marginPercent, (units) =>
        planAllowanceAgentPay({ ...input, network, utxos, params, exUnits: units }),
      );
    },

    async buildOwnerSpend({ exUnits, marginPercent, ...input }) {
      const [params, utxos] = await Promise.all([
        client.scriptProtocolParams(),
        client.utxos(input.owner),
      ]);
      return measured(params, exUnits, marginPercent, (units) =>
        planAllowanceOwnerSpend({ ...input, network, utxos, params, exUnits: units }),
      );
    },
  };
}
