/*
 * Masumi escrow (x402 `assetTransferMethod: "masumi"`, payment-v2 `vested_pay`, PlutusV3)
 * on Cardano: a pure codec/builder layer, no API wiring.
 *
 *  - Lock (buyer pays into escrow): an ordinary key-witnessed transaction whose first output
 *    is a map-format output to the escrow script address with an INLINE datum (opaque bytes
 *    produced by `@x402/cardano`'s `buildMasumiLock`), plus change. Body keys 0-3 only: no
 *    script runs at lock time, so every lock rule is checked off-chain (here and by the
 *    facilitator). TTL = slot of payByTime, floored.
 *  - Buyer script spends (SetRefundRequested = Constr 1, WithdrawRefund = Constr 3): body
 *    keys 0,1,2,3,8,11,13,14,16,17; witness keys 5 (Conway map redeemers) and 7 (the applied
 *    script inline; no reference-script UTxO exists for vested_pay v2), plus the buyer's vkey
 *    witness added at signing time (`attachCardanoWitness` keeps keys 5/7 byte-exact).
 *
 * Fee of a script spend = minFeeA * size + minFeeB + ceil(priceMem*mem + priceStep*steps).
 * Total collateral = ceil(fee * collateralPercent / 100) from one pure-ADA key UTxO, the
 * rest returned (key 16). script_data_hash = blake2b-256(redeemers || language views
 * {2: PlutusV3 costs}) — no witness datums (the escrow datum is inline).
 *
 * Ex-units come from Blockfrost `/utils/txs/evaluate/utxos` (`BlockfrostClient.evaluateTx`);
 * `createCardanoEscrowBuilder().buildSpend` evaluates with placeholder units first and then
 * rebuilds with the measured units plus a margin. Nothing here submits a transaction.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "@zyropay/shared";
import {
  cardanoAddressBytes,
  cardanoAddressFromBytes,
  cardanoNetworkId,
  cardanoPaymentKeyHash,
  parseShelleyAddress,
} from "@zyropay/shared";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord } from "../http";
import { assertAddress, assertFamily } from "../networks";
import type {
  BlockfrostUtxo,
  EvaluatedRedeemer,
  ProtocolParams,
  Rational,
  ScriptProtocolParams,
} from "./blockfrost";
import { BlockfrostClient, parseAmounts } from "./blockfrost";
import { minAdaFor, planCardanoPayment, subtract, utxoValue } from "./builder";
import type { Cbor } from "./cbor";
import { array, decodeCbor, encodeCbor, tag } from "./cbor";
import { MASUMI_VESTED_PAY_V2_SCRIPT_HEX } from "./masumi-script";
import type { CardanoInput, CardanoTxOutput, CardanoValue, DecodedCardanoTx } from "./tx";
import {
  addValues,
  assembleTx,
  bodyHashHex,
  decodeCardanoTx,
  encodeBody,
  encodeRedeemers,
  plutusV3LanguageViews,
  REDEEMER_TAG,
  scriptDataHash,
  signedSizeOf,
  sortedInputs,
  valueSize,
} from "./tx";

// --- time ----------------------------------------------------------------------------

/** Shelley-era slot <-> POSIX ms (1 s slots). Same constants as evolution-sdk SlotConfig. */
export const CARDANO_SLOT_CONFIG: Readonly<
  Partial<Record<NetworkId, { zeroTimeMs: bigint; zeroSlot: bigint; slotLengthMs: bigint }>>
> = {
  "cardano-mainnet": { zeroTimeMs: 1596059091000n, zeroSlot: 4492800n, slotLengthMs: 1000n },
  "cardano-preprod": { zeroTimeMs: 1655769600000n, zeroSlot: 86400n, slotLengthMs: 1000n },
};

function slotConfig(network: NetworkId) {
  const c = CARDANO_SLOT_CONFIG[network];
  if (c === undefined)
    throw new ChainError("NETWORK_NOT_SUPPORTED", `no slot config for ${network}`);
  return c;
}

/** POSIX ms at the START of `slot` (what Plutus sees for either validity bound). */
export function cardanoSlotToPosixMs(network: NetworkId, slot: bigint): bigint {
  const c = slotConfig(network);
  return c.zeroTimeMs + (slot - c.zeroSlot) * c.slotLengthMs;
}

/**
 * Slot containing `ms` ("floor": posix(slot) <= ms, for a TTL that must not pass a deadline)
 * or the first slot starting at/after `ms` ("ceil": for a lower bound that must be >= ms).
 */
export function cardanoPosixMsToSlot(
  network: NetworkId,
  ms: bigint | number,
  rounding: "floor" | "ceil",
): bigint {
  const c = slotConfig(network);
  const t = BigInt(ms) - c.zeroTimeMs;
  if (t < 0n) throw new ChainError("VALIDATION_FAILED", "time is before the Shelley era");
  const q = t / c.slotLengthMs;
  return c.zeroSlot + (rounding === "ceil" && t % c.slotLengthMs !== 0n ? q + 1n : q);
}

// --- the Masumi script ---------------------------------------------------------------

/** Witness-set (key 7) bytes of the applied vested_pay v2 script. */
export const MASUMI_SCRIPT_BYTES: Uint8Array = hexToBytes(MASUMI_VESTED_PAY_V2_SCRIPT_HEX);

/** PlutusV3 script hash: blake2b-224(0x03 || script bytes). */
export function plutusV3ScriptHash(script: Uint8Array): string {
  const tagged = new Uint8Array(script.length + 1);
  tagged[0] = 0x03;
  tagged.set(script, 1);
  return bytesToHex(blake2b(tagged, { dkLen: 28 }));
}

export const MASUMI_SCRIPT_HASH = plutusV3ScriptHash(MASUMI_SCRIPT_BYTES);

/** Enterprise script address (header 0x70 | network id) of a script hash. */
export function cardanoScriptAddress(network: NetworkId, scriptHash: string): string {
  const bytes = new Uint8Array(29);
  bytes[0] = 0x70 | cardanoNetworkId(network);
  bytes.set(hexToBytes(scriptHash), 1);
  const address = cardanoAddressFromBytes(bytes);
  if (address === null) throw new ChainError("INTERNAL_ERROR", "script address encoding failed");
  return address;
}

/** The canonical Masumi v2 escrow address (equals `@x402/cardano` masumiEscrowAddress). */
export function masumiEscrowAddress(network: NetworkId): string {
  assertFamily(network, "cardano");
  return cardanoScriptAddress(network, MASUMI_SCRIPT_HASH);
}

/** Buyer actions ZyroPay builds, with their `Action` constructor index (vested_pay.ak). */
export const MASUMI_BUYER_ACTIONS = { SetRefundRequested: 1, WithdrawRefund: 3 } as const;
export type MasumiBuyerAction = keyof typeof MASUMI_BUYER_ACTIONS;

/** Constructor 0..6 with no fields: tag 121+i around an empty array (`d87a80` for 1). */
export function masumiRedeemer(action: MasumiBuyerAction): Cbor {
  return tag(121 + MASUMI_BUYER_ACTIONS[action], array([]));
}

// --- helpers -------------------------------------------------------------------------

const HEX = /^(?:[0-9a-f]{2})+$/;

function hexArg(value: string, what: string): Uint8Array {
  const hex = value.replace(/^0x/, "").toLowerCase();
  if (!HEX.test(hex)) throw new ChainError("VALIDATION_FAILED", `${what} must be hex`);
  return hexToBytes(hex);
}

/** Opaque Plutus Data bytes: must be ONE well-formed CBOR item (indefinite lengths allowed). */
function datumArg(value: string, what: string): Uint8Array {
  const bytes = hexArg(value, what);
  try {
    decodeCbor(bytes, { strict: false });
  } catch {
    throw new ChainError("VALIDATION_FAILED", `${what} is not a single CBOR item`);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function valuesEqual(a: CardanoValue, b: CardanoValue): boolean {
  if (a.coin !== b.coin || a.assets.size !== b.assets.size) return false;
  for (const [unit, qty] of a.assets) if (b.assets.get(unit) !== qty) return false;
  return true;
}

function sameAddress(bytes: Uint8Array, address: string): boolean {
  try {
    return bytesEqual(bytes, cardanoAddressBytes(address));
  } catch {
    return false;
  }
}

/** The script hash a Shelley address's payment credential is, else null (key/invalid). */
function scriptCredential(address: string): string | null {
  const parsed = parseShelleyAddress(address);
  return parsed?.payment?.kind === "script" ? parsed.payment.hash : null;
}

/** Throws unless `address` is a script-credential address on `network`. */
function assertScriptAddress(network: NetworkId, address: string, field: string): void {
  const parsed = parseShelleyAddress(address);
  if (parsed === null || parsed.networkId !== cardanoNetworkId(network))
    throw new ChainError("INVALID_ADDRESS", `${field} is not a Cardano address for ${network}`);
  if (parsed.payment?.kind !== "script")
    throw new ChainError("VALIDATION_FAILED", `${field} must be a script address`);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** ceil(priceMem*mem + priceStep*steps), as the ledger computes it (exact rationals). */
export function scriptExecutionFee(
  prices: { priceMem: Rational; priceStep: Rational },
  units: { mem: bigint; steps: bigint },
): bigint {
  const { priceMem: m, priceStep: s } = prices;
  return ceilDiv(m.num * units.mem * s.den + s.num * units.steps * m.den, m.den * s.den);
}

/** Ledger rule: total_collateral * 100 >= fee * collateralPercent. */
export function requiredCollateral(fee: bigint, collateralPercent: bigint): bigint {
  return ceilDiv(fee * collateralPercent, 100n);
}

const isPureAda = (u: BlockfrostUtxo) => u.amount.every((a) => a.unit === "lovelace");

// --- lock ----------------------------------------------------------------------------

export interface CardanoEscrowLockInput {
  readonly network: NetworkId;
  /** Buyer (payment key address); change returns here. */
  readonly from: string;
  readonly escrowAddress: string;
  /** EXACT lovelace on the escrow output (x402 `lockedLovelace`); never topped up. */
  readonly lovelace: bigint;
  /** Tokens on the escrow output (token payments), unit -> quantity. */
  readonly assets?: ReadonlyMap<string, bigint>;
  /** Inline datum, hex CBOR (opaque; embedded byte for byte). */
  readonly datumCbor: string;
  /** invalid_hereafter: `cardanoPosixMsToSlot(network, payByTime, "floor")`. */
  readonly ttlSlot: bigint;
  /** A UTxO that must be spent (the x402 `nonce`). */
  readonly requiredInput?: CardanoInput;
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ProtocolParams;
  readonly maxInputs?: number;
}

export interface CardanoEscrowPlan {
  /** Unsigned transaction, hex (empty vkey witnesses; script witnesses for spends). */
  readonly serialized: string;
  /** blake2b-256 of the body: the tx id and what the buyer's key signs. */
  readonly bodyHash: string;
  readonly fee: bigint;
  readonly ttlSlot: bigint;
  readonly inputs: readonly CardanoInput[];
}

/** Pure lock plan (no network). Throws ChainError; self-checks with the verifier. */
export function planCardanoEscrowLock(input: CardanoEscrowLockInput): CardanoEscrowPlan {
  assertFamily(input.network, "cardano");
  assertAddress(input.network, input.from, "from");
  assertScriptAddress(input.network, input.escrowAddress, "escrowAddress");
  if (cardanoPaymentKeyHash(input.from) === null)
    throw new ChainError("VALIDATION_FAILED", "the buyer must be a payment-key address");
  if (input.lovelace <= 0n) throw new ChainError("VALIDATION_FAILED", "lovelace must be positive");
  const datum = datumArg(input.datumCbor, "datumCbor");
  const assets = new Map(input.assets ?? []);
  for (const q of assets.values())
    if (q <= 0n) throw new ChainError("VALIDATION_FAILED", "asset quantities must be positive");
  const escrowOutput = {
    address: input.escrowAddress,
    value: { coin: input.lovelace, assets },
    inlineDatum: datum,
  };
  // Min-UTxO counts the datum bytes (they are part of the serialized output).
  const min = minAdaFor(escrowOutput, input.params.coinsPerUtxoByte);
  if (input.lovelace < min) {
    throw new ChainError(
      "VALIDATION_FAILED",
      `the escrow output needs at least ${min.toString()} lovelace with this datum`,
    );
  }
  if (valueSize(escrowOutput.value) > input.params.maxValSize)
    throw new ChainError("VALIDATION_FAILED", "escrow output value is too large");
  const unit = assets.size === 1 ? ([...assets.keys()][0] ?? null) : null;
  const plan = planCardanoPayment({
    recipient: escrowOutput,
    unit,
    utxos: input.utxos,
    params: input.params,
    ttl: input.ttlSlot,
    from: input.from,
    maxInputs: input.maxInputs ?? 60,
    ...(input.requiredInput !== undefined ? { required: [input.requiredInput] } : {}),
  });
  const serialized = bytesToHex(assembleTx(plan.bodyBytes, []));
  const check = verifyCardanoEscrowLock(serialized, {
    network: input.network,
    from: input.from,
    escrowAddress: input.escrowAddress,
    lovelace: input.lovelace,
    assets,
    datumCbor: input.datumCbor,
    ttlSlot: input.ttlSlot,
    ...(input.requiredInput !== undefined ? { requiredInput: input.requiredInput } : {}),
  });
  if (!check.ok)
    throw new ChainError("INTERNAL_ERROR", `built lock failed self-check: ${check.reason}`);
  return {
    serialized,
    bodyHash: bodyHashHex(plan.bodyBytes),
    fee: plan.fee,
    ttlSlot: input.ttlSlot,
    inputs: plan.inputs,
  };
}

export interface CardanoEscrowLockExpectation {
  readonly network: NetworkId;
  readonly from: string;
  readonly escrowAddress: string;
  readonly lovelace: bigint;
  readonly assets?: ReadonlyMap<string, bigint>;
  readonly datumCbor: string;
  /** Exact TTL expected, if known. */
  readonly ttlSlot?: bigint;
  /** Upper bound on the TTL (e.g. slot of payByTime). */
  readonly maxTtlSlot?: bigint;
  readonly requiredInput?: CardanoInput;
  readonly feeCap?: bigint;
}

export type EscrowVerification = { ok: true } | { ok: false; reason: string };

/**
 * Independent strict check of an UNSIGNED escrow lock. Fails closed:
 *  - strict canonical CBOR whose body re-encodes byte for byte;
 *  - body keys exactly {0,1,2,3}; no witnesses; is_valid; no auxiliary data;
 *  - output 0: map format to exactly `escrowAddress`, exactly `lovelace` (+ exactly the
 *    expected tokens), inline datum byte-equal to `datumCbor`, no script reference;
 *  - at most one more output: plain change to `from`; no other output touches the escrow;
 *  - TTL as expected; the required (nonce) input is spent; fee <= feeCap.
 */
export function verifyCardanoEscrowLock(
  serialized: string,
  expected: CardanoEscrowLockExpectation,
): EscrowVerification {
  const fail = (reason: string): EscrowVerification => ({ ok: false, reason });
  try {
    if (!HEX.test(serialized)) return fail("expected lowercase hex CBOR");
    const tx = decodeCardanoTx(hexToBytes(serialized), { strict: true });
    if (!tx.isValid) return fail("is_valid must be true");
    if (tx.hasAuxiliaryData) return fail("auxiliary data is not allowed");
    if (tx.witnessKeys.length !== 0) return fail("unsigned transaction must have no witnesses");
    const keys = [...tx.bodyKeys].sort((a, b) => a - b).join(",");
    if (keys !== "0,1,2,3") return fail(`unexpected body fields: ${keys}`);
    if (tx.fee === null || tx.ttl === null) return fail("fee and ttl are required");
    if (tx.inputs.length === 0) return fail("no inputs");
    const body = encodeBody({ inputs: tx.inputs, outputs: tx.outputs, fee: tx.fee, ttl: tx.ttl });
    if (!bytesEqual(body, tx.bodyBytes)) return fail("body is not in canonical form");
    if (tx.outputs.length < 1 || tx.outputs.length > 2)
      return fail("expected one escrow output and at most one change output");
    const [escrow, change] = tx.outputs;
    if (escrow === undefined || !sameAddress(escrow.addressBytes, expected.escrowAddress))
      return fail("first output does not pay the escrow address");
    if (escrow.format !== "map" || escrow.hasScriptRef || escrow.datumHash !== undefined)
      return fail("escrow output must be a map-format output with only an inline datum");
    if (escrow.inlineDatum === undefined) return fail("escrow output has no inline datum");
    if (!bytesEqual(escrow.inlineDatum, datumArg(expected.datumCbor, "datumCbor")))
      return fail("escrow datum differs from the expected datum");
    const want = { coin: expected.lovelace, assets: new Map(expected.assets ?? []) };
    if (!valuesEqual(escrow.value, want)) return fail("escrow output value differs");
    if (change !== undefined) {
      if (!sameAddress(change.addressBytes, expected.from))
        return fail("second output is not change to the buyer");
      if (change.hasExtras || change.format !== "array")
        return fail("change output must be a plain output");
    }
    if (expected.ttlSlot !== undefined && tx.ttl !== expected.ttlSlot)
      return fail("ttl differs from the expected slot");
    if (expected.maxTtlSlot !== undefined && tx.ttl > expected.maxTtlSlot)
      return fail("ttl is past the pay-by time");
    const nonce = expected.requiredInput;
    if (
      nonce !== undefined &&
      !tx.inputs.some((i) => i.txHash === nonce.txHash && i.index === nonce.index)
    )
      return fail("the nonce input is not spent");
    if (expected.feeCap !== undefined && tx.fee > expected.feeCap)
      return fail("fee exceeds the fee cap");
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? `decode failed: ${error.message}` : "decode failed");
  }
}

// --- script spend --------------------------------------------------------------------

/** An escrow UTxO as it sits on chain. */
export interface EscrowUtxo {
  readonly txHash: string;
  readonly index: number;
  readonly address: string;
  readonly value: CardanoValue;
  /** Inline datum hex, when read from chain (informational for the spend builder). */
  readonly inlineDatum?: string;
}

export interface CardanoEscrowSpendInput {
  readonly network: NetworkId;
  readonly action: MasumiBuyerAction;
  /** Buyer (payment key address): pays the fee, posts collateral, required signer, payee. */
  readonly from: string;
  readonly escrow: EscrowUtxo;
  /** SetRefundRequested: the continuing output's datum (hex). Must be absent otherwise. */
  readonly continuingDatumCbor?: string;
  /** Buyer wallet UTxOs (fee inputs and collateral candidates). */
  readonly utxos: readonly BlockfrostUtxo[];
  readonly params: ScriptProtocolParams;
  /** Body key 8 (lower bound) and key 3 (upper bound), absolute slots. */
  readonly validityStartSlot: bigint;
  readonly ttlSlot: bigint;
  /** Execution units of the escrow redeemer (from evaluation). */
  readonly exUnits: { readonly mem: bigint; readonly steps: bigint };
  /** Applied script bytes; defaults to the canonical Masumi v2 script. */
  readonly script?: Uint8Array;
  readonly maxInputs?: number;
}

export interface CardanoEscrowSpendPlan extends CardanoEscrowPlan {
  readonly validityStartSlot: bigint;
  /** Index of the escrow input in the sorted input set (the redeemer's index). */
  readonly redeemerIndex: number;
  readonly scriptDataHash: string;
  readonly collateralInput: CardanoInput;
  readonly totalCollateral: bigint;
  readonly exUnits: { readonly mem: bigint; readonly steps: bigint };
}

/** Pure script-spend plan (no network). Throws ChainError; self-checks with the verifier. */
export function planCardanoEscrowSpend(input: CardanoEscrowSpendInput): CardanoEscrowSpendPlan {
  const { params, network } = input;
  assertFamily(network, "cardano");
  assertAddress(network, input.from, "from");
  assertScriptAddress(network, input.escrow.address, "escrow.address");
  const signer = cardanoPaymentKeyHash(input.from);
  if (signer === null)
    throw new ChainError("VALIDATION_FAILED", "the buyer must be a payment-key address");
  const script = input.script ?? MASUMI_SCRIPT_BYTES;
  if (scriptCredential(input.escrow.address) !== plutusV3ScriptHash(script))
    throw new ChainError("VALIDATION_FAILED", "the escrow UTxO is not locked by this script");
  if (input.validityStartSlot > input.ttlSlot)
    throw new ChainError("VALIDATION_FAILED", "validity start is after the ttl");
  if (input.exUnits.mem > params.maxTxExMem || input.exUnits.steps > params.maxTxExSteps)
    throw new ChainError("VALIDATION_FAILED", "execution units exceed the per-transaction limit");
  const continuing =
    input.action === "SetRefundRequested"
      ? {
          address: input.escrow.address,
          value: input.escrow.value,
          inlineDatum: datumArg(input.continuingDatumCbor ?? "", "continuingDatumCbor"),
        }
      : null;
  if (continuing === null && input.continuingDatumCbor !== undefined)
    throw new ChainError("VALIDATION_FAILED", "WithdrawRefund has no continuing output");
  if (continuing !== null) {
    const min = minAdaFor(continuing, params.coinsPerUtxoByte);
    if (continuing.value.coin < min)
      throw new ChainError(
        "VALIDATION_FAILED",
        `the continuing escrow output needs ${min.toString()} lovelace; it holds ${continuing.value.coin.toString()}`,
      );
  }

  const escrowInput: CardanoInput = { txHash: input.escrow.txHash, index: input.escrow.index };
  const usable = input.utxos.filter(
    (u) =>
      u.reference_script_hash === null &&
      !(u.tx_hash === escrowInput.txHash && u.output_index === escrowInput.index),
  );
  const coin = (u: BlockfrostUtxo) => utxoValue(u).coin;
  const byCoinDesc = (a: BlockfrostUtxo, b: BlockfrostUtxo) =>
    coin(b) > coin(a) ? 1 : coin(b) < coin(a) ? -1 : 0;
  // Collateral: the largest pure-ADA UTxO; used for fees only when nothing else suffices.
  const collateralUtxo = usable.filter(isPureAda).sort(byCoinDesc)[0];
  if (collateralUtxo === undefined)
    throw new ChainError("INSUFFICIENT_FUNDS", "a pure-ADA UTxO is needed as Plutus collateral");
  const ordered = [
    ...usable.filter((u) => u !== collateralUtxo && isPureAda(u)).sort(byCoinDesc),
    ...usable.filter((u) => !isPureAda(u)).sort(byCoinDesc),
    collateralUtxo,
  ];
  const redeemersFor = (index: number) =>
    encodeRedeemers([
      {
        tag: REDEEMER_TAG.spend,
        index,
        data: masumiRedeemer(input.action),
        mem: input.exUnits.mem,
        steps: input.exUnits.steps,
      },
    ]);
  const languageViews = plutusV3LanguageViews(params.plutusV3CostModel);
  const execFee = scriptExecutionFee(params, input.exUnits);
  const maxInputs = input.maxInputs ?? 20;

  const attempt = (wallet: readonly BlockfrostUtxo[]): CardanoEscrowSpendPlan | string => {
    const inputs: CardanoInput[] = [
      escrowInput,
      ...wallet.map((u) => ({ txHash: u.tx_hash, index: u.output_index })),
    ];
    const redeemerIndex = sortedInputs(inputs).findIndex(
      (i) => i.txHash === escrowInput.txHash && i.index === escrowInput.index,
    );
    const redeemers = redeemersFor(redeemerIndex);
    const sdh = scriptDataHash({ redeemers, languageViews });
    const total = addValues([input.escrow.value, ...wallet.map(utxoValue)]);
    const collateralValue = utxoValue(collateralUtxo);
    let fee = 0n;
    for (let round = 0; round < 8; round++) {
      const change = subtract(total, {
        coin: (continuing?.value.coin ?? 0n) + fee,
        assets: continuing?.value.assets ?? new Map(),
      });
      if (change === null) return "insufficient token balance";
      if (change.coin < 0n) return "insufficient ADA for the fee";
      const outputs: CardanoTxOutput[] = continuing === null ? [] : [continuing];
      if (change.coin > 0n || change.assets.size > 0) {
        const changeOutput = { address: input.from, value: change };
        if (change.coin < minAdaFor(changeOutput, params.coinsPerUtxoByte))
          return "not enough ADA left for the change output (Cardano minimum per output)";
        if (valueSize(change) > params.maxValSize) return "change output holds too many tokens";
        outputs.push(changeOutput);
      }
      if (outputs.length === 0) return "nothing left to pay out";
      const totalCollateral = requiredCollateral(fee, params.collateralPercent);
      const collateralReturn = {
        address: input.from,
        value: { coin: collateralValue.coin - totalCollateral, assets: new Map<string, bigint>() },
      };
      if (collateralReturn.value.coin < minAdaFor(collateralReturn, params.coinsPerUtxoByte))
        return `the collateral UTxO is too small (needs more than ${totalCollateral.toString()} lovelace plus the minimum return)`;
      const bodyBytes = encodeBody({
        inputs,
        outputs,
        fee,
        ttl: input.ttlSlot,
        validityStart: input.validityStartSlot,
        scriptDataHash: sdh,
        collateral: [{ txHash: collateralUtxo.tx_hash, index: collateralUtxo.output_index }],
        requiredSigners: [signer],
        collateralReturn,
        totalCollateral,
      });
      const scripts = { redeemers, plutusV3Scripts: [script] };
      const size = signedSizeOf(bodyBytes, scripts);
      if (size > params.maxTxSize) return "transaction would exceed the maximum size";
      const needed = params.minFeeA * BigInt(size) + params.minFeeB + execFee;
      if (fee > 0n && needed <= fee) {
        const unsigned = assembleTx(bodyBytes, [], scripts);
        return {
          serialized: bytesToHex(unsigned),
          bodyHash: decodeCardanoTx(unsigned).bodyHash,
          fee,
          ttlSlot: input.ttlSlot,
          validityStartSlot: input.validityStartSlot,
          inputs,
          redeemerIndex,
          scriptDataHash: bytesToHex(sdh),
          collateralInput: { txHash: collateralUtxo.tx_hash, index: collateralUtxo.output_index },
          totalCollateral,
          exUnits: input.exUnits,
        };
      }
      fee = needed;
    }
    return "fee did not converge";
  };

  let reason = "insufficient balance";
  const selected: BlockfrostUtxo[] = [];
  let plan: CardanoEscrowSpendPlan | null = null;
  // WithdrawRefund may pay its fee from the escrow itself: try without wallet inputs first.
  for (let i = continuing === null ? -1 : 0; i < ordered.length && plan === null; i++) {
    const next = ordered[i];
    if (next !== undefined) {
      if (selected.length >= maxInputs) break;
      selected.push(next);
    }
    const result = attempt(selected);
    if (typeof result === "string") reason = result;
    else plan = result;
  }
  if (plan === null) throw new ChainError("INSUFFICIENT_FUNDS", reason);

  const check = verifyCardanoEscrowSpend(plan.serialized, {
    network,
    action: input.action,
    from: input.from,
    escrow: input.escrow,
    ...(input.continuingDatumCbor !== undefined
      ? { continuingDatumCbor: input.continuingDatumCbor }
      : {}),
    plutusV3CostModel: params.plutusV3CostModel,
    collateralPercent: params.collateralPercent,
    collateralInputValue: utxoValue(collateralUtxo).coin,
    validityStartSlot: input.validityStartSlot,
    ttlSlot: input.ttlSlot,
    script,
  });
  if (!check.ok)
    throw new ChainError("INTERNAL_ERROR", `built spend failed self-check: ${check.reason}`);
  return plan;
}

export interface CardanoEscrowSpendExpectation {
  readonly network: NetworkId;
  readonly action: MasumiBuyerAction;
  readonly from: string;
  readonly escrow: Pick<EscrowUtxo, "txHash" | "index" | "address" | "value">;
  readonly continuingDatumCbor?: string;
  /** Cost model the script_data_hash must commit to (fresh from protocol parameters). */
  readonly plutusV3CostModel: readonly bigint[];
  readonly collateralPercent?: bigint;
  /** Lovelace of the (single) collateral input, to check total + return add up. */
  readonly collateralInputValue?: bigint;
  readonly validityStartSlot?: bigint;
  readonly ttlSlot?: bigint;
  readonly feeCap?: bigint;
  /** Expected script bytes; defaults to the canonical Masumi v2 script. */
  readonly script?: Uint8Array;
}

const SPEND_BODY_KEYS = "0,1,2,3,8,11,13,14,16,17";

/**
 * Independent strict check of an UNSIGNED buyer escrow spend. Fails closed:
 *  - strict canonical CBOR; body keys exactly {0,1,2,3,8,11,13,14,16,17}; witness keys
 *    exactly {5,7}; is_valid; no auxiliary data; body re-encodes byte for byte;
 *  - the escrow UTxO is an input and the ONLY redeemer is spend[its sorted index] with the
 *    action's constructor; the only script is the expected one (hash = escrow credential);
 *  - script_data_hash = blake2b-256(witness redeemer bytes || language views(cost model));
 *  - required signers = [buyer key hash]; collateral is not the escrow, returns to the
 *    buyer, total >= fee * collateralPercent / 100 (and adds up to the input if given);
 *  - SetRefundRequested: output 0 continues to the escrow address with the escrow's exact
 *    value and the expected inline datum; every other output is plain, to the buyer.
 *    WithdrawRefund: every output is plain, to the buyer (buyer_return_address = None);
 *  - validity bounds as expected; fee <= feeCap.
 */
export function verifyCardanoEscrowSpend(
  serialized: string,
  expected: CardanoEscrowSpendExpectation,
): EscrowVerification {
  const fail = (reason: string): EscrowVerification => ({ ok: false, reason });
  try {
    if (!HEX.test(serialized)) return fail("expected lowercase hex CBOR");
    const tx: DecodedCardanoTx = decodeCardanoTx(hexToBytes(serialized), { strict: true });
    if (!tx.isValid) return fail("is_valid must be true");
    if (tx.hasAuxiliaryData) return fail("auxiliary data is not allowed");
    const keys = [...tx.bodyKeys].sort((a, b) => a - b).join(",");
    if (keys !== SPEND_BODY_KEYS) return fail(`unexpected body fields: ${keys}`);
    const wkeys = [...tx.witnessKeys].sort((a, b) => a - b).join(",");
    if (wkeys !== "5,7") return fail(`unexpected witness fields: ${wkeys}`);
    if (
      tx.fee === null ||
      tx.ttl === null ||
      tx.validityStart === null ||
      tx.scriptDataHash === null ||
      tx.collateralReturn === null ||
      tx.totalCollateral === null
    )
      return fail("missing script-spend fields");
    const body = encodeBody({
      inputs: tx.inputs,
      outputs: tx.outputs,
      fee: tx.fee,
      ttl: tx.ttl,
      validityStart: tx.validityStart,
      scriptDataHash: hexToBytes(tx.scriptDataHash),
      collateral: tx.collateral,
      requiredSigners: tx.requiredSigners,
      collateralReturn: tx.collateralReturn,
      totalCollateral: tx.totalCollateral,
    });
    if (!bytesEqual(body, tx.bodyBytes)) return fail("body is not in canonical form");

    const escrowIndex = sortedInputs(tx.inputs).findIndex(
      (i) => i.txHash === expected.escrow.txHash && i.index === expected.escrow.index,
    );
    if (escrowIndex < 0) return fail("the escrow UTxO is not spent");
    const [redeemer, ...extraRedeemers] = tx.redeemers;
    if (redeemer === undefined || extraRedeemers.length > 0)
      return fail("expected exactly one redeemer");
    if (redeemer.tag !== REDEEMER_TAG.spend || redeemer.index !== escrowIndex)
      return fail("the redeemer does not point at the escrow input");
    if (!bytesEqual(redeemer.dataBytes, encodeCbor(masumiRedeemer(expected.action))))
      return fail("the redeemer is not the expected action");
    const script = expected.script ?? MASUMI_SCRIPT_BYTES;
    const [txScript, ...extraScripts] = tx.plutusV3Scripts;
    if (txScript === undefined || extraScripts.length > 0 || !bytesEqual(txScript, script))
      return fail("the transaction does not carry exactly the expected script");
    if (scriptCredential(expected.escrow.address) !== plutusV3ScriptHash(script))
      return fail("the escrow address is not locked by the expected script");
    const redeemerBytes = tx.witnessEntries.get(5);
    if (redeemerBytes === undefined) return fail("missing redeemers");
    const sdh = scriptDataHash({
      redeemers: redeemerBytes,
      languageViews: plutusV3LanguageViews(expected.plutusV3CostModel),
    });
    if (bytesToHex(sdh) !== tx.scriptDataHash) return fail("script_data_hash does not match");

    const signer = cardanoPaymentKeyHash(expected.from);
    if (signer === null) return fail("the buyer must be a payment-key address");
    if (tx.requiredSigners.length !== 1 || tx.requiredSigners[0] !== signer)
      return fail("required signers must be exactly the buyer");
    if (tx.collateral.length !== 1) return fail("expected exactly one collateral input");
    if (
      tx.collateral.some(
        (c) => c.txHash === expected.escrow.txHash && c.index === expected.escrow.index,
      )
    )
      return fail("the escrow cannot be collateral");
    const ret = tx.collateralReturn;
    if (!sameAddress(ret.addressBytes, expected.from) || ret.hasExtras || ret.value.assets.size > 0)
      return fail("collateral must return to the buyer as plain ADA");
    if (
      expected.collateralPercent !== undefined &&
      tx.totalCollateral < requiredCollateral(tx.fee, expected.collateralPercent)
    )
      return fail("total collateral is below the ledger minimum");
    if (
      expected.collateralInputValue !== undefined &&
      ret.value.coin + tx.totalCollateral !== expected.collateralInputValue
    )
      return fail("collateral return + total collateral differ from the collateral input");

    const outputs = [...tx.outputs];
    if (expected.action === "SetRefundRequested") {
      const cont = outputs.shift();
      if (cont === undefined || !sameAddress(cont.addressBytes, expected.escrow.address))
        return fail("first output does not continue to the escrow address");
      if (cont.format !== "map" || cont.hasScriptRef || cont.datumHash !== undefined)
        return fail("continuing output must carry only an inline datum");
      if (expected.continuingDatumCbor === undefined) return fail("no continuing datum expected");
      if (
        cont.inlineDatum === undefined ||
        !bytesEqual(cont.inlineDatum, datumArg(expected.continuingDatumCbor, "datum"))
      )
        return fail("continuing datum differs from the expected datum");
      if (!valuesEqual(cont.value, expected.escrow.value))
        return fail("continuing output value differs from the escrow value");
    } else if (expected.continuingDatumCbor !== undefined) {
      return fail("WithdrawRefund has no continuing output");
    }
    if (outputs.length > 1) return fail("expected at most one change output");
    for (const o of outputs) {
      if (!sameAddress(o.addressBytes, expected.from) || o.hasExtras || o.format !== "array")
        return fail("every other output must be plain change to the buyer");
    }
    if (expected.validityStartSlot !== undefined && tx.validityStart !== expected.validityStartSlot)
      return fail("validity start differs");
    if (expected.ttlSlot !== undefined && tx.ttl !== expected.ttlSlot) return fail("ttl differs");
    if (tx.validityStart > tx.ttl) return fail("empty validity interval");
    if (expected.feeCap !== undefined && tx.fee > expected.feeCap)
      return fail("fee exceeds the fee cap");
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? `decode failed: ${error.message}` : "decode failed");
  }
}

// --- network-backed builder ----------------------------------------------------------

export interface CardanoEscrowBuilderConfig extends HttpOptions {
  readonly blockfrostProjectId: string;
  readonly network: NetworkId;
  readonly blockfrostBaseUrl?: string;
  readonly now?: () => Date;
}

/** Placeholder budget for the first (evaluation) build: a typical vested_pay spend is far below. */
const PLACEHOLDER_EX_UNITS = { mem: 14_000_000n, steps: 10_000_000_000n };

export interface CardanoEscrowBuilder {
  readonly network: NetworkId;
  readonly escrowAddress: string;
  /** Lock build: TTL = floor slot of payByTime (must be in the future). */
  buildLock(input: {
    from: string;
    lovelace: bigint;
    assets?: ReadonlyMap<string, bigint>;
    datumCbor: string;
    payByTimeMs: bigint | number;
    requiredInput?: CardanoInput;
    feeCap?: bigint;
    /** x402 maxTimeoutSeconds: the TTL may not end later than now + this. */
    maxValiditySeconds?: number;
  }): Promise<CardanoEscrowPlan>;
  /** Read an escrow UTxO (value + inline datum) from chain; null when unknown or spent. */
  readEscrowUtxo(txHash: string, index: number): Promise<EscrowUtxo | null>;
  /** Blockfrost evaluation of an (unsigned) transaction; throws when a script fails. */
  evaluate(serialized: string): Promise<EvaluatedRedeemer[]>;
  /**
   * Buyer spend: builds with `exUnits` if given, else evaluates a placeholder build and
   * rebuilds with the measured units * (1 + marginPercent/100) (default 20 %).
   */
  buildSpend(input: {
    action: MasumiBuyerAction;
    from: string;
    escrow: EscrowUtxo;
    continuingDatumCbor?: string;
    validityStartSlot: bigint;
    ttlSlot: bigint;
    exUnits?: { mem: bigint; steps: bigint };
    marginPercent?: number;
    feeCap?: bigint;
  }): Promise<CardanoEscrowSpendPlan>;
}

export function createCardanoEscrowBuilder(
  config: CardanoEscrowBuilderConfig,
): CardanoEscrowBuilder {
  assertFamily(config.network, "cardano");
  const client = new BlockfrostClient({
    ...config,
    projectId: config.blockfrostProjectId,
    ...(config.blockfrostBaseUrl !== undefined ? { baseUrl: config.blockfrostBaseUrl } : {}),
  });
  const network = config.network;
  const now = config.now ?? (() => new Date());
  const escrowAddress = masumiEscrowAddress(network);

  return {
    network,
    escrowAddress,

    async buildLock(input) {
      const ttlSlot = cardanoPosixMsToSlot(network, input.payByTimeMs, "floor");
      const ttlMs = cardanoSlotToPosixMs(network, ttlSlot);
      const nowMs = BigInt(now().getTime());
      if (ttlMs <= nowMs) throw new ChainError("REQUEST_EXPIRED", "payByTime has passed");
      if (
        input.maxValiditySeconds !== undefined &&
        ttlMs > nowMs + BigInt(input.maxValiditySeconds) * 1000n
      )
        throw new ChainError("VALIDATION_FAILED", "payByTime is beyond the validity window");
      const [params, tip, utxos] = await Promise.all([
        client.protocolParams(),
        client.tip(),
        client.utxos(input.from),
      ]);
      if (ttlSlot <= tip.slot) throw new ChainError("REQUEST_EXPIRED", "payByTime has passed");
      const plan = planCardanoEscrowLock({
        network,
        from: input.from,
        escrowAddress,
        lovelace: input.lovelace,
        ...(input.assets !== undefined ? { assets: input.assets } : {}),
        datumCbor: input.datumCbor,
        ttlSlot,
        ...(input.requiredInput !== undefined ? { requiredInput: input.requiredInput } : {}),
        utxos,
        params,
      });
      if (input.feeCap !== undefined && plan.fee > input.feeCap)
        throw new ChainError("VALIDATION_FAILED", `fee ${plan.fee.toString()} exceeds the fee cap`);
      return plan;
    },

    async readEscrowUtxo(txHash, index) {
      if (!/^[0-9a-f]{64}$/.test(txHash))
        throw new ChainError("VALIDATION_FAILED", "malformed transaction hash");
      const tx = await client.getOrNull(`/txs/${txHash}/utxos`, "txs/utxos");
      if (tx === null) return null;
      if (!isRecord(tx) || !Array.isArray(tx.outputs))
        throw new ChainError("UPSTREAM_UNAVAILABLE", "txs/utxos: malformed");
      const out = (tx.outputs as unknown[]).find(
        (o) => isRecord(o) && Number(o.output_index) === index,
      );
      if (!isRecord(out)) return null;
      if (typeof out.consumed_by_tx === "string") return null;
      if (typeof out.address !== "string")
        throw new ChainError("UPSTREAM_UNAVAILABLE", "txs/utxos: malformed address");
      const amounts = parseAmounts(out.amount, "txs/utxos.amount");
      const value = utxoValue({
        tx_hash: txHash,
        output_index: index,
        amount: amounts,
        data_hash: null,
        inline_datum: null,
        reference_script_hash: null,
      });
      return {
        txHash,
        index,
        address: out.address,
        value,
        ...(typeof out.inline_datum === "string" ? { inlineDatum: out.inline_datum } : {}),
      };
    },

    evaluate(serialized) {
      return client.evaluateTx(serialized);
    },

    async buildSpend(input) {
      const [params, utxos] = await Promise.all([
        client.scriptProtocolParams(),
        client.utxos(input.from),
      ]);
      const base = {
        network,
        action: input.action,
        from: input.from,
        escrow: input.escrow,
        ...(input.continuingDatumCbor !== undefined
          ? { continuingDatumCbor: input.continuingDatumCbor }
          : {}),
        utxos,
        params,
        validityStartSlot: input.validityStartSlot,
        ttlSlot: input.ttlSlot,
      };
      let exUnits = input.exUnits;
      if (exUnits === undefined) {
        const draft = planCardanoEscrowSpend({
          ...base,
          exUnits: {
            mem:
              PLACEHOLDER_EX_UNITS.mem < params.maxTxExMem
                ? PLACEHOLDER_EX_UNITS.mem
                : params.maxTxExMem,
            steps:
              PLACEHOLDER_EX_UNITS.steps < params.maxTxExSteps
                ? PLACEHOLDER_EX_UNITS.steps
                : params.maxTxExSteps,
          },
        });
        const measured = (await client.evaluateTx(draft.serialized)).find(
          (r) => r.tag === "spend" && r.index === draft.redeemerIndex,
        );
        if (measured === undefined)
          throw new ChainError(
            "UPSTREAM_UNAVAILABLE",
            "evaluation returned no budget for the escrow",
          );
        const margin = BigInt(Math.round((input.marginPercent ?? 20) * 100));
        const grow = (v: bigint, max: bigint) => {
          const g = ceilDiv(v * (10_000n + margin), 10_000n);
          return g < max ? g : max;
        };
        exUnits = {
          mem: grow(measured.mem, params.maxTxExMem),
          steps: grow(measured.steps, params.maxTxExSteps),
        };
      }
      const plan = planCardanoEscrowSpend({ ...base, exUnits });
      if (input.feeCap !== undefined && plan.fee > input.feeCap)
        throw new ChainError("VALIDATION_FAILED", `fee ${plan.fee.toString()} exceeds the fee cap`);
      return plan;
    },
  };
}
