import { describe, expect, it } from "vitest";
import {
  addBaseUnits,
  BaseUnitAmountSchema,
  compareBaseUnits,
  compareTokenAmounts,
  decimalToMinorUnits,
  formatBaseUnits,
  isZeroAmount,
  minorUnitsToDecimal,
  MoneyError,
  parseBaseUnits,
  subtractBaseUnits,
  toBaseUnits,
  valueInUsdMinor,
} from "./money";

describe("BaseUnitAmountSchema", () => {
  it.each([
    "0",
    "1",
    "1000000000",
    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  ])("accepts %s", (v) => expect(BaseUnitAmountSchema.safeParse(v).success).toBe(true));
  it.each(["", "-1", "01", "1.0", "1e9", " 1", "0x10", "1".repeat(79)])("rejects %j", (v) =>
    expect(BaseUnitAmountSchema.safeParse(v).success).toBe(false),
  );
  it("rejects numbers", () => expect(BaseUnitAmountSchema.safeParse(1).success).toBe(false));
});

describe("toBaseUnits", () => {
  it("converts human amounts exactly", () => {
    expect(toBaseUnits("1.5", 9)).toBe("1500000000");
    expect(toBaseUnits("0.000000001", 9)).toBe("1");
    expect(toBaseUnits("123", 6)).toBe("123000000");
    expect(toBaseUnits("0", 18)).toBe("0");
    expect(toBaseUnits("1.10", 1)).toBe("11"); // trailing zeros are not precision
    expect(toBaseUnits("7", 0)).toBe("7");
  });
  it("handles values far beyond float precision", () => {
    expect(toBaseUnits("123456789012345678.123456789012345678", 18)).toBe(
      "123456789012345678123456789012345678",
    );
  });
  it("refuses to round silently", () => {
    expect(() => toBaseUnits("0.0000000001", 9)).toThrow(MoneyError);
    expect(() => toBaseUnits("1.5", 0)).toThrow(MoneyError);
  });
  it.each(["-1", "1e3", "abc", "", ".5", "1.", "+1", "1,5"])("rejects %j", (v) =>
    expect(() => toBaseUnits(v, 9)).toThrow(MoneyError),
  );
  it("rejects invalid decimals", () => {
    expect(() => toBaseUnits("1", -1)).toThrow(MoneyError);
    expect(() => toBaseUnits("1", 1.5)).toThrow(MoneyError);
  });
});

describe("formatBaseUnits", () => {
  it("formats without floats", () => {
    expect(formatBaseUnits("1500000000", 9)).toBe("1.5");
    expect(formatBaseUnits("1", 18)).toBe("0.000000000000000001");
    expect(formatBaseUnits("0", 6)).toBe("0");
    expect(formatBaseUnits(123n, 0)).toBe("123");
    expect(formatBaseUnits("1000000", 6, { trimTrailingZeros: false })).toBe("1.000000");
  });
  it("truncates toward zero with maxFractionDigits", () => {
    expect(formatBaseUnits("1999999", 6, { maxFractionDigits: 2 })).toBe("1.99");
    expect(formatBaseUnits("1999999", 6, { maxFractionDigits: 0 })).toBe("1");
  });
  it("round-trips with toBaseUnits", () => {
    for (const v of ["0.1", "12.345678", "999999999.999999999", "1"]) {
      expect(formatBaseUnits(toBaseUnits(v, 9), 9)).toBe(v);
    }
  });
  it("rejects negative bigint", () => expect(() => formatBaseUnits(-1n, 2)).toThrow(MoneyError));
});

describe("arithmetic and comparison", () => {
  it("compares as integers, not strings", () => {
    expect(compareBaseUnits("9", "10")).toBe(-1);
    expect(compareBaseUnits("10", "10")).toBe(0);
    expect(compareBaseUnits("100000000000000000000001", "100000000000000000000000")).toBe(1);
  });
  it("adds and subtracts", () => {
    expect(addBaseUnits("1", "2", "3")).toBe("6");
    expect(addBaseUnits()).toBe("0");
    expect(subtractBaseUnits("10", "3")).toBe("7");
    expect(() => subtractBaseUnits("3", "10")).toThrow(MoneyError);
  });
  it("detects zero", () => {
    expect(isZeroAmount("0")).toBe(true);
    expect(isZeroAmount("1")).toBe(false);
  });
  it("refuses to compare different decimals", () => {
    expect(() =>
      compareTokenAmounts({ amount: "1", decimals: 6 }, { amount: "1", decimals: 9 }),
    ).toThrow(MoneyError);
    expect(compareTokenAmounts({ amount: "2", decimals: 6 }, { amount: "1", decimals: 6 })).toBe(1);
  });
  it("parseBaseUnits validates", () => {
    expect(parseBaseUnits("42")).toBe(42n);
    expect(() => parseBaseUnits("4.2")).toThrow(MoneyError);
  });
});

describe("fiat and valuation", () => {
  it("converts decimals to minor units with explicit rounding", () => {
    expect(decimalToMinorUnits("12.34", "floor")).toBe(1234n);
    expect(decimalToMinorUnits("12.345", "floor")).toBe(1234n);
    expect(decimalToMinorUnits("12.345", "ceil")).toBe(1235n);
    expect(decimalToMinorUnits("12", "ceil")).toBe(1200n);
    expect(decimalToMinorUnits("0.001", "ceil")).toBe(1n);
    expect(() => decimalToMinorUnits("-1", "ceil")).toThrow(MoneyError);
  });
  it("formats minor units", () => {
    expect(minorUnitsToDecimal("1234")).toBe("12.34");
    expect(minorUnitsToDecimal(5n)).toBe("0.05");
  });
  it("values token amounts in USD cents, rounding up", () => {
    // 1.5 SOL at $150.25 = $225.375 -> 22538 cents (ceil)
    expect(valueInUsdMinor({ amount: "1500000000", decimals: 9 }, "150.25")).toBe("22538");
    // 10 USDC at $1 = 1000 cents exactly
    expect(valueInUsdMinor({ amount: "10000000", decimals: 6 }, "1")).toBe("1000");
    // 1 wei at $3000 is a fraction of a cent -> 1 cent (never 0 for a non-zero value)
    expect(valueInUsdMinor({ amount: "1", decimals: 18 }, "3000")).toBe("1");
    expect(valueInUsdMinor({ amount: "0", decimals: 18 }, "3000")).toBe("0");
  });
});
