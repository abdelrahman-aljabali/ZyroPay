import type { IdGenerator } from "@zyropay/shared";
import { sha256Hex } from "@zyropay/shared";
import { bytesEqual, bytesToBase64Url, bytesToHex } from "@zyropay/wallet";

export { sha256Hex };

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Opaque bearer token: prefix + 256 random bits (base64url). Only its sha256 is stored. */
export function newOpaqueToken(prefix: "zp_at" | "zp_rt"): string {
  return `${prefix}_${bytesToBase64Url(randomBytes(32))}`;
}

export function randomHex(bytes: number): string {
  return bytesToHex(randomBytes(bytes));
}

/** Constant-time string equality (compares sha256 digests so lengths do not leak). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const da = enc.encode(sha256Hex(a));
  const db = enc.encode(sha256Hex(b));
  return bytesEqual(da, db) && a.length === b.length;
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message))));
}

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** `ABCD-1234` style code (8 chars from a 32-symbol alphabet = 40 bits), unbiased. */
export function newUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET.charAt((bytes[i] ?? 0) & 31);
    if (i === 3) out += "-";
  }
  return out;
}

/** UUIDv7 (time-ordered), RFC 9562. */
export const uuidV7: IdGenerator = {
  newId(): string {
    const bytes = randomBytes(16);
    const ms = BigInt(Date.now());
    for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const h = bytesToHex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
};
