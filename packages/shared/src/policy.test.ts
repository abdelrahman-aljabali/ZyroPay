import { describe, expect, it } from "vitest";
import type { AgentPolicy } from "./domain/agents";
import { AgentPolicySchema, defaultAgentPolicy } from "./domain/agents";
import type { PolicyReasonCode, PolicyRequest, SpentWindows } from "./policy";
import { evaluatePolicy } from "./policy";

const WALLET = "0199f3a0-0000-7000-8000-000000000001";
const OTHER_WALLET = "0199f3a0-0000-7000-8000-000000000002";
const RECIPIENT = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const NOW = new Date("2026-10-30T12:00:00.000Z");
const ctx = { now: NOW };

const NOTHING_SPENT: SpentWindows = {
  daily: { spentUsdMinor: "0", reservedUsdMinor: "0" },
  monthly: { spentUsdMinor: "0", reservedUsdMinor: "0" },
};

function spent(daily: [string, string], monthly: [string, string] = daily): SpentWindows {
  return {
    daily: { spentUsdMinor: daily[0], reservedUsdMinor: daily[1] },
    monthly: { spentUsdMinor: monthly[0], reservedUsdMinor: monthly[1] },
  };
}

/** Autonomous, $50/tx, $100/day, $500/month, one allowlisted recipient. */
function autonomous(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    ...defaultAgentPolicy(),
    mode: "autonomous",
    spendingEnabled: true,
    allowedWalletIds: [WALLET],
    allowedNetworks: ["base-sepolia"],
    recipientAllowlist: [{ family: "evm", address: RECIPIENT, label: "Bob" }],
    allowedProtocols: ["x402", "jupiter"],
    limits: { perTransactionUsdMinor: "5000", dailyUsdMinor: "10000", monthlyUsdMinor: "50000" },
    ...overrides,
  };
}

const send: PolicyRequest = {
  tool: "send",
  walletId: WALLET,
  network: "base-sepolia",
  recipient: RECIPIENT,
  protocol: null,
};

const codes = (r: { reasons: { code: PolicyReasonCode }[] }) => r.reasons.map((x) => x.code);

describe("default policy", () => {
  it("is valid, always_ask, spending disabled, zero limits", () => {
    const p = defaultAgentPolicy();
    expect(AgentPolicySchema.parse(p)).toEqual(p);
    expect(p.mode).toBe("always_ask");
    expect(p.spendingEnabled).toBe(false);
    expect(p.limits).toEqual({
      perTransactionUsdMinor: "0",
      dailyUsdMinor: "0",
      monthlyUsdMinor: "0",
    });
  });
  it("denies a send from a fresh agent", () => {
    const r = evaluatePolicy(defaultAgentPolicy(), send, "100", NOTHING_SPENT, ctx);
    expect(r.decision).toBe("deny");
    expect(codes(r)).toEqual(
      expect.arrayContaining(["WALLET_NOT_ALLOWED", "NETWORK_NOT_ALLOWED", "SPENDING_DISABLED"]),
    );
  });
});

describe("deny rules", () => {
  it.each<[string, Partial<AgentPolicy>, PolicyReasonCode]>([
    ["revoked", { revoked: true }, "AGENT_REVOKED"],
    ["expired session", { sessionExpiresAt: "2026-10-30T11:59:59.000Z" }, "SESSION_EXPIRED"],
    ["session expiring exactly now", { sessionExpiresAt: NOW.toISOString() }, "SESSION_EXPIRED"],
    ["tool not allowed", { allowedTools: ["get_balance"] }, "TOOL_NOT_ALLOWED"],
    ["wallet not allowed", { allowedWalletIds: [OTHER_WALLET] }, "WALLET_NOT_ALLOWED"],
    ["network not allowed", { allowedNetworks: ["base-mainnet"] }, "NETWORK_NOT_ALLOWED"],
    ["spending disabled", { spendingEnabled: false }, "SPENDING_DISABLED"],
    ["recipient not allowlisted", { recipientAllowlist: [] }, "RECIPIENT_NOT_ALLOWED"],
  ])("%s => deny", (_, overrides, code) => {
    const r = evaluatePolicy(autonomous(overrides), send, "100", NOTHING_SPENT, ctx);
    expect(r.decision).toBe("deny");
    expect(codes(r)).toContain(code);
  });

  it("deny wins over always_ask", () => {
    const r = evaluatePolicy(
      autonomous({ mode: "always_ask", revoked: true }),
      send,
      "1",
      NOTHING_SPENT,
      ctx,
    );
    expect(r.decision).toBe("deny");
  });

  it("reports every deny reason, not just the first", () => {
    const r = evaluatePolicy(
      autonomous({ revoked: true, allowedNetworks: [], spendingEnabled: false }),
      send,
      "1",
      NOTHING_SPENT,
      ctx,
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(["AGENT_REVOKED", "NETWORK_NOT_ALLOWED", "SPENDING_DISABLED"]),
    );
  });

  it("future session expiry is fine", () => {
    const r = evaluatePolicy(
      autonomous({ sessionExpiresAt: "2026-10-31T00:00:00.000Z" }),
      send,
      "100",
      NOTHING_SPENT,
      ctx,
    );
    expect(r.decision).toBe("allow");
  });

  it("allowlist match is case-insensitive for EVM", () => {
    const r = evaluatePolicy(
      autonomous(),
      { ...send, recipient: RECIPIENT.toLowerCase() },
      "100",
      NOTHING_SPENT,
      ctx,
    );
    expect(r.decision).toBe("allow");
  });

  it("allowlist entry of another family never matches", () => {
    const r = evaluatePolicy(
      autonomous({ recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }] }),
      send,
      "100",
      NOTHING_SPENT,
      ctx,
    );
    expect(codes(r)).toContain("RECIPIENT_NOT_ALLOWED");
  });

  it("unrestricted recipients allow any address", () => {
    const r = evaluatePolicy(
      autonomous({ restrictRecipients: false, recipientAllowlist: [] }),
      { ...send, recipient: "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb" },
      "100",
      NOTHING_SPENT,
      ctx,
    );
    expect(r.decision).toBe("allow");
  });

  it("send without recipient is denied", () => {
    const r = evaluatePolicy(autonomous(), { ...send, recipient: null }, "100", NOTHING_SPENT, ctx);
    expect(codes(r)).toContain("RECIPIENT_REQUIRED");
  });
});

describe("protocols", () => {
  const swap: PolicyRequest = { ...send, tool: "swap", recipient: null, protocol: "jupiter" };
  const x402: PolicyRequest = { ...send, tool: "pay_x402", protocol: "x402" };

  it("allows an allowed protocol", () => {
    expect(evaluatePolicy(autonomous(), x402, "100", NOTHING_SPENT, ctx).decision).toBe("allow");
  });
  it("swaps are never autonomous, even within limits", () => {
    const r = evaluatePolicy(autonomous(), swap, "100", NOTHING_SPENT, ctx);
    expect(r.decision).toBe("require_approval");
    expect(codes(r)).toEqual(["AUTONOMY_NOT_SUPPORTED"]);
  });
  it("denies a protocol not in allowedProtocols", () => {
    const r = evaluatePolicy(
      autonomous({ allowedProtocols: ["x402"] }),
      swap,
      "100",
      NOTHING_SPENT,
      ctx,
    );
    expect(codes(r)).toContain("PROTOCOL_NOT_ALLOWED");
  });
  it("swap requires a protocol", () => {
    const r = evaluatePolicy(autonomous(), { ...swap, protocol: null }, "100", NOTHING_SPENT, ctx);
    expect(codes(r)).toContain("PROTOCOL_REQUIRED");
  });
  it("pay_x402 must route through x402", () => {
    const r = evaluatePolicy(
      autonomous(),
      { ...x402, protocol: "jupiter" },
      "100",
      NOTHING_SPENT,
      ctx,
    );
    expect(codes(r)).toContain("PROTOCOL_NOT_ALLOWED");
  });
});

describe("read-only tools", () => {
  const read: PolicyRequest = { ...send, tool: "get_balance", recipient: null };
  it("are allowed even in always_ask with spending disabled", () => {
    const p = autonomous({ mode: "always_ask", spendingEnabled: false });
    expect(evaluatePolicy(p, read, null, NOTHING_SPENT, ctx)).toEqual({
      decision: "allow",
      reasons: [],
      policyVersion: 1,
    });
  });
  it("are still denied when revoked or out of scope", () => {
    expect(
      evaluatePolicy(autonomous({ revoked: true }), read, null, NOTHING_SPENT, ctx).decision,
    ).toBe("deny");
    expect(
      evaluatePolicy(autonomous({ allowedWalletIds: [] }), read, null, NOTHING_SPENT, ctx).decision,
    ).toBe("deny");
  });
});

describe("always_ask", () => {
  it("requires approval even within limits", () => {
    const r = evaluatePolicy(autonomous({ mode: "always_ask" }), send, "100", NOTHING_SPENT, ctx);
    expect(r.decision).toBe("require_approval");
    expect(codes(r)).toEqual(["ALWAYS_ASK"]);
  });
});

describe("limits (autonomous)", () => {
  it("allows within all limits", () => {
    expect(evaluatePolicy(autonomous(), send, "5000", NOTHING_SPENT, ctx).decision).toBe("allow");
  });
  it("per-transaction limit is inclusive", () => {
    expect(evaluatePolicy(autonomous(), send, "5000", NOTHING_SPENT, ctx).decision).toBe("allow");
    const r = evaluatePolicy(autonomous(), send, "5001", NOTHING_SPENT, ctx);
    expect(r.decision).toBe("require_approval");
    expect(codes(r)).toEqual(["PER_TRANSACTION_LIMIT_EXCEEDED"]);
  });
  it("daily limit counts spent", () => {
    expect(evaluatePolicy(autonomous(), send, "1000", spent(["9000", "0"]), ctx).decision).toBe(
      "allow",
    );
    const r = evaluatePolicy(autonomous(), send, "1001", spent(["9000", "0"]), ctx);
    expect(codes(r)).toEqual(["DAILY_LIMIT_EXCEEDED"]);
  });
  it("daily limit counts reservations of concurrent in-flight requests", () => {
    // Nothing settled yet, but two concurrent $45 requests already hold reservations.
    const r = evaluatePolicy(autonomous(), send, "1001", spent(["0", "9000"]), ctx);
    expect(r.decision).toBe("require_approval");
    expect(codes(r)).toContain("DAILY_LIMIT_EXCEEDED");
  });
  it("spent + reserved are summed (neither alone exceeds)", () => {
    const r = evaluatePolicy(
      autonomous(),
      send,
      "2000",
      spent(["4500", "4500"], ["4500", "4500"]),
      ctx,
    );
    expect(codes(r)).toEqual(["DAILY_LIMIT_EXCEEDED"]);
  });
  it("sequentially reserving drains the window: the request that would cross is caught", () => {
    let reserved = 0n;
    const decisions: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = evaluatePolicy(autonomous(), send, "3000", spent(["0", reserved.toString()]), ctx);
      decisions.push(r.decision);
      if (r.decision === "allow") reserved += 3000n;
    }
    expect(decisions).toEqual(["allow", "allow", "allow", "require_approval"]);
  });
  it("monthly limit", () => {
    const r = evaluatePolicy(autonomous(), send, "100", spent(["0", "0"], ["49000", "1000"]), ctx);
    expect(codes(r)).toEqual(["MONTHLY_LIMIT_EXCEEDED"]);
  });
  it("reports all exceeded limits", () => {
    const r = evaluatePolicy(autonomous(), send, "60000", NOTHING_SPENT, ctx);
    expect(codes(r)).toEqual([
      "PER_TRANSACTION_LIMIT_EXCEEDED",
      "DAILY_LIMIT_EXCEEDED",
      "MONTHLY_LIMIT_EXCEEDED",
    ]);
  });
  it("zero limits mean no autonomous spending", () => {
    const p = autonomous({
      limits: { perTransactionUsdMinor: "0", dailyUsdMinor: "0", monthlyUsdMinor: "0" },
    });
    expect(evaluatePolicy(p, send, "1", NOTHING_SPENT, ctx).decision).toBe("require_approval");
  });
  it("overLimitBehavior=deny turns limits into hard caps", () => {
    const p = autonomous({ overLimitBehavior: "deny" });
    expect(evaluatePolicy(p, send, "5001", NOTHING_SPENT, ctx).decision).toBe("deny");
    expect(
      evaluatePolicy({ ...p, mode: "always_ask" }, send, "5001", NOTHING_SPENT, ctx).decision,
    ).toBe("deny");
    expect(evaluatePolicy(p, send, "5000", NOTHING_SPENT, ctx).decision).toBe("allow");
  });
  it("always_ask also reports exceeded limits", () => {
    const r = evaluatePolicy(autonomous({ mode: "always_ask" }), send, "5001", NOTHING_SPENT, ctx);
    expect(codes(r)).toEqual(["PER_TRANSACTION_LIMIT_EXCEEDED", "ALWAYS_ASK"]);
  });
});

describe("fail closed", () => {
  it("missing valuation never auto-allows", () => {
    const r = evaluatePolicy(autonomous(), send, null, NOTHING_SPENT, ctx);
    expect(r.decision).toBe("require_approval");
    expect(codes(r)).toEqual(["VALUATION_UNAVAILABLE"]);
  });
  it("missing valuation with hard caps denies", () => {
    expect(
      evaluatePolicy(autonomous({ overLimitBehavior: "deny" }), send, null, NOTHING_SPENT, ctx)
        .decision,
    ).toBe("deny");
  });
  it("malformed amounts throw (callers treat as deny)", () => {
    expect(() => evaluatePolicy(autonomous(), send, "1.5", NOTHING_SPENT, ctx)).toThrow();
    expect(() => evaluatePolicy(autonomous(), send, "1", spent(["-1", "0"]), ctx)).toThrow();
  });
  it("reports the evaluated policy version", () => {
    expect(
      evaluatePolicy(autonomous({ version: 7 }), send, "1", NOTHING_SPENT, ctx).policyVersion,
    ).toBe(7);
  });
});

describe("x402 escrow rule (x402EscrowAboveUsdMinor)", () => {
  const pay: PolicyRequest = { ...send, tool: "pay_x402", protocol: "x402" };
  const escrowed: PolicyRequest = { ...pay, x402Escrow: true };

  it("is off by default (null or absent)", () => {
    expect(evaluatePolicy(autonomous(), pay, "1000", NOTHING_SPENT, ctx).decision).toBe("allow");
    const { x402EscrowAboveUsdMinor: _, ...absent } = autonomous();
    expect(evaluatePolicy(absent, pay, "1000", NOTHING_SPENT, ctx).decision).toBe("allow");
  });

  it("asks the user for a direct payment above the threshold, allows an escrowed one", () => {
    const p = autonomous({ x402EscrowAboveUsdMinor: "500" });
    const direct = evaluatePolicy(p, pay, "1000", NOTHING_SPENT, ctx);
    expect(direct.decision).toBe("require_approval");
    expect(codes(direct)).toEqual(["ESCROW_REQUIRED"]);
    expect(evaluatePolicy(p, escrowed, "1000", NOTHING_SPENT, ctx).decision).toBe("allow");
    // At or below the threshold a direct payment is fine.
    expect(evaluatePolicy(p, pay, "500", NOTHING_SPENT, ctx).decision).toBe("allow");
  });

  it("denies with overLimitBehavior deny, and treats an unvalued payment as above", () => {
    const p = autonomous({ x402EscrowAboveUsdMinor: "500", overLimitBehavior: "deny" });
    const direct = evaluatePolicy(p, pay, "1000", NOTHING_SPENT, ctx);
    expect(direct.decision).toBe("deny");
    expect(codes(direct)).toContain("ESCROW_REQUIRED");
    const unvalued = evaluatePolicy(
      autonomous({ x402EscrowAboveUsdMinor: "500" }),
      pay,
      null,
      NOTHING_SPENT,
      ctx,
    );
    expect(codes(unvalued)).toContain("ESCROW_REQUIRED");
    expect(codes(unvalued)).toContain("VALUATION_UNAVAILABLE");
  });

  it("never applies to other tools", () => {
    const p = autonomous({ x402EscrowAboveUsdMinor: "0" });
    expect(evaluatePolicy(p, send, "1000", NOTHING_SPENT, ctx).decision).toBe("allow");
  });

  it("round-trips through the schema", () => {
    const p = autonomous({ x402EscrowAboveUsdMinor: "2500" });
    expect(AgentPolicySchema.parse(p).x402EscrowAboveUsdMinor).toBe("2500");
    expect(AgentPolicySchema.safeParse({ ...p, x402EscrowAboveUsdMinor: "-1" }).success).toBe(
      false,
    );
  });
});

describe("registered Masumi agents only (requireRegisteredAgent)", () => {
  const AGENT = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10${"5a".repeat(28)}000000`;
  const OTHER = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10${"6b".repeat(28)}000000`;
  const pay: PolicyRequest = { ...send, tool: "pay_x402", protocol: "x402", x402Escrow: true };
  const registered: PolicyRequest = { ...pay, x402RegisteredAgent: { agentIdentifier: AGENT } };

  it("is off by default (false or absent): unregistered sellers can be paid", () => {
    expect(evaluatePolicy(autonomous(), pay, "100", NOTHING_SPENT, ctx).decision).toBe("allow");
    const { requireRegisteredAgent: _, ...absent } = autonomous();
    expect(evaluatePolicy(absent, pay, "100", NOTHING_SPENT, ctx).decision).toBe("allow");
  });

  it("denies a seller without a verified registry identity, in any mode", () => {
    for (const mode of ["autonomous", "always_ask"] as const) {
      const p = autonomous({ mode, requireRegisteredAgent: true });
      const r = evaluatePolicy(p, pay, "100", NOTHING_SPENT, ctx);
      expect(r.decision).toBe("deny");
      expect(codes(r)).toEqual(["AGENT_NOT_REGISTERED"]);
      expect(
        codes(evaluatePolicy(p, { ...pay, x402RegisteredAgent: null }, "100", NOTHING_SPENT, ctx)),
      ).toEqual(["AGENT_NOT_REGISTERED"]);
    }
    const p = autonomous({ requireRegisteredAgent: true });
    expect(evaluatePolicy(p, registered, "100", NOTHING_SPENT, ctx).decision).toBe("allow");
  });

  it("narrows to trustedAgentIdentifiers when set; the list alone does nothing", () => {
    const p = autonomous({ requireRegisteredAgent: true, trustedAgentIdentifiers: [OTHER] });
    const r = evaluatePolicy(p, registered, "100", NOTHING_SPENT, ctx);
    expect(r.decision).toBe("deny");
    expect(codes(r)).toEqual(["AGENT_NOT_TRUSTED"]);
    expect(
      evaluatePolicy(
        autonomous({ requireRegisteredAgent: true, trustedAgentIdentifiers: [AGENT, OTHER] }),
        registered,
        "100",
        NOTHING_SPENT,
        ctx,
      ).decision,
    ).toBe("allow");
    expect(
      evaluatePolicy(
        autonomous({ trustedAgentIdentifiers: [OTHER] }),
        pay,
        "100",
        NOTHING_SPENT,
        ctx,
      ).decision,
    ).toBe("allow");
  });

  it("never applies to other tools", () => {
    const p = autonomous({ requireRegisteredAgent: true });
    expect(evaluatePolicy(p, send, "100", NOTHING_SPENT, ctx).decision).toBe("allow");
  });

  it("validates the fields", () => {
    const p = autonomous({ requireRegisteredAgent: true, trustedAgentIdentifiers: [AGENT] });
    expect(AgentPolicySchema.parse(p).trustedAgentIdentifiers).toEqual([AGENT]);
    expect(AgentPolicySchema.safeParse({ ...p, trustedAgentIdentifiers: ["nope"] }).success).toBe(
      false,
    );
    expect(
      AgentPolicySchema.safeParse({
        ...p,
        trustedAgentIdentifiers: Array.from({ length: 51 }, () => AGENT),
      }).success,
    ).toBe(false);
  });
});
