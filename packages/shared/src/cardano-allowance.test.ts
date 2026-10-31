import { describe, expect, it } from "vitest";
import {
  allowancePeriodAt,
  allowanceScriptAddress,
  allowanceScriptHash,
  encodeAllowanceDatumHex,
  evaluateAutoPay,
} from "./cardano-allowance";
import type { AutoPayAllowance, AutoPayRequest } from "./cardano-allowance";
import { cardanoPaymentKeyHash } from "./cardano";
import type { PolicyEvaluation } from "./policy";

// The live preprod deployment (contracts/allowance/deployments/preprod.json).
const OWNER = "addr_test1vp728c73kcswazpl89vv44phxrglcksh9fwllqs2hkvr22sg399v3";
const SELLER =
  "addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen";
const DATUM = {
  agentKeyHash: "f9e4ed0cab084026548aeb365ae827c777957f718e533032382791dc",
  perPaymentMax: "3000000",
  periodMs: "86400000",
  periodCap: "5000000",
  periodStart: "1793403356000",
  spentInPeriod: "0",
  allowedPayees: [
    { kind: "key" as const, hash: "cb4ab9d1fbcf9133c8058f66b7f8b741c0e549b3350bf35fcce3ec4e" },
  ],
  expiresAt: "1794008156000",
};

describe("allowance script (device derivation)", () => {
  it("derives the live preprod script hash and address from the owner's key hash", () => {
    const kh = cardanoPaymentKeyHash(OWNER) ?? "";
    expect(allowanceScriptHash(kh)).toBe(
      "2e6f46a3598b59a61bb66fc66360e8104b159d494de56bddaeb9a037",
    );
    expect(allowanceScriptAddress("cardano-preprod", kh)).toBe(
      "addr_test1wqhx734rtx94nfsmkehuvcmqaqgyk9vaf9x7267a46u6qdcw7x4js",
    );
  });

  it("encodes the datum as Plutus constr 0 with 8 fields", () => {
    const hex = encodeAllowanceDatumHex(DATUM);
    expect(hex.startsWith("d8799f") || hex.startsWith("d87988")).toBe(true);
    expect(hex).toContain(DATUM.agentKeyHash);
    expect(() => encodeAllowanceDatumHex({ ...DATUM, perPaymentMax: "-1" })).toThrow();
  });

  it("rolls the window over like the validator", () => {
    const start = BigInt(DATUM.periodStart);
    const d = { ...DATUM, spentInPeriod: "4000000" };
    expect(allowancePeriodAt(d, start + 1000n)).toEqual({ start, spent: 4_000_000n });
    expect(allowancePeriodAt(d, start + 86_400_000n * 2n + 5n)).toEqual({
      start: start + 86_400_000n * 2n,
      spent: 0n,
    });
  });
});

describe("evaluateAutoPay", () => {
  const NOW = BigInt(DATUM.periodStart) + 3_600_000n;
  const ask: PolicyEvaluation = {
    decision: "require_approval",
    reasons: [{ code: "ALWAYS_ASK", message: "" }],
    policyVersion: 3,
  };
  const allowance: AutoPayAllowance = {
    walletId: "w",
    network: "cardano-preprod",
    datum: DATUM,
    balanceLovelace: 20_000_000n,
    floatLovelace: 5_000_000n,
    busy: false,
  };
  const req: AutoPayRequest = {
    tool: "pay_x402",
    network: "cardano-preprod",
    walletId: "w",
    native: true,
    escrow: false,
    payee: SELLER,
    lovelace: 2_000_000n,
  };
  const code = (d: ReturnType<typeof evaluateAutoPay>) => d.evaluation.reasons.at(-1)?.code;

  it("auto-pays a covered request within every limit", () => {
    const d = evaluateAutoPay(ask, req, allowance, NOW);
    expect(d.route).toBe("allowance");
    expect(d.evaluation).toMatchObject({ decision: "allow", policyVersion: 3 });
    expect(code(d)).toBe("AUTO_PAY_ALLOWANCE");
  });

  it("never touches a deny or an allow, and keeps USD-limit approvals", () => {
    const deny: PolicyEvaluation = { ...ask, decision: "deny" };
    expect(evaluateAutoPay(deny, req, allowance, NOW)).toEqual({
      route: "policy",
      evaluation: deny,
    });
    const allow: PolicyEvaluation = { ...ask, decision: "allow", reasons: [] };
    expect(evaluateAutoPay(allow, req, allowance, NOW).evaluation).toBe(allow);
    const limit: PolicyEvaluation = {
      ...ask,
      reasons: [{ code: "DAILY_LIMIT_EXCEEDED", message: "" }],
    };
    expect(evaluateAutoPay(limit, req, allowance, NOW)).toEqual({
      route: "policy",
      evaluation: limit,
    });
    expect(evaluateAutoPay(ask, req, null, NOW)).toEqual({ route: "policy", evaluation: ask });
  });

  it.each([
    ["ALLOWANCE_LIMIT_EXCEEDED", { lovelace: 3_000_001n }, {}],
    ["ALLOWANCE_LIMIT_EXCEEDED", {}, { datum: { ...DATUM, spentInPeriod: "4000000" } }],
    ["ALLOWANCE_PAYEE_NOT_LISTED", { payee: OWNER }, {}],
    ["ALLOWANCE_INSUFFICIENT", {}, { balanceLovelace: 3_000_000n }],
    ["ALLOWANCE_INSUFFICIENT", {}, { floatLovelace: 1_000_000n }],
    ["ALLOWANCE_BUSY", {}, { busy: true }],
    ["ALLOWANCE_UNAVAILABLE", { escrow: true }, {}],
    ["ALLOWANCE_UNAVAILABLE", { native: false }, {}],
    ["ALLOWANCE_UNAVAILABLE", { walletId: "other" }, {}],
  ] as const)("falls back to the passkey with %s", (expected, r, a) => {
    const d = evaluateAutoPay(ask, { ...req, ...r }, { ...allowance, ...a }, NOW);
    expect(d.route).toBe("policy");
    expect(d.evaluation.decision).toBe("require_approval");
    expect(code(d)).toBe(expected);
  });

  it("falls back once the allowance has expired", () => {
    const d = evaluateAutoPay(ask, req, allowance, BigInt(DATUM.expiresAt) - 1000n);
    expect(code(d)).toBe("ALLOWANCE_EXPIRED");
  });

  it("allows again after the window rolls over", () => {
    const spent = { ...allowance, datum: { ...DATUM, spentInPeriod: "4000000" } };
    expect(evaluateAutoPay(ask, req, spent, NOW + 86_400_000n + 200_000n).route).toBe("allowance");
  });
});
