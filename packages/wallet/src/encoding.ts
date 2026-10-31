/** Small, dependency-free byte helpers that behave the same on Workers and Node. */

const HEX_RE = /^(0x)?([0-9a-fA-F]{2})*$/;

export function isHex(value: string): boolean {
  return HEX_RE.test(value);
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!isHex(hex)) throw new Error("invalid hex");
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (b64.length % 4 !== 0 || !B64_RE.test(b64)) throw new Error("invalid base64");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid base64url");
  const b64 = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(padded);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode an unsigned/signed transaction from its declared encoding. Throws on malformed input. */
export function decodeTransaction(
  serialized: string,
  encoding: "base64" | "hex",
): Uint8Array<ArrayBuffer> {
  return encoding === "hex" ? hexToBytes(serialized) : base64ToBytes(serialized);
}

/** Constant-time byte comparison (length is not secret). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
