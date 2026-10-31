import { validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

/*
 * ADR-003 (wallet import): a recovery phrase or private key is encrypted on the device to
 * Turnkey's import enclave and sent to Turnkey only. No ZyroPay contract has a field for
 * one, and the API refuses any request that looks like it carries one (defence in depth
 * against a buggy or tampered client). The checks are deliberately narrow so they never
 * refuse legitimate data:
 *
 *  - a key NAME that is only ever used for key material (mnemonic, seed phrase, private
 *    key, secret key, Turnkey import/export bundle);
 *  - a string VALUE that is a valid BIP-39 English phrase: 12/15/18/21/24 words, every
 *    word in the wordlist AND a valid checksum (ordinary text practically never passes).
 *
 * Hex/base58 values are not inspected: transaction hashes, signatures and public keys
 * have the same shape as private keys, so a value check there would refuse real traffic.
 */

/** Key names that only ever hold key material. Matched case-insensitively, ignoring `_`/`-`. */
const SECRET_KEY_NAMES = [
  "mnemonic",
  "seed",
  "seedphrase",
  "recoveryphrase",
  "secretphrase",
  "privatekey",
  "privkey",
  "secretkey",
  "encryptedbundle",
  "importbundle",
  "exportbundle",
  "keystore",
] as const;

function normalizeKeyName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, "");
}

/** True for a property name reserved for key material (see SECRET_KEY_NAMES). */
export function isSecretFieldName(name: string): boolean {
  const n = normalizeKeyName(name);
  return SECRET_KEY_NAMES.some((k) => n === k || n.endsWith(k));
}

const PHRASE_LENGTHS = new Set([12, 15, 18, 21, 24]);

/** True when `text` is a valid BIP-39 English recovery phrase (wordlist + checksum). */
export function looksLikeRecoveryPhrase(text: string): boolean {
  if (text.length > 400) return false;
  const words = text.normalize("NFKD").trim().toLowerCase().split(/\s+/);
  if (!PHRASE_LENGTHS.has(words.length)) return false;
  return validateMnemonic(words.join(" "), english);
}

export interface SecretMaterialFinding {
  /** JSON path of the offending key or value, e.g. `body.wallet.mnemonic`. Never the value. */
  readonly path: string;
  readonly reason: "secret_field_name" | "recovery_phrase_value";
}

/**
 * Walk a parsed JSON value and return the first place that looks like key material, or
 * null. Only the path is reported, never the value, so callers can log the finding.
 */
export function findSecretMaterial(value: unknown, path = "$"): SecretMaterialFinding | null {
  if (typeof value === "string") {
    return looksLikeRecoveryPhrase(value) ? { path, reason: "recovery_phrase_value" } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSecretMaterial(value[i], `${path}[${String(i)}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (isSecretFieldName(key)) return { path: childPath, reason: "secret_field_name" };
      const found = findSecretMaterial(child, childPath);
      if (found) return found;
    }
  }
  return null;
}
