export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Wrapped SOL mint (used to price native SOL). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Base fee per signature, lamports. */
export const LAMPORTS_PER_SIGNATURE = 5000n;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** Runtime default when no SetComputeUnitLimit is present: 200k per non-budget instruction. */
export const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;

/** Token account sizes: classic 165 bytes; Token-2022 ATA carries ImmutableOwner (170). */
export const TOKEN_ACCOUNT_SIZE = 165;
export const TOKEN_2022_ATA_SIZE = 170;

export interface MintExtension {
  readonly name: string;
  readonly state: Readonly<Record<string, unknown>>;
}

function feeBps(fee: unknown): number {
  if (typeof fee !== "object" || fee === null) return 0;
  const value = (fee as Record<string, unknown>).transferFeeBasisPoints;
  return typeof value === "number" ? value : Number.NaN;
}

/**
 * Reason a Token-2022 mint is refused for a plain transfer, or null when it is safe. Refused:
 * a non-zero transfer fee (the recipient would not get the approved amount), a transfer hook
 * with a program id (a third-party program would run inside the user's signature),
 * non-transferable or paused tokens.
 */
export function token2022TransferBlocker(extensions: readonly MintExtension[]): string | null {
  for (const { name, state } of extensions) {
    if (name === "nonTransferable") return "token is non-transferable";
    if (name === "pausableConfig" && state.paused === true) return "token transfers are paused";
    if (name === "transferHook" && state.programId !== null && state.programId !== undefined) {
      return "token has a transfer hook program";
    }
    if (name === "transferFeeConfig") {
      if (feeBps(state.olderTransferFee) !== 0 || feeBps(state.newerTransferFee) !== 0) {
        return "token charges a transfer fee";
      }
    }
  }
  return null;
}

/** ceil(units * microLamportsPerCu / 1e6), the priority fee in lamports. */
export function priorityFeeLamports(units: bigint, microLamportsPerCu: bigint): bigint {
  const product = units * microLamportsPerCu;
  return product / 1_000_000n + (product % 1_000_000n === 0n ? 0n : 1n);
}
