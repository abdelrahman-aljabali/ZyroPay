import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import {
  isValidCardanoAddress,
  isValidCardanoPaymentAddress,
  parseShelleyAddress,
} from "./cardano";
import type { ChainFamily, NetworkId } from "./networks";
import { chainFamilyOf } from "./networks";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP: ReadonlyMap<string, number> = new Map(
  Array.from({ length: BASE58_ALPHABET.length }, (_, index) => [
    BASE58_ALPHABET.charAt(index),
    index,
  ]),
);

/** Decode a base58 (Bitcoin alphabet) string. Returns null on any invalid character. */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return new Uint8Array();
  let value = 0n;
  for (const char of input) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") leadingZeros++;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}

/**
 * A Solana address is the base58 encoding of exactly 32 bytes. This accepts both on-curve
 * public keys and off-curve program-derived addresses (both are valid account addresses).
 */
export function isValidSolanaAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false;
  const bytes = base58Decode(address);
  return bytes?.length === 32;
}

const EVM_HEX_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 mixed-case checksum encoding. Throws on malformed input. */
export function toChecksumAddress(address: string): string {
  if (!EVM_HEX_RE.test(address)) throw new Error(`invalid EVM address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const char = lower.charAt(i);
    out += parseInt(hash.charAt(i), 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * Valid when the address is 20 hex bytes AND either carries a correct EIP-55 checksum or
 * is single-case (all-lower/all-upper carry no checksum). Mixed case with a wrong
 * checksum is rejected: that is exactly the typo EIP-55 exists to catch.
 */
export function isValidEvmAddress(address: string): boolean {
  if (!EVM_HEX_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/** Strict: only accepts the exact EIP-55 checksum form. */
export function isChecksummedEvmAddress(address: string): boolean {
  return EVM_HEX_RE.test(address) && toChecksumAddress(address) === address;
}

export const EVM_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Family-level validity (no network known). Cardano: a Shelley address with a KEY payment
 * credential on either network (what a wallet can hold and sign for); use
 * `isValidAddressForNetwork` for the network-id check.
 */
export function isValidAddress(family: ChainFamily, address: string): boolean {
  switch (family) {
    case "solana":
      return isValidSolanaAddress(address);
    case "evm":
      return isValidEvmAddress(address);
    case "cardano":
      return parseShelleyAddress(address)?.payment?.kind === "key";
  }
}

/**
 * Network-aware validity, used for every payload `from`/`to` and every send recipient.
 * Cardano additionally requires the address's network id to match (mainnet `addr1...` vs
 * testnet `addr_test1...`) and refuses Byron, stake and script-credential addresses.
 */
export function isValidAddressForNetwork(network: NetworkId, address: string): boolean {
  const family = chainFamilyOf(network);
  if (family === "cardano") return isValidCardanoPaymentAddress(network, address);
  return isValidAddress(family, address);
}

/**
 * Canonical form: EIP-55 checksum for EVM, unchanged for Solana (base58 is case-sensitive),
 * lowercase bech32 for Cardano (bech32 is case-insensitive; lowercase is canonical).
 */
export function normalizeAddress(family: ChainFamily, address: string): string {
  if (!isValidAddress(family, address)) {
    throw new Error(`invalid ${family} address: ${address}`);
  }
  if (family === "evm") return toChecksumAddress(address);
  return family === "cardano" ? address.toLowerCase() : address;
}

/** Equality on canonical forms (EVM and Cardano bech32 are case-insensitive, Solana is not). */
export function addressesEqual(family: ChainFamily, a: string, b: string): boolean {
  return family === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();
}

export const SolanaAddressSchema = z
  .string()
  .refine(isValidSolanaAddress, "invalid Solana address (base58, 32 bytes)");
export const EvmAddressSchema = z
  .string()
  .refine(isValidEvmAddress, "invalid EVM address (20 bytes hex, EIP-55 checksum if mixed case)");
export const CardanoAddressSchema = z
  .string()
  .max(128)
  .refine(isValidCardanoAddress, "invalid Cardano address");
/**
 * Any family; use network-aware checks (`isValidAddressForNetwork`) where the network is
 * known. Cardano is accepted in every form that can appear on chain (Shelley payment
 * addresses of either network, Byron), so history counterparties validate; sends are
 * narrowed by `isValidAddressForNetwork`. Cardano base addresses are up to 108 characters.
 */
export const AddressSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (a) => isValidSolanaAddress(a) || isValidEvmAddress(a) || isValidCardanoAddress(a),
    "invalid Solana, EVM or Cardano address",
  );
