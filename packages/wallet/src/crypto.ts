/*
 * Delegated-signer key material (ADR-001 D6).
 *
 *  - The API generates a P-256 key pair with WebCrypto. Turnkey API keys use the
 *    compressed SEC1 public key (33 bytes, hex) and the raw 32-byte private scalar (hex).
 *  - The private key is encrypted at rest with AES-256-GCM under
 *    DELEGATED_KEY_ENCRYPTION_KEY. Stored format (delegated_signers.encrypted_api_private_key):
 *    base64( iv(12) || ciphertext || tag(16) ). Additional authenticated data binds the
 *    ciphertext to its owner so a row cannot be swapped onto another user.
 */
import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToHex } from "./encoding";

const IV_BYTES = 12;
const AAD_PREFIX = "zyropay:delegated-key:v1:";

export interface P256ApiKeyPair {
  /** Compressed SEC1 public key, lowercase hex (66 chars). */
  readonly publicKey: string;
  /** Raw private scalar, lowercase hex (64 chars). Never log or persist unencrypted. */
  readonly privateKey: string;
}

export async function generateP256ApiKeyPair(): Promise<P256ApiKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (jwk.d === undefined || jwk.x === undefined || jwk.y === undefined) {
    throw new Error("WebCrypto did not export a complete P-256 JWK");
  }
  const d = base64UrlToBytes(jwk.d);
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (d.length !== 32 || x.length !== 32 || y.length !== 32) {
    throw new Error("unexpected P-256 key length");
  }
  const prefix = ((y[31] ?? 0) & 1) === 0 ? "02" : "03";
  return { publicKey: prefix + bytesToHex(x), privateKey: bytesToHex(d) };
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(keyBase64);
  } catch {
    throw new Error("DELEGATED_KEY_ENCRYPTION_KEY must be base64");
  }
  if (raw.length !== 32) throw new Error("DELEGATED_KEY_ENCRYPTION_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function aad(ownerId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(AAD_PREFIX + ownerId);
}

/** AES-256-GCM encrypt `plaintext`, bound to `ownerId` (e.g. the ZyroPay user id). */
export async function encryptSecret(
  plaintext: string,
  keyBase64: string,
  ownerId: string,
): Promise<string> {
  const key = await importAesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(ownerId) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

/** Inverse of encryptSecret. Throws on a wrong key, wrong owner or tampered ciphertext. */
export async function decryptSecret(
  ciphertextBase64: string,
  keyBase64: string,
  ownerId: string,
): Promise<string> {
  const key = await importAesKey(keyBase64);
  const data = base64ToBytes(ciphertextBase64);
  if (data.length <= IV_BYTES + 16) throw new Error("ciphertext too short");
  const iv = data.slice(0, IV_BYTES);
  const ct = data.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad(ownerId) },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}
