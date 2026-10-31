import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "./networks";
import { cardanoNetworkId, NETWORKS } from "./networks";

/*
 * Cardano address handling (pure, no network). Sources:
 *  - CIP-19 (address formats): https://cips.cardano.org/cip/CIP-0019
 *  - CIP-5 (bech32 prefixes):  https://cips.cardano.org/cip/CIP-0005
 *  - BIP-173 (bech32):         https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
 *
 * A Shelley address is bech32 (hrp `addr` on mainnet, `addr_test` on every testnet) over
 * `header || payload`. The header's high nibble is the address type, the low nibble the
 * network id (1 mainnet, 0 testnet). Byron addresses are base58 CBOR and only ever appear
 * as counterparties in history: ZyroPay never sends to them.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_MAP: ReadonlyMap<string, number> = new Map(
  Array.from({ length: CHARSET.length }, (_, i) => [CHARSET.charAt(i), i]),
);
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
/** Cardano lifts BIP-173's 90-character limit (CIP-5); 1023 is the practical bound. */
const MAX_BECH32_LENGTH = 1023;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i] ?? 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: readonly number[], from: number, to: number, pad: boolean) {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/** BIP-173 bech32 (not bech32m) decode without the 90-char limit. Null on any error. */
export function bech32Decode(input: string): { hrp: string; bytes: Uint8Array } | null {
  if (input.length < 8 || input.length > MAX_BECH32_LENGTH) return null;
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return null; // mixed case
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET_MAP.get(ch);
    if (v === undefined) return null;
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes === null ? null : { hrp, bytes: Uint8Array.from(bytes) };
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  if (data === null) throw new Error("bech32: invalid data");
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => CHARSET.charAt(v)).join("")}`;
}

export type CardanoCredentialKind = "key" | "script";

export interface ParsedShelleyAddress {
  /** CIP-19 header type: 0-3 base, 4-5 pointer, 6-7 enterprise, 14-15 reward (stake). */
  readonly type: number;
  readonly networkId: number;
  /** Null for reward (stake) addresses, which have no payment part. */
  readonly payment: { readonly kind: CardanoCredentialKind; readonly hash: string } | null;
  readonly bytes: Uint8Array;
}

function readVarUint(bytes: Uint8Array, start: number): number | null {
  // CIP-19 pointer: variable-length natural, 7 bits per byte, MSB = continuation.
  let value = 0;
  let i = start;
  for (let n = 0; n < 9; n++) {
    const b = bytes[i];
    if (b === undefined) return null;
    value = value * 128 + (b & 0x7f);
    i++;
    if ((b & 0x80) === 0) return i;
  }
  return null;
}

/** Decode and structurally validate a bech32 Shelley address (payment or reward). */
export function parseShelleyAddress(address: string): ParsedShelleyAddress | null {
  const decoded = bech32Decode(address);
  if (decoded === null) return null;
  const { hrp, bytes } = decoded;
  const header = bytes[0];
  if (header === undefined) return null;
  const type = header >>> 4;
  const networkId = header & 0x0f;
  const isReward = type === 14 || type === 15;
  const expectedHrp = isReward
    ? networkId === 1
      ? "stake"
      : "stake_test"
    : networkId === 1
      ? "addr"
      : "addr_test";
  if (hrp !== expectedHrp) return null;
  if (networkId !== 0 && networkId !== 1) return null;
  if (type <= 3) {
    if (bytes.length !== 57) return null;
  } else if (type === 4 || type === 5) {
    // header + 28-byte payment hash + three pointer naturals (slot, tx index, cert index).
    let i: number | null = 29;
    for (let n = 0; n < 3 && i !== null; n++) i = readVarUint(bytes, i);
    if (i === null || i !== bytes.length) return null;
  } else if (type === 6 || type === 7 || isReward) {
    if (bytes.length !== 29) return null;
  } else {
    return null;
  }
  const hash = bytesToHex(bytes.slice(1, 29));
  const scriptPayment = type === 1 || type === 3 || type === 5 || type === 7;
  return {
    type,
    networkId,
    payment: isReward ? null : { kind: scriptPayment ? "script" : "key", hash },
    bytes,
  };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ToBytes(input: string): Uint8Array | null {
  let value = 0n;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const out: number[] = [];
  while (value > 0n) {
    out.push(Number(value & 0xffn));
    value >>= 8n;
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...out.reverse()]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Byron (bootstrap) address: base58 of CBOR `[tag 24(bytes), crc32(bytes)]`. Only the
 * envelope and checksum are checked. Accepted for display (history counterparties), never
 * as a send recipient.
 */
export function isValidCardanoByronAddress(address: string): boolean {
  if (address.length < 50 || address.length > 128) return false;
  const bytes = base58ToBytes(address);
  if (bytes?.[0] !== 0x82 || bytes[1] !== 0xd8 || bytes[2] !== 0x18) return false;
  let offset: number;
  let length: number;
  if (bytes[3] === 0x58) {
    length = bytes[4] ?? -1;
    offset = 5;
  } else if (bytes[3] === 0x59) {
    length = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
    offset = 6;
  } else {
    return false;
  }
  const inner = bytes.slice(offset, offset + length);
  if (inner.length !== length) return false;
  const rest = bytes.slice(offset + length);
  if (rest.length !== 5 || rest[0] !== 0x1a) return false;
  const crc =
    (((rest[1] ?? 0) << 24) | ((rest[2] ?? 0) << 16) | ((rest[3] ?? 0) << 8) | (rest[4] ?? 0)) >>>
    0;
  return crc === crc32(inner);
}

/** Any Shelley payment address (types 0-7, either network) or a Byron address. */
export function isValidCardanoAddress(address: string): boolean {
  if (address.startsWith("addr")) {
    const parsed = parseShelleyAddress(address);
    return parsed !== null && parsed.payment !== null;
  }
  return isValidCardanoByronAddress(address);
}

/**
 * Address ZyroPay may send to (or hold funds at) on `network`: a Shelley address whose
 * network id matches and whose payment credential is a KEY hash. Rejected: Byron, reward
 * (stake) addresses, the other network's addresses, and script payment credentials (a
 * plain transfer to a Plutus script without a datum can lock the funds for good).
 */
export function isValidCardanoPaymentAddress(network: NetworkId, address: string): boolean {
  if (NETWORKS[network].family !== "cardano") return false;
  const parsed = parseShelleyAddress(address);
  return (
    parsed !== null &&
    parsed.payment?.kind === "key" &&
    parsed.networkId === cardanoNetworkId(network)
  );
}

/**
 * The Turnkey wallet account ZyroPay uses for Cardano (docs/ARCHITECTURE.md ADR-002):
 * `ADDRESS_FORMAT_COMPRESSED` on `CURVE_ED25519` (Turnkey returns the raw Ed25519 public
 * key as the account address) at the CIP-1852 purpose/coin path with every level hardened,
 * because Turnkey's Ed25519 derivation (SLIP-10 style) has no soft derivation.
 */
export const CARDANO_TURNKEY_ACCOUNT = {
  curve: "CURVE_ED25519",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/1852'/1815'/0'/0'/0'",
  addressFormat: "ADDRESS_FORMAT_COMPRESSED",
} as const;

/** True for a Turnkey account ZyroPay treats as its Cardano payment key. */
export function isCardanoTurnkeyAccount(account: {
  addressFormat: string;
  path: string;
  curve?: string | undefined;
}): boolean {
  return (
    account.addressFormat === CARDANO_TURNKEY_ACCOUNT.addressFormat &&
    (account.curve === undefined || account.curve === CARDANO_TURNKEY_ACCOUNT.curve) &&
    account.path.startsWith("m/1852'/1815'/")
  );
}

/** Blake2b-224 of the payment key: the credential an enterprise/base address carries. */
export function cardanoKeyHash(publicKeyHex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    throw new Error("Cardano payment key must be a 32-byte Ed25519 public key (hex)");
  }
  return bytesToHex(blake2b(hexToBytes(publicKeyHex.toLowerCase()), { dkLen: 28 }));
}

/**
 * The address ZyroPay derives for a Turnkey Ed25519 account: a CIP-19 type-6 ENTERPRISE
 * address (payment key hash only, no stake part) on `network`. See docs/ARCHITECTURE.md
 * ADR-002 for why this is not the address a Daedalus/Eternl seed would show.
 */
export function cardanoEnterpriseAddress(publicKeyHex: string, network: NetworkId): string {
  const networkId = cardanoNetworkId(network);
  const bytes = new Uint8Array(29);
  bytes[0] = (6 << 4) | networkId;
  bytes.set(hexToBytes(cardanoKeyHash(publicKeyHex)), 1);
  return bech32Encode(networkId === 1 ? "addr" : "addr_test", bytes);
}

/** Payment key hash of a key-credential Shelley address; null for anything else. */
export function cardanoPaymentKeyHash(address: string): string | null {
  const parsed = parseShelleyAddress(address);
  return parsed?.payment?.kind === "key" ? parsed.payment.hash : null;
}

/** Raw address bytes (header || payload) of a Shelley address, as carried in tx outputs. */
export function cardanoAddressBytes(address: string): Uint8Array {
  const parsed = parseShelleyAddress(address);
  if (parsed === null) throw new Error("not a Shelley address");
  return parsed.bytes;
}

/** Bech32 form of raw Shelley address bytes (tx output decode). Null for Byron/invalid. */
export function cardanoAddressFromBytes(bytes: Uint8Array): string | null {
  const header = bytes[0];
  if (header === undefined) return null;
  const type = header >>> 4;
  const networkId = header & 0x0f;
  if (type > 7 || (networkId !== 0 && networkId !== 1)) return null;
  const address = bech32Encode(networkId === 1 ? "addr" : "addr_test", bytes);
  return parseShelleyAddress(address) === null ? null : address;
}

/**
 * End offset of the definite-length CBOR item starting at `offset`, or -1 when the bytes
 * are not one well-formed definite-length item (indefinite lengths, reserved additional
 * info, truncation and nesting deeper than 64 are refused).
 */
function cborItemEnd(bytes: Uint8Array, offset: number, depth = 0): number {
  if (depth > 64 || offset >= bytes.length) return -1;
  const initial = bytes[offset] ?? 0;
  const major = initial >>> 5;
  const info = initial & 0x1f;
  let pos = offset + 1;
  let arg = 0;
  if (info < 24) arg = info;
  else if (info <= 27) {
    const size = 1 << (info - 24);
    if (pos + size > bytes.length) return -1;
    for (let i = 0; i < size; i++) arg = arg * 256 + (bytes[pos + i] ?? 0);
    pos += size;
  } else return -1; // 28-30 reserved, 31 indefinite
  if (!Number.isSafeInteger(arg)) return -1;
  switch (major) {
    case 0:
    case 1:
    case 7:
      return pos;
    case 2:
    case 3:
      return pos + arg <= bytes.length ? pos + arg : -1;
    case 4:
    case 5: {
      const items = major === 5 ? arg * 2 : arg;
      for (let i = 0; i < items; i++) {
        pos = cborItemEnd(bytes, pos, depth + 1);
        if (pos < 0) return -1;
      }
      return pos;
    }
    case 6:
      return cborItemEnd(bytes, pos, depth + 1);
    default:
      return -1;
  }
}

/** Witness-set keys an UNSIGNED ZyroPay transaction may carry: redeemers and PlutusV3 scripts. */
const UNSIGNED_WITNESS_KEYS: ReadonlySet<number> = new Set([5, 7]);

/**
 * Body hash of an UNSIGNED transaction in the exact shape ZyroPay builds:
 * `84 <body> <witness set> f5 f6` (array of 4: body map, witness set, true, null). The
 * witness set is empty (`a0`) for a transfer or an escrow lock, and holds only redeemers
 * (key 5) and PlutusV3 scripts (key 7) for an escrow script spend: never a vkey witness
 * (key 0), so the transaction is unsigned. The passkey signs this hash either way. Lets a
 * client (the app) recompute what it is asked to sign without a CBOR library. Null for any
 * other shape. The API re-checks with a full strict decode.
 */
export function cardanoUnsignedBodyHash(unsignedHex: string): string | null {
  const hex = unsignedHex.replace(/^0x/, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex) || !hex.startsWith("84") || !hex.endsWith("f5f6")) {
    return null;
  }
  const bytes = hexToBytes(hex);
  if ((bytes[1] ?? 0) >>> 5 !== 5) return null; // the body is a CBOR map (major type 5)
  const bodyEnd = cborItemEnd(bytes, 1);
  if (bodyEnd < 0) return null;
  // Witness set: a definite map whose keys are only 5 and/or 7, each at most once, ascending.
  const ws = bytes[bodyEnd] ?? 0;
  if (ws >>> 5 !== 5 || (ws & 0x1f) > 2) return null;
  let pos = bodyEnd + 1;
  let last = -1;
  for (let i = 0; i < (ws & 0x1f); i++) {
    const key = bytes[pos] ?? 0xff;
    if (!UNSIGNED_WITNESS_KEYS.has(key) || key <= last) return null;
    last = key;
    pos = cborItemEnd(bytes, pos + 1);
    if (pos < 0) return null;
  }
  if (pos !== bytes.length - 2) return null; // then exactly `f5 f6`
  return bytesToHex(blake2b(bytes.subarray(1, bodyEnd), { dkLen: 32 }));
}

/**
 * The canonical Masumi payment-v2 (`vested_pay`) escrow address per network: the enterprise
 * script address of the applied validator (2-of-3 admins, 7 min cooldown) that x402's
 * `assetTransferMethod: "masumi"` locks into. Equal to `@x402/cardano` masumiEscrowAddress
 * and `@zyropay/blockchain` masumiEscrowAddress (asserted in @zyropay/integrations tests).
 * A canonical payload may name this script address as `to` only for an x402 Masumi escrow
 * lock (see CanonicalTransactionPayloadSchema).
 */
export const MASUMI_ESCROW_ADDRESSES: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": "addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d",
  "cardano-preprod": "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g",
};

/**
 * Native-token unit as Blockfrost writes it: policy id (28 bytes) || asset name (0-32
 * bytes), lowercase hex. The asset id of a Cardano token is `<network>:<unit>`.
 */
export const CARDANO_ASSET_UNIT_RE = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

export function splitCardanoAssetUnit(unit: string): { policyId: string; assetName: string } {
  if (!CARDANO_ASSET_UNIT_RE.test(unit)) throw new Error("invalid Cardano asset unit");
  return { policyId: unit.slice(0, 56), assetName: unit.slice(56) };
}
