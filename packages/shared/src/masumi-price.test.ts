import { describe, expect, it } from "vitest";
import {
  describeMasumiPriceAmount,
  knownMasumiUnit,
  MASUMI_TUSDM_PREPROD_UNIT,
  MASUMI_USDM_MAINNET_UNIT,
  MasumiPriceAmountSchema,
} from "./domain/masumi";

describe("Masumi price units", () => {
  it("names tUSDM on preprod and USDM on mainnet, 6 decimals, keeping the base units", () => {
    expect(
      describeMasumiPriceAmount({ unit: MASUMI_TUSDM_PREPROD_UNIT, amount: "1000000" }),
    ).toEqual({
      unit: MASUMI_TUSDM_PREPROD_UNIT,
      amount: "1000000",
      symbol: "tUSDM",
      decimals: 6,
      display: "1 tUSDM",
    });
    expect(
      describeMasumiPriceAmount({ unit: MASUMI_USDM_MAINNET_UNIT, amount: "2500001" }).display,
    ).toBe("2.500001 USDM");
  });

  it("names ADA for lovelace and the empty unit", () => {
    expect(describeMasumiPriceAmount({ unit: "lovelace", amount: "1500000" }).display).toBe(
      "1.5 ADA",
    );
    expect(knownMasumiUnit("")).toEqual({ symbol: "ADA", decimals: 6 });
  });

  it("matches the policy id exactly: a look-alike tUSDM stays base units only", () => {
    const fake = "00".repeat(28) + "0014df10745553444d";
    expect(describeMasumiPriceAmount({ unit: fake, amount: "1000000" })).toEqual({
      unit: fake,
      amount: "1000000",
    });
    expect(knownMasumiUnit("constructor")).toBeNull();
  });

  it("accepts the policy.asset dotted form and stays within the schema", () => {
    const dotted = `${MASUMI_TUSDM_PREPROD_UNIT.slice(0, 56)}.${MASUMI_TUSDM_PREPROD_UNIT.slice(56)}`;
    const described = describeMasumiPriceAmount({ unit: dotted, amount: "1000000" });
    expect(described.display).toBe("1 tUSDM");
    expect(MasumiPriceAmountSchema.parse(described)).toEqual(described);
  });
});
