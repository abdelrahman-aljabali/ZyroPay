import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeed } from "@scure/bip39";
import { toChecksumAddress } from "@zyropay/shared";

/*
 * ADR-003: local address preview for an imported phrase, so the user can confirm "this is
 * my wallet" BEFORE the phrase is encrypted and sent to Turnkey, and so the app can check
 * that Turnkey derived the same addresses afterwards (fail closed on a mismatch).
 *
 * The paths are the ones ZyroPay asks Turnkey for (walletAccountParams) and the ones
 * Phantom/Solflare and MetaMask use:
 *   Solana  m/44'/501'/0'/0'  SLIP-10 Ed25519 (all hardened)
 *   EVM     m/44'/60'/0'/0/0  BIP-32 secp256k1
 * Cardano is not derived here: Turnkey's Ed25519 scheme for it is not documented
 * (ADR-002 C3), so its address is only known after Turnkey creates the account.
 *
 * Seeds and keys are Uint8Arrays that are zeroed after use. (JS strings, such as the
 * phrase itself, cannot be zeroed; callers drop every reference instead.)
 */

export const SOLANA_PATH = "m/44'/501'/0'/0'";
export const EVM_PATH = "m/44'/60'/0'/0/0";

const HARDENED = 0x80000000;

function hardenedIndices(path: string): number[] {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error("path must start with m");
  return parts.slice(1).map((p) => {
    if (!p.endsWith("'")) throw new Error("SLIP-10 Ed25519 supports hardened steps only");
    const n = Number(p.slice(0, -1));
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error("bad path index");
    return n + HARDENED;
  });
}

/** SLIP-10 Ed25519 private key (32 bytes) at a hardened path. */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  I.fill(0);
  for (const index of hardenedIndices(path)) {
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chain, data);
    data.fill(0);
    key.fill(0);
    chain.fill(0);
    key = I.slice(0, 32);
    chain = I.slice(32);
    I.fill(0);
  }
  chain.fill(0);
  return key;
}

export function solanaAddressFromSecret(secret32: Uint8Array): string {
  return base58.encode(ed25519.getPublicKey(secret32));
}

export function evmAddressFromSecret(secret32: Uint8Array): string {
  const pub = secp256k1.getPublicKey(secret32, false);
  const hash = keccak_256(pub.slice(1));
  const hex = Array.from(hash.slice(12), (b) => b.toString(16).padStart(2, "0")).join("");
  return toChecksumAddress(`0x${hex}`);
}

export interface PhrasePreview {
  readonly solana?: string;
  readonly evm?: string;
}

/**
 * Derive the Solana and/or EVM address the imported wallet will have. Runs PBKDF2 (2048
 * rounds, async so the UI stays responsive) entirely on the device.
 */
export async function previewPhraseAddresses(
  phrase: string,
  families: readonly ("solana" | "evm" | "cardano")[],
): Promise<PhrasePreview> {
  const seed = await mnemonicToSeed(phrase);
  try {
    const out: { solana?: string; evm?: string } = {};
    if (families.includes("solana")) {
      const sk = slip10Ed25519(seed, SOLANA_PATH);
      out.solana = solanaAddressFromSecret(sk);
      sk.fill(0);
    }
    if (families.includes("evm")) {
      const node = HDKey.fromMasterSeed(seed).derive(EVM_PATH);
      const sk = node.privateKey;
      if (sk === null) throw new Error("EVM derivation failed");
      out.evm = evmAddressFromSecret(sk);
      node.wipePrivateData();
    }
    return out;
  } finally {
    seed.fill(0);
  }
}
