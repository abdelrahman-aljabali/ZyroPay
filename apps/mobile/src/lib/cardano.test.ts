import {
  bech32Encode,
  nativeAsset,
  parseShelleyAddress,
  type Balance,
  type SigningReview,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import {
  ADA_PUBLIC_KEY_MAIN,
  ADDR,
  ASSETS,
  WALLET_MAIN,
  makeReviewForSend,
} from "@/api/mock/fixtures";
import { checkReviewIntegrity, stampForReview } from "./review";
import { checkRecipient } from "./send";
import {
  simulatedSigner,
  turnkeySignRawPayloadBody,
  turnkeyTransactionType,
} from "./turnkey/signer";

const adaBalance: Balance = {
  walletId: WALLET_MAIN,
  address: ADDR.adaMain,
  network: "cardano-preprod",
  asset: nativeAsset("cardano-preprod"),
  amount: "245500000",
  price: null,
  value: null,
};

describe("Cardano in the app (ADR-002)", () => {
  it("validates recipients: preprod key addresses only", () => {
    expect(checkRecipient(adaBalance, ADDR.friendAda)).toEqual({ ok: true, warning: null });
    const mainnet = checkRecipient(
      adaBalance,
      "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8",
    );
    expect(mainnet.ok ? "" : mainnet.error).toMatch(/addr_test1/);
    // A well-formed preprod SCRIPT address (header 0x70): refused, funds could be locked.
    const scriptAddress = bech32Encode(
      "addr_test",
      Uint8Array.from([0x70, ...new Array<number>(28).fill(7)]),
    );
    expect(parseShelleyAddress(scriptAddress)?.payment?.kind).toBe("script");
    const script = checkRecipient(adaBalance, scriptAddress);
    expect(script.ok).toBe(false);
    expect(checkRecipient(adaBalance, ADDR.adaMain).ok).toBe(false); // self-send
  });

  it("stamps SIGN_RAW_PAYLOAD (body hash, no hashing) for Cardano reviews", async () => {
    const review = makeReviewForSend(
      1,
      WALLET_MAIN,
      ASSETS.ada,
      ADDR.adaMain,
      ADDR.friendAda,
      "2000000",
    );
    expect(checkReviewIntegrity(review)).toEqual({ ok: true, problems: [] });
    const stamped = await stampForReview(simulatedSigner(), review, "org-1");
    expect(stamped.url).toMatch(/\/public\/v1\/submit\/sign_raw_payload$/);
    expect(JSON.parse(stamped.body)).toMatchObject({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      organizationId: "org-1",
      parameters: {
        signWith: ADA_PUBLIC_KEY_MAIN,
        payload: review.rawPayload?.payload,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      },
    });
    expect(
      turnkeySignRawPayloadBody({ organizationId: "o", signWith: "a", payload: "b" }, "1").type,
    ).toBe("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2");
    expect(() => turnkeyTransactionType("cardano-preprod")).toThrow(/SIGN_RAW_PAYLOAD/);
  });

  it("refuses a review whose signing key does not own the sender or whose payload is missing", () => {
    const review = makeReviewForSend(
      2,
      WALLET_MAIN,
      ASSETS.ada,
      ADDR.adaMain,
      ADDR.friendAda,
      "2000000",
    );
    const wrongKey: SigningReview = {
      ...review,
      rawPayload: { ...review.rawPayload!, signWith: "ab".repeat(32) },
    };
    expect(checkReviewIntegrity(wrongKey).ok).toBe(false);
    const { rawPayload: _drop, ...missing } = review;
    expect(checkReviewIntegrity(missing as SigningReview).ok).toBe(false);
    // A real (non-simulated) review must carry the hash of the body it ships.
    const real: SigningReview = {
      ...review,
      request: { ...review.request, simulated: false },
      rawPayload: { ...review.rawPayload!, payload: "cd".repeat(32) },
    };
    expect(checkReviewIntegrity(real).problems.join(" ")).toMatch(/does not match the transaction/);
  });

  it("mock transport: ADA balance, CIP-13 receive QR and a simulated send", async () => {
    resetMockState();
    const c = new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "simulated",
    });
    const portfolio = await c.call("getPortfolio", { query: { network: "cardano-preprod" } });
    expect(portfolio.portfolio.balances.map((b) => [b.asset.symbol, b.amount])).toEqual([
      ["ADA", "245500000"],
    ]);
    const receive = await c.call("getReceiveInfo", {
      query: { walletId: WALLET_MAIN, network: "cardano-preprod" },
    });
    expect(receive.qrPayload).toBe(`web+cardano:${ADDR.adaMain}`);
    const key = "ada-mock-send-0001";
    const quote = await c.call("quoteSend", {
      body: {
        walletId: WALLET_MAIN,
        network: "cardano-preprod",
        to: ADDR.friendAda,
        assetId: "cardano-preprod:native",
        amount: "2000000",
        decimals: 6,
        idempotencyKey: key,
      },
    });
    expect(quote.review.rawPayload?.signWith).toBe(ADA_PUBLIC_KEY_MAIN);
    const signRequest = await stampForReview(simulatedSigner(), quote.review, "org-1");
    const sent = await c.call("submitSend", {
      params: { requestId: quote.review.request.id },
      body: { payloadHash: quote.review.payloadHash, signRequest },
    });
    expect(sent.request.state).toBe("BROADCAST");
    expect(sent.request.txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
