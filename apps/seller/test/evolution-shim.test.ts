import { Data, UPLC } from "@evolution-sdk/evolution";
import { MASUMI_DEFAULT_DEPLOYMENT, masumiEscrowScriptHash } from "@x402/cardano";
import { describe, expect, it } from "vitest";
import * as Shim from "../src/evolution";
import { VESTED_PAY_V2_UNAPPLIED_HEX } from "../src/escrow/script";

const canonicalParams = () => [
  Data.int(BigInt(MASUMI_DEFAULT_DEPLOYMENT.requiredAdmins)),
  Data.list(MASUMI_DEFAULT_DEPLOYMENT.adminVkeys.map((v) => Data.bytearray(v))),
  Data.int(BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod)),
];

describe("src/evolution.ts (the Worker build's @evolution-sdk/evolution)", () => {
  it("precomputes exactly what applyParamsToScript returns for the canonical deployment", () => {
    expect(Data.toCBORHex(Data.list(canonicalParams()))).toBe(Shim.CANONICAL_PARAMS_CBOR);
    expect(UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, canonicalParams())).toBe(
      Shim.CANONICAL_APPLIED_CBOR,
    );
    expect(Shim.UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, canonicalParams())).toBe(
      Shim.CANONICAL_APPLIED_CBOR,
    );
  });

  it("holds the unapplied script @x402/cardano applies (its script hash matches)", () => {
    // masumiEscrowScriptHash runs the real (slow) application on @x402/cardano's own copy.
    const script = new Shim.PlutusV3.PlutusV3({
      bytes: Shim.Bytes.fromHex(Shim.CANONICAL_APPLIED_CBOR.slice(6)),
    });
    expect(Shim.ScriptHash.toHex(Shim.ScriptHash.fromScript(script))).toBe(
      masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT),
    );
  });

  it("delegates every other input to the real function", () => {
    const other = [Data.int(1n), Data.list([]), Data.int(420000n)];
    expect(Shim.UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, other)).toBe(
      UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, other),
    );
    expect(Shim.UPLC.applyParamsToScript(VESTED_PAY_V2_UNAPPLIED_HEX, other)).not.toBe(
      Shim.CANONICAL_APPLIED_CBOR,
    );
    // The real applyParamsToScript runs twice here (~3 s each, slower under a parallel run).
  }, 30_000);

  it("re-exports the rest of the package unchanged", () => {
    expect(Shim.Data).toBe(Data);
    expect(Shim.UPLC.applyDoubleCborEncoding).toBe(UPLC.applyDoubleCborEncoding);
  });
});
