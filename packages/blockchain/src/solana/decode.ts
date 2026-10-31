import type { AccountMeta, Address, Instruction, ReadonlyUint8Array } from "@solana/kit";
import {
  AccountRole,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";

/** Placeholder address for accounts loaded through an address lookup table. */
export const LOOKUP_TABLE_ACCOUNT = "ADDRESS_TABLE_LOOKUP";

export interface DecodedInstruction extends Instruction {
  readonly programAddress: Address;
  readonly accounts: readonly AccountMeta[];
  readonly data: ReadonlyUint8Array;
}

export interface DecodedSolanaTransaction {
  readonly version: "legacy" | 0;
  readonly messageBytes: ReadonlyUint8Array;
  /** Signer address -> base58 signature, or null if not signed yet. Ordered like the message. */
  readonly signatures: ReadonlyArray<{ address: string; signature: string | null }>;
  readonly feePayer: string;
  readonly staticAccounts: readonly string[];
  readonly numSigners: number;
  readonly lifetimeToken: string;
  readonly instructions: readonly DecodedInstruction[];
  /** True when any account is loaded through an address lookup table. */
  readonly usesLookupTables: boolean;
}

/**
 * Decode a base64 wire transaction into its compiled message, WITHOUT resolving address lookup
 * tables. Accounts that come from a lookup table appear as `ADDRESS_TABLE_LOOKUP`, exactly
 * like Turnkey's policy engine shows them. Program ids can never come from a lookup table, so
 * every instruction's program is always known.
 */
export function decodeSolanaTransaction(base64: string): DecodedSolanaTransaction {
  const bytes = getBase64Encoder().encode(base64);
  const tx = getTransactionDecoder().decode(bytes);
  const decoded = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (decoded.version === 1) {
    // v1 messages (SIMD-0385) are not produced by ZyroPay and Turnkey policies do not parse them.
    throw new Error("v1 transaction messages are not supported");
  }
  const compiled = decoded;
  const staticAccounts = compiled.staticAccounts.map(String);
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } =
    compiled.header;
  const roleOf = (index: number): AccountRole => {
    if (index < numSignerAccounts) {
      return index < numSignerAccounts - numReadonlySignerAccounts
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER;
    }
    if (index < staticAccounts.length) {
      return index < staticAccounts.length - numReadonlyNonSignerAccounts
        ? AccountRole.WRITABLE
        : AccountRole.READONLY;
    }
    return AccountRole.READONLY;
  };
  const lookups =
    "addressTableLookups" in compiled && compiled.addressTableLookups !== undefined
      ? compiled.addressTableLookups
      : [];
  const usesLookupTables = lookups.some(
    (l) => l.readonlyIndexes.length + l.writableIndexes.length > 0,
  );
  const instructions = compiled.instructions.map((ix): DecodedInstruction => {
    const program = staticAccounts[ix.programAddressIndex];
    if (program === undefined) throw new Error("program id index out of range");
    const accounts = (ix.accountIndices ?? []).map((i): AccountMeta => ({
      address: (staticAccounts[i] ?? LOOKUP_TABLE_ACCOUNT) as Address,
      role: roleOf(i),
    }));
    return {
      programAddress: program as Address,
      accounts,
      data: ix.data ?? new Uint8Array(),
    };
  });
  const b58 = getBase58Decoder();
  const signatures = Object.entries(tx.signatures).map(([address, sig]) => ({
    address,
    signature: sig === null ? null : b58.decode(sig),
  }));
  const feePayer = staticAccounts[0];
  if (feePayer === undefined) throw new Error("transaction has no accounts");
  return {
    version: compiled.version,
    messageBytes: tx.messageBytes,
    signatures,
    feePayer,
    staticAccounts,
    numSigners: numSignerAccounts,
    lifetimeToken: "lifetimeToken" in compiled ? compiled.lifetimeToken : "",
    instructions,
    usesLookupTables,
  };
}

/** Byte equality of two message byte arrays. */
export function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
