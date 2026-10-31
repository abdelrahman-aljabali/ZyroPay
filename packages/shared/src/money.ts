import { z } from "zod";

/*
 * Money rules (enforced by schemas and lint):
 *  - Token amounts are ALWAYS non-negative integer strings in base units (lamports, wei,
 *    atomic token units) accompanied by `decimals`. Never JS numbers, never floats.
 *  - Fiat values are decimal strings with an ISO-4217 currency code.
 *  - Policy limits and valuations are integer strings of USD minor units (cents).
 *  - All arithmetic is bigint. Rounding is explicit, never implicit.
 */

/** Max uint256 has 78 decimal digits. */
const MAX_BASE_UNIT_DIGITS = 78;
const BASE_UNIT_RE = /^(0|[1-9]\d*)$/;
const DECIMAL_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const UNSIGNED_DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export const BaseUnitAmountSchema = z
  .string()
  .max(MAX_BASE_UNIT_DIGITS)
  .regex(BASE_UNIT_RE, "amount must be a non-negative integer string in base units");
export type BaseUnitAmount = z.infer<typeof BaseUnitAmountSchema>;

export const DecimalsSchema = z.number().int().min(0).max(36);

export const TokenAmountSchema = z.object({
  amount: BaseUnitAmountSchema,
  decimals: DecimalsSchema,
});
export type TokenAmount = z.infer<typeof TokenAmountSchema>;

/** Signed decimal string, e.g. "12.34" or "-0.5". No exponents, no leading '+'. */
export const DecimalStringSchema = z.string().max(100).regex(DECIMAL_RE, "invalid decimal string");
export type DecimalString = z.infer<typeof DecimalStringSchema>;

export const FiatCurrencySchema = z.string().regex(/^[A-Z]{3}$/, "ISO-4217 currency code");
export type FiatCurrency = z.infer<typeof FiatCurrencySchema>;

export const FiatValueSchema = z.object({
  value: DecimalStringSchema,
  currency: FiatCurrencySchema,
});
export type FiatValue = z.infer<typeof FiatValueSchema>;

/** Integer string of USD cents. */
export const UsdMinorSchema = BaseUnitAmountSchema;
export type UsdMinor = z.infer<typeof UsdMinorSchema>;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyError(`invalid decimals: ${decimals}`);
  }
}

/** Parse a base-unit integer string into a bigint, validating format. */
export function parseBaseUnits(amount: string): bigint {
  if (amount.length > MAX_BASE_UNIT_DIGITS || !BASE_UNIT_RE.test(amount)) {
    throw new MoneyError(`invalid base-unit amount: ${JSON.stringify(amount)}`);
  }
  return BigInt(amount);
}

/** Serialize a non-negative bigint as a base-unit string. */
export function toBaseUnitString(value: bigint): BaseUnitAmount {
  if (value < 0n) throw new MoneyError("amount cannot be negative");
  return value.toString();
}

/**
 * Convert a human decimal string ("1.5") into base units ("1500000000" at 9 decimals).
 * Throws when the input has more fractional digits than `decimals` (no silent rounding).
 */
export function toBaseUnits(human: string, decimals: number): BaseUnitAmount {
  assertDecimals(decimals);
  const trimmed = human.trim();
  if (!UNSIGNED_DECIMAL_RE.test(trimmed)) {
    throw new MoneyError(`invalid amount: ${JSON.stringify(human)}`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const significantFraction = fraction.replace(/0+$/, "");
  if (significantFraction.length > decimals) {
    throw new MoneyError(`amount ${human} has more than ${decimals} fractional digits`);
  }
  const padded = significantFraction.padEnd(decimals, "0");
  return toBaseUnitString(BigInt(whole + padded));
}

export interface FormatOptions {
  /** Truncate (round toward zero) to at most this many fractional digits. */
  readonly maxFractionDigits?: number;
  /** Remove trailing zeros in the fraction. Default true. */
  readonly trimTrailingZeros?: boolean;
}

/** Convert base units into a human decimal string. Never uses floating point. */
export function formatBaseUnits(
  amount: string | bigint,
  decimals: number,
  options: FormatOptions = {},
): string {
  assertDecimals(decimals);
  const value = typeof amount === "bigint" ? amount : parseBaseUnits(amount);
  if (value < 0n) throw new MoneyError("amount cannot be negative");
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  if (options.maxFractionDigits !== undefined) {
    fraction = fraction.slice(0, Math.max(0, options.maxFractionDigits));
  }
  if (options.trimTrailingZeros ?? true) fraction = fraction.replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export function compareBaseUnits(a: string, b: string): -1 | 0 | 1 {
  const x = parseBaseUnits(a);
  const y = parseBaseUnits(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addBaseUnits(...amounts: readonly string[]): BaseUnitAmount {
  return toBaseUnitString(amounts.reduce((sum, a) => sum + parseBaseUnits(a), 0n));
}

/** a - b; throws if the result would be negative. */
export function subtractBaseUnits(a: string, b: string): BaseUnitAmount {
  const result = parseBaseUnits(a) - parseBaseUnits(b);
  if (result < 0n) throw new MoneyError(`cannot subtract ${b} from ${a}: result is negative`);
  return toBaseUnitString(result);
}

export function isZeroAmount(amount: string): boolean {
  return parseBaseUnits(amount) === 0n;
}

/** Compare two token amounts; they must share decimals (same asset). */
export function compareTokenAmounts(a: TokenAmount, b: TokenAmount): -1 | 0 | 1 {
  if (a.decimals !== b.decimals) {
    throw new MoneyError(`cannot compare amounts with different decimals`);
  }
  return compareBaseUnits(a.amount, b.amount);
}

export type RoundingMode = "floor" | "ceil";

function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const q = numerator / denominator;
  if (mode === "ceil" && numerator % denominator !== 0n) return q + 1n;
  return q;
}

function splitDecimal(value: string): { int: bigint; scale: number } {
  if (!UNSIGNED_DECIMAL_RE.test(value)) {
    throw new MoneyError(`invalid non-negative decimal: ${JSON.stringify(value)}`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return { int: BigInt(whole + fraction), scale: fraction.length };
}

/**
 * Convert a non-negative fiat decimal string into minor units ("12.345" -> 1235n with ceil).
 * Rounding is explicit. For limits and valuations use "ceil" (conservative).
 */
export function decimalToMinorUnits(
  value: string,
  rounding: RoundingMode,
  minorDigits = 2,
): bigint {
  const { int, scale } = splitDecimal(value);
  if (scale <= minorDigits) return int * 10n ** BigInt(minorDigits - scale);
  return divRound(int, 10n ** BigInt(scale - minorDigits), rounding);
}

export function minorUnitsToDecimal(minor: string | bigint, minorDigits = 2): string {
  return formatBaseUnits(minor, minorDigits, { trimTrailingZeros: false });
}

/**
 * Value a token amount in USD cents given a USD unit price as a decimal string.
 * Rounds UP: a valuation used for limits must never under-count.
 */
export function valueInUsdMinor(amount: TokenAmount, unitPriceUsd: string): UsdMinor {
  const base = parseBaseUnits(amount.amount);
  assertDecimals(amount.decimals);
  const price = splitDecimal(unitPriceUsd);
  // cents = base * price.int * 100 / 10^(decimals + price.scale)
  const numerator = base * price.int * 100n;
  const denominator = 10n ** BigInt(amount.decimals + price.scale);
  return toBaseUnitString(divRound(numerator, denominator, "ceil"));
}
