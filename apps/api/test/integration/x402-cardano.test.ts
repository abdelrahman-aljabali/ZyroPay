/*
 * pay_x402 on Cardano preprod through the API, in mock-adapter mode (simulated chain and
 * Turnkey, real request engine): the agent asks, policy requires the passkey, the user signs
 * the body hash, the payment is handed to the MCP worker exactly as a PAYMENT-SIGNATURE
 * header, the request follows the chain to CONFIRMED and the reservation settles. Nothing
 * here touches a network.
 */
import { testEd25519PublicKey, testEd25519Sign } from "@zyropay/blockchain/testing";
import { cardanoEnterpriseAddress, x402ReceiptMessage } from "@zyropay/shared";
import { createHash } from "node:crypto";
import { mockPasskeyStamp } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import { sweep } from "../../src/services/execution";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, setPolicy, signUp } from "../helpers";

const TK = "https://api.turnkey.com";
const SELLER = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
const RESOURCE = "https://address-intel.zyropay.online/v1/address-report?address=addr_test1vabc";
/** TEST-ONLY seller key (fixed bytes) for delivery receipts, and its enterprise address. */
const RECEIPT_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
const RECEIPT_PK = Buffer.from(testEd25519PublicKey(RECEIPT_SECRET)).toString("hex");
const RECEIPT_SELLER = cardanoEnterpriseAddress(RECEIPT_PK, "cardano-preprod");
const BODY = JSON.stringify({ address: "addr_test1vabc", riskScore: 10 });
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

/** X-Delivery-Receipt as the seller sends it (base64 JSON), signed with `secret`. */
function receiptHeader(
  fields: {
    resourceUrl?: string;
    payTo?: string;
    paymentTx: string | null;
    contentSha256?: string;
  },
  secret = RECEIPT_SECRET,
): string {
  const unsigned = {
    resourceUrl: fields.resourceUrl ?? RESOURCE,
    payTo: fields.payTo ?? RECEIPT_SELLER,
    paymentTx: fields.paymentTx,
    contentSha256: fields.contentSha256 ?? BODY_SHA256,
    signedAt: "2026-10-30T12:00:00.000Z",
  };
  const signature = testEd25519Sign(secret, new TextEncoder().encode(x402ReceiptMessage(unsigned)));
  return Buffer.from(
    JSON.stringify({
      v: 1,
      ...unsigned,
      publicKey: Buffer.from(testEd25519PublicKey(secret)).toString("hex"),
      signature: Buffer.from(signature).toString("hex"),
    }),
  ).toString("base64");
}

function paymentRequired(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: RESOURCE, description: "Cardano address intelligence report" },
    accepts: [
      {
        scheme: "exact",
        network: "cardano:preprod",
        amount: "2000000",
        asset: "lovelace",
        payTo: SELLER,
        maxTimeoutSeconds: 600,
        extra: { assetTransferMethod: "default" },
        ...overrides,
      },
    ],
  };
}

function rawSign(
  credentialId: string,
  opts: { organizationId: string; signWith: string; payload: string; timestampMs: number },
) {
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(opts.timestampMs),
    organizationId: opts.organizationId,
    parameters: {
      signWith: opts.signWith,
      payload: opts.payload,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    },
  });
  return {
    url: `${TK}/public/v1/submit/sign_raw_payload`,
    body,
    stamp: mockPasskeyStamp(credentialId, body),
  };
}

function decodeHeader(value: string): any {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

describe("pay_x402 on Cardano preprod (mock adapters)", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;
  let publicKey: string;
  let address: string;

  const pay = (idempotencyKey: string, requirements = paymentRequired(), maxAmount = "3000000") =>
    call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
      internal: true,
      idempotencyKey,
      body: {
        tool: "pay_x402",
        input: {
          walletId: user.walletId,
          network: "cardano-preprod",
          resourceUrl: RESOURCE,
          method: "GET",
          maxAmount,
          assetId: "cardano-preprod:native",
          decimals: 6,
          idempotencyKey,
        },
        paymentRequirements: requirements,
      },
    });

  const status = (requestId: string) =>
    call(h, "GET", `/internal/v1/agents/${agentId}/transaction-requests/${requestId}`, {
      internal: true,
    });
  const handOff = (requestId: string) =>
    call(
      h,
      "POST",
      `/internal/v1/agents/${agentId}/transaction-requests/${requestId}/x402-payment`,
      { internal: true },
    );
  const report = (requestId: string, body: Record<string, unknown>) =>
    call(
      h,
      "POST",
      `/internal/v1/agents/${agentId}/transaction-requests/${requestId}/x402-delivery`,
      { internal: true, body },
    );

  async function approve(requestId: string) {
    const [approval] = await h.db
      .select()
      .from(t.approvalRequests)
      .where(eq(t.approvalRequests.transactionRequestId, requestId));
    if (approval === undefined) throw new Error("no approval");
    const detail = await call(h, "GET", `/v1/approvals/${approval.id}`, {
      token: user.accessToken,
    });
    expect(detail.status).toBe(200);
    const review = detail.json.review;
    return call(h, "POST", `/v1/approvals/${approval.id}/approve`, {
      token: user.accessToken,
      body: {
        payloadHash: review.payloadHash,
        signRequest: rawSign(user.credentialId, {
          organizationId: user.organizationId,
          signWith: review.rawPayload.signWith,
          payload: review.rawPayload.payload,
          timestampMs: h.clock.now().getTime(),
        }),
      },
    });
  }

  beforeAll(async () => {
    h = await createHarness({
      SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400",
      X402_CAPS: JSON.stringify({ "cardano-preprod:native": "5000000" }),
    });
    user = await signUp(h, "x402");
    const account = (await h.turnkey.listWalletAccounts(user.organizationId)).find(
      (a) => a.family === "cardano",
    );
    publicKey = account?.publicKey ?? "";
    address = cardanoEnterpriseAddress(publicKey, "cardano-preprod");
    agentId = await connectAgent(h, user, ["cardano-preprod"]);
    const enabled = await call(h, "PUT", "/v1/plugins/x402", {
      token: user.accessToken,
      body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    await setPolicy(h, user, agentId, {
      spendingEnabled: true,
      allowedProtocols: ["x402"],
      recipientAllowlist: [
        { family: "cardano", address: SELLER, label: "report seller" },
        { family: "cardano", address: RECEIPT_SELLER, label: "receipt seller" },
      ],
      limits: { perTransactionUsdMinor: "10000", dailyUsdMinor: "20000", monthlyUsdMinor: "50000" },
    });
  });

  it("asks the passkey, hands the signed payment to MCP once, and follows it to CONFIRMED", async () => {
    const created = await pay(`x402-ada-${Date.now()}`);
    expect(created.status).toBe(200);
    const { request } = created.json;
    expect(request.state).toBe("PENDING_APPROVAL");
    expect(request.x402).toEqual({
      status: "awaiting_signature",
      resourceUrl: RESOURCE,
      httpStatus: null,
      deliveredAt: null,
      receipt: null,
      proof: null,
      // A direct payment carries no registry identity claim.
      sellerIdentity: null,
    });
    // Nothing to hand off before the user signs.
    expect((await handOff(request.requestId)).status).toBe(409);

    const approved = await approve(request.requestId);
    expect(approved.status).toBe(200);
    expect(h.turnkey.signed.at(-1)).toMatchObject({ via: "passkey", kind: "raw_payload" });
    // Signed, not broadcast: the resource server settles it.
    const ready = await status(request.requestId);
    expect(ready.json.request.state).toBe("SIGNING");
    expect(ready.json.request.x402.status).toBe("ready");

    const first = await handOff(request.requestId);
    expect(first.status).toBe(200);
    const { payment } = first.json;
    expect(payment).toMatchObject({ resourceUrl: RESOURCE, method: "GET" });
    expect(payment.header.name).toBe("PAYMENT-SIGNATURE");
    expect(payment.txHash).toMatch(/^[0-9a-f]{64}$/);
    const header = decodeHeader(payment.header.value);
    expect(header).toMatchObject({
      x402Version: 2,
      resource: { url: RESOURCE },
      accepted: { network: "cardano:preprod", asset: "lovelace", amount: "2000000", payTo: SELLER },
    });
    expect(header.payload.transaction).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(header.payload.nonce).toMatch(/^[0-9a-f]{64}#\d+$/);

    // The request now tracks the transaction id derived from the signed bytes.
    const broadcast = await status(request.requestId);
    expect(broadcast.json.request).toMatchObject({ state: "BROADCAST", txHash: payment.txHash });
    expect(broadcast.json.request.explorerUrl).toContain(payment.txHash);
    // Handing off again returns the same bytes (they can only be spent once).
    const again = await handOff(request.requestId);
    expect(again.json.payment.header.value).toBe(payment.header.value);

    const delivered = await report(request.requestId, {
      httpStatus: 200,
      settled: true,
      transaction: payment.txHash,
      errorReason: null,
    });
    expect(delivered.status).toBe(200);
    expect(delivered.json.request.x402).toMatchObject({ status: "delivered", httpStatus: 200 });
    // This seller sent no receipt: recorded as such, never as verified.
    expect(delivered.json.request.x402.receipt).toMatchObject({
      verified: false,
      reason: "missing",
    });

    await h.drain();
    const [row] = await h.db
      .select()
      .from(t.transactionRequests)
      .where(eq(t.transactionRequests.id, request.requestId));
    expect(row?.state).toBe("CONFIRMED");
    const [ledger] = await h.db
      .select()
      .from(t.spendingLedger)
      .where(eq(t.spendingLedger.transactionRequestId, request.requestId));
    expect(ledger).toBeDefined();
    expect(row?.payload.from).toBe(address);
  });

  it("flags a receipt for another transaction and keeps the chain's view", async () => {
    const created = await pay(`x402-ada-mismatch-${Date.now()}`);
    await approve(created.json.request.requestId);
    const { payment } = (await handOff(created.json.request.requestId)).json;
    const res = await report(created.json.request.requestId, {
      httpStatus: 200,
      settled: true,
      transaction: "ff".repeat(32),
      errorReason: null,
    });
    expect(res.status).toBe(200);
    expect(res.json.request.txHash).toBe(payment.txHash);
    const audits = await h.db
      .select()
      .from(t.auditLogs)
      .where(eq(t.auditLogs.targetId, created.json.request.requestId));
    expect(audits.map((a) => a.action)).toContain("security.x402_receipt_mismatch");
  });

  it("a refused payment (402 again) stays deliverable", async () => {
    const created = await pay(`x402-ada-refused-${Date.now()}`);
    await approve(created.json.request.requestId);
    await handOff(created.json.request.requestId);
    const res = await report(created.json.request.requestId, {
      httpStatus: 402,
      settled: false,
      transaction: null,
      errorReason: "invalid_payload",
    });
    expect(res.json.request.x402).toMatchObject({ status: "ready", httpStatus: 402 });
  });

  it("refuses escrow requirements and prices above maxAmount before anything is created", async () => {
    const escrow = await pay(
      `x402-ada-escrow-${Date.now()}`,
      paymentRequired({ extra: { assetTransferMethod: "masumi" } }),
    );
    expect(escrow.status).toBeGreaterThanOrEqual(400);
    const pricey = await pay(`x402-ada-pricey-${Date.now()}`, paymentRequired(), "1000000");
    expect(pricey.status).toBe(400);
  });

  it("a seller outside the allowlist is denied outright (nothing reaches the user or the chain)", async () => {
    // A test-only key's enterprise address, not on the allowlist.
    const otherKey = testEd25519PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 50 + i));
    const other = cardanoEnterpriseAddress(
      Buffer.from(otherKey).toString("hex"),
      "cardano-preprod",
    );
    const created = await pay(`x402-ada-unknown-${Date.now()}`, paymentRequired({ payTo: other }));
    expect(created.status).toBe(200);
    expect(created.json.request.state).toBe("REJECTED");
    expect(created.json.request.approvalUrl).toBeNull();
    expect(created.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "RECIPIENT_NOT_ALLOWED",
    );
  });

  it("a signed payment never handed off fails once it expires and releases its reservation", async () => {
    const created = await pay(`x402-ada-stale-${Date.now()}`);
    await approve(created.json.request.requestId);
    expect((await status(created.json.request.requestId)).json.request.state).toBe("SIGNING");
    h.clock.advance(11 * 60_000);
    await sweep(h.deps);
    h.clock.advance(6 * 60_000);
    await sweep(h.deps);
    await h.drain();
    const after = (await status(created.json.request.requestId)).json.request;
    expect(after.state).toBe("FAILED");
    expect(after.x402.status).toBe("closed");
    const [reservation] = await h.db
      .select()
      .from(t.spendingReservations)
      .where(eq(t.spendingReservations.transactionRequestId, created.json.request.requestId));
    expect(reservation?.status).toBe("released");
    expect((await handOff(created.json.request.requestId)).status).toBe(409);
  });

  describe("verified delivery receipt", () => {
    const audits = async (requestId: string) =>
      (await h.db.select().from(t.auditLogs).where(eq(t.auditLogs.targetId, requestId))).map(
        (a) => ({ action: a.action, metadata: a.metadata }),
      );

    /** A paid, handed-off request to RECEIPT_SELLER: its id and transaction id. */
    async function paid(tag: string) {
      const created = await pay(
        `x402-receipt-${tag}-${Date.now()}`,
        paymentRequired({ payTo: RECEIPT_SELLER }),
      );
      expect(created.json.request.state).toBe("PENDING_APPROVAL");
      const requestId: string = created.json.request.requestId;
      await approve(requestId);
      const { payment } = (await handOff(requestId)).json;
      return { requestId, txHash: payment.txHash as string };
    }

    const deliver = (
      requestId: string,
      txHash: string,
      header: string,
      contentSha256 = BODY_SHA256,
    ) =>
      report(requestId, {
        httpStatus: 200,
        settled: true,
        transaction: txHash,
        errorReason: null,
        receipt: { header, contentSha256 },
      });

    it("a receipt signed by payTo's key over the delivered bytes is verified", async () => {
      const { requestId, txHash } = await paid("ok");
      const res = await deliver(requestId, txHash, receiptHeader({ paymentTx: txHash }));
      expect(res.status).toBe(200);
      expect(res.json.request.x402.receipt).toEqual({
        verified: true,
        contentSha256: BODY_SHA256,
        signedBy: RECEIPT_SELLER,
        signedAt: "2026-10-30T12:00:00.000Z",
        reason: null,
      });
      expect(await audits(requestId)).toContainEqual({
        action: "x402.delivery_verified",
        metadata: { contentSha256: BODY_SHA256, payTo: RECEIPT_SELLER },
      });
      // The app sees the same verdict on the approval.
      const [approval] = await h.db
        .select()
        .from(t.approvalRequests)
        .where(eq(t.approvalRequests.transactionRequestId, requestId));
      const detail = await call(h, "GET", `/v1/approvals/${approval!.id}`, {
        token: user.accessToken,
      });
      expect(detail.json.x402).toMatchObject({
        status: "delivered",
        receipt: { verified: true, signedBy: RECEIPT_SELLER },
      });
      // A later failed retry does not erase the verdict.
      const again = await report(requestId, {
        httpStatus: 502,
        settled: null,
        transaction: null,
        errorReason: "resource answered HTTP 502",
      });
      expect(again.json.request.x402.receipt.verified).toBe(true);
    });

    it.each([
      [
        "signed by a key that is not payTo's",
        (tx: string) =>
          receiptHeader(
            { paymentTx: tx },
            Uint8Array.from({ length: 32 }, (_, i) => 200 - i),
          ),
        BODY_SHA256,
        "wrong_signer",
      ],
      [
        "for bytes other than the ones delivered",
        (tx: string) => receiptHeader({ paymentTx: tx }),
        createHash("sha256").update(`${BODY} `).digest("hex"),
        "content_mismatch",
      ],
      [
        "for another resource URL",
        (tx: string) =>
          receiptHeader({ paymentTx: tx, resourceUrl: `${RESOURCE.split("?")[0]}?address=other` }),
        BODY_SHA256,
        "wrong_resource",
      ],
      [
        "for another payment",
        () => receiptHeader({ paymentTx: "ee".repeat(32) }),
        BODY_SHA256,
        "wrong_payment",
      ],
      [
        "that is not a receipt",
        () => Buffer.from("{}").toString("base64"),
        BODY_SHA256,
        "malformed",
      ],
    ])("a receipt %s is not verified and is audited", async (_, header, sha, reason) => {
      const { requestId, txHash } = await paid(reason);
      const res = await deliver(requestId, txHash, header(txHash), sha);
      expect(res.status).toBe(200);
      // Delivery is still recorded (the seller answered); only the verdict differs.
      expect(res.json.request.x402).toMatchObject({
        status: "delivered",
        receipt: { verified: false, signedBy: null, reason },
      });
      expect(await audits(requestId)).toContainEqual({
        action: "security.x402_receipt_invalid",
        metadata: { reason, contentSha256: sha },
      });
    });

    it("a forged signature is rejected", async () => {
      const { requestId, txHash } = await paid("sig");
      const decoded = JSON.parse(
        Buffer.from(receiptHeader({ paymentTx: txHash }), "base64").toString("utf8"),
      );
      decoded.signedAt = "2026-10-30T12:00:01.000Z";
      const res = await deliver(
        requestId,
        txHash,
        Buffer.from(JSON.stringify(decoded)).toString("base64"),
      );
      expect(res.json.request.x402.receipt).toMatchObject({
        verified: false,
        reason: "bad_signature",
      });
    });
  });
});
