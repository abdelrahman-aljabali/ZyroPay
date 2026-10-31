import {
  cardanoUnsignedBodyHash,
  createCanonicalPayload,
  decodeCardanoUnsignedTx,
  isMasumiEscrowLock,
  payloadHash,
  type CanonicalTransactionPayload,
  type SigningReview,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import {
  ADDR,
  ASSETS,
  fakeId,
  makeApprovals,
  makeReviewForSend,
  WALLET_MAIN,
} from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import V from "./__fixtures__/cardano-review-vectors.json";
import { checkEscrowReviewIntegrity } from "./escrow";
import { checkReviewIntegrity, deviceVerifiedLine, TX_MISMATCH } from "./review";

/*
 * On-device decode of REAL Cardano transactions (built by @zyropay/blockchain's builders,
 * vectors kept in sync by packages/blockchain cardano-review-vectors.test.ts): the app must
 * refuse to sign anything that does not do exactly what the review shows.
 */

const feeOf = (hex: string) => {
  try {
    return decodeCardanoUnsignedTx(hex, "cardano-preprod").fee.toString();
  } catch {
    return "200000";
  }
};

/** Turn a simulated review into a real one over `hex` with `payload` overrides. */
function realReview(
  base: SigningReview,
  over: Partial<CanonicalTransactionPayload>,
  hex: string,
  extra: Partial<SigningReview> = {},
): SigningReview {
  const payload = createCanonicalPayload({ ...base.payload, from: V.from, ...over });
  const hash = payloadHash(payload);
  return {
    ...base,
    payload,
    payloadHash: hash,
    request: { ...base.request, payload, payloadHash: hash, simulated: false },
    unsignedTransaction: { encoding: "hex", serialized: hex },
    rawPayload: {
      kind: "cardano_tx_body_hash",
      payload: cardanoUnsignedBodyHash(hex) ?? "",
      signWith: V.senderPublicKey,
    },
    estimatedFee: { amount: feeOf(hex), value: null },
    ...extra,
  };
}

const sendBase = () =>
  makeReviewForSend(3, WALLET_MAIN, ASSETS.ada, ADDR.adaMain, ADDR.friendAda, "2000000");
const transferReview = (hex: string = V.transferAda.hex, over = {}) =>
  realReview(sendBase(), { to: V.to, amount: "2000000", feeCap: "1000000", ...over }, hex);

const mismatch = (r: { problems: readonly string[] }) =>
  r.problems.find((p) => p.startsWith(TX_MISMATCH)) ?? "";

describe("checkReviewIntegrity: Cardano transfer decoded on device", () => {
  it("passes a real transfer and says what it proved", () => {
    const r = checkReviewIntegrity(transferReview());
    expect(r.problems).toEqual([]);
    expect(r.verified).toEqual({
      kind: "transfer",
      payTo: V.to,
      lovelace: "2000000",
      token: null,
    });
    expect(deviceVerifiedLine(r.verified!, "2 ADA")).toBe(
      `Verified on this device: the transaction pays 2 ADA to ${V.to.slice(0, 20)}…${V.to.slice(-6)}.`,
    );
  });

  it("refuses tampered transactions with the specific reason", () => {
    const t = V.tampered;
    const cases: Array<[string, RegExp]> = [
      [t.transferOtherRecipient, /pays a different address/],
      [t.transferOtherAmount, /pays a different amount/],
      [t.transferExtraOutput, /more outputs/],
      [t.transferChangeElsewhere, /change to another address/],
      [t.transferFeeTooHigh, /fee cap/],
      [t.transferExpired, /already ended/],
      [V.escrowLock.hex, /different address/],
    ];
    for (const [hex, re] of cases) {
      const r = checkReviewIntegrity(transferReview(hex));
      expect(r.ok).toBe(false);
      expect(r.verified).toBeUndefined();
      expect(mismatch(r)).toMatch(re);
    }
  });

  it("refuses when the screen shows other terms than the bytes", () => {
    // The API shows a payment to the friend; the bytes pay V.to.
    expect(
      mismatch(checkReviewIntegrity(transferReview(V.transferAda.hex, { to: V.mallory }))),
    ).toMatch(/different address/);
    expect(
      mismatch(checkReviewIntegrity(transferReview(V.transferAda.hex, { amount: "1000000" }))),
    ).toMatch(/different amount/);
    // A fee shown lower than the one in the transaction.
    const lowFee = { ...transferReview(), estimatedFee: { amount: "1000", value: null } };
    expect(mismatch(checkReviewIntegrity(lowFee))).toMatch(/higher than the fee shown/);
    // Garbage bytes (the body hash is recomputed from them, so it matches).
    expect(mismatch(checkReviewIntegrity(transferReview("84a0a0f5f6")))).toMatch(
      /could not be read/,
    );
  });

  it("a token transfer pays exactly the token", () => {
    const token = {
      id: `cardano-preprod:${V.tokenUnit}`,
      kind: "cardano_token",
      decimals: 2,
    } as const;
    const ok = checkReviewIntegrity(
      transferReview(V.transferToken.hex, { asset: token, amount: "100", feeCap: "3000000" }),
    );
    expect(ok.problems).toEqual([]);
    expect(ok.verified?.token).toEqual({ unit: V.tokenUnit, amount: "100" });
    const more = checkReviewIntegrity(
      transferReview(V.transferToken.hex, { asset: token, amount: "99", feeCap: "3000000" }),
    );
    expect(mismatch(more)).toMatch(/different token amount/);
  });

  it("simulated reviews are not decoded (mock bytes)", () => {
    const r = checkReviewIntegrity(sendBase());
    expect(r.ok).toBe(true);
    expect(r.verified).toBeUndefined();
  });
});

describe("checkReviewIntegrity: Masumi escrow lock decoded on device", () => {
  const base = () => {
    const found = makeApprovals().find((a) => isMasumiEscrowLock(a.review.payload));
    if (found === undefined) throw new Error("no escrow approval in the fixtures");
    return found.review;
  };
  const lockReview = (hex: string = V.escrowLock.hex, escrowOver: Record<string, string> = {}) => {
    const b = base();
    const escrow = b.payload.pluginData?.escrow as Record<string, unknown>;
    return realReview(
      b,
      {
        to: V.escrow.address,
        amount: V.escrow.price,
        feeCap: "1000000",
        pluginData: {
          ...b.payload.pluginData,
          escrow: {
            ...escrow,
            datumCbor: V.escrow.datumCbor,
            lockedLovelace: V.escrow.lockedLovelace,
            collateralLovelace: V.escrow.collateralLovelace,
            payByTime: V.escrow.payByTime,
            ...escrowOver,
          },
        },
      },
      hex,
    );
  };

  it("passes the real lock", () => {
    const r = checkReviewIntegrity(lockReview());
    expect(r.problems).toEqual([]);
    expect(r.verified).toMatchObject({ kind: "escrow_lock", lovelace: "4000000" });
    expect(deviceVerifiedLine(r.verified!, "2.56477 ADA")).toMatch(
      /locks 4 ADA in the Masumi escrow addr_test1wz/,
    );
  });

  it("refuses tampered locks and terms that differ from the bytes", () => {
    expect(mismatch(checkReviewIntegrity(lockReview(V.tampered.lockOtherAddress)))).toMatch(
      /does not pay the Masumi escrow/,
    );
    expect(mismatch(checkReviewIntegrity(lockReview(V.tampered.lockOtherDatum)))).toMatch(/datum/);
    expect(mismatch(checkReviewIntegrity(lockReview(V.tampered.lockExtraOutput)))).toMatch(
      /more outputs/,
    );
    expect(
      mismatch(checkReviewIntegrity(lockReview(V.escrowLock.hex, { datumCbor: "d8799fff" }))),
    ).toMatch(/datum/);
    expect(mismatch(checkReviewIntegrity(lockReview(V.transferAda.hex)))).toMatch(/Masumi escrow/);
  });
});

describe("checkEscrowReviewIntegrity: refund spends decoded on device", () => {
  const prepared = async (action: "request_refund" | "withdraw_refund") => {
    resetMockState();
    const c = new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "sim",
    });
    const { review } = await c.call("getApproval", { params: { approvalId: fakeId(7, 8) } });
    const prep = await c.call("prepareX402RefundRequest", {
      params: { requestId: review.request.id },
    });
    const spend = prep.review.escrowSpend;
    if (spend === undefined) throw new Error("no escrowSpend");
    return (hex: string, over: Partial<typeof spend> = {}) =>
      realReview(prep.review, {}, hex, {
        escrowSpend: {
          ...spend,
          action,
          escrowUtxo: V.escrow.utxo,
          lockedLovelace: V.escrow.lockedLovelace,
          refundTo: V.from,
          validFrom: V.validFrom,
          validUntil: V.validUntil,
          ...over,
        },
      });
  };

  it("passes a real refund request and refuses tampered ones", async () => {
    const mk = await prepared("request_refund");
    const ok = checkEscrowReviewIntegrity(mk(V.refundRequest.hex), "request_refund", null);
    expect(ok.problems).toEqual([]);
    expect(ok.verified?.kind).toBe("request_refund");
    expect(
      mismatch(
        checkEscrowReviewIntegrity(
          mk(V.tampered.refundRequestChangeElsewhere),
          "request_refund",
          null,
        ),
      ),
    ).toMatch(/change to another address/);
    expect(
      mismatch(
        checkEscrowReviewIntegrity(
          mk(V.tampered.refundRequestDrainsEscrow),
          "request_refund",
          null,
        ),
      ),
    ).toMatch(/amount held in escrow/);
    expect(
      mismatch(
        checkEscrowReviewIntegrity(
          mk(V.refundRequest.hex, { escrowUtxo: `${"3".repeat(64)}#0` }),
          "request_refund",
          null,
        ),
      ),
    ).toMatch(/escrow shown/);
    // A withdrawal's bytes under a refund-request review.
    expect(
      mismatch(checkEscrowReviewIntegrity(mk(V.withdrawRefund.hex), "request_refund", null)),
    ).toMatch(/another action|keep the payment/);
  });

  it("passes a real withdrawal and refuses one paying elsewhere", async () => {
    const mk = await prepared("withdraw_refund");
    const ok = checkEscrowReviewIntegrity(mk(V.withdrawRefund.hex), "withdraw_refund", null);
    expect(ok.problems).toEqual([]);
    expect(ok.verified).toMatchObject({ kind: "withdraw_refund", payTo: V.from });
    expect(
      mismatch(checkEscrowReviewIntegrity(mk(V.tampered.withdrawToOther), "withdraw_refund", null)),
    ).toMatch(/refund to another address/);
    expect(
      mismatch(
        checkEscrowReviewIntegrity(
          mk(V.tampered.withdrawCollateralElsewhere),
          "withdraw_refund",
          null,
        ),
      ),
    ).toMatch(/collateral/);
  });
});
