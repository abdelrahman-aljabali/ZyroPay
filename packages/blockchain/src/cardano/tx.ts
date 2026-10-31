/*
 * Cardano transaction model, encoding and strict decoding (Conway era CDDL:
 * https://github.com/IntersectMBO/cardano-ledger/blob/master/eras/conway/impl/cddl/data/conway.cddl).
 *
 * Plain transfers use one shape: a body with inputs (0), outputs (1), fee (2) and TTL (3);
 * legacy array outputs `[address, value]`; a witness set that is empty while unsigned and
 * holds exactly one vkey witness once signed; `is_valid = true`; no auxiliary data.
 * Sets (inputs, vkey witnesses) carry tag 258, which Conway accepts.
 *
 * Escrow (Masumi) transactions add, and only add:
 *  - post-Alonzo map outputs `{0: address, 1: value, 2: [1, #6.24(bytes)]}` carrying an
 *    inline datum (opaque CBOR bytes, never re-encoded);
 *  - for Plutus spends: body keys 8 (validity start), 11 (script_data_hash), 13 (collateral
 *    inputs), 14 (required signers), 16 (collateral return), 17 (total collateral), and the
 *    witness keys 5 (redeemers, Conway map format) and 7 (PlutusV3 scripts).
 *
 * The transaction id is blake2b-256 of the body bytes. Ed25519 signs that hash directly,
 * which is what Turnkey's SIGN_RAW_PAYLOAD with HASH_FUNCTION_NOT_APPLICABLE does.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardanoAddressBytes, cardanoAddressFromBytes } from "@zyropay/shared";
import type { Cbor, Decoded } from "./cbor";
import {
  array,
  bool,
  bytes,
  CborError,
  decodeCbor,
  encodeCbor,
  int,
  map,
  nil,
  tag,
  uint,
} from "./cbor";

/** CBOR tag for sets (CIP-21 / Conway CDDL `set<a> = #6.258([* a]) / [* a]`). */
const SET_TAG = 258n;
/** CBOR tag for embedded CBOR (`#6.24(bytes .cbor plutus_data)` in an inline datum). */
const EMBEDDED_CBOR_TAG = 24n;

export interface CardanoInput {
  /** Hex transaction id of the UTxO being spent. */
  readonly txHash: string;
  readonly index: number;
}

export interface CardanoValue {
  readonly coin: bigint;
  /** unit (policy id hex || asset name hex) -> quantity. Zero quantities are not allowed. */
  readonly assets: ReadonlyMap<string, bigint>;
}

export interface CardanoOutput {
  /** Bech32 Shelley address (Byron outputs decode to `null`). */
  readonly address: string | null;
  readonly addressBytes: Uint8Array;
  readonly value: CardanoValue;
  /** True when the output carries a datum hash, an inline datum or a script reference. */
  readonly hasExtras: boolean;
  /** `array`: legacy `[address, value(, datum_hash)]`; `map`: post-Alonzo `{0, 1, 2?, 3?}`. */
  readonly format: "array" | "map";
  /** The inline datum's CBOR bytes (content of `[1, #6.24(bytes)]`), when present. */
  readonly inlineDatum?: Uint8Array;
  /** A datum hash (legacy third element or `[0, hash]`), when present. */
  readonly datumHash?: Uint8Array;
  /** True when the output carries a script reference (map key 3). */
  readonly hasScriptRef: boolean;
}

/**
 * An output ZyroPay encodes: legacy array format, or map format with an inline datum when
 * `inlineDatum` is set (the bytes are embedded as given, never re-encoded).
 */
export interface CardanoTxOutput {
  readonly address: string | null;
  readonly value: CardanoValue;
  readonly inlineDatum?: Uint8Array;
}

export interface CardanoTxBody {
  readonly inputs: readonly CardanoInput[];
  readonly outputs: readonly CardanoTxOutput[];
  readonly fee: bigint;
  /** Absolute slot after which the transaction is invalid (`invalid_hereafter`). */
  readonly ttl: bigint;
  /** Key 8: first slot the transaction is valid in. */
  readonly validityStart?: bigint;
  /** Key 11: blake2b-256 of redeemers || datums || language views (32 bytes). */
  readonly scriptDataHash?: Uint8Array;
  /** Key 13: collateral inputs (key-locked, consumed only if a script fails). */
  readonly collateral?: readonly CardanoInput[];
  /** Key 14: payment key hashes (hex, 28 bytes) that must sign. */
  readonly requiredSigners?: readonly string[];
  /** Key 16: where the collateral's excess goes if it is consumed. */
  readonly collateralReturn?: CardanoTxOutput;
  /** Key 17: lovelace forfeited if a script fails. */
  readonly totalCollateral?: bigint;
}

/** Redeemer purpose tags (Conway CDDL `redeemer_tag`). */
export const REDEEMER_TAG = { spend: 0, mint: 1, cert: 2, reward: 3, voting: 4, proposing: 5 };

export interface CardanoRedeemer {
  readonly tag: number;
  readonly index: number;
  /** Plutus data of the redeemer (ZyroPay only emits constructor redeemers it builds). */
  readonly data: Cbor;
  readonly mem: bigint;
  readonly steps: bigint;
}

export interface DecodedRedeemer {
  readonly tag: number;
  readonly index: number;
  /** Original CBOR bytes of the redeemer data. */
  readonly dataBytes: Uint8Array;
  readonly mem: bigint;
  readonly steps: bigint;
}

export interface VkeyWitness {
  /** 32-byte Ed25519 public key, hex. */
  readonly vkey: string;
  /** 64-byte Ed25519 signature, hex. */
  readonly signature: string;
}

export interface DecodedCardanoTx {
  readonly bodyBytes: Uint8Array;
  /** blake2b-256(bodyBytes), hex: the transaction id. */
  readonly bodyHash: string;
  /** Every key present in the body map, in encounter order. */
  readonly bodyKeys: readonly number[];
  readonly inputs: readonly CardanoInput[];
  readonly outputs: readonly CardanoOutput[];
  readonly fee: bigint | null;
  readonly ttl: bigint | null;
  readonly validityStart: bigint | null;
  readonly scriptDataHash: string | null;
  readonly collateral: readonly CardanoInput[];
  readonly requiredSigners: readonly string[];
  readonly collateralReturn: CardanoOutput | null;
  readonly totalCollateral: bigint | null;
  readonly witnessKeys: readonly number[];
  /** Original bytes of every witness-set value, by key (redeemers are hashed byte-exact). */
  readonly witnessEntries: ReadonlyMap<number, Uint8Array>;
  readonly vkeyWitnesses: readonly VkeyWitness[];
  readonly redeemers: readonly DecodedRedeemer[];
  /** PlutusV3 scripts (witness key 7): the flat-encoded script bytes of each entry. */
  readonly plutusV3Scripts: readonly Uint8Array[];
  readonly isValid: boolean;
  readonly hasAuxiliaryData: boolean;
}

export const emptyValue = (coin: bigint): CardanoValue => ({ coin, assets: new Map() });

// --- encoding ------------------------------------------------------------------------

function encodeValue(value: CardanoValue): Cbor {
  if (value.assets.size === 0) return uint(value.coin);
  const byPolicy = new Map<string, Array<[string, bigint]>>();
  for (const [unit, qty] of value.assets) {
    if (qty <= 0n) throw new Error("asset quantities must be positive");
    const policy = unit.slice(0, 56);
    byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), [unit.slice(56), qty]]);
  }
  return array([
    uint(value.coin),
    map(
      [...byPolicy].map(([policy, names]) => [
        bytes(hexToBytes(policy)),
        map(names.map(([name, qty]) => [bytes(hexToBytes(name)), uint(qty)])),
      ]),
    ),
  ]);
}

function encodeOutput(output: CardanoTxOutput): Cbor {
  if (output.address === null) throw new Error("cannot encode an output without an address");
  const address = bytes(cardanoAddressBytes(output.address));
  if (output.inlineDatum === undefined) return array([address, encodeValue(output.value)]);
  if (output.inlineDatum.length === 0) throw new Error("inline datum must not be empty");
  return map([
    [uint(0), address],
    [uint(1), encodeValue(output.value)],
    [uint(2), array([uint(1), tag(EMBEDDED_CBOR_TAG, bytes(output.inlineDatum))])],
  ]);
}

/** Serialized size of a value (checked against the maxValSize protocol parameter). */
export function valueSize(value: CardanoValue): number {
  return encodeCbor(encodeValue(value)).length;
}

/** Serialized size of one output (for the min-UTxO rule; includes any inline datum). */
export function outputSize(output: CardanoTxOutput): number {
  return encodeCbor(encodeOutput(output)).length;
}

function compareInputs(a: CardanoInput, b: CardanoInput): number {
  return a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1;
}

/** Inputs in ledger order (txid bytes, then index): redeemer indexes point into this order. */
export function sortedInputs(inputs: readonly CardanoInput[]): CardanoInput[] {
  const sorted = [...inputs].sort(compareInputs);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev !== undefined && cur !== undefined && compareInputs(prev, cur) === 0)
      throw new Error("duplicate input");
  }
  return sorted;
}

const inputSet = (inputs: readonly CardanoInput[]): Cbor =>
  tag(
    SET_TAG,
    array(sortedInputs(inputs).map((i) => array([bytes(hexToBytes(i.txHash)), uint(i.index)]))),
  );

export function encodeBody(body: CardanoTxBody): Uint8Array {
  const entries: Array<readonly [Cbor, Cbor]> = [
    [uint(0), inputSet(body.inputs)],
    [uint(1), array(body.outputs.map(encodeOutput))],
    [uint(2), uint(body.fee)],
    [uint(3), uint(body.ttl)],
  ];
  if (body.validityStart !== undefined) entries.push([uint(8), uint(body.validityStart)]);
  if (body.scriptDataHash !== undefined) {
    if (body.scriptDataHash.length !== 32) throw new Error("script_data_hash must be 32 bytes");
    entries.push([uint(11), bytes(body.scriptDataHash)]);
  }
  if (body.collateral !== undefined) {
    if (body.collateral.length === 0) throw new Error("collateral must not be empty");
    entries.push([uint(13), inputSet(body.collateral)]);
  }
  if (body.requiredSigners !== undefined) {
    const signers = [...new Set(body.requiredSigners)].sort();
    if (signers.length !== body.requiredSigners.length) throw new Error("duplicate signer");
    if (signers.length === 0 || signers.some((h) => !/^[0-9a-f]{56}$/.test(h)))
      throw new Error("required signers must be 28-byte key hashes");
    entries.push([uint(14), tag(SET_TAG, array(signers.map((h) => bytes(hexToBytes(h)))))]);
  }
  if (body.collateralReturn !== undefined)
    entries.push([uint(16), encodeOutput(body.collateralReturn)]);
  if (body.totalCollateral !== undefined) entries.push([uint(17), uint(body.totalCollateral)]);
  return encodeCbor(map(entries));
}

/** Conway map-format redeemers `{ [tag, index]: [data, [mem, steps]] }` (canonical bytes). */
export function encodeRedeemers(redeemers: readonly CardanoRedeemer[]): Uint8Array {
  if (redeemers.length === 0) throw new Error("no redeemers");
  return encodeCbor(
    map(
      redeemers.map((r) => [
        array([uint(r.tag), uint(r.index)]),
        array([r.data, array([uint(r.mem), uint(r.steps)])]),
      ]),
    ),
  );
}

/** Language views for PlutusV3 only: `{ 2: [cost, ...] }` (Conway CDDL, Babbage+ rule). */
export function plutusV3LanguageViews(costModel: readonly bigint[]): Uint8Array {
  if (costModel.length === 0) throw new Error("PlutusV3 cost model is empty");
  return encodeCbor(map([[uint(2), array(costModel.map((c) => int(c)))]]));
}

/**
 * script_data_hash = blake2b-256(redeemers || datums || language_views) over the EXACT
 * witness-set bytes. `datums` is omitted when the transaction has no witness datums (inline
 * datums never count).
 */
export function scriptDataHash(input: {
  redeemers: Uint8Array;
  datums?: Uint8Array;
  languageViews: Uint8Array;
}): Uint8Array {
  const parts = [input.redeemers, input.datums ?? new Uint8Array(), input.languageViews];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return blake2b(all, { dkLen: 32 });
}

/** Non-vkey witness-set content of a script transaction. */
export interface ScriptWitnesses {
  /** Witness key 5, as produced by `encodeRedeemers` (hashed byte-exact). */
  readonly redeemers?: Uint8Array;
  /** Witness key 7: flat-encoded PlutusV3 scripts (the bytes inside the script bytestring). */
  readonly plutusV3Scripts?: readonly Uint8Array[];
}

function vkeyWitnessesCbor(witnesses: readonly VkeyWitness[]): Uint8Array {
  return encodeCbor(
    tag(
      SET_TAG,
      array(
        witnesses.map((w) => array([bytes(hexToBytes(w.vkey)), bytes(hexToBytes(w.signature))])),
      ),
    ),
  );
}

/** A canonical CBOR map from small uint keys to already-encoded values. */
function rawMap(entries: ReadonlyArray<readonly [number, Uint8Array]>): Uint8Array {
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i - 1]?.[0] === sorted[i]?.[0]) throw new Error("duplicate witness key");
  if (sorted.length > 23) throw new Error("too many witness keys");
  const chunks: Uint8Array[] = [Uint8Array.from([0xa0 | sorted.length])];
  for (const [k, v] of sorted) chunks.push(encodeCbor(uint(k)), v);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Witness-set entries (key -> encoded value) for vkeys plus optional script witnesses. */
export function witnessEntries(
  witnesses: readonly VkeyWitness[],
  scripts: ScriptWitnesses = {},
): Array<readonly [number, Uint8Array]> {
  const entries: Array<readonly [number, Uint8Array]> = [];
  if (witnesses.length > 0) entries.push([0, vkeyWitnessesCbor(witnesses)]);
  if (scripts.redeemers !== undefined) entries.push([5, scripts.redeemers]);
  if (scripts.plutusV3Scripts !== undefined && scripts.plutusV3Scripts.length > 0) {
    entries.push([
      7,
      encodeCbor(tag(SET_TAG, array(scripts.plutusV3Scripts.map((s) => bytes(s))))),
    ]);
  }
  return entries;
}

/** `[body, witness_set, true, null]` around the EXACT body and witness-value bytes given. */
export function assembleTxFromEntries(
  bodyBytes: Uint8Array,
  entries: ReadonlyArray<readonly [number, Uint8Array]>,
): Uint8Array {
  const ws = rawMap(entries);
  const out = new Uint8Array(1 + bodyBytes.length + ws.length + 2);
  out[0] = 0x84; // array(4)
  out.set(bodyBytes, 1);
  out.set(ws, 1 + bodyBytes.length);
  out.set(encodeCbor(bool(true)), 1 + bodyBytes.length + ws.length);
  out.set(encodeCbor(nil), 2 + bodyBytes.length + ws.length);
  return out;
}

/** `[body, witness_set, true, null]` around the EXACT body bytes given. */
export function assembleTx(
  bodyBytes: Uint8Array,
  witnesses: readonly VkeyWitness[],
  scripts: ScriptWitnesses = {},
): Uint8Array {
  return assembleTxFromEntries(bodyBytes, witnessEntries(witnesses, scripts));
}

export function bodyHashHex(bodyBytes: Uint8Array): string {
  return bytesToHex(blake2b(bodyBytes, { dkLen: 32 }));
}

/** Size of the transaction once it carries ONE vkey witness (what the fee is paid on). */
export function signedSizeOf(bodyBytes: Uint8Array, scripts: ScriptWitnesses = {}): number {
  return assembleTx(bodyBytes, [{ vkey: "00".repeat(32), signature: "00".repeat(64) }], scripts)
    .length;
}

// --- decoding ------------------------------------------------------------------------

function asUint(value: Cbor | undefined, what: string): bigint {
  if (value?.t !== "uint") throw new CborError(`${what}: expected unsigned integer`);
  return value.v;
}

function asBytes(value: Cbor | undefined, what: string, length?: number): Uint8Array {
  if (value?.t !== "bytes") throw new CborError(`${what}: expected bytes`);
  if (length !== undefined && value.v.length !== length)
    throw new CborError(`${what}: expected ${length} bytes`);
  return value.v;
}

/** `set<a>`: tag 258 around an array, or a bare array. */
function setItems(value: Cbor, what: string): readonly Cbor[] {
  const inner = value.t === "tag" && value.tag === SET_TAG ? value.v : value;
  if (inner.t !== "array") throw new CborError(`${what}: expected a set`);
  return inner.v;
}

function decodeValue(value: Cbor): CardanoValue {
  if (value.t === "uint") return emptyValue(value.v);
  if (value.t !== "array" || value.v.length !== 2) throw new CborError("value: malformed");
  const coin = asUint(value.v[0], "value.coin");
  const multi = value.v[1];
  if (multi?.t !== "map") throw new CborError("value.assets: expected map");
  const assets = new Map<string, bigint>();
  for (const [policy, names] of multi.v) {
    const policyHex = bytesToHex(asBytes(policy, "policy id", 28));
    if (names.t !== "map") throw new CborError("value.assets: expected asset map");
    for (const [name, qty] of names.v) {
      const nameBytes = asBytes(name, "asset name");
      if (nameBytes.length > 32) throw new CborError("asset name longer than 32 bytes");
      const unit = policyHex + bytesToHex(nameBytes);
      if (assets.has(unit)) throw new CborError("duplicate asset");
      assets.set(unit, asUint(qty, "asset quantity"));
    }
  }
  return { coin, assets };
}

function decodeDatumOption(value: Cbor | undefined): { inline?: Uint8Array; hash?: Uint8Array } {
  if (value?.t !== "array" || value.v.length !== 2) throw new CborError("datum option: malformed");
  const kind = asUint(value.v[0], "datum option kind");
  if (kind === 0n) return { hash: asBytes(value.v[1], "datum hash", 32) };
  const embedded = value.v[1];
  if (kind !== 1n || embedded?.t !== "tag" || embedded.tag !== EMBEDDED_CBOR_TAG)
    throw new CborError("datum option: malformed");
  const inline = asBytes(embedded.v, "inline datum");
  if (inline.length === 0) throw new CborError("inline datum: empty");
  return { inline };
}

function decodeOutput(value: Cbor): CardanoOutput {
  let addressBytes: Uint8Array;
  let rawValue: Cbor | undefined;
  let hasExtras: boolean;
  let format: "array" | "map";
  let datum: { inline?: Uint8Array; hash?: Uint8Array } = {};
  let hasScriptRef = false;
  if (value.t === "array") {
    if (value.v.length !== 2 && value.v.length !== 3) throw new CborError("output: malformed");
    format = "array";
    addressBytes = asBytes(value.v[0], "output.address");
    rawValue = value.v[1];
    hasExtras = value.v.length === 3;
    if (value.v.length === 3) datum = { hash: asBytes(value.v[2], "datum hash", 32) };
  } else if (value.t === "map") {
    format = "map";
    const fields = new Map(value.v.map(([k, v]) => [Number(asUint(k, "output key")), v]));
    if ([...fields.keys()].some((k) => k > 3)) throw new CborError("output: unknown key");
    addressBytes = asBytes(fields.get(0), "output.address");
    rawValue = fields.get(1);
    hasExtras = [...fields.keys()].some((k) => k !== 0 && k !== 1);
    if (fields.has(2)) datum = decodeDatumOption(fields.get(2));
    hasScriptRef = fields.has(3);
  } else {
    throw new CborError("output: malformed");
  }
  if (rawValue === undefined) throw new CborError("output: missing value");
  return {
    address: cardanoAddressFromBytes(addressBytes),
    addressBytes,
    value: decodeValue(rawValue),
    hasExtras,
    format,
    ...(datum.inline !== undefined ? { inlineDatum: datum.inline } : {}),
    ...(datum.hash !== undefined ? { datumHash: datum.hash } : {}),
    hasScriptRef,
  };
}

function decodeInputs(value: Cbor, what: string): CardanoInput[] {
  return setItems(value, what).map((item) => {
    if (item.t !== "array" || item.v.length !== 2) throw new CborError(`${what}: malformed`);
    const index = asUint(item.v[1], `${what}.index`);
    if (index > 0xffffn) throw new CborError(`${what}.index out of range`);
    return { txHash: bytesToHex(asBytes(item.v[0], `${what}.txHash`, 32)), index: Number(index) };
  });
}

function decodeExUnits(value: Cbor | undefined): { mem: bigint; steps: bigint } {
  if (value?.t !== "array" || value.v.length !== 2) throw new CborError("ex_units: malformed");
  return { mem: asUint(value.v[0], "ex_units.mem"), steps: asUint(value.v[1], "ex_units.steps") };
}

/** Witness key 5: Conway map format, or the legacy array `[[tag, index, data, ex_units]]`. */
function decodeRedeemers(item: Decoded, input: Uint8Array): DecodedRedeemer[] {
  const out: DecodedRedeemer[] = [];
  const span = (d: Decoded | undefined) => {
    if (d === undefined) throw new CborError("redeemer: malformed");
    return input.slice(d.start, d.end);
  };
  if (item.value.t === "map") {
    for (let i = 0; i < item.items.length; i += 2) {
      const key = item.items[i];
      const val = item.items[i + 1];
      if (key?.value.t !== "array" || key.value.v.length !== 2)
        throw new CborError("redeemer key: malformed");
      if (val?.value.t !== "array" || val.items.length !== 2)
        throw new CborError("redeemer value: malformed");
      out.push({
        tag: Number(asUint(key.value.v[0], "redeemer tag")),
        index: Number(asUint(key.value.v[1], "redeemer index")),
        dataBytes: span(val.items[0]),
        ...decodeExUnits(val.value.v[1]),
      });
    }
    return out;
  }
  if (item.value.t !== "array") throw new CborError("redeemers: malformed");
  for (const r of item.items) {
    if (r.value.t !== "array" || r.items.length !== 4) throw new CborError("redeemer: malformed");
    out.push({
      tag: Number(asUint(r.value.v[0], "redeemer tag")),
      index: Number(asUint(r.value.v[1], "redeemer index")),
      dataBytes: span(r.items[2]),
      ...decodeExUnits(r.value.v[3]),
    });
  }
  return out;
}

/**
 * Decode a full transaction `[body, witness_set, is_valid, auxiliary_data]`. `strict`
 * (default) refuses any non-canonical CBOR; lenient mode exists for reading arbitrary
 * on-chain transactions in tests. Throws CborError.
 */
export function decodeCardanoTx(
  input: Uint8Array,
  options: { strict?: boolean } = {},
): DecodedCardanoTx {
  const root: Decoded = decodeCbor(input, options);
  if (root.value.t !== "array" || root.items.length !== 4)
    throw new CborError("transaction: expected a 4-element array");
  const [bodyItem, witnessItem, validItem, auxItem] = root.items;
  if (
    bodyItem === undefined ||
    witnessItem === undefined ||
    validItem === undefined ||
    auxItem === undefined
  )
    throw new CborError("transaction: malformed");
  if (bodyItem.value.t !== "map") throw new CborError("body: expected map");
  const bodyBytes = input.slice(bodyItem.start, bodyItem.end);

  const bodyKeys: number[] = [];
  let inputs: CardanoInput[] = [];
  let outputs: CardanoOutput[] = [];
  let fee: bigint | null = null;
  let ttl: bigint | null = null;
  let validityStart: bigint | null = null;
  let scriptDataHash: string | null = null;
  let collateral: CardanoInput[] = [];
  let requiredSigners: string[] = [];
  let collateralReturn: CardanoOutput | null = null;
  let totalCollateral: bigint | null = null;
  for (const [k, v] of bodyItem.value.v) {
    const key = Number(asUint(k, "body key"));
    bodyKeys.push(key);
    if (key === 0) {
      inputs = decodeInputs(v, "input");
    } else if (key === 1) {
      if (v.t !== "array") throw new CborError("outputs: expected array");
      outputs = v.v.map(decodeOutput);
    } else if (key === 2) {
      fee = asUint(v, "fee");
    } else if (key === 3) {
      ttl = asUint(v, "ttl");
    } else if (key === 8) {
      validityStart = asUint(v, "validity_interval_start");
    } else if (key === 11) {
      scriptDataHash = bytesToHex(asBytes(v, "script_data_hash", 32));
    } else if (key === 13) {
      collateral = decodeInputs(v, "collateral input");
    } else if (key === 14) {
      requiredSigners = setItems(v, "required signers").map((h) =>
        bytesToHex(asBytes(h, "required signer", 28)),
      );
    } else if (key === 16) {
      collateralReturn = decodeOutput(v);
    } else if (key === 17) {
      totalCollateral = asUint(v, "total_collateral");
    }
  }

  if (witnessItem.value.t !== "map") throw new CborError("witness set: expected map");
  const witnessKeys: number[] = [];
  const witnessEntryBytes = new Map<number, Uint8Array>();
  const vkeyWitnesses: VkeyWitness[] = [];
  let redeemers: DecodedRedeemer[] = [];
  let plutusV3Scripts: Uint8Array[] = [];
  for (let i = 0; i < witnessItem.items.length; i += 2) {
    const kItem = witnessItem.items[i];
    const vItem = witnessItem.items[i + 1];
    if (kItem === undefined || vItem === undefined) throw new CborError("witness set: malformed");
    const key = Number(asUint(kItem.value, "witness key"));
    const v = vItem.value;
    witnessKeys.push(key);
    witnessEntryBytes.set(key, input.slice(vItem.start, vItem.end));
    if (key === 0) {
      for (const w of setItems(v, "vkey witnesses")) {
        if (w.t !== "array" || w.v.length !== 2) throw new CborError("vkey witness: malformed");
        vkeyWitnesses.push({
          vkey: bytesToHex(asBytes(w.v[0], "vkey", 32)),
          signature: bytesToHex(asBytes(w.v[1], "signature", 64)),
        });
      }
    } else if (key === 5) {
      redeemers = decodeRedeemers(vItem, input);
    } else if (key === 7) {
      plutusV3Scripts = setItems(v, "plutus v3 scripts").map((s) => asBytes(s, "plutus v3 script"));
    }
  }
  if (validItem.value.t !== "simple" || typeof validItem.value.v !== "boolean")
    throw new CborError("is_valid: expected boolean");
  return {
    bodyBytes,
    bodyHash: bodyHashHex(bodyBytes),
    bodyKeys,
    inputs,
    outputs,
    fee,
    ttl,
    validityStart,
    scriptDataHash,
    collateral,
    requiredSigners,
    collateralReturn,
    totalCollateral,
    witnessKeys,
    witnessEntries: witnessEntryBytes,
    vkeyWitnesses,
    redeemers,
    plutusV3Scripts,
    isValid: validItem.value.v,
    hasAuxiliaryData: !(auxItem.value.t === "simple" && auxItem.value.v === null),
  };
}

/** Ed25519 verification of a vkey witness over the body hash. Never throws. */
export function verifyVkeyWitness(bodyHash: string, witness: VkeyWitness): boolean {
  try {
    return ed25519.verify(
      hexToBytes(witness.signature),
      hexToBytes(bodyHash),
      hexToBytes(witness.vkey),
    );
  } catch {
    return false;
  }
}

/** Sum of output values (coin + every asset). */
export function addValues(values: readonly CardanoValue[]): CardanoValue {
  let coin = 0n;
  const assets = new Map<string, bigint>();
  for (const v of values) {
    coin += v.coin;
    for (const [unit, qty] of v.assets) assets.set(unit, (assets.get(unit) ?? 0n) + qty);
  }
  return { coin, assets };
}
