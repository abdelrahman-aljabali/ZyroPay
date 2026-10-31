import {
  ComputeBudgetInstruction,
  identifyComputeBudgetInstruction,
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  COMPUTE_BUDGET_PROGRAM,
  DEFAULT_UNITS_PER_INSTRUCTION,
  LAMPORTS_PER_SIGNATURE,
  MAX_COMPUTE_UNIT_LIMIT,
  priorityFeeLamports,
} from "./constants";
import type { DecodedInstruction } from "./decode";

export interface ComputeBudgetSummary {
  readonly unitLimit: number;
  readonly microLamportsPerCu: bigint;
  /** Instructions that are not compute-budget instructions, in order. */
  readonly otherInstructions: readonly DecodedInstruction[];
}

/**
 * Read SetComputeUnitLimit/SetComputeUnitPrice from a decoded transaction. Throws on duplicates
 * or on any other compute-budget instruction (heap frame, loaded-accounts limit), which a plain
 * transfer never needs.
 */
export function readComputeBudget(
  instructions: readonly DecodedInstruction[],
): ComputeBudgetSummary {
  let limit: number | null = null;
  let price: bigint | null = null;
  const other: DecodedInstruction[] = [];
  for (const ix of instructions) {
    if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM) {
      other.push(ix);
      continue;
    }
    const kind = identifyComputeBudgetInstruction(ix);
    if (kind === ComputeBudgetInstruction.SetComputeUnitLimit) {
      if (limit !== null) throw new Error("duplicate SetComputeUnitLimit");
      limit = parseSetComputeUnitLimitInstruction(ix).data.units;
    } else if (kind === ComputeBudgetInstruction.SetComputeUnitPrice) {
      if (price !== null) throw new Error("duplicate SetComputeUnitPrice");
      price = parseSetComputeUnitPriceInstruction(ix).data.microLamports;
    } else {
      throw new Error("unexpected compute-budget instruction");
    }
  }
  const unitLimit =
    limit ?? Math.min(MAX_COMPUTE_UNIT_LIMIT, DEFAULT_UNITS_PER_INSTRUCTION * other.length);
  return {
    unitLimit: Math.min(unitLimit, MAX_COMPUTE_UNIT_LIMIT),
    microLamportsPerCu: price ?? 0n,
    otherInstructions: other,
  };
}

/** Worst-case network fee in lamports: signatures plus the priority fee at the unit limit. */
export function maxNetworkFee(numSignatures: number, unitLimit: number, price: bigint): bigint {
  return (
    LAMPORTS_PER_SIGNATURE * BigInt(numSignatures) + priorityFeeLamports(BigInt(unitLimit), price)
  );
}

/** The `percentile`-th value (0-100) of a list of fees; 0 for an empty list. */
export function percentileFee(fees: readonly bigint[], percentile: number): bigint {
  if (fees.length === 0) return 0n;
  const sorted = [...fees].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[index] ?? 0n;
}
