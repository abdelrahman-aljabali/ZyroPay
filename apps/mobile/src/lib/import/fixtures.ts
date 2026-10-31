/*
 * PUBLIC TEST VECTORS for the simulated (mock-mode) import. They are published in the
 * BIP-39 / Hardhat / SLIP-10 test suites, hold no funds and must never be "real". Mock
 * mode fills these instead of reading anything the user types or copies, so a demo can
 * never capture a real secret. The simulated signer refuses any other value.
 */

/** BIP-39 test vector 1 (Trezor python-mnemonic vectors.json, entropy 0x00 * 16). */
export const TEST_PHRASE_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Its addresses at the standard paths (Phantom / MetaMask show these for the phrase). */
export const TEST_PHRASE_12_ADDRESSES = {
  solana: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
  evm: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
} as const;

/** Hardhat / Anvil default account #0 (published in their docs; drained on every mainnet). */
export const TEST_EVM_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_EVM_KEY_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** The Solana keypair of TEST_PHRASE_12 at m/44'/501'/0'/0' (secret || public, base58). */
export const TEST_SOLANA_KEY =
  "27npWoNE4HfmLeQo1TyWcW7NEA28qnsnDK7kcttDQEWrCWnro83HMJ97rMmpvYYZRwDAvG4KRuB7hTBacvwD7bgi";

export const TEST_PHRASES: readonly string[] = [TEST_PHRASE_12];
export const TEST_PRIVATE_KEYS: readonly string[] = [TEST_EVM_KEY, TEST_SOLANA_KEY];
