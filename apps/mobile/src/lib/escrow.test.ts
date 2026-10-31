import type { X402Escrow } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "@/api/client";
import { ADDR, fakeId, makeApprovals, MASUMI_ESCROW_PREPROD } from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import {
  checkEscrowReviewIntegrity,
  deadlineValue,
  deadlineWords,
  escrowActions,
  escrowErrorMessage,
  escrowPollMs,
  escrowProofNotice,
  escrowProtection,
  escrowSpendRows,
  escrowTermsOf,
  escrowTxLinks,
  escrowView,
  isEscrowTerminal,
  policyReasonText,
  relativeWords,
} from "./escrow";
import { escrowThresholdFromInput, escrowThresholdToInput } from "./policy-draft";
import { stampForReview } from "./review";
import { simulatedSigner } from "./turnkey/signer";
import { requestProgress } from "./x402";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const TX = (n: number) => String(n).repeat(64).slice(0, 64);

function escrow(over: Partial<X402Escrow> = {}, refund: Partial<X402Escrow["refund"]> = {}) {
  const base: X402Escrow = {
    method: "masumi",
    state: "funds_locked",
    escrowAddress: MASUMI_ESCROW_PREPROD,
    sellerAddress: ADDR.sellerAda,
    lockTx: TX(1),
    utxo: `${TX(1)}#0`,
    lockedLovelace: "4500000",
    collateralLovelace: "1500000",
    deadlines: {
      payBy: at(-10),
      submitResult: at(30),
      unlock: at(120),
      externalDisputeUnlock: at(240),
    },
    resultHash: null,
    proof: {
      state: "pending",
      receivedHash: null,
      onChainHash: null,
      resultTx: null,
      checkedAt: NOW.toISOString(),
      message: "Waiting for the seller to record the result on Cardano.",
    },
    refund: {
      available: ["request_refund"],
      recommended: null,
      reason: null,
      withdrawableAt: at(30),
      pending: null,
      requestTx: null,
      withdrawTx: null,
    },
    checkedAt: NOW.toISOString(),
  };
  return { ...base, ...over, refund: { ...base.refund, ...refund } };
}

const statuses = (e: X402Escrow) => escrowView(e, NOW).steps.map((s) => `${s.key}:${s.status}`);

describe("deadline wording", () => {
  it("says how far a time is, in words", () => {
    expect(relativeWords(at(0.5), NOW)).toBe("now");
    expect(relativeWords(at(25), NOW)).toBe("in 25 min");
    expect(relativeWords(at(-25), NOW)).toBe("25 min ago");
    expect(relativeWords(at(150), NOW)).toBe("in 2 h 30 min");
    expect(relativeWords(at(600), NOW)).toBe("in 10 h");
    expect(relativeWords(at(3 * 24 * 60), NOW)).toBe("in 3 days");
    expect(relativeWords("not a date", NOW)).toBe("");
  });

  it("pairs the absolute time (UTC) with the relative one", () => {
    expect(deadlineWords(at(30), NOW)).toBe("30 Oct 2026, 12:30 UTC (in 30 min)");
    expect(deadlineValue(at(30), NOW)).toBe("30 Oct 2026, 12:30 UTC (in\u00a030\u00a0min)");
  });
});

describe("escrow terms on the approval", () => {
  const pending = makeApprovals().find((a) => a.approval.id === fakeId(7, 7));
  if (!pending) throw new Error("escrow fixture missing");

  it("reads the seller-signed terms bound in the payload", () => {
    const terms = escrowTermsOf(pending.review.payload);
    expect(terms).not.toBeNull();
    expect(terms?.sellerAddress).toBe(ADDR.sellerAda);
    expect(terms?.escrowAddress).toBe(MASUMI_ESCROW_PREPROD);
    expect(terms?.lockedLovelace).toBe("4500000");
    expect(new Date(terms?.deadlines.unlock ?? "").getTime()).toBeGreaterThan(
      new Date(terms?.deadlines.submitResult ?? "").getTime(),
    );
  });

  it("is null for a direct x402 payment or a non-canonical escrow", () => {
    const direct = makeApprovals().find((a) => a.approval.id === fakeId(7, 6));
    expect(direct && escrowTermsOf(direct.review.payload)).toBeNull();
    const p = pending.review.payload;
    expect(
      escrowTermsOf({
        ...p,
        pluginData: { ...p.pluginData, escrow: { method: "default" } },
      }),
    ).toBeNull();
  });

  it("explains the protection in plain words, naming the seller, not the script", () => {
    const terms = escrowTermsOf(pending.review.payload);
    if (!terms) throw new Error("no terms");
    const p = escrowProtection(terms, NOW);
    expect(p.title).toBe("Protected by Escrow (Masumi)");
    expect(p.lines[0]).toContain("locked on Cardano until the seller delivers");
    expect(p.lines[1]).toMatch(/^If it isn't delivered by .+ UTC/);
    expect(p.lines.at(-1)).toContain("1.5 ADA deposit");
    expect(p.seller.startsWith(ADDR.sellerAda.slice(0, 10))).toBe(true);
    expect(p.seller).not.toContain(MASUMI_ESCROW_PREPROD.slice(0, 16));
  });

  it("labels the request progress as locked, not paid", () => {
    const p = requestProgress({
      state: "CONFIRMED",
      network: "cardano-preprod",
      x402: true,
      escrow: true,
      failureReason: null,
      txHash: TX(1),
    });
    expect(p.title).toBe("Locked in escrow");
    expect(p.steps.at(-1)?.label).toBe("Locked in escrow");
  });
});

describe("escrow timeline", () => {
  it("locking -> locked -> delivered -> released", () => {
    expect(statuses(escrow({ state: "locking", lockTx: null, utxo: null }))).toEqual([
      "locked:active",
      "delivered:todo",
      "released:todo",
    ]);
    expect(statuses(escrow())).toEqual(["locked:done", "delivered:active", "released:todo"]);
    const delivered = escrow({ state: "result_submitted", resultHash: "ab".repeat(32) });
    expect(statuses(delivered)).toEqual(["locked:done", "delivered:done", "released:active"]);
    const view = escrowView(delivered, NOW);
    expect(view.title).toBe("Result delivered");
    expect(view.message).toContain("in 2 h");
    expect(view.steps[1]?.detail).toMatch(/^Result hash abababab/);
    const done = escrowView(escrow({ state: "withdrawn", resultHash: "ab".repeat(32) }), NOW);
    expect(done.terminal).toBe(true);
    expect(done.tone).toBe("success");
    expect(done.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
  });

  it("refund path: requested -> authorized -> refunded", () => {
    expect(
      statuses(
        escrow(
          {},
          {
            pending: {
              action: "request_refund",
              status: "submitted",
              txHash: TX(2),
              updatedAt: at(0),
            },
          },
        ),
      ),
    ).toEqual([
      "locked:done",
      "refund-requested:active",
      "refund-authorized:todo",
      "refunded:todo",
    ]);
    const requested = escrow({ state: "refund_requested" }, { requestTx: TX(2) });
    expect(statuses(requested)).toEqual([
      "locked:done",
      "refund-requested:done",
      "refund-authorized:active",
      "refunded:todo",
    ]);
    expect(escrowView(requested, NOW).steps[1]?.txHash).toBe(TX(2));
    const authorized = escrow({ state: "refund_authorized" }, { requestTx: TX(2) });
    expect(statuses(authorized)).toEqual([
      "locked:done",
      "refund-requested:done",
      "refund-authorized:done",
      "refunded:todo",
    ]);
    const refunded = escrowView(
      escrow({ state: "refunded", utxo: null }, { requestTx: TX(2), withdrawTx: TX(3) }),
      NOW,
    );
    expect(refunded.terminal).toBe(true);
    expect(refunded.tone).toBe("success");
    expect(refunded.message).toContain("4.5 ADA");
    expect(refunded.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("a withdrawal without a request (nothing delivered in time) and a dispute", () => {
    const late = escrow(
      {},
      {
        available: ["withdraw_refund"],
        pending: {
          action: "withdraw_refund",
          status: "submitted",
          txHash: TX(3),
          updatedAt: at(0),
        },
      },
    );
    expect(statuses(late)).toEqual(["locked:done", "no-result:done", "refunded:active"]);
    const disputed = escrowView(
      escrow({ state: "disputed", resultHash: "cd".repeat(32) }, { requestTx: TX(2) }),
      NOW,
    );
    expect(disputed.tone).toBe("danger");
    expect(disputed.steps.map((s) => s.key)).toEqual([
      "locked",
      "refund-requested",
      "disputed",
      "refunded",
    ]);
  });

  it("failed and unknown", () => {
    const failed = escrowView(escrow({ state: "failed", lockTx: null }), NOW);
    expect(failed.terminal).toBe(true);
    expect(failed.steps).toHaveLength(1);
    expect(failed.steps[0]?.status).toBe("failed");
    expect(escrowView(escrow({ state: "unknown" }), NOW).terminal).toBe(false);
  });
});

describe("escrow actions and polling", () => {
  it("offers exactly what the API says is possible, not while a spend is in flight", () => {
    expect(escrowActions(escrow(), NOW)).toMatchObject({
      requestRefund: true,
      withdrawRefund: false,
      withdrawableAt: at(30),
      pendingNote: null,
    });
    const both = escrowActions(
      escrow({ state: "refund_authorized" }, { available: ["withdraw_refund"] }),
      NOW,
    );
    expect(both).toMatchObject({
      requestRefund: false,
      withdrawRefund: true,
      withdrawableAt: null,
    });
    const busy = escrowActions(
      escrow(
        {},
        {
          pending: {
            action: "request_refund",
            status: "submitted",
            txHash: null,
            updatedAt: at(0),
          },
        },
      ),
      NOW,
    );
    expect(busy.requestRefund).toBe(false);
    expect(busy.pendingNote?.text).toContain("refund request was sent");
    const failed = escrowActions(
      escrow(
        {},
        {
          pending: { action: "withdraw_refund", status: "failed", txHash: null, updatedAt: at(0) },
        },
      ),
      NOW,
    );
    expect(failed.pendingNote).toMatchObject({ tone: "danger" });
    // No countdown once a result was delivered, or after the deadline.
    expect(
      escrowActions(escrow({ state: "result_submitted", resultHash: "ab".repeat(32) }), NOW)
        .withdrawableAt,
    ).toBeNull();
    expect(escrowActions(escrow({}, { withdrawableAt: at(-1) }), NOW).withdrawableAt).toBeNull();
  });

  it("polls while the escrow can change and stops once it is closed", () => {
    expect(escrowPollMs(null)).toBe(false);
    expect(escrowPollMs(escrow())).toBe(15_000);
    expect(escrowPollMs(escrow({ state: "locking" }))).toBe(5_000);
    expect(
      escrowPollMs(
        escrow(
          {},
          {
            pending: {
              action: "request_refund",
              status: "submitted",
              txHash: null,
              updatedAt: at(0),
            },
          },
        ),
      ),
    ).toBe(5_000);
    for (const s of ["refunded", "withdrawn", "failed"] as const) {
      expect(isEscrowTerminal(s)).toBe(true);
      expect(escrowPollMs(escrow({ state: s }))).toBe(false);
    }
  });

  it("links every escrow transaction to the explorer", () => {
    const links = escrowTxLinks(
      "cardano-preprod",
      escrow({ state: "refunded" }, { requestTx: TX(2), withdrawTx: TX(3) }),
    );
    expect(links.map((l) => l.key)).toEqual(["lock", "request", "withdraw"]);
    expect(links[0]?.url).toContain(TX(1));
    expect(escrowTxLinks("cardano-preprod", escrow({ lockTx: null }))).toEqual([]);
  });
});

describe("escrow errors and policy reasons", () => {
  it("says plainly why an action failed", () => {
    expect(escrowErrorMessage({ code: "INSUFFICIENT_FUNDS", message: "x" })).toContain(
      "150% of the fee",
    );
    expect(
      escrowErrorMessage({
        code: "CONFLICT",
        message: "a refund was requested recently; try again later",
        details: { retryAfter: at(5) },
      }),
    ).toBe(
      "Not possible right now: a refund was requested recently; try again later. Try again after 30 Oct 2026, 12:05 UTC.",
    );
    expect(
      escrowErrorMessage({ code: "CONFLICT", message: "the escrow is closed (refunded)" }),
    ).toBe("Not possible right now: the escrow is closed (refunded).");
    expect(escrowErrorMessage({ code: "PAYLOAD_HASH_MISMATCH", message: "x" })).toContain(
      "Review it again",
    );
  });

  it("gives ESCROW_REQUIRED a readable label", () => {
    expect(
      policyReasonText({
        code: "ESCROW_REQUIRED",
        message: "x402 payments above the escrow threshold must use escrow (Masumi)",
      }),
    ).toBe(
      "Escrow required above your threshold: x402 payments above the escrow threshold must use escrow (Masumi).",
    );
    expect(policyReasonText({ code: "NEW_CODE", message: "something" })).toBe("Something.");
  });
});

describe("policy: escrow threshold field", () => {
  it("off <-> null, on <-> cents", () => {
    expect(escrowThresholdToInput(null)).toEqual({ on: false, dollars: "" });
    expect(escrowThresholdToInput(undefined)).toEqual({ on: false, dollars: "" });
    expect(escrowThresholdToInput("1250")).toEqual({ on: true, dollars: "12.50" });
    expect(escrowThresholdToInput("0")).toEqual({ on: true, dollars: "" });
    expect(escrowThresholdFromInput({ on: false, dollars: "12" })).toBeNull();
    expect(escrowThresholdFromInput({ on: true, dollars: "12.5" })).toBe("1250");
    expect(escrowThresholdFromInput({ on: true, dollars: "" })).toBe("0");
    expect(() => escrowThresholdFromInput({ on: true, dollars: "1.2.3" })).toThrow();
  });
});

describe("mock: Masumi escrow payment and refund", () => {
  const client = () =>
    new ApiClient({ transport: mockTransport({ latencyMs: 0 }), getAccessToken: () => "sim" });
  const withNow = async <T>(t: number, fn: () => Promise<T>): Promise<T> => {
    const real = Date.now;
    Date.now = () => t;
    try {
      return await fn();
    } finally {
      Date.now = real;
    }
  };

  it("locks on approval and the simulated seller delivers", async () => {
    resetMockState();
    const c = client();
    const id = fakeId(7, 7);
    const before = await c.call("getApproval", { params: { approvalId: id } });
    expect(before.x402?.escrow?.state).toBe("locking");
    const signRequest = await stampForReview(simulatedSigner(), before.review, "org");
    const t0 = Date.now();
    await c.call("approveApproval", {
      params: { approvalId: id },
      body: { payloadHash: before.review.payloadHash, signRequest },
    });
    const escrowAt = (ms: number) =>
      withNow(t0 + ms, () =>
        c.call("getX402Escrow", { params: { requestId: before.review.request.id } }),
      ).then((r) => r.escrow);
    // The request confirms ~10 s after approval (transport SETTLE).
    await withNow(t0 + 11_000, () => c.call("getApproval", { params: { approvalId: id } }));
    const locked = await escrowAt(11_500);
    expect(locked.state).toBe("funds_locked");
    expect(locked.lockTx).toMatch(/^[0-9a-f]{64}$/);
    const delivered = await escrowAt(30_000);
    expect(delivered.state).toBe("result_submitted");
    expect(delivered.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("request -> seller authorizes -> withdraw -> refunded, each passkey-stamped", async () => {
    resetMockState();
    const c = client();
    const { review } = await c.call("getApproval", { params: { approvalId: fakeId(7, 8) } });
    const requestId = review.request.id;
    const first = await c.call("getX402Escrow", { params: { requestId } });
    expect(first.escrow.state).toBe("funds_locked");
    expect(first.escrow.refund.available).toEqual(["request_refund"]);
    // Withdrawing before the result deadline is a 409 with retryAfter.
    const early = await c
      .call("prepareX402RefundWithdrawal", { params: { requestId } })
      .catch((e: unknown) => e);
    expect(early).toBeInstanceOf(ApiError);
    expect((early as ApiError).code).toBe("CONFLICT");
    expect(typeof (early as ApiError).details?.retryAfter).toBe("string");

    const prep = await c.call("prepareX402RefundRequest", { params: { requestId } });
    expect(checkEscrowReviewIntegrity(prep.review, "request_refund", prep.escrow).ok).toBe(true);
    expect(checkEscrowReviewIntegrity(prep.review, "withdraw_refund", prep.escrow).ok).toBe(false);
    expect(escrowSpendRows(prep.review)?.map((r) => r.label)).toEqual([
      "Locked amount",
      "Refund to",
      "Valid from",
      "Valid until",
      "Network fee",
    ]);
    const signRequest = await stampForReview(simulatedSigner(), prep.review, "org");
    const bodyHash = prep.review.rawPayload?.payload ?? "";
    await expect(
      c.call("submitX402RefundRequest", {
        params: { requestId },
        body: { payloadHash: prep.review.payloadHash, bodyHash: "0".repeat(64), signRequest },
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_HASH_MISMATCH" });
    const sent = await c.call("submitX402RefundRequest", {
      params: { requestId },
      body: { payloadHash: prep.review.payloadHash, bodyHash, signRequest },
    });
    expect(sent.escrow.refund.pending?.status).toBe("submitted");
    expect(sent.escrow.refund.available).toEqual([]);
    const t0 = Date.now();
    const at = (ms: number) =>
      withNow(t0 + ms, () => c.call("getX402Escrow", { params: { requestId } })).then(
        (r) => r.escrow,
      );
    const requested = await at(5_000);
    expect(requested.state).toBe("refund_requested");
    expect(requested.refund.requestTx).toMatch(/^[0-9a-f]{64}$/);
    const authorized = await at(12_000);
    expect(authorized.state).toBe("refund_authorized");
    expect(authorized.refund.available).toContain("withdraw_refund");

    const w = await withNow(t0 + 12_500, () =>
      c.call("prepareX402RefundWithdrawal", { params: { requestId } }),
    );
    expect(w.review.escrowSpend?.refundTo).toBe(w.review.payload.from);
    const stamp = await stampForReview(simulatedSigner(), w.review, "org");
    await withNow(t0 + 13_000, () =>
      c.call("submitX402RefundWithdrawal", {
        params: { requestId },
        body: {
          payloadHash: w.review.payloadHash,
          bodyHash: w.review.rawPayload?.payload ?? "",
          signRequest: stamp,
        },
      }),
    );
    const refunded = await at(20_000);
    expect(refunded.state).toBe("refunded");
    expect(refunded.refund.withdrawTx).toMatch(/^[0-9a-f]{64}$/);
    expect(escrowView(refunded).terminal).toBe(true);
  });

  it("refuses a review that would refund elsewhere or spend another output", async () => {
    resetMockState();
    const c = client();
    const { review } = await c.call("getApproval", { params: { approvalId: fakeId(7, 8) } });
    const prep = await c.call("prepareX402RefundRequest", {
      params: { requestId: review.request.id },
    });
    const spend = prep.review.escrowSpend;
    if (!spend) throw new Error("no escrowSpend");
    const elsewhere = { ...prep.review, escrowSpend: { ...spend, refundTo: ADDR.friendAda } };
    expect(checkEscrowReviewIntegrity(elsewhere, "request_refund", prep.escrow).problems).toContain(
      "The refund does not go to the wallet that paid.",
    );
    const other = { ...prep.review, escrowSpend: { ...spend, escrowUtxo: `${TX(9)}#1` } };
    expect(checkEscrowReviewIntegrity(other, "request_refund", prep.escrow).ok).toBe(false);
    const stale = { ...prep.review, escrowSpend: { ...spend, validUntil: at(-1) } };
    expect(checkEscrowReviewIntegrity(stale, "request_refund", prep.escrow, NOW).ok).toBe(false);
  });
});

describe("proof before release", () => {
  const H1 = "c0".repeat(32);
  const H2 = "d1".repeat(32);
  const proof = (over: Partial<NonNullable<X402Escrow["proof"]>>): X402Escrow["proof"] => ({
    state: "pending",
    receivedHash: H1,
    onChainHash: null,
    resultTx: null,
    checkedAt: NOW.toISOString(),
    message: "",
    ...over,
  });

  it("verified: says so, with a link to the seller's result transaction", () => {
    const e = escrow({
      state: "result_submitted",
      resultHash: H1,
      proof: proof({ state: "verified", onChainHash: H1, resultTx: TX(7) }),
    });
    const notice = escrowProofNotice("cardano-preprod", e, NOW);
    expect(notice).toMatchObject({
      state: "verified",
      tone: "success",
      title: "Verified on Cardano ✓",
      message: "What your agent received matches the result the seller recorded on chain.",
      action: null,
    });
    expect(notice?.resultTxUrl).toContain(TX(7));
    expect(notice?.resultTxUrl).toContain("cardanoscan");
    // The timeline links the result too, and so do the escrow's transaction links.
    expect(escrowView(e, NOW).steps.find((s) => s.key === "delivered")?.txHash).toBe(TX(7));
    expect(escrowTxLinks("cardano-preprod", e).map((l) => l.key)).toEqual(["lock", "result"]);
  });

  it("mismatch: red, with the recommended refund request as the call to action", () => {
    const e = escrow(
      {
        state: "result_submitted",
        resultHash: H2,
        proof: proof({ state: "mismatch", onChainHash: H2, resultTx: TX(7) }),
      },
      { available: ["request_refund"], recommended: "request_refund", reason: "x" },
    );
    const notice = escrowProofNotice("cardano-preprod", e, NOW);
    expect(notice).toMatchObject({
      state: "mismatch",
      tone: "danger",
      title: "Mismatch — request refund",
      action: "request_refund",
    });
    expect(notice?.message).toContain("does not match the result the seller recorded on Cardano");
    // Once the refund is requested, no call to action remains.
    const asked = escrow(
      { state: "disputed", resultHash: H2, proof: e.proof },
      { available: [], recommended: null, requestTx: TX(8) },
    );
    expect(escrowProofNotice("cardano-preprod", asked, NOW)).toMatchObject({
      title: "Mismatch on Cardano",
      action: null,
    });
  });

  it("not delivered: recommends the withdrawal; pending: waits for the seller", () => {
    const missed = escrow(
      { proof: proof({ state: "not_delivered" }) },
      {
        available: ["request_refund", "withdraw_refund"],
        recommended: "withdraw_refund",
        withdrawableAt: null,
      },
    );
    expect(escrowProofNotice("cardano-preprod", missed, NOW)).toMatchObject({
      tone: "danger",
      title: "Not delivered — get your refund",
      action: "withdraw_refund",
    });
    expect(escrowProofNotice("cardano-preprod", escrow(), NOW)).toMatchObject({
      tone: "neutral",
      title: "Waiting for the seller to record the result",
      resultTxUrl: null,
      action: null,
    });
    // Nothing to say for a direct payment or a failed lock.
    expect(escrowProofNotice("cardano-preprod", escrow({ proof: null }), NOW)).toBeNull();
  });

  it("mock fixtures: a verified and a mismatched escrow payment", async () => {
    resetMockState();
    const c = new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "sim",
    });
    // Fixture requests 9 (seller recorded what it delivered) and 10 (it recorded another hash).
    const verified = fakeId(6, 9);
    const mismatched = fakeId(6, 10);
    const ok = (await c.call("getX402Escrow", { params: { requestId: verified } })).escrow;
    expect(ok.state).toBe("result_submitted");
    expect(ok.proof).toMatchObject({ state: "verified", resultTx: expect.any(String) });
    expect(escrowProofNotice("cardano-preprod", ok)?.title).toBe("Verified on Cardano ✓");
    const bad = (await c.call("getX402Escrow", { params: { requestId: mismatched } })).escrow;
    expect(bad.proof?.state).toBe("mismatch");
    expect(bad.refund).toMatchObject({ recommended: "request_refund" });
    expect(escrowProofNotice("cardano-preprod", bad)).toMatchObject({
      title: "Mismatch — request refund",
      action: "request_refund",
    });
  });
});
