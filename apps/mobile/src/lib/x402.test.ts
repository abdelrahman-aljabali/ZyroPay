import { verifySignRawPayloadRequest } from "@zyropay/wallet";
import { describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import { ADDR, fakeId, makeApprovals, type MockApproval } from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import { checkReviewIntegrity, stampForReview } from "./review";
import { devMockTurnkeySigner, simulatedSigner, turnkeySignRawPayloadBody } from "./turnkey/signer";
import type { X402Delivery } from "@zyropay/shared";
import {
  alwaysNeedsPasskey,
  deliveryNotice,
  explorerLink,
  humanFailure,
  readableUrl,
  requestProgress,
  x402Purpose,
} from "./x402";

const approval = (n: number): MockApproval => {
  const found = makeApprovals().find((a) => a.approval.id === fakeId(7, n));
  if (!found) throw new Error(`fixture ${String(n)} missing`);
  return found;
};

describe("x402 purpose", () => {
  it("shows the seller's description, host and a readable path", () => {
    const { review } = approval(6);
    const purpose = x402Purpose(review.payload);
    expect(purpose?.description).toBe("Cardano address intelligence report");
    expect(purpose?.host).toBe("address-intel.zyropay.online");
    // The address segment is shortened; the full URL stays available for Details.
    expect(purpose?.path).toMatch(/^\/v1\/reports\/address\/addr_test1.{1,}…/);
    expect(purpose?.path.length).toBeLessThanOrEqual(44);
    expect(purpose?.url).toBe(
      `https://address-intel.zyropay.online/v1/reports/address/${ADDR.friendAda}`,
    );
  });

  it("is null for anything that is not an x402 payment", () => {
    expect(x402Purpose(approval(1).review.payload)).toBeNull();
    expect(x402Purpose(approval(5).review.payload)).toBeNull();
  });

  it("falls back to the v1 requirement's description and caps a long one", () => {
    const { review } = approval(2);
    const v1 = {
      ...review.payload,
      pluginData: {
        resourceUrl: "https://api.example.com/x",
        accepted: { description: `  Big\n${"report ".repeat(40)}` },
        resource: null,
      },
    };
    const purpose = x402Purpose(v1);
    expect(purpose?.description?.startsWith("Big report")).toBe(true);
    expect(purpose?.description?.endsWith("…")).toBe(true);
    expect(purpose?.description?.length).toBeLessThanOrEqual(140);
    expect(
      x402Purpose({ ...v1, pluginData: { resourceUrl: "https://api.example.com/x" } }),
    ).toMatchObject({ description: null, host: "api.example.com", path: "/x" });
  });

  it("splits URLs without the URL global (React Native)", () => {
    expect(readableUrl("https://www.Example.com")).toEqual({ host: "example.com", path: "/" });
    expect(readableUrl("https://user:pw@api.example.com:8443/a/b?q=1")).toEqual({
      host: "api.example.com",
      path: "/a/b?q=1",
    });
    expect(readableUrl(`https://h.example/r?token=${"x".repeat(40)}`)?.path).toBe("/r?…");
    expect(readableUrl("ftp://h.example/r")).toBeNull();
    const long = readableUrl(`https://h.example/${"segment/".repeat(12)}end`);
    expect(long?.path.length).toBeLessThanOrEqual(44);
    expect(long?.path.endsWith("end")).toBe(true);
  });

  it("says Cardano always needs the passkey", () => {
    expect(alwaysNeedsPasskey("cardano-preprod")).toBe(true);
    expect(alwaysNeedsPasskey("base-sepolia")).toBe(false);
  });
});

describe("request progress after approval", () => {
  const base = {
    network: "cardano-preprod" as const,
    x402: true,
    failureReason: null,
    txHash: null,
  };
  const statuses = (p: ReturnType<typeof requestProgress>) => p.steps.map((s) => s.status);

  it("walks SIGNING -> BROADCAST -> CONFIRMED in plain words", () => {
    const signing = requestProgress({ ...base, state: "SIGNING" });
    expect(signing.message).toBe("Signed. Handing the payment to the seller…");
    expect(statuses(signing)).toEqual(["active", "todo", "todo"]);
    expect(signing.terminal).toBe(false);
    const broadcast = requestProgress({ ...base, state: "BROADCAST", txHash: "ab".repeat(32) });
    expect(broadcast.message).toBe("Submitted to Cardano. Waiting for confirmation…");
    expect(statuses(broadcast)).toEqual(["done", "active", "todo"]);
    const confirmed = requestProgress({ ...base, state: "CONFIRMED", txHash: "ab".repeat(32) });
    expect(confirmed.title).toBe("Paid");
    expect(confirmed.tone).toBe("success");
    expect(confirmed.terminal).toBe(true);
    expect(statuses(confirmed)).toEqual(["done", "done", "done"]);
  });

  it("explains a failure briefly and marks where it stopped", () => {
    const beforeSubmit = requestProgress({
      ...base,
      state: "FAILED",
      failureReason: "signing failed",
    });
    expect(beforeSubmit.title).toBe("Payment failed");
    expect(beforeSubmit.message).toBe("Signing failed.");
    expect(beforeSubmit.terminal).toBe(true);
    expect(statuses(beforeSubmit)).toEqual(["failed", "todo", "todo"]);
    const onChain = requestProgress({
      ...base,
      state: "FAILED",
      failureReason: "broadcast failed",
      txHash: "ab".repeat(32),
    });
    expect(statuses(onChain)).toEqual(["done", "failed", "todo"]);
    expect(humanFailure(null)).toBe("The network didn't accept it.");
    expect(humanFailure("x".repeat(500)).length).toBeLessThanOrEqual(161);
  });

  it("does not say Paid for a plain send", () => {
    const p = requestProgress({
      ...base,
      x402: false,
      network: "solana-devnet",
      state: "CONFIRMED",
    });
    expect(p.title).toBe("Confirmed");
    expect(p.steps.at(-1)?.label).toBe("Confirmed");
    expect(requestProgress({ ...base, state: "PENDING_APPROVAL" }).title).toBe(
      "Waiting for approval",
    );
  });

  it("links the Cardano preprod explorer only when there is a transaction id", () => {
    expect(explorerLink("cardano-preprod", null)).toBeNull();
    expect(explorerLink("cardano-preprod", "ab".repeat(32))).toBe(
      `https://preprod.cardanoscan.io/transaction/${"ab".repeat(32)}`,
    );
  });
});

describe("stampForReview: typed data (x402 on EVM)", () => {
  it("stamps SIGN_RAW_PAYLOAD over the EIP-712 digest with the wallet address, NO_OP hashing", async () => {
    const { review, approval: a } = approval(2);
    const typed = review.typedData;
    if (!typed) throw new Error("the x402 EVM fixture carries typed data");
    expect(review.unsignedTransaction.serialized).toBe(typed.digest);
    expect(checkReviewIntegrity(review, a)).toEqual({ ok: true, problems: [] });
    const stamped = await stampForReview(simulatedSigner(), review, "org-1");
    expect(stamped.url).toBe("https://api.turnkey.com/public/v1/submit/sign_raw_payload");
    expect(JSON.parse(stamped.body)).toMatchObject({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      organizationId: "org-1",
      parameters: {
        signWith: review.payload.from,
        payload: typed.digest,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
      },
    });
  });

  it("produces exactly what the API's typed-data check accepts", async () => {
    const { review } = approval(2);
    const typed = review.typedData;
    if (!typed) throw new Error("fixture");
    // A WebAuthn-format stamp over the body (the dev passkey), so the whole check runs.
    const signer = devMockTurnkeySigner(() => Promise.resolve("dev-credential-1"));
    const now = Date.now();
    const stamped = await stampForReview(signer, review, "org-1");
    const expected = {
      turnkeyApiBaseUrl: "https://api.turnkey.com",
      organizationId: "org-1",
      signWith: review.payload.from,
      digest: typed.digest,
      now: new Date(now),
    };
    const check = verifySignRawPayloadRequest(stamped, expected);
    expect(check.ok ? "ok" : check.code).toBe("ok");
    // Before this fix the app stamped SIGN_TRANSACTION over the digest: refused.
    const old = await signer.stampSignTransaction({
      organizationId: "org-1",
      signWith: review.payload.from,
      unsignedTransaction: review.unsignedTransaction,
      network: review.payload.network,
    });
    expect(verifySignRawPayloadRequest(old, expected).ok).toBe(false);
  });

  it("keeps Cardano at HASH_FUNCTION_NOT_APPLICABLE by default", () => {
    const body = turnkeySignRawPayloadBody(
      { organizationId: "o", signWith: "a", payload: "b" },
      "1",
    );
    expect(body.parameters.hashFunction).toBe("HASH_FUNCTION_NOT_APPLICABLE");
  });

  it("refuses typed data whose digest is not the reviewed one, or that is not on EVM", () => {
    const { review } = approval(2);
    const typed = review.typedData;
    if (!typed) throw new Error("fixture");
    const swapped = { ...review, typedData: { ...typed, digest: `0x${"1".repeat(64)}` } };
    expect(checkReviewIntegrity(swapped).problems.join(" ")).toMatch(/digest/);
    const ada = approval(6).review;
    expect(checkReviewIntegrity({ ...ada, typedData: typed }).ok).toBe(false);
  });
});

describe("mock: x402 Cardano approval", () => {
  const client = () =>
    new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "simulated",
    });

  it("refuses a stamp over the wrong activity and walks the request to CONFIRMED", async () => {
    resetMockState();
    const c = client();
    const id = fakeId(7, 6);
    const { review } = await c.call("getApproval", { params: { approvalId: id } });
    const wrong = {
      url: "https://api.turnkey.com/public/v1/submit/sign_transaction",
      body: "{}",
      stamp: { stampHeaderName: "X-Stamp-Webauthn" as const, stampHeaderValue: "sim" },
    };
    await expect(
      c.call("approveApproval", {
        params: { approvalId: id },
        body: { payloadHash: review.payloadHash, signRequest: wrong },
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_HASH_MISMATCH" });
    const signRequest = await stampForReview(simulatedSigner(), review, "org-1");
    const t0 = Date.now();
    const ok = await c.call("approveApproval", {
      params: { approvalId: id },
      body: { payloadHash: review.payloadHash, signRequest },
    });
    expect(ok.request.state).toBe("SIGNING");
    expect(ok.request.txHash).toBeNull();
    const detailAt = async (ms: number) => {
      const spy = Date.now;
      Date.now = () => t0 + ms;
      try {
        return await c.call("getApproval", { params: { approvalId: id } });
      } finally {
        Date.now = spy;
      }
    };
    const at = async (ms: number) => (await detailAt(ms)).review.request;
    expect((await at(1_000)).state).toBe("SIGNING");
    const submitted = await at(5_000);
    expect(submitted.state).toBe("BROADCAST");
    expect(submitted.txHash).toMatch(/^[0-9a-f]{64}$/);
    const paid = await at(11_000);
    expect(paid.state).toBe("CONFIRMED");
    expect(paid.txHash).toBe(submitted.txHash);
    // The simulated seller answered with a receipt that verified.
    const detail = await detailAt(12_000);
    expect(detail.x402).toMatchObject({ status: "delivered", receipt: { verified: true } });
    expect(deliveryNotice(detail.x402)?.title).toBe("Delivery verified");
  });

  it("a pending x402 approval carries its delivery state, without a receipt", async () => {
    resetMockState();
    const detail = await client().call("getApproval", { params: { approvalId: fakeId(7, 6) } });
    expect(detail.x402).toMatchObject({ status: "awaiting_signature", receipt: null });
    expect(deliveryNotice(detail.x402)).toBeNull();
  });
});

describe("delivery receipt notice", () => {
  const delivered = (receipt: X402Delivery["receipt"]): X402Delivery => ({
    status: "delivered",
    resourceUrl: "https://address-intel.zyropay.online/r",
    httpStatus: 200,
    deliveredAt: "2026-10-30T12:00:00.000Z",
    receipt,
    proof: null,
  });
  const failed = (reason: NonNullable<X402Delivery["receipt"]>["reason"]) =>
    deliveryNotice(
      delivered({ verified: false, contentSha256: null, signedBy: null, signedAt: null, reason }),
    );

  it("says verified, signed by the seller you paid", () => {
    expect(
      deliveryNotice(
        delivered({
          verified: true,
          contentSha256: "a".repeat(64),
          signedBy: "addr_test1vseller",
          signedAt: "2026-10-30T12:00:00.000Z",
          reason: null,
        }),
      ),
    ).toEqual({
      tone: "success",
      title: "Delivery verified",
      message: "Signed by the seller you paid, over exactly what your agent received.",
    });
  });

  it("warns clearly when a receipt does not check out", () => {
    for (const reason of [
      "wrong_signer",
      "wrong_resource",
      "wrong_payment",
      "content_mismatch",
      "bad_signature",
      "malformed",
    ] as const) {
      const notice = failed(reason);
      expect(notice?.tone).toBe("danger");
      expect(notice?.title).toBe("Delivery not verified");
      expect(notice?.message).toContain("caution");
    }
    expect(failed("wrong_signer")?.message).toContain("someone other than the seller you paid");
  });

  it("is neutral when the seller sends no receipt or it could not be checked", () => {
    expect(failed("missing")).toMatchObject({ tone: "neutral", title: "Delivered, not verified" });
    expect(failed("body_unavailable")?.tone).toBe("neutral");
    expect(failed("unsupported_network")?.tone).toBe("neutral");
  });

  it("adds the proof-before-release line: receipt only, verified or mismatch on Cardano", () => {
    const receipt = {
      verified: true,
      contentSha256: "a".repeat(64),
      signedBy: "addr_test1vseller",
      signedAt: "2026-10-30T12:00:00.000Z",
      reason: null,
    };
    const withProof = (state: NonNullable<X402Delivery["proof"]>["state"]) =>
      deliveryNotice({
        ...delivered(receipt),
        proof: {
          state,
          receivedHash: "a".repeat(64),
          onChainHash: null,
          resultTx: null,
          checkedAt: null,
          message: "",
        },
      })?.proof;
    expect(withProof("receipt_only")).toContain("Direct payment: no result is recorded on Cardano");
    expect(withProof("verified")).toContain("Verified on Cardano");
    expect(withProof("mismatch")).toContain("you can request a refund");
    expect(withProof("pending")).toBeUndefined();
  });

  it("says nothing before delivery", () => {
    expect(deliveryNotice(undefined)).toBeNull();
    expect(deliveryNotice({ ...delivered(null), status: "ready", deliveredAt: null })).toBeNull();
    expect(deliveryNotice(delivered(null))).toBeNull();
  });
});
