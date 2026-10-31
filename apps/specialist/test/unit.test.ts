import { describe, expect, it } from "vitest";
import { checkUnit } from "../src/unit";
import { POLICY, UNIT } from "./support";

describe("checkUnit", () => {
  it("accepts a policy id or an asset unit (case-insensitive)", () => {
    expect(checkUnit(POLICY)).toEqual({ ok: true, query: { kind: "policy", policyId: POLICY } });
    expect(checkUnit(UNIT.toUpperCase())).toEqual({
      ok: true,
      query: { kind: "asset", unit: UNIT, policyId: POLICY, assetNameHex: "74657374746f6b656e" },
    });
    expect(checkUnit(`${POLICY}${"ab".repeat(32)}`).ok).toBe(true);
  });

  it("refuses everything else", () => {
    for (const bad of [
      undefined,
      "",
      "lovelace",
      "zz".repeat(28),
      POLICY.slice(2),
      `${POLICY}a`,
      `${POLICY}${"ab".repeat(33)}`,
    ])
      expect(checkUnit(bad).ok).toBe(false);
  });
});
