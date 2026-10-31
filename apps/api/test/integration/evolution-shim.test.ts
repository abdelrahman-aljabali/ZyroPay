/*
 * The Worker build aliases "@evolution-sdk/evolution" to src/evolution (wrangler.jsonc). Its one
 * shortcut must equal the real applyParamsToScript for the canonical Masumi deployment, and pass
 * every other input through.
 */
import { Data, UPLC } from "@evolution-sdk/evolution";
import { describe, expect, it } from "vitest";
import * as Shim from "../../src/evolution/index";
import { VESTED_PAY_V2_UNAPPLIED_HEX } from "../../src/evolution/script";

const canonicalParams = () => {
  const list = Data.fromCBORHex(Shim.CANONICAL_PARAMS_CBOR);
  if (!(list instanceof Array)) throw new Error("canonical params are not a list");
  return list;
};

describe("API Worker evolution shim", () => {
  it("returns the real applyParamsToScript result for the canonical deployment", () => {
    const real = UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, canonicalParams());
    expect(real).toBe(Shim.CANONICAL_APPLIED_CBOR);
    expect(Shim.UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, canonicalParams())).toBe(
      real,
    );
  }, 30_000);

  it("delegates every other input to the real function", () => {
    const other = [Data.int(1n), Data.list([]), Data.int(420000n)];
    expect(Shim.UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, other)).toBe(
      UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, other),
    );
  }, 30_000);
});
