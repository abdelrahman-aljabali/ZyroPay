import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * SHA-256 of a UTF-8 string, lowercase hex. Pure JS (no WebCrypto, no node:crypto),
 * so it behaves identically on Cloudflare Workers, Node and React Native/Hermes.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return bytesToHex(sha256(bytes));
}
