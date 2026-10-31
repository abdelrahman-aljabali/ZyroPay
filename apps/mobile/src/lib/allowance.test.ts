import {
  CardanoAllowanceSchema,
  type AllowanceReview,
  type CardanoAllowance,
  type CreateAllowanceBody,
} from "@zyropay/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "@/api/client";
import { ALLOWANCE_TIMING } from "@/api/mock/allowance";
import { ADDR, AGENT_CHATGPT, AGENT_CLAUDE, WALLET_MAIN } from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import {
  ada,
  allowanceActions,
  allowanceErrorMessage,
  allowanceFallback,
  allowancePollMs,
  allowanceReviewRows,
  allowanceStatusView,
  allowanceVerifiedLine,
  amountToLovelace,
  checkAllowanceDraft,
  checkAllowanceReview,
  conversionPreview,
  convertAmount,
  defaultAllowanceDraft,
  draftFromAllowance,
  explorerAddressLink,
  fiatToLovelace,
  isAutoPaid,
  isLiveAllowance,
  lovelaceToFiat,
  moneyOf,
  normalizeAmount,
  spentToday,
  suggestedPayees,
  type AllowanceDraft,
} from "./allowance";
import { policyReasonText } from "./escrow";
import { activitySubtitle } from "./agent-activity";
import { transactionKindCopy } from "./tx-kind";
import { simulatedSigner } from "./turnkey/signer";

const EUR = { value: "0.48", currency: "EUR" as const };

describe("amounts", () => {
  it("normalizes typed amounts per unit", () => {
    expect(normalizeAmount("12,50", "EUR")).toBe("12.50");
    expect(normalizeAmount(" 5 ", "ADA")).toBe("5");
    expect(normalizeAmount("1.123456", "ADA")).toBe("1.123456");
    expect(normalizeAmount("1.1234567", "ADA")).toBeNull();
    expect(normalizeAmount("1.123", "EUR")).toBeNull();
    expect(normalizeAmount("", "ADA")).toBeNull();
    expect(normalizeAmount("01", "ADA")).toBeNull();
    expect(normalizeAmount("-1", "ADA")).toBeNull();
    expect(normalizeAmount("1e3", "ADA")).toBeNull();
  });

  it("converts fiat and lovelace exactly (bigint, floor / half-up)", () => {
    expect(fiatToLovelace("10", "0.48")).toBe(20_833_333n);
    expect(fiatToLovelace("10", "0")).toBeNull();
    expect(lovelaceToFiat(50_000_000n, "0.48")).toBe("24.00");
    expect(lovelaceToFiat(1n, "0.48")).toBe("0.00");
    expect(amountToLovelace("2.5", "ADA", null)).toBe(2_500_000n);
    expect(amountToLovelace("10", "EUR", null)).toBeNull();
    expect(amountToLovelace("10", "EUR", "0.5")).toBe(20_000_000n);
  });

  it("previews the other side of the conversion", () => {
    expect(conversionPreview("10", "EUR", EUR)).toBe("≈ 20.83 ADA");
    expect(conversionPreview("50", "ADA", EUR)).toBe("≈ €24.00");
    expect(conversionPreview("10", "USD", EUR)).toBeNull(); // price in another currency
    expect(conversionPreview("10", "EUR", null)).toBeNull();
    expect(conversionPreview("abc", "EUR", EUR)).toBeNull();
  });

  it("converts the form when the unit changes", () => {
    expect(convertAmount("10", "EUR", "ADA", EUR)).toBe("20.83");
    expect(convertAmount("48", "EUR", "ADA", EUR)).toBe("100");
    expect(convertAmount("50", "ADA", "EUR", EUR)).toBe("24.00");
    expect(convertAmount("10", "EUR", "ADA", null)).toBe("10");
  });

  it("sends ADA as lovelace and fiat for conversion at creation", () => {
    expect(moneyOf("2.5", "ADA")).toEqual({ lovelace: "2500000" });
    expect(moneyOf("10", "EUR")).toEqual({ fiat: { currency: "EUR", amount: "10" } });
    expect(moneyOf("x", "EUR")).toBeNull();
    expect(ada(2_500_000n)).toBe("2.5 ADA");
  });
});

describe("the setup draft", () => {
  const base = (patch: Partial<AllowanceDraft> = {}): AllowanceDraft => ({
    ...defaultAllowanceDraft({ walletId: WALLET_MAIN, currency: "EUR", payees: [ADDR.sellerAda] }),
    ...patch,
  });
  const errors = (d: AllowanceDraft, price: string | null = "0.48") =>
    checkAllowanceDraft(d, price)
      .issues.filter((i) => i.severity === "error")
      .map((i) => i.field);

  it("defaults to €10 per payment, €20 a day, 7 days and a 5 ADA float", () => {
    const d = base();
    expect([d.unit, d.perPayment, d.perDay, d.expiresInDays, d.floatAda]).toEqual([
      "EUR",
      "10",
      "20",
      7,
      "5",
    ]);
    const check = checkAllowanceDraft(d, "0.48");
    expect(check.ok).toBe(true);
    expect(check.body).toEqual<CreateAllowanceBody>({
      walletId: WALLET_MAIN,
      network: "cardano-preprod",
      budget: { fiat: { currency: "EUR", amount: "30" } },
      perPayment: { fiat: { currency: "EUR", amount: "10" } },
      perDay: { fiat: { currency: "EUR", amount: "20" } },
      payees: { mode: "list", addresses: [ADDR.sellerAda] },
      expiresInDays: 7,
      floatLovelace: "5000000",
    });
    expect(check.lovelace.perPayment).toBe(20_833_333n);
  });

  it("needs max per payment <= max per day", () => {
    expect(errors(base({ perPayment: "25", perDay: "20" }))).toContain("perPayment");
    expect(errors(base({ perPayment: "20", perDay: "20" }))).toEqual([]);
  });

  it("needs one payment at the max to fit the budget above the 2 ADA the contract keeps", () => {
    expect(errors(base({ unit: "ADA", budget: "6", perPayment: "5", perDay: "10" }))).toContain(
      "budget",
    );
    expect(errors(base({ unit: "ADA", budget: "7", perPayment: "5", perDay: "5" }))).toEqual([]);
    expect(errors(base({ unit: "ADA", budget: "2", perPayment: "1", perDay: "1" }))).toContain(
      "budget",
    );
    // Fiat without a price: compared in the same unit.
    expect(errors(base({ budget: "5", perPayment: "10", perDay: "20" }), null)).toContain("budget");
  });

  it("calls out a budget below a day's max without blocking", () => {
    const c = checkAllowanceDraft(
      base({ unit: "ADA", budget: "20", perPayment: "5", perDay: "40" }),
      null,
    );
    expect(c.ok).toBe(true);
    expect(c.issues).toEqual([expect.objectContaining({ field: "perDay", severity: "warning" })]);
  });

  it("refuses zero, junk and sub-ADA payments", () => {
    expect(errors(base({ perPayment: "0" }))).toContain("perPayment");
    expect(errors(base({ perDay: "abc" }))).toContain("perDay");
    expect(errors(base({ unit: "ADA", perPayment: "0.5" }))).toContain("perPayment");
  });

  it("bounds the expiry to 1..90 days and the float to 3..20 ADA", () => {
    expect(errors(base({ expiresInDays: 0 }))).toContain("expiresInDays");
    expect(errors(base({ expiresInDays: 91 }))).toContain("expiresInDays");
    expect(errors(base({ expiresInDays: 1.5 }))).toContain("expiresInDays");
    expect(errors(base({ expiresInDays: 90 }))).toEqual([]);
    expect(errors(base({ floatAda: "2" }))).toContain("float");
    expect(errors(base({ floatAda: "21" }))).toContain("float");
    expect(errors(base({ floatAda: "20" }))).toEqual([]);
  });

  it("checks the payees", () => {
    expect(errors(base({ payees: [] }))).toContain("payees");
    expect(errors(base({ payees: [ADDR.sellerAda, ADDR.sellerAda] }))).toContain("payees");
    expect(errors(base({ payees: ["addr1notpreprod"] }))).toContain("payees");
    expect(errors(base({ payees: [], payeeMode: "any" }))).toEqual([]);
    expect(checkAllowanceDraft(base({ payeeMode: "any" }), null).body?.payees).toEqual({
      mode: "any",
    });
    expect(errors(base({ walletId: null }))).toContain("wallet");
  });

  it("suggests the Cardano allowlist, then direct x402 sellers on preprod", () => {
    const payload = (to: string, extra: Record<string, unknown> = {}) => ({
      payload: {
        network: "cardano-preprod",
        tool: "pay_x402",
        to,
        pluginData: { resourceUrl: "https://address-intel.zyropay.online/x", ...extra },
      },
    });
    const out = suggestedPayees(
      [
        { family: "solana", address: ADDR.solMain, label: "Sol" },
        { family: "cardano", address: ADDR.friendAda, label: "Alex" },
      ],
      [
        payload(ADDR.sellerAda),
        payload(ADDR.friendAda),
        payload(ADDR.adaMain, { escrow: {} }),
      ] as never,
    );
    expect(out).toEqual([
      { address: ADDR.friendAda, label: "Alex" },
      { address: ADDR.sellerAda, label: "x402 seller · address-intel.zyropay.online" },
    ]);
  });
});

describe("reasons and labels", () => {
  it("knows an auto-paid request and why another came to the phone", () => {
    expect(isAutoPaid({ policyReasons: [{ code: "AUTO_PAY_ALLOWANCE", message: "" }] })).toBe(true);
    expect(isAutoPaid({ policyReasons: [{ code: "ALWAYS_ASK", message: "" }] })).toBe(false);
    expect(
      allowanceFallback([
        { code: "AUTONOMY_NOT_SUPPORTED", message: "" },
        { code: "ALLOWANCE_LIMIT_EXCEEDED", message: "over" },
      ])?.title,
    ).toBe("Over your auto-pay limits");
    expect(allowanceFallback([{ code: "ALWAYS_ASK", message: "" }])).toBeNull();
    expect(policyReasonText({ code: "ALLOWANCE_BUSY", message: "still confirming" })).toBe(
      "Another auto-payment is confirming: still confirming.",
    );
  });

  it("links an address on Cardanoscan", () => {
    expect(explorerAddressLink("cardano-preprod", ADDR.sellerAda)).toBe(
      `https://preprod.cardanoscan.io/address/${ADDR.sellerAda}`,
    );
  });

  it("maps the API's errors to plain words", () => {
    expect(allowanceErrorMessage({ code: "INSUFFICIENT_FUNDS", message: "" })).toContain(
      "plain ADA",
    );
    expect(allowanceErrorMessage({ code: "NOT_FOUND", message: "" })).toBeNull();
  });
});

// --- the whole flow against the mock API, with real on-device transaction checks ----------

describe("auto-pay against the simulated API", () => {
  let now = Date.parse("2026-10-31T09:00:00.000Z");
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetMockState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const c = () =>
    new ApiClient({ transport: mockTransport({ latencyMs: 0 }), getAccessToken: () => "sim" });
  const signer = simulatedSigner();
  const sign = async (review: AllowanceReview) =>
    signer.stampSignRawPayload({
      organizationId: "simulated-suborg-0000",
      signWith: review.rawPayload.signWith,
      payload: review.rawPayload.payload,
    });
  const body = (): CreateAllowanceBody => ({
    walletId: WALLET_MAIN,
    network: "cardano-preprod",
    budget: { lovelace: "50000000" },
    perPayment: { lovelace: "5000000" },
    perDay: { lovelace: "15000000" },
    payees: { mode: "list", addresses: [ADDR.sellerAda] },
    expiresInDays: 7,
    floatLovelace: "5000000",
  });
  const params = { agentId: AGENT_CHATGPT };

  it("creates, verifies on the device, activates, auto-pays, falls back, tops up and revokes", async () => {
    const api = c();
    expect((await api.call("getAgentAllowance", { params })).allowance).toBeNull();

    const created = await api.call("createAgentAllowance", { params, body: body() });
    expect(created.allowance.status).toBe("pending_create");
    const integrity = checkAllowanceReview(created.review, {
      action: "create",
      allowance: created.allowance,
      simulated: false,
      requested: { create: body() },
      now: new Date(now),
    });
    expect(integrity.problems).toEqual([]);
    expect(integrity.verified).toBeDefined();
    expect(allowanceVerifiedLine(integrity.verified ?? never())).toBe(
      "Verified on this device: locks 50 ADA in your allowance (max 5 ADA per payment, 15 ADA per day) and sends 5 ADA to the agent for fees.",
    );
    expect(allowanceReviewRows(created.review, created.allowance)[0]).toEqual({
      label: "Locks (budget)",
      value: "50 ADA",
    });

    // What the user typed must be what was built.
    const asked = { ...body(), floatLovelace: "6000000" };
    expect(
      checkAllowanceReview(created.review, {
        action: "create",
        allowance: created.allowance,
        simulated: false,
        requested: { create: asked },
        now: new Date(now),
      }).problems,
    ).toContain("The agent's ADA for fees differs from what you entered.");

    // A stamp over another body hash is refused.
    const wrong = await signer.stampSignRawPayload({
      organizationId: "o",
      signWith: created.review.rawPayload.signWith,
      payload: "0".repeat(64),
    });
    await expect(
      api.call("submitAgentAllowance", {
        params,
        body: { bodyHash: "0".repeat(64), signRequest: wrong },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const submitted = await api.call("submitAgentAllowance", {
      params,
      body: {
        bodyHash: created.review.rawPayload.payload,
        signRequest: await sign(created.review),
      },
    });
    expect(submitted.allowance.status).toBe("creating");
    expect(allowancePollMs(submitted.allowance)).toBe(5_000);

    now += ALLOWANCE_TIMING.confirmMs;
    const active = (await api.call("getAgentAllowance", { params })).allowance;
    expect(active?.status).toBe("active");
    expect(active?.onChain?.balanceLovelace).toBe("50000000");
    expect(allowanceActions(active ?? never())).toEqual({
      topUp: true,
      revoke: true,
      finish: false,
    });

    // The simulated agent pays 2 ADA without a tap, then asks for more than the limits.
    now += ALLOWANCE_TIMING.firstPaymentMs;
    const requests = await api.call("listAgentRequests", { params, query: { limit: 100 } });
    const auto = requests.items.find((i) => isAutoPaid(i.request));
    expect(auto?.request.state).toBe("CONFIRMED");
    expect(activitySubtitle(auto ?? never())).toMatch(/^Auto-paid · allowance · /);
    const fallback = requests.items.find((i) => i.request.state === "PENDING_APPROVAL");
    expect(allowanceFallback(fallback?.request.policyReasons ?? [])?.code).toBe(
      "ALLOWANCE_LIMIT_EXCEEDED",
    );
    const paid = (await api.call("getAgentAllowance", { params })).allowance ?? never();
    expect(spentToday(paid)?.label).toBe("2 ADA of 15 ADA");
    expect((await api.call("listAgentAllowanceSpends", { params, query: {} })).spends).toHaveLength(
      1,
    );
    const txs = await api.call("listTransactions", {
      query: { network: "cardano-preprod", limit: 20 },
    });
    const scripts = new Set([paid.scriptAddress]);
    expect(txs.transactions.map((t) => transactionKindCopy(t, scripts)?.label)).toEqual(
      expect.arrayContaining(["Auto-paid · allowance", "Locked in allowance"]),
    );

    // Top up 10 ADA: an owner spend, decoded and checked on the device.
    const top = await api.call("topUpAgentAllowance", {
      params,
      body: { budget: { lovelace: "10000000" } },
    });
    const topCheck = checkAllowanceReview(top.review, {
      action: "top_up",
      allowance: top.allowance,
      simulated: false,
      requested: { addLovelace: 10_000_000n },
      now: new Date(now),
    });
    expect(topCheck.problems).toEqual([]);
    expect(allowanceVerifiedLine(topCheck.verified ?? never())).toBe(
      "Verified on this device: the transaction adds 10 ADA to your allowance (58 ADA in it after) and keeps its limits.",
    );
    await api.call("submitAgentAllowance", {
      params,
      body: { bodyHash: top.review.rawPayload.payload, signRequest: await sign(top.review) },
    });

    // Revoke: everything back to the wallet.
    const rev = await api.call("revokeAgentAllowance", { params });
    const revCheck = checkAllowanceReview(rev.review, {
      action: "revoke",
      allowance: rev.allowance,
      simulated: false,
      now: new Date(now),
    });
    expect(revCheck.problems).toEqual([]);
    expect(revCheck.verified?.kind).toBe("revoke");
    // The same review is refused for another action or once expired.
    expect(
      checkAllowanceReview(rev.review, {
        action: "top_up",
        allowance: rev.allowance,
        simulated: false,
        now: new Date(now),
      }).ok,
    ).toBe(false);
    expect(
      checkAllowanceReview(rev.review, {
        action: "revoke",
        allowance: rev.allowance,
        simulated: false,
        now: new Date(now + 11 * 60_000),
      }).problems,
    ).toContain("This review is no longer valid; prepare it again.");
    const revoking = await api.call("submitAgentAllowance", {
      params,
      body: { bodyHash: rev.review.rawPayload.payload, signRequest: await sign(rev.review) },
    });
    expect(revoking.allowance.status).toBe("revoking");
    now += ALLOWANCE_TIMING.confirmMs;
    const gone = (await api.call("getAgentAllowance", { params })).allowance;
    expect(gone?.status).toBe("revoked");
    expect(isLiveAllowance(gone)).toBe(false);
  });

  it("refuses a tampered transaction on the device", async () => {
    const api = c();
    const created = await api.call("createAgentAllowance", { params, body: body() });
    const ctx = {
      action: "create" as const,
      allowance: created.allowance,
      simulated: false,
      now: new Date(now),
    };
    // The API claims a 50 ADA lock but the record says 60: refused before decoding.
    const lying = CardanoAllowanceSchema.parse({
      ...created.allowance,
      budgetLovelace: "60000000",
    });
    expect(checkAllowanceReview(created.review, { ...ctx, allowance: lying }).ok).toBe(false);
    // The datum shown says 5 ADA per payment but the bytes are for another one.
    const datum = {
      ...created.review.expect,
      ...(created.review.expect.kind === "create" ? {} : {}),
    };
    const tampered: AllowanceReview = {
      ...created.review,
      expect:
        datum.kind === "create"
          ? { ...datum, datum: { ...datum.datum, perPaymentMax: "50000000" } }
          : datum,
    };
    const lyingLimits: CardanoAllowance = {
      ...created.allowance,
      limits: { ...created.allowance.limits, perPaymentLovelace: "50000000" },
    };
    const res = checkAllowanceReview(tampered, { ...ctx, allowance: lyingLimits });
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toContain("limits (datum) differ");
    // A body hash that isn't the transaction's.
    const swapped: AllowanceReview = {
      ...created.review,
      rawPayload: { ...created.review.rawPayload, payload: "ab".repeat(32) },
    };
    expect(checkAllowanceReview(swapped, ctx).problems).toContain(
      "The Cardano signing payload does not match the transaction.",
    );
    // A signing key that isn't the wallet's.
    const otherKey: AllowanceReview = {
      ...created.review,
      rawPayload: { ...created.review.rawPayload, signWith: "11".repeat(32) },
    };
    expect(checkAllowanceReview(otherKey, ctx).problems).toContain(
      "The signing key does not belong to your wallet.",
    );
  });

  it("refuses a second allowance, an agent without Cardano, and reads statuses", async () => {
    const api = c();
    await expect(
      api.call("createAgentAllowance", { params: { agentId: AGENT_CLAUDE }, body: body() }),
    ).rejects.toBeInstanceOf(ApiError);
    const created = await api.call("createAgentAllowance", { params, body: body() });
    expect(allowanceStatusView(created.allowance).label).toBe("Not signed yet");
    expect(allowanceActions(created.allowance).finish).toBe(true);
    const d = draftFromAllowance(created.allowance, new Date(now));
    expect([d.unit, d.budget, d.perPayment, d.perDay, d.expiresInDays, d.floatAda]).toEqual([
      "ADA",
      "50",
      "5",
      "15",
      7,
      "5",
    ]);
    // Repeating the create while pending rebuilds the same allowance.
    const again = await api.call("createAgentAllowance", { params, body: body() });
    expect(again.allowance.id).toBe(created.allowance.id);
    await api.call("submitAgentAllowance", {
      params,
      body: { bodyHash: again.review.rawPayload.payload, signRequest: await sign(again.review) },
    });
    await expect(api.call("createAgentAllowance", { params, body: body() })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

function never(): never {
  throw new Error("unexpected");
}
