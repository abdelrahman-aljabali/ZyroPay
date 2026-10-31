import type { ChainFamily, NetworkId } from "@zyropay/shared";
import { formatBaseUnits, getNetwork, MoneyError, parseBaseUnits } from "@zyropay/shared";

/*
 * Display formatting. Pure string/bigint code: money is never routed through
 * floating point (see @zyropay/shared money rules). Every function here is
 * presentation-only; amounts sent to the API come from the shared money helpers.
 */

const DECIMAL_RE = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

export interface CurrencyInfo {
  readonly symbol: string;
  /** Symbol goes after the number ("12.00 CHF") instead of before ("$12.00"). */
  readonly suffix: boolean;
  readonly minorDigits: number;
}

const CURRENCIES: Readonly<Record<string, CurrencyInfo>> = {
  USD: { symbol: "$", suffix: false, minorDigits: 2 },
  EUR: { symbol: "€", suffix: false, minorDigits: 2 },
  GBP: { symbol: "£", suffix: false, minorDigits: 2 },
  CHF: { symbol: "CHF", suffix: true, minorDigits: 2 },
  JPY: { symbol: "¥", suffix: false, minorDigits: 0 },
};

export const SUPPORTED_DISPLAY_CURRENCIES = Object.keys(CURRENCIES);

export function currencyInfo(code: string): CurrencyInfo {
  return CURRENCIES[code] ?? { symbol: code, suffix: true, minorDigits: 2 };
}

/** "1234567" -> "1,234,567". Input must be digits only. */
export function groupDigits(whole: string, separator = ","): string {
  if (!/^\d+$/.test(whole)) throw new MoneyError(`not a digit string: ${whole}`);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Round a decimal string to `digits` fractional digits, half away from zero,
 * padding with zeros. "12.345" (2) -> "12.35"; "-0.004" (2) -> "0.00".
 */
export function roundDecimal(value: string, digits: number): string {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new MoneyError(`invalid decimal: ${JSON.stringify(value)}`);
  const negative = match[1] === "-";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const padded = fraction.padEnd(digits + 1, "0");
  const keep = BigInt(whole + padded.slice(0, digits));
  const next = Number(padded.charAt(digits));
  const rounded = next >= 5 ? keep + 1n : keep;
  const text = rounded.toString().padStart(digits + 1, "0");
  const intPart = digits === 0 ? text : text.slice(0, text.length - digits);
  const fracPart = digits === 0 ? "" : text.slice(text.length - digits);
  const isZero = rounded === 0n;
  const sign = negative && !isZero ? "-" : "";
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

export interface FiatFormatOptions {
  /** Prefix positive values with "+". */
  readonly showPlus?: boolean;
}

/** Format a fiat decimal string: ("1234.5", "USD") -> "$1,234.50". */
export function formatFiat(
  value: string,
  currency: string,
  options: FiatFormatOptions = {},
): string {
  return fiatWithDigits(value, currency, currencyInfo(currency).minorDigits, options);
}

function fiatWithDigits(
  value: string,
  currency: string,
  digits: number,
  options: FiatFormatOptions = {},
): string {
  const info = currencyInfo(currency);
  const rounded = roundDecimal(value, digits);
  const negative = rounded.startsWith("-");
  const unsigned = negative ? rounded.slice(1) : rounded;
  const [whole = "0", fraction] = unsigned.split(".");
  const number = fraction === undefined ? groupDigits(whole) : `${groupDigits(whole)}.${fraction}`;
  const sign = negative
    ? "−"
    : options.showPlus === true && !/^0(\.0+)?$/.test(unsigned)
      ? "+"
      : "";
  return info.suffix ? `${sign}${number} ${info.symbol}` : `${sign}${info.symbol}${number}`;
}

/** Most fractional digits a unit price shows (sub-cent tokens). */
const MAX_PRICE_DIGITS = 10;

/**
 * Price of ONE whole unit: "2432.05" -> "$2,432.05". Below one unit of currency the price
 * keeps four significant digits so sub-cent tokens do not collapse to "$0.00":
 * "0.0000123456" -> "$0.00001235", "0.5" -> "$0.50". Rounded half away from zero, never floats.
 */
export function formatUnitPrice(value: string, currency: string): string {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new MoneyError(`invalid decimal: ${JSON.stringify(value)}`);
  const minor = currencyInfo(currency).minorDigits;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (whole !== "0" || !/[1-9]/.test(fraction)) return fiatWithDigits(value, currency, minor);
  const leadingZeros = /^0*/.exec(fraction)?.[0].length ?? 0;
  const digits = Math.min(MAX_PRICE_DIGITS, Math.max(2, leadingZeros + 4));
  const rounded = roundDecimal(value, digits);
  // "0.5000" -> "0.50": drop zeros the rounding padded beyond the currency's usual digits.
  const keep = Math.max(2, minor);
  const trimmed = rounded.replace(new RegExp(`(\\.\\d{${String(keep)}}\\d*?)0+$`), "$1");
  return fiatWithDigits(trimmed, currency, trimmed.split(".")[1]?.length ?? 0);
}

export type PriceDirection = "up" | "down" | "flat";

export interface PriceChange {
  /** Signed percentage for display: "+1.29%", "−0.45%" (true minus), "0.00%". */
  readonly percent: string;
  /** From the rounded figure: a change that rounds to 0.00% is "flat". */
  readonly direction: PriceDirection;
  /** Spoken form, e.g. "up 1.29%" / "down 0.45%" / "unchanged". */
  readonly spoken: string;
}

/** Decimal string -> bigint scaled by 10^scale (scale >= its fractional digits). */
function scaledDecimal(value: string, scale: number): bigint {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new MoneyError(`invalid decimal: ${JSON.stringify(value)}`);
  const fraction = (match[3] ?? "").padEnd(scale, "0");
  const magnitude = BigInt(`${match[2] ?? "0"}${fraction}`);
  return match[1] === "-" ? -magnitude : magnitude;
}

/**
 * Change from `before` to `now` (two unit prices, decimal strings) in exact bigint math.
 * Null when there is no base to compare against (`before` is zero or negative).
 */
export function priceChange(before: string, now: string, digits = 2): PriceChange | null {
  const scale = Math.max(before.split(".")[1]?.length ?? 0, now.split(".")[1]?.length ?? 0);
  const b = scaledDecimal(before, scale);
  const n = scaledDecimal(now, scale);
  if (b <= 0n) return null;
  const formatted = formatPercent(n - b, b, digits);
  if (formatted === null) return null;
  const negative = formatted.startsWith("−");
  const magnitude = negative ? formatted.slice(1) : formatted;
  const flat = !/[1-9]/.test(magnitude);
  const direction: PriceDirection = flat ? "flat" : negative ? "down" : "up";
  return {
    percent: flat ? magnitude : `${negative ? "−" : "+"}${magnitude}`,
    direction,
    spoken: flat ? "unchanged" : `${direction} ${magnitude}`,
  };
}

/** Fiat from integer minor units (cents): ("123456", "USD") -> "$1,234.56". */
export function formatFiatMinor(minor: string, currency: string): string {
  const info = currencyInfo(currency);
  return formatFiat(formatBaseUnits(minor, info.minorDigits), currency);
}

export interface TokenFormatOptions {
  /** Maximum fractional digits shown (truncated toward zero). Default 6. */
  readonly maxFractionDigits?: number;
  readonly symbol?: string;
}

/**
 * Base units -> grouped human amount. Truncates (never rounds up) so the UI
 * never shows more than the user holds. Tiny non-zero amounts show as "<0.000001".
 */
export function formatTokenAmount(
  amount: string,
  decimals: number,
  options: TokenFormatOptions = {},
): string {
  const maxFractionDigits = options.maxFractionDigits ?? 6;
  const truncated = formatBaseUnits(amount, decimals, { maxFractionDigits });
  const suffix = options.symbol === undefined ? "" : ` ${options.symbol}`;
  if (truncated === "0" && parseBaseUnits(amount) > 0n) {
    const smallest = maxFractionDigits === 0 ? "1" : `0.${"0".repeat(maxFractionDigits - 1)}1`;
    return `<${smallest}${suffix}`;
  }
  const [whole = "0", fraction] = truncated.split(".");
  const grouped = fraction === undefined ? groupDigits(whole) : `${groupDigits(whole)}.${fraction}`;
  return `${grouped}${suffix}`;
}

/**
 * "0x1234567890abcdef..." -> "0x1234…cdef". Prefixes that carry no entropy ("0x", and the
 * Cardano bech32 parts "addr1" / "addr_test1") are kept on top of `lead` characters.
 */
export function shortenAddress(address: string, lead = 4, tail = 4): string {
  const prefix = address.startsWith("0x") ? 2 : bech32PrefixLength(address);
  if (address.length <= prefix + lead + tail + 1) return address;
  return `${address.slice(0, prefix + lead)}…${address.slice(-tail)}`;
}

/** Human label of an address family (one address serves every network of its family). */
export function chainFamilyLabel(family: ChainFamily, style: "long" | "short" = "long"): string {
  switch (family) {
    case "solana":
      return "Solana";
    case "evm":
      return style === "long" ? "EVM · Ethereum and Base" : "EVM";
    case "cardano":
      return "Cardano";
  }
}

/** Placeholder hint for a recipient address field on a network. */
export function addressPlaceholder(network: NetworkId): string {
  const info = getNetwork(network);
  if (info.family === "evm") return "0x…";
  if (info.family === "cardano") return info.isTestnet ? "addr_test1…" : "addr1…";
  return "Solana address";
}

/** Split an address into groups of 4 for read-aloud verification screens. */
export function chunkAddress(address: string, size = 4): string[] {
  // A Cardano human-readable part ("addr_test1") reads as one group, not "addr _tes t1…".
  const prefix = bech32PrefixLength(address);
  const chunks: string[] = prefix > 0 ? [address.slice(0, prefix)] : [];
  for (let i = prefix; i < address.length; i += size) chunks.push(address.slice(i, i + size));
  return chunks;
}

/** Length of a Cardano bech32 prefix incl. the "1" separator ("addr1", "addr_test1"), else 0. */
function bech32PrefixLength(address: string): number {
  if (address.startsWith("addr_test1")) return 10;
  if (address.startsWith("addr1")) return 5;
  return 0;
}

/** Remaining time as "m:ss" (or "h:mm:ss"); "0:00" once expired. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", or a short date. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diff = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(diff)) return "";
  if (diff < 0) return formatShortDate(iso);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 7 * 86_400) return `${Math.round(diff / 86_400)}d ago`;
  return formatShortDate(iso);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "30 Oct 2026" (UTC; stable across devices and tests). */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

/** "30 Oct 2026, 14:05 UTC". */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatShortDate(iso)}, ${hh}:${mm} UTC`;
}

/**
 * Normalise what a user typed into an amount field: digits and one dot,
 * at most `decimals` fractional digits, no leading zeros. Returns null when
 * the keystroke must be rejected.
 */
export function sanitizeAmountInput(next: string, decimals: number): string | null {
  const text = next.replace(",", ".");
  if (text === "") return "";
  if (!/^\d*\.?\d*$/.test(text)) return null;
  const [whole = "", fraction] = text.split(".");
  if (fraction !== undefined && fraction.length > decimals) return null;
  if (decimals === 0 && fraction !== undefined) return null;
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedWhole = trimmedWhole === "" && fraction !== undefined ? "0" : trimmedWhole;
  return fraction === undefined ? normalizedWhole : `${normalizedWhole}.${fraction}`;
}

/** Fiat decimal string -> number of minor units, for display animation only. */
export function fiatToAnimatableMinor(value: string, minorDigits = 2): number {
  const rounded = roundDecimal(value, minorDigits).replace("-", "").replace(".", "");
  return Number(rounded);
}

/** Inverse of fiatToAnimatableMinor, for intermediate animation frames. */
export function animatableMinorToFiat(minor: number, currency: string): string {
  const info = currencyInfo(currency);
  const clamped = Math.max(0, Math.round(minor));
  return formatFiat(formatBaseUnits(BigInt(clamped), info.minorDigits), currency);
}

/**
 * Split a formatted fiat string for display: "$15,930.88" -> { main: "$15,930", fraction: ".88" }.
 * Suffix currencies ("12.00 CHF") and zero-decimal ones come back whole.
 */
export function splitFiat(formatted: string): { main: string; fraction: string } {
  const match = /^(.*?)(\.\d+)$/.exec(formatted);
  if (!match) return { main: formatted, fraction: "" };
  return { main: match[1] ?? formatted, fraction: match[2] ?? "" };
}

/**
 * Exact percentage `part / whole`, rounded half away from zero, as "0.82%". Signed
 * like `part` ("−1.20%" uses a true minus). Null when `whole` is zero.
 */
export function formatPercent(part: bigint, whole: bigint, digits = 2): string | null {
  if (whole === 0n) return null;
  const negative = part < 0n !== whole < 0n;
  const p = part < 0n ? -part : part;
  const w = whole < 0n ? -whole : whole;
  const scale = 10n ** BigInt(digits);
  const scaled = (p * 100n * scale * 2n + w) / (w * 2n);
  const intPart = scaled / scale;
  const frac = (scaled % scale).toString().padStart(digits, "0");
  const body =
    digits > 0 ? `${groupDigits(intPart.toString())}.${frac}` : groupDigits(intPart.toString());
  return `${negative && scaled !== 0n ? "−" : ""}${body}%`;
}

/**
 * Development builds value testnet assets at their mainnet counterpart's price
 * (`priceBasis: "mainnet_proxy"`). Every such value carries the same marker, so a testnet
 * dollar figure is never mistaken for real money.
 */
export const MAINNET_PRICE_MARKER = "mainnet price";
/** Note under totals and on chart/limit context that mix testnet values. */
export const MAINNET_PRICE_NOTE = "Testnet · valued at mainnet prices";

/** True when a value was derived from a mainnet price for a testnet asset. */
export function isMainnetPriced(
  item: { readonly priceBasis?: string | null } | null | undefined,
): boolean {
  return item?.priceBasis === "mainnet_proxy";
}

/** `"≈ $12.34"` -> `"≈ $12.34 · mainnet price"` when the value is a mainnet-proxy valuation. */
export function withPriceMarker(label: string, priceBasis: string | null | undefined): string {
  return priceBasis === "mainnet_proxy" ? `${label} · ${MAINNET_PRICE_MARKER}` : label;
}
