import { cardanoPaymentKeyHash, MASUMI_ESCROW_ADDRESSES, parseShelleyAddress } from "./cardano";
import type { CardanoTxOutputView, DecodedCardanoUnsignedTx } from "./cardano-tx";
import { cardanoSlotToMs, CardanoTxDecodeError, decodeCardanoUnsignedTx } from "./cardano-tx";
import type { NetworkId } from "./networks";
import type { AllowanceDatumView } from "./cardano-allowance";
import {
  allowanceScriptAddress,
  allowanceScriptHash,
  encodeAllowanceDatumHex,
} from "./cardano-allowance";

/*
 * On-device checks of an unsigned Cardano transaction against what a review SHOWS, so a
 * compromised API cannot describe one payment and have the passkey sign another. Each check
 * decodes the bytes itself (decodeCardanoUnsignedTx) and fails closed with a plain reason.
 * They mirror (a subset of) the API's verifiers in @zyropay/blockchain: verifyCardanoTransfer,
 * verifyCardanoEscrowLock and verifyCardanoEscrowSpend. What a device cannot know without the
 * chain (input values, cost models for script_data_hash) stays the API's job.
 */

export type CardanoTxCheck =
  | {
      readonly ok: true;
      readonly tx: DecodedCardanoUnsignedTx;
      /** The output the check proved pays the counterparty (recipient or escrow). */
      readonly payout: CardanoTxOutputView;
    }
  | { readonly ok: false; readonly reason: string };

/** Lovelace a token output may carry as its min-UTxO deposit (= blockchain's cap). */
export const CARDANO_MAX_TOKEN_OUTPUT_LOVELACE = 5_000_000n;

interface Common {
  readonly network: NetworkId;
  /** The sender's address (change and collateral must come back here). */
  readonly from: string;
  /** Upper bound on the network fee (the payload's feeCap, or the fee shown). */
  readonly maxFee: bigint;
  readonly now: Date;
}

export interface CardanoTransferExpectation extends Common {
  readonly to: string;
  /** Base units of `unit` (lovelace when `unit` is null). */
  readonly amount: bigint;
  /** Token unit (policy id || asset name, hex) or null for ADA. */
  readonly unit: string | null;
}

export interface CardanoEscrowLockExpectation extends Common {
  readonly amount: bigint;
  readonly unit: string | null;
  /** Exact lovelace on the escrow output (x402 `lockedLovelace`). */
  readonly lockedLovelace: bigint;
  /** Datum collateral (returns to the buyer): locked = (ADA ? amount : 0) + collateral. */
  readonly collateralLovelace: bigint;
  /** The bound inline datum, hex. */
  readonly datumCbor: string;
  /** POSIX ms the lock must land by (TTL no later). */
  readonly payByMs: number;
}

export interface CardanoEscrowSpendExpectation extends Common {
  readonly action: "request_refund" | "withdraw_refund";
  /** The escrow UTxO being spent, `<txHash>#<index>`. */
  readonly escrowUtxo: string;
  readonly lockedLovelace: bigint;
  /** Tokens the escrow holds (token payments), else null. */
  readonly unit: string | null;
  readonly amount: bigint;
  /** Validity window the review shows (ISO). */
  readonly validFrom: string;
  readonly validUntil: string;
}

type Result = CardanoTxCheck;
const no = (reason: string): Result => ({ ok: false, reason });

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function plain(o: CardanoTxOutputView): boolean {
  return o.format === "array" && o.inlineDatumHex === undefined && !o.hasDatumHash;
}

function sameAssets(a: ReadonlyMap<string, bigint>, unit: string | null, amount: bigint) {
  if (unit === null) return a.size === 0;
  return a.size === 1 && a.get(unit.toLowerCase()) === amount;
}

function keys(list: readonly number[]): string {
  return [...list].sort((x, y) => x - y).join(",");
}

function decode(hex: string, network: NetworkId): DecodedCardanoUnsignedTx | string {
  try {
    return decodeCardanoUnsignedTx(hex, network);
  } catch (error) {
    return error instanceof CardanoTxDecodeError
      ? `it could not be read (${error.message})`
      : "it could not be read";
  }
}

/** TTL present and in the future; returns a reason or null. */
function ttlProblem(tx: DecodedCardanoUnsignedTx, e: Common): string | null {
  if (tx.ttl === null) return "it has no expiry";
  const ms = cardanoSlotToMs(e.network, tx.ttl);
  if (ms === null) return "this network's slot times are unknown";
  if (ms <= e.now.getTime()) return "its validity window has already ended";
  return null;
}

/** Change outputs: every output after the payout is plain and goes back to `from`. */
function changeProblem(rest: readonly CardanoTxOutputView[], from: string): string | null {
  if (rest.length > 1) return "it has more outputs than a payment and its change";
  for (const o of rest) {
    if (!sameAddress(o.address, from)) return "it sends change to another address";
    if (!plain(o)) return "its change output carries extra data";
  }
  return null;
}

/**
 * A plain transfer (also x402 `exact` on Cardano): body keys exactly {0,1,2,3}; no witness;
 * output 0 pays `to` exactly `amount` (ADA: nothing else; token: exactly that token and at
 * most a 5 ADA deposit); at most one more output, plain change to `from`; fee (+ deposit)
 * within `maxFee`; TTL not past.
 */
export function checkCardanoTransferTx(hex: string, e: CardanoTransferExpectation): Result {
  const tx = decode(hex, e.network);
  if (typeof tx === "string") return no(tx);
  if (keys(tx.bodyKeys) !== "0,1,2,3") return no("it contains fields a payment never has");
  if (tx.witnessKeys.length > 0) return no("it runs a script");
  const [pay, ...rest] = tx.outputs;
  if (pay === undefined) return no("it has no outputs");
  if (!sameAddress(pay.address, e.to)) return no("it pays a different address");
  if (!plain(pay) || pay.hasScriptRef) return no("its payment output carries extra data");
  let deposit = 0n;
  if (e.unit === null) {
    if (pay.lovelace !== e.amount || pay.assets.size !== 0) return no("it pays a different amount");
  } else {
    if (!sameAssets(pay.assets, e.unit, e.amount)) return no("it pays a different token amount");
    if (pay.lovelace > CARDANO_MAX_TOKEN_OUTPUT_LOVELACE)
      return no("it sends too much ADA along with the token");
    deposit = pay.lovelace;
  }
  const change = changeProblem(rest, e.from);
  if (change !== null) return no(change);
  if (tx.fee + deposit > e.maxFee) return no("its network fee is higher than the fee cap");
  const ttl = ttlProblem(tx, e);
  if (ttl !== null) return no(ttl);
  return { ok: true, tx, payout: pay };
}

/**
 * An x402 Masumi escrow lock: body keys exactly {0,1,2,3}; no witness; output 0 is a map
 * output to the CANONICAL Masumi escrow address of the network holding exactly
 * `lockedLovelace` (+ exactly the token) with the bound inline datum byte for byte; at most
 * one more output, plain change to `from`; TTL not past and no later than payBy; fee within
 * `maxFee`. Also checks the terms add up (locked = price for ADA + collateral).
 */
export function checkCardanoEscrowLockTx(hex: string, e: CardanoEscrowLockExpectation): Result {
  const canonical = MASUMI_ESCROW_ADDRESSES[e.network];
  if (canonical === undefined) return no("there is no Masumi escrow on this network");
  if (e.lockedLovelace !== (e.unit === null ? e.amount : 0n) + e.collateralLovelace)
    return no("the locked amount does not add up to the price");
  const tx = decode(hex, e.network);
  if (typeof tx === "string") return no(tx);
  if (keys(tx.bodyKeys) !== "0,1,2,3") return no("it contains fields an escrow lock never has");
  if (tx.witnessKeys.length > 0) return no("it runs a script");
  const [lock, ...rest] = tx.outputs;
  if (lock === undefined) return no("it has no outputs");
  if (!sameAddress(lock.address, canonical)) return no("it does not pay the Masumi escrow");
  if (lock.format !== "map" || lock.hasDatumHash || lock.hasScriptRef)
    return no("its escrow output is malformed");
  if (lock.inlineDatumHex === undefined) return no("its escrow output has no datum");
  if (lock.inlineDatumHex !== e.datumCbor.replace(/^0x/, "").toLowerCase())
    return no("its escrow terms (datum) differ from the ones shown");
  if (lock.lovelace !== e.lockedLovelace) return no("it locks a different amount");
  if (!sameAssets(lock.assets, e.unit, e.amount)) return no("it locks a different token amount");
  if (rest.some((o) => sameAddress(o.address, canonical)))
    return no("it pays the escrow more than once");
  const change = changeProblem(rest, e.from);
  if (change !== null) return no(change);
  if (tx.fee > e.maxFee) return no("its network fee is higher than the fee cap");
  const ttl = ttlProblem(tx, e);
  if (ttl !== null) return no(ttl);
  const ttlMs = cardanoSlotToMs(e.network, tx.ttl ?? 0n) ?? Infinity;
  if (ttlMs > e.payByMs) return no("it stays valid past the seller's pay-by time");
  return { ok: true, tx, payout: lock };
}

/** Masumi `Action` redeemers ZyroPay builds: constructor 1 / 3 with no fields. */
const SPEND_REDEEMER: Readonly<Record<CardanoEscrowSpendExpectation["action"], string>> = {
  request_refund: "d87a80", // SetRefundRequested
  withdraw_refund: "d87c80", // WithdrawRefund
};

/**
 * A buyer escrow spend (refund request / refund withdrawal): body keys exactly
 * {0,1,2,3,8,11,13,14,16,17}; witness keys exactly {5,7}; spends the shown escrow UTxO with
 * one spend redeemer of the action at its index and only the escrow's own script; required
 * signer exactly the buyer; one collateral input (not the escrow) returning to the buyer as
 * plain ADA, at most 2x the fee at stake; request_refund: output 0 continues to the escrow
 * with the locked value and an inline datum; every other output is plain change to the
 * buyer (withdraw_refund: every output, the refund itself); validity window as shown; fee
 * within `maxFee`.
 */
export function checkCardanoEscrowSpendTx(hex: string, e: CardanoEscrowSpendExpectation): Result {
  const canonical = MASUMI_ESCROW_ADDRESSES[e.network];
  if (canonical === undefined) return no("there is no Masumi escrow on this network");
  const scriptHash = parseShelleyAddress(canonical)?.payment?.hash;
  const buyer = cardanoPaymentKeyHash(e.from);
  if (buyer === null) return no("the buyer is not a payment-key address");
  const tx = decode(hex, e.network);
  if (typeof tx === "string") return no(tx);
  if (keys(tx.bodyKeys) !== "0,1,2,3,8,11,13,14,16,17")
    return no("it contains fields an escrow spend never has");
  if (keys(tx.witnessKeys) !== "5,7") return no("it does not run exactly the escrow script");
  const [txHash, index] = e.escrowUtxo.split("#");
  const escrowIndex = tx.inputs.findIndex(
    (i) => i.txHash === txHash?.toLowerCase() && String(i.index) === index,
  );
  if (escrowIndex < 0) return no("it does not spend the escrow shown");
  const [redeemer, ...more] = tx.redeemers;
  if (redeemer === undefined || more.length > 0) return no("it runs more than one script action");
  if (redeemer.tag !== 0 || redeemer.index !== escrowIndex)
    return no("its script action is not on the escrow");
  if (redeemer.dataHex !== SPEND_REDEEMER[e.action])
    return no("it asks the escrow for another action");
  if (tx.plutusV3ScriptHashes.length !== 1 || tx.plutusV3ScriptHashes[0] !== scriptHash)
    return no("it carries a script other than the Masumi escrow");
  if (tx.requiredSigners.length !== 1 || tx.requiredSigners[0] !== buyer)
    return no("it needs a signer other than your wallet");
  const [collateral, ...moreCollateral] = tx.collateral;
  if (collateral === undefined || moreCollateral.length > 0)
    return no("it does not post exactly one collateral input");
  if (collateral.txHash === txHash?.toLowerCase() && String(collateral.index) === index)
    return no("it uses the escrow as collateral");
  const ret = tx.collateralReturn;
  if (ret === null || !sameAddress(ret.address, e.from) || !plain(ret) || ret.assets.size > 0)
    return no("its collateral does not come back to you");
  if (tx.totalCollateral === null || tx.totalCollateral > 2n * tx.fee)
    return no("it puts too much collateral at stake");

  const outputs = [...tx.outputs];
  let payout: CardanoTxOutputView | undefined;
  if (e.action === "request_refund") {
    const cont = outputs.shift();
    if (cont === undefined || !sameAddress(cont.address, canonical))
      return no("it does not keep the payment in the escrow");
    if (cont.format !== "map" || cont.hasDatumHash || cont.hasScriptRef)
      return no("its escrow output is malformed");
    if (cont.inlineDatumHex === undefined) return no("its escrow output has no datum");
    if (cont.lovelace !== e.lockedLovelace || !sameAssets(cont.assets, e.unit, e.amount))
      return no("it changes the amount held in escrow");
    payout = cont;
  } else {
    if (outputs.length !== 1) return no("it does not pay the refund back in one output");
    payout = outputs[0];
  }
  if (
    e.action === "withdraw_refund" &&
    payout !== undefined &&
    !sameAddress(payout.address, e.from)
  )
    return no("it pays the refund to another address");
  const change = changeProblem(outputs, e.from);
  if (change !== null) return no(change);
  if (payout === undefined) return no("it has no outputs");
  if (tx.fee > e.maxFee) return no("its network fee is higher than the fee shown");
  if (tx.validityStart === null || tx.ttl === null || tx.validityStart > tx.ttl)
    return no("its validity window is empty");
  if (
    cardanoSlotToMs(e.network, tx.validityStart) !== Date.parse(e.validFrom) ||
    cardanoSlotToMs(e.network, tx.ttl) !== Date.parse(e.validUntil)
  )
    return no("its validity window differs from the one shown");
  const ttl = ttlProblem(tx, e);
  if (ttl !== null) return no(ttl);
  return { ok: true, tx, payout };
}

// --- Auto-pay allowance (docs/AUTOPAY.md) -------------------------------------------------

export interface CardanoAllowanceCreateExpectation {
  readonly network: NetworkId;
  /** The owner's wallet address (funds the allowance, receives the change). */
  readonly owner: string;
  readonly agentAddress: string;
  readonly allowanceLovelace: bigint;
  readonly floatLovelace: bigint;
  /** The limits the review shows; the device encodes the datum itself. */
  readonly datum: AllowanceDatumView;
  readonly maxFee: bigint;
  readonly now: Date;
}

export interface CardanoAllowanceOwnerSpendExpectation {
  readonly network: NetworkId;
  readonly action: "top_up" | "revoke";
  readonly owner: string;
  /** The allowance UTxO being spent, `<txHash>#<index>`. */
  readonly utxo: string;
  /** top_up: the lovelace and datum the allowance keeps. */
  readonly newLovelace?: bigint;
  readonly datum?: AllowanceDatumView;
  readonly maxFee: bigint;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly now: Date;
}

/** `Owner` redeemer of the allowance validator: constructor 1, no fields. */
const ALLOWANCE_OWNER_REDEEMER = "d87a80";

/**
 * An allowance create: body keys exactly {0,1,2,3}; no witness; output 0 is a map output to
 * the owner's allowance address (derived here from the owner's key hash and the compiled
 * validator) holding exactly `allowanceLovelace`, no tokens, and the inline datum encoded
 * here from the shown limits, byte for byte; the datum's agent is the shown agent address;
 * output 1 pays the agent exactly `floatLovelace` (plain); at most one more output, plain
 * change to the owner; nothing else pays the script; fee within `maxFee`; TTL not past.
 */
export function checkCardanoAllowanceCreateTx(
  hex: string,
  e: CardanoAllowanceCreateExpectation,
): Result {
  const ownerKh = cardanoPaymentKeyHash(e.owner);
  if (ownerKh === null) return no("the wallet is not a payment-key address");
  const agentKh = cardanoPaymentKeyHash(e.agentAddress);
  if (agentKh === null) return no("the agent is not a payment-key address");
  if (agentKh !== e.datum.agentKeyHash) return no("the allowance names a different agent key");
  let script: string;
  let datumHex: string;
  try {
    script = allowanceScriptAddress(e.network, ownerKh);
    datumHex = encodeAllowanceDatumHex(e.datum);
  } catch {
    return no("the allowance limits shown are malformed");
  }
  if (BigInt(e.datum.spentInPeriod) !== 0n) return no("a new allowance must start unspent");
  const tx = decode(hex, e.network);
  if (typeof tx === "string") return no(tx);
  if (keys(tx.bodyKeys) !== "0,1,2,3") return no("it contains fields an allowance never has");
  if (tx.witnessKeys.length > 0) return no("it runs a script");
  const [lock, float, ...rest] = tx.outputs;
  if (lock === undefined || float === undefined) return no("it is missing an output");
  if (!sameAddress(lock.address, script)) return no("it does not pay your allowance contract");
  if (lock.format !== "map" || lock.hasDatumHash || lock.hasScriptRef)
    return no("its allowance output is malformed");
  if (lock.inlineDatumHex !== datumHex) return no("its limits (datum) differ from the ones shown");
  if (lock.lovelace !== e.allowanceLovelace || lock.assets.size !== 0)
    return no("it locks a different amount");
  if (!sameAddress(float.address, e.agentAddress)) return no("it funds a different agent");
  if (!plain(float) || float.hasScriptRef || float.assets.size !== 0)
    return no("its agent output carries extra data");
  if (float.lovelace !== e.floatLovelace) return no("it gives the agent a different amount");
  if (rest.some((o) => sameAddress(o.address, script)))
    return no("it pays the allowance more than once");
  const change = changeProblem(rest, e.owner);
  if (change !== null) return no(change);
  if (tx.fee > e.maxFee) return no("its network fee is higher than the fee cap");
  const ttl = ttlProblem(tx, { ...e, from: e.owner });
  if (ttl !== null) return no(ttl);
  return { ok: true, tx, payout: lock };
}

/**
 * An owner spend of the allowance (top-up or revoke): body keys exactly
 * {0,1,2,3,8,11,13,14,16,17}; witness keys exactly {5,7}; spends the shown UTxO with exactly
 * one `Owner` redeemer on it and only the owner's allowance script; required signer exactly
 * the owner; one collateral input (not the allowance) returning to the owner as plain ADA,
 * at most 2x the fee at stake; top_up: output 0 continues to the allowance with exactly
 * `newLovelace` and the shown datum (encoded here) and every other output is plain change to
 * the owner; revoke: everything goes back to the owner; validity window as shown; fee within
 * `maxFee`.
 */
export function checkCardanoAllowanceOwnerSpendTx(
  hex: string,
  e: CardanoAllowanceOwnerSpendExpectation,
): Result {
  const ownerKh = cardanoPaymentKeyHash(e.owner);
  if (ownerKh === null) return no("the wallet is not a payment-key address");
  const script = allowanceScriptAddress(e.network, ownerKh);
  const scriptHash = allowanceScriptHash(ownerKh);
  const tx = decode(hex, e.network);
  if (typeof tx === "string") return no(tx);
  if (keys(tx.bodyKeys) !== "0,1,2,3,8,11,13,14,16,17")
    return no("it contains fields an allowance spend never has");
  if (keys(tx.witnessKeys) !== "5,7") return no("it does not run exactly the allowance script");
  const [txHash, index] = e.utxo.split("#");
  const at = tx.inputs.findIndex(
    (i) => i.txHash === txHash?.toLowerCase() && String(i.index) === index,
  );
  if (at < 0) return no("it does not spend the allowance shown");
  const [redeemer, ...more] = tx.redeemers;
  if (redeemer === undefined || more.length > 0) return no("it runs more than one script action");
  if (redeemer.tag !== 0 || redeemer.index !== at || redeemer.dataHex !== ALLOWANCE_OWNER_REDEEMER)
    return no("it does not use your owner key on the allowance");
  if (tx.plutusV3ScriptHashes.length !== 1 || tx.plutusV3ScriptHashes[0] !== scriptHash)
    return no("it carries a script other than your allowance");
  if (tx.requiredSigners.length !== 1 || tx.requiredSigners[0] !== ownerKh)
    return no("it needs a signer other than your wallet");
  const [collateral, ...moreCollateral] = tx.collateral;
  if (collateral === undefined || moreCollateral.length > 0)
    return no("it does not post exactly one collateral input");
  if (collateral.txHash === txHash?.toLowerCase() && String(collateral.index) === index)
    return no("it uses the allowance as collateral");
  const ret = tx.collateralReturn;
  if (ret === null || !sameAddress(ret.address, e.owner) || !plain(ret) || ret.assets.size > 0)
    return no("its collateral does not come back to you");
  if (tx.totalCollateral === null || tx.totalCollateral > 2n * tx.fee)
    return no("it puts too much collateral at stake");
  const outputs = [...tx.outputs];
  let payout: CardanoTxOutputView | undefined;
  if (e.action === "top_up") {
    if (e.newLovelace === undefined || e.datum === undefined)
      return no("the top-up shown is incomplete");
    let datumHex: string;
    try {
      datumHex = encodeAllowanceDatumHex(e.datum);
    } catch {
      return no("the allowance limits shown are malformed");
    }
    const cont = outputs.shift();
    if (cont === undefined || !sameAddress(cont.address, script))
      return no("it does not keep the allowance");
    if (cont.format !== "map" || cont.hasDatumHash || cont.hasScriptRef)
      return no("its allowance output is malformed");
    if (cont.inlineDatumHex !== datumHex)
      return no("its limits (datum) differ from the ones shown");
    if (cont.lovelace !== e.newLovelace || cont.assets.size !== 0)
      return no("it leaves a different amount in the allowance");
    payout = cont;
  } else {
    payout = outputs[0];
    if (outputs.length !== 1 || payout === undefined || !sameAddress(payout.address, e.owner))
      return no("it does not return everything to your wallet");
  }
  if (outputs.some((o) => sameAddress(o.address, script)))
    return no("it pays the allowance more than once");
  const change = changeProblem(outputs, e.owner);
  if (change !== null) return no(change);
  if (tx.fee > e.maxFee) return no("its network fee is higher than the fee shown");
  if (tx.validityStart === null || tx.ttl === null || tx.validityStart > tx.ttl)
    return no("its validity window is empty");
  if (
    cardanoSlotToMs(e.network, tx.validityStart) !== Date.parse(e.validFrom) ||
    cardanoSlotToMs(e.network, tx.ttl) !== Date.parse(e.validUntil)
  )
    return no("its validity window differs from the one shown");
  const ttl = ttlProblem(tx, { ...e, from: e.owner });
  if (ttl !== null) return no(ttl);
  return { ok: true, tx, payout };
}
