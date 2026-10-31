/*
 * pay_x402 into Masumi escrow (x402 Cardano `assetTransferMethod: "masumi"`) through the API,
 * on mock adapters (simulated chain and Turnkey; the escrow chain is MockEscrowChain), with
 * the REAL Masumi validation: the 402 is issued by @x402/cardano's own issuer with a
 * TEST-ONLY seller mnemonic and the lock datum is built and checked by the integrations
 * code. Covers: lock -> passkey -> hand-off -> CONFIRMED -> escrow state from the chain,
 * refund request and withdrawal (passkey-signed escrow spends), the policy escrow rule, and
 * the refusals. Nothing touches a network or funds.
 */
import { Data } from "@evolution-sdk/evolution";
import * as x402c from "@x402/cardano";
import { masumiEscrowTermsOf } from "@zyropay/integrations";
import { mockPasskeyStamp } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as t from "../../src/db/tables";
import type { MockEscrowChain } from "../../src/providers/mocks";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, setPolicy, signUp } from "../helpers";

const TK = "https://api.turnkey.com";
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const RESOURCE = "https://seller.example.com/v1/jobs/7";
/** TEST ONLY: a throwaway BIP-39 phrase, never funded. */
const SELLER = x402c.toMasumiSellerSigner({
  mnemonic: "test walk nut penalty hip pave soap entry language right filter choice",
  network: "cardano:preprod",
});

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

describe("pay_x402 into Masumi escrow (mock adapters, real Masumi validation)", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;
  let escrowChain: MockEscrowChain;

  const now = () => h.clock.now().getTime();
  const advance = (ms: number) => {
    h.clock.advance(ms);
    vi.setSystemTime(h.clock.now());
  };

  async function masumiRequirement(amount = "4000000") {
    const payBy = now() + 4 * 60_000;
    return JSON.parse(
      JSON.stringify(
        await x402c.issueMasumiRequirements({
          network: "cardano:preprod",
          asset: "lovelace",
          amount,
          maxTimeoutSeconds: 300,
          sellerAddress: SELLER.sellerAddress,
          signTerms: SELLER.signTerms,
          commitment: [
            {
              name: "resource",
              canonicalization: "jcs",
              mediaType: "application/json",
              content: { url: RESOURCE },
            },
          ],
          payByTime: String(payBy),
          submitResultTime: String(payBy + 15 * 60_000),
          unlockTime: String(payBy + 35 * 60_000),
          externalDisputeUnlockTime: String(payBy + 55 * 60_000),
        }),
      ),
    ) as Record<string, unknown>;
  }

  const direct = (amount = "4000000") => ({
    scheme: "exact",
    network: "cardano:preprod",
    amount,
    asset: "lovelace",
    payTo: SELLER.sellerAddress,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: "default" },
  });

  const pay = (accepts: unknown[], escrow?: boolean, key = `masumi-${Math.random()}`) =>
    call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
      internal: true,
      idempotencyKey: key,
      body: {
        tool: "pay_x402",
        input: {
          walletId: user.walletId,
          network: "cardano-preprod",
          resourceUrl: RESOURCE,
          method: "GET",
          maxAmount: "5000000",
          assetId: "cardano-preprod:native",
          decimals: 6,
          idempotencyKey: key,
          ...(escrow !== undefined ? { escrow } : {}),
        },
        paymentRequirements: { x402Version: 2, resource: { url: RESOURCE }, accepts },
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
  const escrowOf = (requestId: string) =>
    call(h, "GET", `/v1/transaction-requests/${requestId}/escrow`, { token: user.accessToken });

  async function approve(requestId: string) {
    const [approval] = await h.db
      .select()
      .from(t.approvalRequests)
      .where(eq(t.approvalRequests.transactionRequestId, requestId));
    if (approval === undefined) throw new Error("no approval");
    const detail = await call(h, "GET", `/v1/approvals/${approval.id}`, {
      token: user.accessToken,
    });
    const review = detail.json.review;
    return call(h, "POST", `/v1/approvals/${approval.id}/approve`, {
      token: user.accessToken,
      body: {
        payloadHash: review.payloadHash,
        signRequest: rawSign(user.credentialId, {
          organizationId: user.organizationId,
          signWith: review.rawPayload.signWith,
          payload: review.rawPayload.payload,
          timestampMs: now(),
        }),
      },
    });
  }

  /** A confirmed escrow payment: its request id. */
  async function lockedPayment(): Promise<string> {
    const created = await pay([await masumiRequirement()], true);
    expect(created.status).toBe(200);
    const requestId: string = created.json.request.requestId;
    expect((await approve(requestId)).status).toBe(200);
    expect((await handOff(requestId)).status).toBe(200);
    await h.drain();
    return requestId;
  }

  const prepare = (requestId: string, action: "refund-request" | "withdraw-refund") =>
    call(h, "POST", `/v1/transaction-requests/${requestId}/escrow/${action}`, {
      token: user.accessToken,
    });

  function submitBody(review: any, overrides: Record<string, unknown> = {}) {
    return {
      payloadHash: review.payloadHash,
      bodyHash: review.rawPayload.payload,
      signRequest: rawSign(user.credentialId, {
        organizationId: user.organizationId,
        signWith: review.rawPayload.signWith,
        payload: review.rawPayload.payload,
        timestampMs: now(),
      }),
      ...overrides,
    };
  }

  const submit = (
    requestId: string,
    action: "refund-request" | "withdraw-refund",
    body: Record<string, unknown>,
  ) =>
    call(h, "POST", `/v1/transaction-requests/${requestId}/escrow/${action}/submit`, {
      token: user.accessToken,
      body,
    });

  /** The seller authorizes the refund (vested_pay AuthorizeRefund), as a datum on chain. */
  function sellerAuthorizesRefund(utxo: string, lovelace: string) {
    const [txHash = "", index = "0"] = utxo.split("#");
    const read = escrowChain.utxos.get(utxo);
    const datum = read?.inlineDatum;
    if (datum === undefined) throw new Error("no escrow utxo to authorize");
    const data = Data.fromCBORHex(datum) as Data.Constr;
    const fields = [...data.fields];
    fields[11] = Data.bytearray("");
    fields[16] = BigInt(now() + 420_000);
    fields[17] = 0n;
    fields[18] = Data.constr(5n, []);
    return escrowChain.sellerMove(
      { txHash, index: Number(index) },
      Data.toCBORHex(Data.constr(0n, fields)),
      lovelace,
    );
  }

  beforeAll(async () => {
    h = await createHarness({
      SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400",
      X402_CAPS: JSON.stringify({ "cardano-preprod:native": "10000000" }),
    });
    // @x402/cardano reads the clock itself: keep it on the harness clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(h.clock.now());
    escrowChain = h.deps.chain.cardanoEscrow("cardano-preprod") as MockEscrowChain;
    user = await signUp(h, "masumi");
    agentId = await connectAgent(h, user, ["cardano-preprod"]);
    expect(
      (
        await call(h, "PUT", "/v1/plugins/x402", {
          token: user.accessToken,
          body: { enabled: true },
        })
      ).status,
    ).toBe(200);
    await setPolicy(h, user, agentId, {
      spendingEnabled: true,
      allowedProtocols: ["x402"],
      // The allowlist names the SELLER: an escrow payment is to the seller, not the script.
      recipientAllowlist: [{ family: "cardano", address: SELLER.sellerAddress, label: "seller" }],
      limits: { perTransactionUsdMinor: "10000", dailyUsdMinor: "50000", monthlyUsdMinor: "90000" },
    });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("locks into escrow, follows it on chain, and refunds through request + seller authorization", async () => {
    const created = await pay([direct(), await masumiRequirement()], true);
    expect(created.status).toBe(200);
    const { request } = created.json;
    expect(request.state).toBe("PENDING_APPROVAL");
    expect(request.x402.escrow).toMatchObject({
      method: "masumi",
      state: "locking",
      escrowAddress: ESCROW,
      sellerAddress: SELLER.sellerAddress,
      lockTx: null,
      lockedLovelace: "4000000",
      collateralLovelace: "0",
      resultHash: null,
    });
    const [row] = await h.db
      .select()
      .from(t.transactionRequests)
      .where(eq(t.transactionRequests.id, request.requestId));
    expect(row?.payload.to).toBe(ESCROW);
    expect(row?.payload.pluginData?.escrow).toMatchObject({
      method: "masumi",
      escrowAddress: ESCROW,
    });
    // The request ends at the seller's payByTime.
    expect(Date.parse(request.expiresAt)).toBeLessThanOrEqual(now() + 4 * 60_000);

    expect((await approve(request.requestId)).status).toBe(200);
    const paid = await handOff(request.requestId);
    expect(paid.status).toBe(200);
    const header = JSON.parse(Buffer.from(paid.json.payment.header.value, "base64").toString());
    expect(header.accepted.extra.assetTransferMethod).toBe("masumi");
    expect(header.accepted.payTo).toBe(ESCROW);
    await h.drain();

    const locked = (await status(request.requestId)).json.request;
    expect(locked.state).toBe("CONFIRMED");
    expect(locked.x402.escrow).toMatchObject({
      state: "funds_locked",
      lockTx: paid.json.payment.txHash,
      utxo: `${paid.json.payment.txHash}#0`,
      refund: { available: ["request_refund"], pending: null },
    });
    expect(locked.x402.escrow.refund.withdrawableAt).toBe(
      locked.x402.escrow.deadlines.submitResult,
    );

    // Request the refund: an escrow spend reviewed and signed like an approval.
    const prepared = await prepare(request.requestId, "refund-request");
    expect(prepared.status).toBe(200);
    const review = prepared.json.review;
    expect(review.payloadHash).toBe(request.payloadHash);
    expect(review.escrowSpend).toMatchObject({
      action: "request_refund",
      escrowUtxo: `${paid.json.payment.txHash}#0`,
      lockedLovelace: "4000000",
    });
    expect(review.rawPayload.kind).toBe("cardano_tx_body_hash");
    expect(prepared.json.escrow.refund.pending).toMatchObject({ status: "awaiting_signature" });

    // A signature over anything else is refused (and audited).
    const forged = await submit(
      request.requestId,
      "refund-request",
      submitBody(review, { bodyHash: "ab".repeat(32) }),
    );
    expect(forged.status).toBe(409);
    expect(forged.json.error.code).toBe("PAYLOAD_HASH_MISMATCH");
    const wrongStamp = submitBody(review);
    wrongStamp.signRequest = rawSign(user.credentialId, {
      organizationId: user.organizationId,
      signWith: review.rawPayload.signWith,
      payload: "cd".repeat(32),
      timestampMs: now(),
    });
    const stampRefused = await submit(request.requestId, "refund-request", wrongStamp);
    expect(stampRefused.json.error.code).toBe("PAYLOAD_HASH_MISMATCH");

    const sent = await submit(request.requestId, "refund-request", submitBody(review));
    expect(sent.status).toBe(200);
    expect(sent.json.escrow.refund.pending).toMatchObject({
      action: "request_refund",
      status: "submitted",
    });
    const requestTx = sent.json.escrow.refund.pending.txHash;
    expect(requestTx).toMatch(/^[0-9a-f]{64}$/);
    // The same build cannot be signed twice.
    const twice = await submit(request.requestId, "refund-request", submitBody(review));
    expect(twice.status).toBe(409);
    expect(twice.json.error.code).toBe("CONFLICT");

    const requested = (await escrowOf(request.requestId)).json.escrow;
    expect(requested).toMatchObject({
      state: "refund_requested",
      utxo: `${requestTx}#0`,
      refund: { requestTx, pending: { status: "confirmed" }, available: [] },
    });
    // Without the seller the refund waits for the result deadline.
    const early = await prepare(request.requestId, "withdraw-refund");
    expect(early.status).toBe(409);
    expect(early.json.error.message).toMatch(/not possible|after the result deadline/);

    // The seller authorizes the refund on chain: the buyer may withdraw at once.
    sellerAuthorizesRefund(`${requestTx}#0`, "4000000");
    const authorized = await prepare(request.requestId, "withdraw-refund");
    expect(authorized.status).toBe(200);
    expect(authorized.json.escrow.state).toBe("refund_authorized");
    const withdrawn = await submit(
      request.requestId,
      "withdraw-refund",
      submitBody(authorized.json.review),
    );
    expect(withdrawn.status).toBe(200);
    const done = (await status(request.requestId)).json.request.x402.escrow;
    expect(done).toMatchObject({ state: "refunded", refund: { available: [] } });
    expect(done.refund.withdrawTx).toMatch(/^[0-9a-f]{64}$/);

    const actions = (
      await h.db.select().from(t.auditLogs).where(eq(t.auditLogs.targetId, request.requestId))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "x402.escrow_spend_prepared",
        "security.sign_request_rejected",
        "x402.escrow_refund_requested",
        "x402.escrow_refund_request_confirmed",
        "x402.escrow_refund_withdrawn",
      ]),
    );
  });

  it("withdraws a refund without the seller once the result deadline passed", async () => {
    const requestId = await lockedPayment();
    expect((await prepare(requestId, "withdraw-refund")).status).toBe(409);
    advance(20 * 60_000);
    const prepared = await prepare(requestId, "withdraw-refund");
    expect(prepared.status).toBe(200);
    expect(prepared.json.escrow.state).toBe("funds_locked");
    const sent = await submit(requestId, "withdraw-refund", submitBody(prepared.json.review));
    expect(sent.status).toBe(200);
    expect((await escrowOf(requestId)).json.escrow.state).toBe("refunded");
  });

  it("withdraw waits until the chain tip (not only the clock) passed the result deadline", async () => {
    const requestId = await lockedPayment();
    const deadline = Date.parse((await escrowOf(requestId)).json.escrow.deadlines.submitResult);
    advance(deadline - now() + 10_000);
    // The clock is past the deadline, the tip 60 slots behind it: the node would refuse.
    escrowChain.tipLagSlots = 60n;
    try {
      const early = await prepare(requestId, "withdraw-refund");
      expect(early.status).toBe(409);
      expect(early.json.error.message).toContain("shortly after the result deadline");
      expect(Date.parse(early.json.error.details.retryAfter)).toBeGreaterThan(now());
      escrowChain.tipLagSlots = 5n;
      const prepared = await prepare(requestId, "withdraw-refund");
      expect(prepared.status).toBe(200);
      const tip = await escrowChain.tipSlot();
      const spend = JSON.parse(
        Buffer.from(prepared.json.review.unsignedTransaction.serialized, "hex").toString(),
      ) as { validityStartSlot: string };
      expect(BigInt(spend.validityStartSlot)).toBeLessThanOrEqual(tip);
      // A provider far behind the clock is not built on.
      escrowChain.tipLagSlots = 3_600n;
      expect((await prepare(requestId, "withdraw-refund")).status).toBe(502);
    } finally {
      escrowChain.tipLagSlots = 0n;
    }
  });

  it("a refund request's lower bound is never ahead of a lagging chain tip", async () => {
    const requestId = await lockedPayment();
    escrowChain.tipLagSlots = 90n;
    try {
      const prepared = await prepare(requestId, "refund-request");
      expect(prepared.status).toBe(200);
      const spend = JSON.parse(
        Buffer.from(prepared.json.review.unsignedTransaction.serialized, "hex").toString(),
      ) as { validityStartSlot: string; ttlSlot: string };
      const tip = await escrowChain.tipSlot();
      expect(BigInt(spend.validityStartSlot)).toBeLessThanOrEqual(tip);
      // The TTL is counted from the clock, so the lag does not shorten the signing window.
      expect(BigInt(spend.ttlSlot) - tip).toBeGreaterThan(600n);
    } finally {
      escrowChain.tipLagSlots = 0n;
    }
  });

  it("a retry with the same key after a failed build is a new attempt, then replays it", async () => {
    const key = `masumi-retry-${Math.random()}`;
    const accepts = [await masumiRequirement()];
    escrowChain.failNextLocks = 1;
    const failed = await pay(accepts, true, key);
    expect(failed.status).toBe(200);
    expect(failed.json.request.state).toBe("CANCELLED");
    expect(failed.json.request.failureReason).toContain("retrying the same request tries again");
    const retried = await pay(accepts, true, key);
    expect(retried.status).toBe(200);
    expect(retried.json.request.state).toBe("PENDING_APPROVAL");
    expect(retried.json.request.requestId).not.toBe(failed.json.request.requestId);
    // The new attempt is now what the key stands for.
    const again = await pay(accepts, true, key);
    expect(again.json.request.requestId).toBe(retried.json.request.requestId);
    // The failed attempt keeps its history.
    const [old] = await h.db
      .select()
      .from(t.transactionRequests)
      .where(eq(t.transactionRequests.id, failed.json.request.requestId));
    expect(old?.state).toBe("CANCELLED");
  });

  it("a seller who collects shows as withdrawn; no buyer action remains", async () => {
    const requestId = await lockedPayment();
    const escrow = (await escrowOf(requestId)).json.escrow;
    const [txHash = "", index = "0"] = String(escrow.utxo).split("#");
    escrowChain.sellerWithdraw({ txHash, index: Number(index) });
    advance(30_000);
    expect((await escrowOf(requestId)).json.escrow).toMatchObject({
      state: "withdrawn",
      refund: { available: [] },
    });
    expect((await prepare(requestId, "refund-request")).status).toBe(409);
  });

  it("refuses escrow actions on requests without escrow or before the lock is confirmed", async () => {
    const plain = await pay([direct()], false);
    expect(plain.json.request.x402.escrow).toBeUndefined();
    expect((await escrowOf(plain.json.request.requestId)).status).toBe(404);
    const pending = await pay([await masumiRequirement()], true);
    expect((await prepare(pending.json.request.requestId, "refund-request")).status).toBe(409);
    // escrow: true when the resource does not offer it.
    expect((await pay([direct()], true)).status).toBe(400);
  });

  it("policy x402EscrowAboveUsdMinor: prefers escrow when offered, asks the user otherwise", async () => {
    await setPolicy(h, user, agentId, { x402EscrowAboveUsdMinor: "0" });
    const policy = await call(h, "GET", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
    });
    expect(policy.json.policy.x402EscrowAboveUsdMinor).toBe("0");
    // Both offered, agent silent: escrow is picked.
    const picked = await pay([direct(), await masumiRequirement()]);
    expect(picked.json.request.x402.escrow?.method).toBe("masumi");
    expect(picked.json.request.reasons.map((r: { code: string }) => r.code)).not.toContain(
      "ESCROW_REQUIRED",
    );
    // Only a direct payment offered: the policy says escrow, so the user must decide.
    const directOnly = await pay([direct()]);
    expect(directOnly.json.request.state).toBe("PENDING_APPROVAL");
    expect(directOnly.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "ESCROW_REQUIRED",
    );
    // With overLimitBehavior deny it is refused outright.
    await setPolicy(h, user, agentId, { overLimitBehavior: "deny" });
    const denied = await pay([direct()]);
    expect(denied.json.request.state).toBe("REJECTED");
    // A policy update without the field (an older app) keeps it.
    const current = (
      await call(h, "GET", `/v1/agents/${agentId}/policy`, { token: user.accessToken })
    ).json.policy;
    const { version, revoked: _revoked, x402EscrowAboveUsdMinor: _kept, ...older } = current;
    const res = await call(h, "PUT", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
      body: {
        expectedVersion: version,
        policy: { ...older, overLimitBehavior: "require_approval" },
      },
    });
    expect(res.status).toBe(200);
    const after = await call(h, "GET", `/v1/agents/${agentId}/policy`, { token: user.accessToken });
    expect(after.json.policy.x402EscrowAboveUsdMinor).toBe("0");
    await setPolicy(h, user, agentId, { x402EscrowAboveUsdMinor: null });
  });
  describe("proof before release (received body vs on-chain result_hash)", () => {
    const BODY_HASH = "c0".repeat(32);

    /** The agent's delivery report, with the MCP worker's own hash of the received body. */
    const report = (requestId: string, contentSha256: string | null) =>
      call(
        h,
        "POST",
        `/internal/v1/agents/${agentId}/transaction-requests/${requestId}/x402-delivery`,
        {
          internal: true,
          body: {
            httpStatus: 200,
            settled: true,
            transaction: null,
            errorReason: null,
            receipt: { header: null, contentSha256 },
          },
        },
      );

    /** The seller's SubmitResult: result_hash set, state ResultSubmitted, as a datum on chain. */
    async function sellerSubmitsResult(requestId: string, resultHash: string) {
      const [row] = await h.db
        .select()
        .from(t.transactionRequests)
        .where(eq(t.transactionRequests.id, requestId));
      const terms = masumiEscrowTermsOf(row?.payload.pluginData);
      if (terms === null) throw new Error("no escrow terms");
      const escrow = (await escrowOf(requestId)).json.escrow;
      const [txHash = "", index = "0"] = String(escrow.utxo).split("#");
      const data = Data.fromCBORHex(terms.datumCbor) as Data.Constr;
      const fields = [...data.fields];
      fields[11] = Data.bytearray(resultHash);
      fields[18] = Data.constr(1n, []);
      return escrowChain.sellerMove(
        { txHash, index: Number(index) },
        Data.toCBORHex(Data.constr(0n, fields)),
        terms.lockedLovelace,
      );
    }

    const auditsOf = async (requestId: string) =>
      (await h.db.select().from(t.auditLogs).where(eq(t.auditLogs.targetId, requestId))).map(
        (a) => a.action,
      );

    it("verified: the agent's body hash equals the seller's on-chain result", async () => {
      const requestId = await lockedPayment();
      const delivered = await report(requestId, BODY_HASH);
      expect(delivered.status).toBe(200);
      expect(delivered.json.request.x402.proof).toMatchObject({
        state: "pending",
        receivedHash: BODY_HASH,
        onChainHash: null,
      });
      const moved = await sellerSubmitsResult(requestId, BODY_HASH);
      advance(30_000);
      const polled = await status(requestId);
      expect(polled.json.request.x402.escrow.state).toBe("result_submitted");
      expect(polled.json.request.x402.proof).toMatchObject({
        state: "verified",
        receivedHash: BODY_HASH,
        onChainHash: BODY_HASH,
        resultTx: moved.txHash,
      });
      expect(polled.json.request.x402.escrow.refund.recommended).toBeNull();
      // The app's escrow view carries the same verdict.
      expect((await escrowOf(requestId)).json.escrow.proof.state).toBe("verified");
      advance(30_000);
      await status(requestId);
      const audits = await auditsOf(requestId);
      expect(audits.filter((a) => a === "x402.proof_verified")).toHaveLength(1);
    });

    it("mismatch: recommends a refund request and audits it as a security event", async () => {
      const requestId = await lockedPayment();
      await sellerSubmitsResult(requestId, "d1".repeat(32));
      advance(30_000);
      expect((await status(requestId)).json.request.x402.proof.state).toBe("pending");
      const delivered = await report(requestId, BODY_HASH);
      const { x402 } = delivered.json.request;
      expect(x402.proof).toMatchObject({
        state: "mismatch",
        receivedHash: BODY_HASH,
        onChainHash: "d1".repeat(32),
      });
      expect(x402.proof.message).toMatch(/does not match/);
      expect(x402.escrow.refund).toMatchObject({
        available: ["request_refund"],
        recommended: "request_refund",
      });
      expect(x402.escrow.refund.reason).toMatch(/request a refund/);
      expect(await auditsOf(requestId)).toContain("security.x402_proof_mismatch");
    });

    it("not_delivered: no result before the submitResult deadline recommends the withdrawal", async () => {
      const requestId = await lockedPayment();
      await report(requestId, BODY_HASH);
      advance(20 * 60_000);
      const { x402 } = (await status(requestId)).json.request;
      expect(x402.escrow.state).toBe("funds_locked");
      expect(x402.proof).toMatchObject({ state: "not_delivered", onChainHash: null });
      expect(x402.escrow.refund.recommended).toBe("withdraw_refund");
      expect(x402.escrow.refund.reason).toMatch(/did not record a result/);
      expect(await auditsOf(requestId)).toContain("x402.proof_not_delivered");
    });

    it("a direct payment is receipt_only (nothing recorded on chain)", async () => {
      const created = await pay([direct()], false);
      const requestId: string = created.json.request.requestId;
      expect(created.json.request.x402.proof).toBeNull();
      expect((await approve(requestId)).status).toBe(200);
      expect((await handOff(requestId)).status).toBe(200);
      const delivered = await report(requestId, BODY_HASH);
      expect(delivered.json.request.x402.proof).toMatchObject({
        state: "receipt_only",
        receivedHash: BODY_HASH,
        onChainHash: null,
        resultTx: null,
      });
    });
  });
});
