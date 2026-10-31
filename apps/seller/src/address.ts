/*
 * Cardano Shelley address parsing (pure, no network).
 *  - CIP-19 (address header and payload): https://cips.cardano.org/cip/CIP-0019
 *  - CIP-5 (bech32 prefixes; no 90-char limit): https://cips.cardano.org/cip/CIP-0005
 *  - BIP-173 (bech32 checksum): https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
 *
 * Header high nibble = address type, low nibble = network id (1 mainnet, 0 every testnet).
 * Types 0-7 are payment addresses; an odd type has a SCRIPT payment credential.
 * Preprod and preview share network id 0 and the `addr_test` prefix, so an address alone
 * cannot say which testnet it belongs to.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;
const MAX_LENGTH = 200; // a base address is 108 chars; pointer addresses are a bit longer

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

/** 5-bit groups to bytes; null on non-zero padding (BIP-173). */
function fromWords(words: readonly number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return Uint8Array.from(out);
}

/** Bech32 (not bech32m) decode. Null for anything malformed, mixed-case or over-long. */
function bech32Decode(input: string): { hrp: string; bytes: Uint8Array } | null {
  if (input.length < 8 || input.length > MAX_LENGTH) return null;
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) return null;
  const s = input.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const data: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  const bytes = fromWords(data.slice(0, -6));
  return bytes === null ? null : { hrp, bytes };
}

export type AddressKind = "base" | "pointer" | "enterprise";

export interface ShelleyAddress {
  /** Lower-case bech32. */
  readonly bech32: string;
  readonly hrp: string;
  readonly networkId: number;
  readonly kind: AddressKind;
  readonly paymentCredential: "key" | "script";
}

/** Parse a Shelley PAYMENT address (types 0-7). Null for Byron, reward or malformed input. */
export function parseShelleyAddress(input: string): ShelleyAddress | null {
  const decoded = bech32Decode(input.trim());
  if (decoded === null) return null;
  const { hrp, bytes } = decoded;
  const header = bytes[0];
  if (header === undefined) return null;
  const type = header >>> 4;
  const networkId = header & 0x0f;
  if (type > 7) return null;
  let kind: AddressKind;
  if (type <= 3) {
    if (bytes.length !== 57) return null;
    kind = "base";
  } else if (type <= 5) {
    // 28-byte credential + three variable-length naturals (at least one byte each)
    if (bytes.length < 32 || bytes.length > 64) return null;
    kind = "pointer";
  } else {
    if (bytes.length !== 29) return null;
    kind = "enterprise";
  }
  // CIP-5: the prefix must agree with the header's network id.
  if ((networkId === 1 && hrp !== "addr") || (networkId !== 1 && hrp !== "addr_test")) return null;
  return {
    bech32: input.trim().toLowerCase(),
    hrp,
    networkId,
    kind,
    paymentCredential: type % 2 === 0 ? "key" : "script",
  };
}

export type AddressCheck =
  | { readonly ok: true; readonly address: ShelleyAddress }
  | { readonly ok: false; readonly reason: string };

/** The address a buyer may ask about: any testnet (network id 0) Shelley payment address. */
export function checkQueryAddress(input: string | undefined): AddressCheck {
  if (input === undefined || input.trim() === "")
    return { ok: false, reason: "query parameter 'address' is required (addr_test1...)" };
  const s = input.trim().toLowerCase();
  if (s.startsWith("stake"))
    return { ok: false, reason: "stake (reward) addresses are not supported; pass addr_test1..." };
  const parsed = parseShelleyAddress(input);
  if (parsed === null) return { ok: false, reason: "not a valid Cardano Shelley bech32 address" };
  if (parsed.networkId !== 0)
    return { ok: false, reason: "mainnet address: this service covers Cardano preprod only" };
  return { ok: true, address: parsed };
}

/**
 * The seller's payTo: a testnet Shelley address whose payment credential is a KEY hash.
 * ZyroPay (and any careful buyer) refuses to pay a script credential, since a plain
 * transfer to a script without the expected datum can be unspendable.
 */
export function checkPayToAddress(input: string | undefined): AddressCheck {
  if (input === undefined || input.trim() === "")
    return { ok: false, reason: "SELLER_ADDRESS is not set" };
  const parsed = parseShelleyAddress(input);
  if (parsed === null)
    return { ok: false, reason: "SELLER_ADDRESS is not a valid Shelley bech32 address" };
  if (parsed.networkId !== 0)
    return { ok: false, reason: "SELLER_ADDRESS must be a preprod address (addr_test1...)" };
  if (parsed.paymentCredential !== "key")
    return { ok: false, reason: "SELLER_ADDRESS must have a key-hash payment credential" };
  return { ok: true, address: parsed };
}
