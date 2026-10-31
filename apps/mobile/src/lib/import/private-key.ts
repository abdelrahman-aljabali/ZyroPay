import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import { evmAddressFromSecret, solanaAddressFromSecret } from "./derive";

/*
 * ADR-003: raw private-key import, validated on the device. The formats are the ones
 * Turnkey's import accepts (@turnkey/crypto `encryptPrivateKeyToBundle`):
 *   EVM     64 hex characters, optional 0x  -> keyFormat HEXADECIMAL, secp256k1
 *   Solana  base58 of the 64-byte keypair (secret || public, Phantom/Solflare export)
 *           -> keyFormat SOLANA, ed25519
 * The derived address is shown for confirmation and later compared with Turnkey's.
 */

export type KeyFamily = "solana" | "evm";

export type PrivateKeyCheck =
  | {
      readonly ok: true;
      readonly family: KeyFamily;
      readonly keyFormat: "HEXADECIMAL" | "SOLANA";
      /** The value to hand to Turnkey (trimmed; EVM gets a 0x prefix). */
      readonly privateKey: string;
      readonly address: string;
    }
  | { readonly ok: false; readonly message: string };

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Which chain a pasted key belongs to, by its encoding (null: neither format). */
export function detectKeyFamily(raw: string): KeyFamily | null {
  const text = raw.trim();
  if (HEX_KEY.test(text)) return "evm";
  try {
    if (base58.decode(text).length === 64) return "solana";
  } catch {
    // not base58
  }
  return null;
}

export function checkPrivateKey(raw: string): PrivateKeyCheck {
  const text = raw.trim();
  if (text === "") return { ok: false, message: "Enter a private key." };
  const family = detectKeyFamily(text);
  if (family === "evm") {
    const sk = hexToBytes(text.replace(/^0x/, ""));
    try {
      if (!secp256k1.utils.isValidSecretKey(sk))
        return { ok: false, message: "That isn't a valid EVM private key." };
      return {
        ok: true,
        family,
        keyFormat: "HEXADECIMAL",
        privateKey: text.startsWith("0x") ? text.toLowerCase() : `0x${text.toLowerCase()}`,
        address: evmAddressFromSecret(sk),
      };
    } finally {
      sk.fill(0);
    }
  }
  if (family === "solana") {
    const pair = base58.decode(text);
    try {
      const secret = pair.slice(0, 32);
      const publicKey = pair.slice(32);
      const derived = ed25519.getPublicKey(secret);
      const consistent = equalBytes(derived, publicKey);
      const address = solanaAddressFromSecret(secret);
      secret.fill(0);
      if (!consistent)
        return {
          ok: false,
          message: "This Solana key is damaged: its two halves don't match. Copy it again.",
        };
      return { ok: true, family, keyFormat: "SOLANA", privateKey: text, address };
    } finally {
      pair.fill(0);
    }
  }
  return {
    ok: false,
    message:
      "Use an EVM key (64 hex characters) or a Solana key (base58, as Phantom or Solflare export it).",
  };
}

/**
 * Turnkey's private-key export decrypts to hex (32 bytes). Show it the way the user
 * imported it: EVM as 0x-hex, Solana as the base58 keypair (secret || public) that
 * Phantom and Solflare import.
 */
export function formatExportedKey(hexKey: string, family: KeyFamily): string {
  const clean = hexKey.trim().replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("Turnkey returned an unexpected key");
  if (family === "evm") return `0x${clean}`;
  const secret = hexToBytes(clean);
  const pair = new Uint8Array(64);
  try {
    pair.set(secret, 0);
    pair.set(ed25519.getPublicKey(secret), 32);
    return base58.encode(pair);
  } finally {
    secret.fill(0);
    pair.fill(0);
  }
}
