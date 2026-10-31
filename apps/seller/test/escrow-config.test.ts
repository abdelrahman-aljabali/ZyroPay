import { describe, expect, it } from "vitest";
import { loadEscrowConfig } from "../src/escrow/config";

describe("escrow config", () => {
  it("defaults: 5 tADA, payBy +5 min, submit +10, unlock +15, dispute +15, auto refunds", () => {
    const r = loadEscrowConfig({});
    expect(r).toEqual({
      ok: true,
      config: {
        priceLovelace: "5000000",
        maxTimeoutSeconds: 300,
        submitAfterPayByMs: 600_000,
        unlockAfterSubmitMs: 900_000,
        disputeAfterUnlockMs: 900_000,
        autoAuthorizeRefunds: true,
        scanPages: 3,
        agentIdentifier: null,
      },
    });
  });

  it("MASUMI_AGENT_IDENTIFIER: a V2 registry identifier, or nothing claimed", () => {
    const id = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"10".padEnd(64, "a")}`;
    const ok = loadEscrowConfig({ MASUMI_AGENT_IDENTIFIER: ` ${id} ` });
    expect(ok.ok && ok.config.agentIdentifier).toBe(id);
    expect(loadEscrowConfig({ MASUMI_AGENT_IDENTIFIER: "" })).toMatchObject({
      ok: true,
      config: { agentIdentifier: null },
    });
    for (const bad of [id.toUpperCase(), id.slice(0, 118), `${"ab".repeat(28)}${id.slice(56)}`]) {
      const r = loadEscrowConfig({ MASUMI_AGENT_IDENTIFIER: bad });
      expect(r.ok ? "" : r.problems.join(" ")).toContain("MASUMI_AGENT_IDENTIFIER");
    }
  });

  it("enforces @x402/cardano's deadline rules and the collateral-free price", () => {
    const problems = (env: Record<string, string>) => {
      const r = loadEscrowConfig(env);
      return r.ok ? [] : r.problems.join(" | ");
    };
    expect(problems({ ESCROW_PRICE_LOVELACE: "3999999" })).toContain("ESCROW_PRICE_LOVELACE");
    expect(problems({ ESCROW_SUBMIT_AFTER_PAYBY_MIN: "4" })).toContain(
      "ESCROW_SUBMIT_AFTER_PAYBY_MIN",
    );
    expect(problems({ ESCROW_UNLOCK_AFTER_SUBMIT_MIN: "14" })).toContain(
      "ESCROW_UNLOCK_AFTER_SUBMIT_MIN",
    );
    expect(problems({ ESCROW_DISPUTE_AFTER_UNLOCK_MIN: "10" })).toContain(
      "ESCROW_DISPUTE_AFTER_UNLOCK_MIN",
    );
    // submitResultTime must be >= 15 min after the 402 (issuer rule).
    expect(
      problems({ ESCROW_MAX_TIMEOUT_SECONDS: "60", ESCROW_SUBMIT_AFTER_PAYBY_MIN: "5" }),
    ).toContain(">= 15 min");
    expect(problems({ AUTO_AUTHORIZE_REFUNDS: "yes" })).toContain("AUTO_AUTHORIZE_REFUNDS");
    expect(loadEscrowConfig({ AUTO_AUTHORIZE_REFUNDS: "false" })).toMatchObject({
      ok: true,
      config: { autoAuthorizeRefunds: false },
    });
    expect(problems({ ESCROW_SCAN_PAGES: "0" })).toContain("ESCROW_SCAN_PAGES");
  });
});
