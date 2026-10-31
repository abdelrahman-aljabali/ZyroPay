import { describe, expect, it } from "vitest";
import {
  addressPlaceholder,
  animatableMinorToFiat,
  chainFamilyLabel,
  chunkAddress,
  fiatToAnimatableMinor,
  formatCountdown,
  formatDateTime,
  formatFiat,
  formatFiatMinor,
  formatPercent,
  formatRelativeTime,
  formatTokenAmount,
  formatUnitPrice,
  groupDigits,
  priceChange,
  roundDecimal,
  sanitizeAmountInput,
  shortenAddress,
  splitFiat,
} from "./index";

describe("roundDecimal", () => {
  it("rounds half away from zero without floats", () => {
    expect(roundDecimal("12.345", 2)).toBe("12.35");
    expect(roundDecimal("12.344", 2)).toBe("12.34");
    expect(roundDecimal("0.995", 2)).toBe("1.00");
    expect(roundDecimal("7", 2)).toBe("7.00");
    expect(roundDecimal("-1.005", 2)).toBe("-1.01");
    expect(roundDecimal("-0.004", 2)).toBe("0.00");
    expect(roundDecimal("12.5", 0)).toBe("13");
  });
  it("keeps precision beyond Number range", () => {
    expect(roundDecimal("123456789012345678901234.565", 2)).toBe("123456789012345678901234.57");
  });
  it("rejects malformed input", () => {
    expect(() => roundDecimal("1e5", 2)).toThrow();
    expect(() => roundDecimal("abc", 2)).toThrow();
  });
});

describe("formatFiat", () => {
  it("groups and prefixes the symbol", () => {
    expect(formatFiat("1234567.891", "USD")).toBe("$1,234,567.89");
    expect(formatFiat("0", "EUR")).toBe("€0.00");
    expect(formatFiat("-12.5", "USD")).toBe("−$12.50");
    expect(formatFiat("12.5", "USD", { showPlus: true })).toBe("+$12.50");
    expect(formatFiat("0", "USD", { showPlus: true })).toBe("$0.00");
  });
  it("suffixes currencies without a prefix symbol", () => {
    expect(formatFiat("1000", "CHF")).toBe("1,000.00 CHF");
    expect(formatFiat("1000.4", "JPY")).toBe("¥1,000");
    expect(formatFiat("5", "XYZ")).toBe("5.00 XYZ");
  });
  it("formats cents", () => {
    expect(formatFiatMinor("123456", "USD")).toBe("$1,234.56");
    expect(formatFiatMinor("5", "USD")).toBe("$0.05");
  });
});

describe("formatTokenAmount", () => {
  it("truncates toward zero and groups", () => {
    expect(formatTokenAmount("1234567891234", 9, { symbol: "SOL" })).toBe("1,234.567891 SOL");
    expect(formatTokenAmount("1999999", 6, { maxFractionDigits: 2 })).toBe("1.99");
    expect(formatTokenAmount("0", 18, { symbol: "ETH" })).toBe("0 ETH");
  });
  it("marks dust instead of showing zero", () => {
    expect(formatTokenAmount("1", 18, { symbol: "ETH" })).toBe("<0.000001 ETH");
  });
});

describe("addresses", () => {
  it("shortens EVM and Solana addresses", () => {
    expect(shortenAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe("0x5290…9EE7");
    expect(shortenAddress("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", 5, 5)).toBe(
      "4Nd1m…gDB4T",
    );
    expect(shortenAddress("short")).toBe("short");
  });
  it("chunks for read-aloud verification", () => {
    expect(chunkAddress("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkAddress("addr_test1vz2fxv2um", 4)).toEqual(["addr_test1", "vz2f", "xv2u", "m"]);
  });
});

describe("time", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  it("formats countdowns", () => {
    expect(formatCountdown(272_000)).toBe("4:32");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(-5)).toBe("0:00");
  });
  it("formats relative time", () => {
    expect(formatRelativeTime("2026-11-10T11:59:50.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-11-10T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-11-10T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-11-08T12:00:00.000Z", now)).toBe("2d ago");
    expect(formatRelativeTime("2026-10-31T12:00:00.000Z", now)).toBe("31 Oct 2026");
  });
  it("formats absolute times in UTC", () => {
    expect(formatDateTime("2026-10-30T14:05:00.000Z")).toBe("30 Oct 2026, 14:05 UTC");
  });
});

describe("sanitizeAmountInput", () => {
  it("accepts valid partial input", () => {
    expect(sanitizeAmountInput("", 6)).toBe("");
    expect(sanitizeAmountInput("1.", 6)).toBe("1.");
    expect(sanitizeAmountInput(".5", 6)).toBe("0.5");
    expect(sanitizeAmountInput("007", 6)).toBe("7");
    expect(sanitizeAmountInput("1,25", 6)).toBe("1.25");
  });
  it("rejects too many decimals and junk", () => {
    expect(sanitizeAmountInput("1.1234567", 6)).toBeNull();
    expect(sanitizeAmountInput("1.2.3", 6)).toBeNull();
    expect(sanitizeAmountInput("1a", 6)).toBeNull();
    expect(sanitizeAmountInput("1.5", 0)).toBeNull();
  });
});

describe("animation helpers", () => {
  it("round-trips minor units", () => {
    expect(fiatToAnimatableMinor("1234.567")).toBe(123457);
    expect(animatableMinorToFiat(123457, "USD")).toBe("$1,234.57");
    expect(animatableMinorToFiat(-3, "USD")).toBe("$0.00");
  });
  it("groups digits", () => {
    expect(groupDigits("1000000")).toBe("1,000,000");
    expect(() => groupDigits("1.5")).toThrow();
  });
});

describe("balance helpers", () => {
  it("splits fiat into main and fraction", () => {
    expect(splitFiat("$15,930.88")).toEqual({ main: "$15,930", fraction: ".88" });
    expect(splitFiat("¥1,200")).toEqual({ main: "¥1,200", fraction: "" });
    expect(splitFiat("12.00 CHF")).toEqual({ main: "12.00 CHF", fraction: "" });
  });
  it("formats exact percentages", () => {
    expect(formatPercent(82n, 10_000n)).toBe("0.82%");
    expect(formatPercent(-120n, 10_000n)).toBe("−1.20%");
    expect(formatPercent(1n, 3n)).toBe("33.33%");
    expect(formatPercent(2n, 3n)).toBe("66.67%");
    expect(formatPercent(0n, 5n)).toBe("0.00%");
    expect(formatPercent(5n, 0n)).toBeNull();
  });
});

describe("Cardano labels", () => {
  it("names families and network-specific address hints", () => {
    expect(chainFamilyLabel("cardano")).toBe("Cardano");
    expect(chainFamilyLabel("evm", "short")).toBe("EVM");
    expect(addressPlaceholder("cardano-preprod")).toBe("addr_test1…");
    expect(addressPlaceholder("cardano-mainnet")).toBe("addr1…");
    expect(addressPlaceholder("base-sepolia")).toBe("0x…");
    expect(formatTokenAmount("1500000", 6, { symbol: "ADA" })).toBe("1.5 ADA");
    expect(
      shortenAddress("addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz", 9, 6),
    ).toBe("addr_test1vz2fxv2um…pjrlsz");
    expect(shortenAddress("addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8", 4, 4)).toBe(
      "addr1vx2f…hrl8",
    );
  });
});

describe("formatUnitPrice", () => {
  it("shows cents for prices of one unit or more", () => {
    expect(formatUnitPrice("2432.05", "USD")).toBe("$2,432.05");
    expect(formatUnitPrice("2432.0549", "USD")).toBe("$2,432.05");
    expect(formatUnitPrice("187.2", "USD")).toBe("$187.20");
    expect(formatUnitPrice("1", "USD")).toBe("$1.00");
    expect(formatUnitPrice("12.5", "CHF")).toBe("12.50 CHF");
    expect(formatUnitPrice("150.4", "JPY")).toBe("¥150");
  });

  it("keeps four significant digits below one unit", () => {
    expect(formatUnitPrice("0.5", "USD")).toBe("$0.50");
    expect(formatUnitPrice("0.6612", "USD")).toBe("$0.6612");
    expect(formatUnitPrice("0.66125", "USD")).toBe("$0.6613");
    expect(formatUnitPrice("0.0000123456", "USD")).toBe("$0.00001235");
    expect(formatUnitPrice("0.99995", "USD")).toBe("$1.00");
    expect(formatUnitPrice("0.999949", "USD")).toBe("$0.9999");
    expect(formatUnitPrice("0.000000000001", "USD")).toBe("$0.00");
    expect(formatUnitPrice("0", "USD")).toBe("$0.00");
  });

  it("rejects malformed input", () => {
    expect(() => formatUnitPrice("1e-7", "USD")).toThrow();
  });
});

describe("priceChange", () => {
  it("signs and rounds the change exactly", () => {
    expect(priceChange("100", "101.29")).toEqual({
      percent: "+1.29%",
      direction: "up",
      spoken: "up 1.29%",
    });
    expect(priceChange("2450.10", "2432.05")).toEqual({
      percent: "−0.74%",
      direction: "down",
      spoken: "down 0.74%",
    });
  });

  it("calls a change that rounds to zero flat", () => {
    expect(priceChange("1.0000", "1.00001")).toEqual({
      percent: "0.00%",
      direction: "flat",
      spoken: "unchanged",
    });
    expect(priceChange("187.2", "187.20")?.direction).toBe("flat");
  });

  it("mixes precisions and needs a positive base", () => {
    expect(priceChange("0.5", "0.75")?.percent).toBe("+50.00%");
    expect(priceChange("0", "1")).toBeNull();
  });
});
