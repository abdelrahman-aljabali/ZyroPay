import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardanoAddressFromBytes } from "./cardano";
import type { NetworkId } from "./networks";
import { cardanoNetworkId, NETWORKS } from "./networks";

/*
 * Strict decoder for the UNSIGNED Cardano transactions ZyroPay asks a passkey to sign, so a
 * client (the app) can see for itself what a transaction does instead of trusting the review
 * the API sends. Dependency-light on purpose (runs on Hermes, Workers and Node): a minimal
 * port of what @zyropay/blockchain cardano/{cbor,tx}.ts decodes, refusing everything else.
 *
 * Shapes (Conway CDDL, https://github.com/IntersectMBO/cardano-ledger conway.cddl):
 *  - `[body, witness_set, true, null]`;
 *  - body keys 0 inputs, 1 outputs, 2 fee, 3 ttl, and for Plutus spends also 8 validity
 *    start, 11 script_data_hash, 13 collateral, 14 required signers, 16 collateral return,
 *    17 total collateral. Any other key (certificates, withdrawals, mint, metadata,
 *    governance, network id...) is refused;
 *  - outputs: legacy `[address, value]` or map `{0: address, 1: value, 2?: datum, 3?: ref}`;
 *  - witness set: only redeemers (5, Conway map format) and PlutusV3 scripts (7); a vkey
 *    witness (0) means the transaction is already signed and is refused.
 *
 * CBOR is read in canonical form only (RFC 8949 4.2.1 as ZyroPay's encoder writes it):
 * shortest-form heads, definite lengths, map keys strictly ascending (shorter first, then
 * bytewise: no duplicates), sets strictly ascending; no text strings, negative integers,
 * floats or undefined. Anything ZyroPay does not build fails to decode.
 */

export class CardanoTxDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardanoTxDecodeError";
  }
}

const fail = (message: string): never => {
  throw new CardanoTxDecodeError(message);
};

// --- CBOR ------------------------------------------------------------------------------

type Node =
  | { readonly t: "uint"; readonly v: bigint; readonly start: number; readonly end: number }
  | { readonly t: "bytes"; readonly v: Uint8Array; readonly start: number; readonly end: number }
  | {
      readonly t: "array";
      readonly v: readonly Node[];
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly t: "map";
      readonly v: ReadonlyArray<readonly [Node, Node]>;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly t: "tag";
      readonly tag: bigint;
      readonly v: Node;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly t: "simple";
      readonly v: boolean | null;
      readonly start: number;
      readonly end: number;
    };

const MAX_DEPTH = 32;
const MAX_ITEMS = 20_000;

/** Canonical key order: shorter encoding first, then bytewise. */
function compareEncoded(buf: Uint8Array, a: Node, b: Node): number {
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la !== lb) return la - lb;
  for (let i = 0; i < la; i++) {
    const d = (buf[a.start + i] ?? 0) - (buf[b.start + i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function decodeCanonicalCbor(buf: Uint8Array): Node {
  let pos = 0;
  let items = 0;
  const byte = (): number => {
    const b = buf[pos];
    if (b === undefined) return fail("unexpected end of input");
    pos++;
    return b;
  };
  const argument = (info: number): bigint => {
    if (info < 24) return BigInt(info);
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0) return fail(info === 31 ? "indefinite length" : "reserved head");
    let v = 0n;
    for (let i = 0; i < width; i++) v = (v << 8n) | BigInt(byte());
    const minimal =
      (width === 1 && v >= 24n) ||
      (width === 2 && v > 0xffn) ||
      (width === 4 && v > 0xffffn) ||
      (width === 8 && v > 0xffffffffn);
    if (!minimal) fail("non-shortest integer encoding");
    return v;
  };
  const length = (info: number): number => {
    const n = argument(info);
    if (n > BigInt(buf.length - pos)) fail("length exceeds input");
    return Number(n);
  };
  const item = (depth: number): Node => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    if (++items > MAX_ITEMS) fail("too many items");
    const start = pos;
    const initial = byte();
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return { t: "uint", v: argument(info), start, end: pos };
      case 2: {
        const n = length(info);
        const v = buf.slice(pos, pos + n);
        pos += n;
        return { t: "bytes", v, start, end: pos };
      }
      case 4: {
        const n = length(info);
        const v: Node[] = [];
        for (let i = 0; i < n; i++) v.push(item(depth + 1));
        return { t: "array", v, start, end: pos };
      }
      case 5: {
        const n = length(info);
        const v: Array<readonly [Node, Node]> = [];
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          const prev = v[i - 1];
          if (prev !== undefined && compareEncoded(buf, prev[0], k) >= 0)
            fail("map keys are not in canonical order");
          v.push([k, item(depth + 1)]);
        }
        return { t: "map", v, start, end: pos };
      }
      case 6: {
        const tag = argument(info);
        const v = item(depth + 1);
        return { t: "tag", tag, v, start, end: pos };
      }
      case 7:
        if (info === 20) return { t: "simple", v: false, start, end: pos };
        if (info === 21) return { t: "simple", v: true, start, end: pos };
        if (info === 22) return { t: "simple", v: null, start, end: pos };
        return fail("unsupported simple value or float");
      default:
        return fail(major === 1 ? "unexpected negative integer" : "unexpected text string");
    }
  };
  const root = item(0);
  if (pos !== buf.length) fail("trailing bytes");
  return root;
}

// --- transaction model -----------------------------------------------------------------

export interface CardanoTxInputRef {
  /** Transaction id of the UTxO being spent, hex. */
  readonly txHash: string;
  readonly index: number;
}

export interface CardanoTxOutputView {
  /** Bech32 Shelley address (on the decode network: anything else is refused). */
  readonly address: string;
  readonly lovelace: bigint;
  /** Native tokens, unit (policy id hex || asset name hex) -> quantity (always > 0). */
  readonly assets: ReadonlyMap<string, bigint>;
  /** `array`: legacy `[address, value(, datum_hash)]`; `map`: post-Alonzo `{0, 1, 2?, 3?}`. */
  readonly format: "array" | "map";
  /** Inline datum CBOR (content of `[1, #6.24(bytes)]`), hex, when present. */
  readonly inlineDatumHex?: string;
  readonly hasDatumHash: boolean;
  readonly hasScriptRef: boolean;
}

export interface CardanoTxRedeemerView {
  /** Purpose (0 spend, 1 mint, ...). */
  readonly tag: number;
  readonly index: number;
  /** Original CBOR bytes of the redeemer's Plutus data, hex. */
  readonly dataHex: string;
  readonly mem: bigint;
  readonly steps: bigint;
}

export interface DecodedCardanoUnsignedTx {
  /** blake2b-256 of the body bytes: the transaction id and what the passkey signs. */
  readonly bodyHash: string;
  /** Body map keys, ascending. */
  readonly bodyKeys: readonly number[];
  /** Spent UTxOs in ledger order (redeemer indexes point into this order). */
  readonly inputs: readonly CardanoTxInputRef[];
  readonly outputs: readonly CardanoTxOutputView[];
  readonly fee: bigint;
  /** Key 3 (`invalid_hereafter`), absolute slot. */
  readonly ttl: bigint | null;
  /** Key 8, absolute slot. */
  readonly validityStart: bigint | null;
  readonly scriptDataHash: string | null;
  readonly collateral: readonly CardanoTxInputRef[];
  /** Payment key hashes (hex) that must sign. */
  readonly requiredSigners: readonly string[];
  readonly collateralReturn: CardanoTxOutputView | null;
  readonly totalCollateral: bigint | null;
  /** Witness-set keys, ascending (only 5 and 7 can appear). */
  readonly witnessKeys: readonly number[];
  readonly redeemers: readonly CardanoTxRedeemerView[];
  /** blake2b-224(0x03 || script) of every PlutusV3 script in the witness set. */
  readonly plutusV3ScriptHashes: readonly string[];
}

const SET_TAG = 258n;
const EMBEDDED_CBOR_TAG = 24n;
const BODY_KEYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 8, 11, 13, 14, 16, 17]);

function asUint(node: Node | undefined, what: string): bigint {
  return node?.t === "uint" ? node.v : fail(`${what}: expected an unsigned integer`);
}

function asBytes(node: Node | undefined, what: string, len?: number): Uint8Array {
  if (node?.t !== "bytes") return fail(`${what}: expected bytes`);
  if (len !== undefined && node.v.length !== len) fail(`${what}: expected ${String(len)} bytes`);
  return node.v;
}

function asArray(node: Node | undefined, what: string, len?: number): readonly Node[] {
  if (node?.t !== "array") return fail(`${what}: expected an array`);
  if (len !== undefined && node.v.length !== len) fail(`${what}: malformed`);
  return node.v;
}

function compareHexThenIndex(a: CardanoTxInputRef, b: CardanoTxInputRef): number {
  return a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1;
}

/** `set<a>`: tag 258 around an array, or a bare array. */
function setItems(node: Node, what: string): readonly Node[] {
  const inner =
    node.t === "tag" ? (node.tag === SET_TAG ? node.v : fail(`${what}: bad tag`)) : node;
  return asArray(inner, what);
}

function decodeInputs(node: Node, what: string): CardanoTxInputRef[] {
  const out = setItems(node, what).map((item) => {
    const [hash, index] = asArray(item, what, 2);
    const i = asUint(index, `${what} index`);
    if (i > 0xffffn) fail(`${what} index out of range`);
    return { txHash: bytesToHex(asBytes(hash, `${what} id`, 32)), index: Number(i) };
  });
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (prev !== undefined && cur !== undefined && compareHexThenIndex(prev, cur) >= 0)
      fail(`${what}s are not a sorted set`);
  }
  return out;
}

function decodeValue(node: Node | undefined): { lovelace: bigint; assets: Map<string, bigint> } {
  if (node?.t === "uint") return { lovelace: node.v, assets: new Map() };
  const [coin, multi] = asArray(node, "value", 2);
  if (multi?.t !== "map" || multi.v.length === 0) return fail("value: malformed token bundle");
  const assets = new Map<string, bigint>();
  for (const [policy, names] of multi.v) {
    const policyHex = bytesToHex(asBytes(policy, "policy id", 28));
    if (names.t !== "map" || names.v.length === 0) return fail("value: malformed asset map");
    for (const [name, qty] of names.v) {
      const nameBytes = asBytes(name, "asset name");
      if (nameBytes.length > 32) fail("asset name longer than 32 bytes");
      const q = asUint(qty, "asset quantity");
      if (q === 0n) fail("zero asset quantity");
      assets.set(policyHex + bytesToHex(nameBytes), q);
    }
  }
  return { lovelace: asUint(coin, "value coin"), assets };
}

function decodeAddress(node: Node | undefined, networkId: number): string {
  const bytes = asBytes(node, "output address");
  const address = cardanoAddressFromBytes(bytes);
  if (address === null) return fail("output address is not a Shelley payment address");
  if (((bytes[0] ?? 0) & 0x0f) !== networkId) fail("an output address is for another network");
  return address;
}

function decodeOutput(node: Node, networkId: number): CardanoTxOutputView {
  if (node.t === "array") {
    if (node.v.length !== 2 && node.v.length !== 3) fail("output: malformed");
    if (node.v.length === 3) asBytes(node.v[2], "datum hash", 32);
    return {
      address: decodeAddress(node.v[0], networkId),
      ...decodeValue(node.v[1]),
      format: "array",
      hasDatumHash: node.v.length === 3,
      hasScriptRef: false,
    };
  }
  if (node.t !== "map") return fail("output: malformed");
  const fields = new Map<number, Node>();
  for (const [k, v] of node.v) {
    const key = asUint(k, "output key");
    if (key > 3n) fail("output: unknown field");
    fields.set(Number(key), v);
  }
  let inlineDatumHex: string | undefined;
  let hasDatumHash = false;
  const datum = fields.get(2);
  if (datum !== undefined) {
    const [kind, content] = asArray(datum, "datum option", 2);
    const k = asUint(kind, "datum option kind");
    if (k === 0n) {
      asBytes(content, "datum hash", 32);
      hasDatumHash = true;
    } else if (k === 1n && content?.t === "tag" && content.tag === EMBEDDED_CBOR_TAG) {
      const bytes = asBytes(content.v, "inline datum");
      if (bytes.length === 0) fail("inline datum is empty");
      inlineDatumHex = bytesToHex(bytes);
    } else {
      fail("datum option: malformed");
    }
  }
  const ref = fields.get(3);
  if (ref !== undefined && (ref.t !== "tag" || ref.tag !== EMBEDDED_CBOR_TAG))
    fail("script reference: malformed");
  return {
    address: decodeAddress(fields.get(0), networkId),
    ...decodeValue(fields.get(1)),
    format: "map",
    ...(inlineDatumHex !== undefined ? { inlineDatumHex } : {}),
    hasDatumHash,
    hasScriptRef: ref !== undefined,
  };
}

function plutusV3Hash(script: Uint8Array): string {
  const tagged = new Uint8Array(script.length + 1);
  tagged[0] = 0x03;
  tagged.set(script, 1);
  return bytesToHex(blake2b(tagged, { dkLen: 28 }));
}

/**
 * Decode an unsigned transaction (hex CBOR) ZyroPay built for `network`. Throws
 * CardanoTxDecodeError on any shape ZyroPay does not build, on non-canonical CBOR, on a
 * vkey witness (already signed) and on an output address of another network.
 */
export function decodeCardanoUnsignedTx(
  unsignedHex: string,
  network: NetworkId,
): DecodedCardanoUnsignedTx {
  if (NETWORKS[network].family !== "cardano") fail("not a Cardano network");
  const networkId = cardanoNetworkId(network);
  const hex = unsignedHex.replace(/^0x/, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) fail("expected hex CBOR");
  const buf = hexToBytes(hex);
  const root = decodeCanonicalCbor(buf);
  const [body, witnesses, isValid, aux] = asArray(root, "transaction", 4);
  if (body?.t !== "map") return fail("body: expected a map");
  if (isValid?.t !== "simple" || isValid.v !== true) fail("is_valid must be true");
  if (aux?.t !== "simple" || aux.v !== null) fail("auxiliary data is not allowed");

  const bodyKeys: number[] = [];
  let inputs: CardanoTxInputRef[] = [];
  let outputs: CardanoTxOutputView[] = [];
  let fee: bigint | null = null;
  let ttl: bigint | null = null;
  let validityStart: bigint | null = null;
  let scriptDataHash: string | null = null;
  let collateral: CardanoTxInputRef[] = [];
  let requiredSigners: string[] = [];
  let collateralReturn: CardanoTxOutputView | null = null;
  let totalCollateral: bigint | null = null;
  for (const [k, v] of body.v) {
    const big = asUint(k, "body key");
    const key = Number(big);
    if (big > 255n || !BODY_KEYS.has(key)) fail(`unexpected body field ${big.toString()}`);
    bodyKeys.push(key);
    if (key === 0) inputs = decodeInputs(v, "input");
    else if (key === 1) outputs = asArray(v, "outputs").map((o) => decodeOutput(o, networkId));
    else if (key === 2) fee = asUint(v, "fee");
    else if (key === 3) ttl = asUint(v, "ttl");
    else if (key === 8) validityStart = asUint(v, "validity start");
    else if (key === 11) scriptDataHash = bytesToHex(asBytes(v, "script_data_hash", 32));
    else if (key === 13) collateral = decodeInputs(v, "collateral input");
    else if (key === 14) {
      requiredSigners = setItems(v, "required signers").map((h) =>
        bytesToHex(asBytes(h, "required signer", 28)),
      );
      for (let i = 1; i < requiredSigners.length; i++)
        if ((requiredSigners[i - 1] ?? "") >= (requiredSigners[i] ?? ""))
          fail("required signers are not a sorted set");
    } else if (key === 16) collateralReturn = decodeOutput(v, networkId);
    else totalCollateral = asUint(v, "total collateral");
  }
  if (inputs.length === 0) fail("no inputs");
  if (outputs.length === 0) fail("no outputs");
  if (fee === null) return fail("no fee");

  if (witnesses?.t !== "map") return fail("witness set: expected a map");
  const witnessKeys: number[] = [];
  let redeemers: CardanoTxRedeemerView[] = [];
  let plutusV3ScriptHashes: string[] = [];
  for (const [k, v] of witnesses.v) {
    const key = asUint(k, "witness key");
    if (key === 0n) fail("the transaction already carries a signature");
    if (key === 5n) {
      if (v.t !== "map" || v.v.length === 0) fail("redeemers: expected a non-empty map");
      if (v.t === "map")
        redeemers = v.v.map(([rk, rv]) => {
          const [tag, index] = asArray(rk, "redeemer key", 2);
          const [data, units] = asArray(rv, "redeemer value", 2);
          const [mem, steps] = asArray(units, "ex units", 2);
          if (data === undefined) return fail("redeemer: malformed");
          return {
            tag: Number(asUint(tag, "redeemer tag")),
            index: Number(asUint(index, "redeemer index")),
            dataHex: bytesToHex(buf.subarray(data.start, data.end)),
            mem: asUint(mem, "ex units mem"),
            steps: asUint(steps, "ex units steps"),
          };
        });
    } else if (key === 7n) {
      plutusV3ScriptHashes = setItems(v, "plutus v3 scripts").map((s) =>
        plutusV3Hash(asBytes(s, "plutus v3 script")),
      );
      if (plutusV3ScriptHashes.length === 0) fail("empty script set");
    } else {
      fail(`unexpected witness field ${key.toString()}`);
    }
    witnessKeys.push(Number(key));
  }

  return {
    bodyHash: bytesToHex(blake2b(buf.subarray(body.start, body.end), { dkLen: 32 })),
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
    redeemers,
    plutusV3ScriptHashes,
  };
}

// --- time --------------------------------------------------------------------------------

/** Shelley-era slot <-> POSIX ms (1 s slots); same constants as @zyropay/blockchain. */
export const CARDANO_SLOT_CONFIG: Readonly<
  Partial<Record<NetworkId, { zeroTimeMs: number; zeroSlot: number; slotLengthMs: number }>>
> = {
  "cardano-mainnet": { zeroTimeMs: 1596059091000, zeroSlot: 4492800, slotLengthMs: 1000 },
  "cardano-preprod": { zeroTimeMs: 1655769600000, zeroSlot: 86400, slotLengthMs: 1000 },
};

/** POSIX ms at the start of `slot`, or null when the network has no slot config. */
export function cardanoSlotToMs(network: NetworkId, slot: bigint): number | null {
  const c = CARDANO_SLOT_CONFIG[network];
  if (c === undefined) return null;
  return c.zeroTimeMs + (Number(slot) - c.zeroSlot) * c.slotLengthMs;
}
