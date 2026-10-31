/*
 * Auto-pay on Cardano (docs/AUTOPAY.md) through the API in mock-adapter mode: the REAL
 * allowance planners build real CBOR over a simulated UTxO ledger (MockAllowanceChain), the
 * owner signs create / revoke with the (mock) passkey, and the agent key pays from the
 * allowance without any approval. Nothing here touches a network.
 */
import type { AllowanceReview } from "@zyropay/shared";
import {
  cardanoPaymentKeyHash,
  checkCardanoAllowanceCreateTx,
  checkCardanoAllowanceOwnerSpendTx,
  decodeCardanoUnsignedTx,
  encodeAllowanceDatumHex,
} from "@zyropay/shared";
import { mockPasskeyStamp } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { MockAllowanceChain } from "../../src/providers/mocks";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, setPolicy, signUp } from "../helpers";

const TK = "https://api.turnkey.com";
const SELLER = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
const OTHER = "addr_test1vru7fmgv4vyyqfj53t4nvkhgylrh09tlwx89xvpj8qnerhq3yr2xv";
const RESOURCE = "https://address-intel.zyropay.online/v1/address-report?address=addr_test1vabc";
const ADA = 1_000_000;

function keyHashOf(address: string): string {
  const kh = cardanoPaymentKeyHash(address);
  if (kh === null) throw new Error(`not a key address: ${address}`);
  return kh;
}

function paymentRequired(amount = "2000000", payTo = SELLER) {
  return {
    x402Version: 2,
    resource: { url: RESOURCE, description: "Cardano address intelligence report" },
    accepts: [
      {
        scheme: "exact",
        network: "cardano:preprod",
        amount,
        asset: "lovelace",
        payTo,
        maxTimeoutSeconds: 600,
        extra: { assetTransferMethod: "default" },
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

describe("auto-pay on Cardano: the agent pays from its on-chain allowance", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;
  let ledger: MockAllowanceChain;
  let seq = 0;
  const key = (label: string) => `autopay-${label}-${String(++seq)}`;

  const base = () => `/v1/agents/${agentId}/allowance`;
  const get = () => call(h, "GET", base(), { token: user.accessToken });
  const submit = (
    review: AllowanceReview,
    override: Partial<{ bodyHash: string; payload: string }> = {},
  ) =>
    call(h, "POST", `${base()}/submit`, {
      token: user.accessToken,
      body: {
        bodyHash: override.bodyHash ?? review.rawPayload.payload,
        signRequest: rawSign(user.credentialId, {
          organizationId: user.organizationId,
          signWith: review.rawPayload.signWith,
          payload: override.payload ?? review.rawPayload.payload,
          timestampMs: h.clock.now().getTime(),
        }),
      },
    });
  const pay = (idempotencyKey: string, requirements = paymentRequired(), maxAmount = "5000000") =>
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
  const send = (idempotencyKey: string, amount: string, to = SELLER) =>
    call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
      internal: true,
      idempotencyKey,
      body: {
        tool: "send",
        input: {
          walletId: user.walletId,
          network: "cardano-preprod",
          to,
          assetId: "cardano-preprod:native",
          amount,
          decimals: 6,
          idempotencyKey,
        },
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
      {
        internal: true,
      },
    );
  async function signedOf(requestId: string): Promise<string> {
    const [a] = await h.db
      .select()
      .from(t.transactionRequestArtifacts)
      .where(eq(t.transactionRequestArtifacts.transactionRequestId, requestId));
    return a?.signedTransaction ?? "";
  }

  beforeAll(async () => {
    h = await createHarness({
      SESSION_ACCESS_TOKEN_TTL_SECONDS: "864000",
      X402_CAPS: JSON.stringify({ "cardano-preprod:native": "5000000" }),
    });
    ledger = h.deps.chain.cardanoAllowance("cardano-preprod") as MockAllowanceChain;
    user = await signUp(h, "autopay");
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
      recipientAllowlist: [
        { family: "cardano", address: SELLER, label: "report seller" },
        { family: "cardano", address: OTHER, label: "other" },
      ],
      limits: { perTransactionUsdMinor: "10000", dailyUsdMinor: "20000", monthlyUsdMinor: "50000" },
    });
  });

  it("without an allowance, a Cardano payment still needs the passkey", async () => {
    expect((await get()).json).toEqual({ allowance: null });
    const created = await pay(key("no-allowance"));
    expect(created.json.request).toMatchObject({ state: "PENDING_APPROVAL" });
    expect(created.json.request.autoPay).toBeUndefined();
  });

  it("refuses limits that do not make sense", async () => {
    const bad = await call(h, "POST", base(), {
      token: user.accessToken,
      body: {
        walletId: user.walletId,
        network: "cardano-preprod",
        budget: { lovelace: String(20 * ADA) },
        perPayment: { lovelace: String(5 * ADA) },
        perDay: { lovelace: String(3 * ADA) },
        payees: { mode: "list", addresses: [SELLER] },
        expiresInDays: 7,
      },
    });
    expect(bad.status).toBe(400);
  });

  let createReview: AllowanceReview;

  it("creates the allowance with one passkey signature, checked like the device does", async () => {
    const created = await call(h, "POST", base(), {
      token: user.accessToken,
      body: {
        walletId: user.walletId,
        network: "cardano-preprod",
        budget: { lovelace: String(20 * ADA) },
        perPayment: { lovelace: String(3 * ADA) },
        perDay: { lovelace: String(5 * ADA) },
        payees: { mode: "list", addresses: [SELLER] },
        expiresInDays: 7,
      },
    });
    expect(created.status).toBe(200);
    const { allowance, review } = created.json as {
      allowance: Record<string, any>;
      review: AllowanceReview;
    };
    createReview = review;
    expect(allowance).toMatchObject({
      status: "pending_create",
      ownerAddress: expect.stringMatching(/^addr_test1v/),
      scriptAddress: expect.stringMatching(/^addr_test1w/),
      limits: {
        perPaymentLovelace: String(3 * ADA),
        perDayLovelace: String(5 * ADA),
        payees: { mode: "list", addresses: [SELLER] },
        fiat: null,
      },
      floatLovelace: String(5 * ADA),
      onChain: null,
    });
    expect(review.action).toBe("create");
    expect(review.expect.kind).toBe("create");
    if (review.expect.kind !== "create") throw new Error("unreachable");
    // The device check on the exact bytes.
    const check = checkCardanoAllowanceCreateTx(review.unsignedTransaction.serialized, {
      network: "cardano-preprod",
      owner: review.expect.owner,
      agentAddress: review.expect.agentAddress,
      allowanceLovelace: BigInt(review.expect.allowanceLovelace),
      floatLovelace: BigInt(review.expect.floatLovelace),
      datum: review.expect.datum,
      maxFee: BigInt(review.expect.maxFeeLovelace),
      now: h.clock.now(),
    });
    expect(check).toMatchObject({ ok: true });
    // Tampered bytes (a server that raised the per-payment limit in the datum, or sent the
    // float elsewhere) fail the same device check.
    const honestDatum = encodeAllowanceDatumHex(review.expect.datum);
    const raisedDatum = encodeAllowanceDatumHex({
      ...review.expect.datum,
      perPaymentMax: "9000000",
    });
    expect(review.unsignedTransaction.serialized).toContain(honestDatum);
    const createExpect = {
      network: "cardano-preprod" as const,
      owner: review.expect.owner,
      agentAddress: review.expect.agentAddress,
      allowanceLovelace: BigInt(review.expect.allowanceLovelace),
      floatLovelace: BigInt(review.expect.floatLovelace),
      datum: review.expect.datum,
      maxFee: BigInt(review.expect.maxFeeLovelace),
      now: h.clock.now(),
    };
    expect(
      checkCardanoAllowanceCreateTx(
        review.unsignedTransaction.serialized.replace(honestDatum, raisedDatum),
        createExpect,
      ),
    ).toMatchObject({ ok: false });
    const agentKh = keyHashOf(review.expect.agentAddress);
    const otherKh = keyHashOf(OTHER);
    expect(
      checkCardanoAllowanceCreateTx(
        review.unsignedTransaction.serialized.replaceAll(agentKh, otherKh),
        createExpect,
      ),
    ).toMatchObject({ ok: false });
    expect(review.expect.datum).toMatchObject({
      perPaymentMax: String(3 * ADA),
      periodCap: String(5 * ADA),
      spentInPeriod: "0",
      periodMs: "86400000",
    });
    // The secret key never leaves the API.
    expect(JSON.stringify(created.json)).not.toMatch(/encrypted|seed|secret/i);
    const [row] = await h.db.select().from(t.cardanoAllowances);
    expect(row?.encryptedAgentKey).not.toContain(row?.agentPublicKey ?? "x");
  });

  it("refuses a submit for another body or a stamp over other bytes", async () => {
    const otherBody = await submit(createReview, { bodyHash: "ab".repeat(32) });
    expect(otherBody.status).toBe(409);
    expect(otherBody.json.error.code).toBe("PAYLOAD_HASH_MISMATCH");
    const otherStamp = await submit(createReview, { payload: "cd".repeat(32) });
    expect(otherStamp.json.error.code).toBe("PAYLOAD_HASH_MISMATCH");
    const audits = await h.db
      .select()
      .from(t.auditLogs)
      .where(eq(t.auditLogs.action, "security.allowance_sign_rejected"));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("submits the create, and the allowance becomes active once it is on chain", async () => {
    const done = await submit(createReview);
    expect(done.status).toBe(200);
    // The mock ledger applied it on submit, so the read already finds it.
    expect(done.json.allowance.createTxHash).toMatch(/^[0-9a-f]{64}$/);
    const read = await get();
    expect(read.json.allowance).toMatchObject({
      status: "active",
      onChain: {
        balanceLovelace: String(20 * ADA),
        spentInPeriodLovelace: "0",
        remainingTodayLovelace: String(5 * ADA),
        availableNowLovelace: String(3 * ADA),
      },
      float: { lovelace: String(5 * ADA), low: false },
    });
    // The same review cannot be signed twice.
    expect((await submit(createReview)).status).toBe(409);
    // One live allowance per agent.
    const again = await call(h, "POST", base(), {
      token: user.accessToken,
      body: {
        walletId: user.walletId,
        network: "cardano-preprod",
        budget: { lovelace: String(20 * ADA) },
        perPayment: { lovelace: String(3 * ADA) },
        perDay: { lovelace: String(5 * ADA) },
        payees: { mode: "any" },
        expiresInDays: 7,
      },
    });
    expect(again.status).toBe(409);
  });

  let firstRequest = "";
  let firstKey = "";

  it("pays an x402 resource without a passkey tap, within the on-chain limits", async () => {
    firstKey = key("auto");
    const created = await pay(firstKey);
    expect(created.status).toBe(200);
    const { request } = created.json;
    expect(request).toMatchObject({
      state: "APPROVED",
      decision: "allow",
      reasons: [{ code: "AUTO_PAY_ALLOWANCE" }],
      approvalUrl: null,
      autoPay: {
        lovelace: "2000000",
        txHash: null,
        balanceLovelace: String(18 * ADA),
        remainingTodayLovelace: String(3 * ADA),
        message: "Auto-paid 2 ADA from your on-chain allowance (no tap needed); 3 ADA left today.",
      },
    });
    firstRequest = request.requestId;
    const approvals = await h.db
      .select()
      .from(t.approvalRequests)
      .where(eq(t.approvalRequests.transactionRequestId, request.requestId));
    expect(approvals).toHaveLength(0);

    // A second payment while the first is still in flight falls back to the passkey.
    const busy = await pay(key("busy"));
    expect(busy.json.request.state).toBe("PENDING_APPROVAL");
    expect(busy.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "ALLOWANCE_BUSY",
    );

    await h.drain();
    const ready = await status(request.requestId);
    expect(ready.json.request).toMatchObject({ state: "SIGNING", x402: { status: "ready" } });
    expect(ready.json.request.autoPay.txHash).toMatch(/^[0-9a-f]{64}$/);

    // What the agent key signed: the allowance spend, decoded independently.
    const signed = await signedOf(request.requestId);
    const unsigned = signed.slice(0, -64);
    const tx = decodeCardanoUnsignedTx(unsigned, "cardano-preprod");
    const allowance = (await get()).json.allowance;
    expect(tx.outputs[0]?.address).toBe(allowance.scriptAddress);
    expect(tx.outputs[0]?.lovelace).toBe(BigInt(18 * ADA));
    expect(tx.outputs[1]).toMatchObject({ address: SELLER, lovelace: 2_000_000n });
    expect(tx.redeemers).toEqual([expect.objectContaining({ dataHex: "d87980" })]);
    expect(h.turnkey.signed.filter((s) => s.kind === "raw_payload")).toHaveLength(1); // only the create

    const handed = await handOff(request.requestId);
    expect(handed.status).toBe(200);
    expect(handed.json.payment.txHash).toBe(ready.json.request.autoPay.txHash);
    // The seller's facilitator submits it; the mock ledger applies it.
    ledger.land(signed);
    await h.drain();
    const done = await status(request.requestId);
    expect(done.json.request.state).toBe("CONFIRMED");
    const after = (await get()).json.allowance;
    expect(after.onChain).toMatchObject({
      balanceLovelace: String(18 * ADA),
      spentInPeriodLovelace: "2000000",
      remainingTodayLovelace: String(3 * ADA),
    });
    expect(Number(after.float.lovelace)).toBeLessThan(5 * ADA);
    const audits = await h.db
      .select()
      .from(t.auditLogs)
      .where(eq(t.auditLogs.action, "tx_request.auto_paid_from_allowance"));
    expect(audits).toHaveLength(1);
  });

  it("is idempotent: the same key returns the same auto-paid request", async () => {
    const again = await pay(firstKey);
    expect(again.json.request).toMatchObject({
      requestId: firstRequest,
      state: "CONFIRMED",
      autoPay: { lovelace: "2000000", txHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    const spends = await h.db
      .select()
      .from(t.cardanoAllowanceSpends)
      .where(eq(t.cardanoAllowanceSpends.transactionRequestId, firstRequest));
    expect(spends).toHaveLength(1);
    const [spend] = await h.db
      .select()
      .from(t.cardanoAllowanceSpends)
      .where(eq(t.cardanoAllowanceSpends.transactionRequestId, firstRequest));
    expect(spend?.txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the passkey over the per-payment limit or for an unlisted payee", async () => {
    const over = await pay(key("over"), paymentRequired("4000000"));
    expect(over.json.request.state).toBe("PENDING_APPROVAL");
    expect(over.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "ALLOWANCE_LIMIT_EXCEEDED",
    );
    const other = await send(key("other"), "1000000", OTHER);
    expect(other.json.request.state).toBe("PENDING_APPROVAL");
    expect(other.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "ALLOWANCE_PAYEE_NOT_LISTED",
    );
  });

  it("auto-pays a plain send and submits it itself; the daily cap then sends to the passkey", async () => {
    const sent = await send(key("send"), "2500000");
    expect(sent.json.request).toMatchObject({ state: "APPROVED", decision: "allow" });
    await h.drain();
    const done = await status(sent.json.request.requestId);
    expect(done.json.request.state).toBe("CONFIRMED");
    expect(done.json.request.autoPay).toMatchObject({ lovelace: "2500000" });
    const readRes = await get();
    const read = readRes.json.allowance;
    expect(read.onChain).toMatchObject({
      spentInPeriodLovelace: "4500000",
      remainingTodayLovelace: "500000",
    });
    // 4.5 + 1 > 5 ADA per day: the chain would refuse, so ZyroPay asks the passkey.
    const capped = await send(key("cap"), "1000000");
    expect(capped.json.request.state).toBe("PENDING_APPROVAL");
    expect(capped.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "ALLOWANCE_LIMIT_EXCEEDED",
    );
    // The next UTC day the window rolls over and auto-pay works again.
    h.clock.advance(86_400_000);
    const nextDay = await send(key("next-day"), "1000000");
    expect(nextDay.json.request.state).toBe("APPROVED");
    await h.drain();
    expect((await status(nextDay.json.request.requestId)).json.request.state).toBe("CONFIRMED");
    expect((await get()).json.allowance.onChain.spentInPeriodLovelace).toBe("1000000");
  });

  it("lists the agent's payments", async () => {
    const spends = await call(h, "GET", `${base()}/spends`, { token: user.accessToken });
    expect(spends.status).toBe(200);
    expect(spends.json.spends.map((s: { lovelace: string }) => s.lovelace)).toEqual([
      "1000000",
      "2500000",
      "2000000",
    ]);
    expect(spends.json.spends.every((s: { status: string }) => s.status === "confirmed")).toBe(
      true,
    );
  });

  it("tops up with the passkey, keeping the limits and the window", async () => {
    const prepared = await call(h, "POST", `${base()}/top-up`, {
      token: user.accessToken,
      body: { budget: { lovelace: String(10 * ADA) } },
    });
    expect(prepared.status).toBe(200);
    const review = prepared.json.review as AllowanceReview;
    if (review.expect.kind !== "top_up") throw new Error("expected a top-up");
    expect(
      checkCardanoAllowanceOwnerSpendTx(review.unsignedTransaction.serialized, {
        network: "cardano-preprod",
        action: "top_up",
        owner: review.expect.owner,
        utxo: review.expect.utxo,
        newLovelace: BigInt(review.expect.newLovelace),
        datum: review.expect.datum,
        maxFee: BigInt(review.expect.maxFeeLovelace),
        validFrom: review.expect.validFrom,
        validUntil: review.expect.validUntil,
        now: h.clock.now(),
      }),
    ).toMatchObject({ ok: true });
    const honest = encodeAllowanceDatumHex(review.expect.datum);
    const widened = encodeAllowanceDatumHex({ ...review.expect.datum, periodCap: "9000000" });
    expect(
      checkCardanoAllowanceOwnerSpendTx(
        review.unsignedTransaction.serialized.replace(honest, widened),
        {
          network: "cardano-preprod",
          action: "top_up",
          owner: review.expect.owner,
          utxo: review.expect.utxo,
          newLovelace: BigInt(review.expect.newLovelace),
          datum: review.expect.datum,
          maxFee: BigInt(review.expect.maxFeeLovelace),
          validFrom: review.expect.validFrom,
          validUntil: review.expect.validUntil,
          now: h.clock.now(),
        },
      ),
    ).toMatchObject({ ok: false });
    expect((await submit(review)).status).toBe(200);
    expect((await get()).json.allowance.onChain).toMatchObject({
      balanceLovelace: String(24.5 * ADA),
      spentInPeriodLovelace: "1000000",
    });
  });

  it("revokes with the passkey: the budget and the float come back, the key is destroyed", async () => {
    const prepared = await call(h, "POST", `${base()}/revoke`, { token: user.accessToken });
    expect(prepared.status).toBe(200);
    const review = prepared.json.review as AllowanceReview;
    if (review.expect.kind !== "revoke") throw new Error("expected a revoke");
    expect(
      checkCardanoAllowanceOwnerSpendTx(review.unsignedTransaction.serialized, {
        network: "cardano-preprod",
        action: "revoke",
        owner: review.expect.owner,
        utxo: review.expect.utxo,
        maxFee: BigInt(review.expect.maxFeeLovelace),
        validFrom: review.expect.validFrom,
        validUntil: review.expect.validUntil,
        now: h.clock.now(),
      }),
    ).toMatchObject({ ok: true });
    // The same revoke paying someone else (every owner key hash swapped) is refused.
    const ownerKh = keyHashOf(review.expect.owner);
    expect(
      checkCardanoAllowanceOwnerSpendTx(
        review.unsignedTransaction.serialized.replaceAll(ownerKh, keyHashOf(OTHER)),
        {
          network: "cardano-preprod",
          action: "revoke",
          owner: review.expect.owner,
          utxo: review.expect.utxo,
          maxFee: BigInt(review.expect.maxFeeLovelace),
          validFrom: review.expect.validFrom,
          validUntil: review.expect.validUntil,
          now: h.clock.now(),
        },
      ),
    ).toMatchObject({ ok: false });
    const done = await submit(review);
    expect(done.status).toBe(200);
    // The chain shows the allowance gone: revoked. After that the agent has none.
    expect((await get()).json.allowance).toMatchObject({ status: "revoked", onChain: null });
    expect((await get()).json.allowance).toBeNull();
    const [row] = await h.db.select().from(t.cardanoAllowances);
    expect(row).toMatchObject({ status: "revoked", encryptedAgentKey: "destroyed" });
    expect(await ledger.adaBalance(row?.agentAddress ?? "")).toBe(0n);
    // Back to the passkey.
    const after = await pay(key("after-revoke"));
    expect(after.json.request.state).toBe("PENDING_APPROVAL");
  });

  it("a second allowance in USD: limits converted once at creation, both stored", async () => {
    const created = await call(h, "POST", base(), {
      token: user.accessToken,
      body: {
        walletId: user.walletId,
        network: "cardano-preprod",
        budget: { lovelace: String(15 * ADA) },
        perPayment: { fiat: { currency: "USD", amount: "1.50" } },
        perDay: { fiat: { currency: "USD", amount: "3.00" } },
        payees: { mode: "any" },
        expiresInDays: 1,
      },
    });
    expect(created.status).toBe(200);
    const { allowance, review } = created.json as {
      allowance: Record<string, any>;
      review: AllowanceReview;
    };
    expect(allowance.limits.fiat).toMatchObject({
      currency: "USD",
      perPayment: "1.50",
      perDay: "3.00",
      budget: null,
    });
    const price = Number(allowance.limits.fiat.adaPrice);
    expect(Number(allowance.limits.perPaymentLovelace)).toBe(Math.floor((1.5 / price) * ADA));
    expect(review.expect.kind === "create" && review.expect.datum.allowedPayees).toEqual([]);
    expect((await submit(review)).status).toBe(200);
    expect((await get()).json.allowance.status).toBe("active");
  });

  it("two concurrent requests: one is auto-paid, the other waits for the passkey", async () => {
    const amount = String(
      Math.min(1_000_000, Number((await get()).json.allowance.onChain.availableNowLovelace)),
    );
    const [a, b] = await Promise.all([send(key("race-a"), amount), send(key("race-b"), amount)]);
    const states = [a.json.request.state, b.json.request.state].sort();
    expect(states).toEqual(["APPROVED", "PENDING_APPROVAL"]);
    const waiting = [a, b].find((r) => r.json.request.state === "PENDING_APPROVAL");
    expect(waiting?.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "ALLOWANCE_BUSY",
    );
    await h.drain();
  });

  it("a spend the chain's evaluator refuses fails the request and releases its reservation", async () => {
    ledger.failNextAgentPays = 1;
    const created = await send(key("refused"), "1000000");
    expect(created.json.request.state).toBe("APPROVED");
    await h.drain();
    const failed = await status(created.json.request.requestId);
    expect(failed.json.request.state).toBe("FAILED");
    expect(failed.json.request.failureReason).toMatch(/auto-pay could not be built/);
    const [reservation] = await h.db
      .select()
      .from(t.spendingReservations)
      .where(eq(t.spendingReservations.transactionRequestId, created.json.request.requestId));
    expect(reservation?.status).toBe("released");
    // Not busy afterwards: the next one is auto-paid.
    const next = await send(key("after-refusal"), "1000000");
    expect(next.json.request.state).toBe("APPROVED");
    await h.drain();
  });

  const reasonsOf = (r: { json: any }) =>
    (r.json.request.reasons as { code: string }[]).map((x) => x.code);

  it("falls back with ALLOWANCE_INSUFFICIENT when the agent's float cannot pay the fee", async () => {
    const agentAddress = (await get()).json.allowance.agentAddress as string;
    const stash = [...ledger.utxos].filter(([, u]) => u.address === agentAddress);
    for (const [k] of stash) ledger.utxos.delete(k);
    ledger.fund(agentAddress, 1_000_000n);
    const low = await send(key("low-float"), "1000000");
    expect(low.json.request.state).toBe("PENDING_APPROVAL");
    expect(reasonsOf(low)).toContain("ALLOWANCE_INSUFFICIENT");
    expect((await get()).json.allowance.float).toMatchObject({ low: true });
    for (const [k, u] of [...ledger.utxos]) if (u.address === agentAddress) ledger.utxos.delete(k);
    for (const [k, u] of stash) ledger.utxos.set(k, u);
  });

  it("falls back with ALLOWANCE_UNAVAILABLE when the chain cannot be read", async () => {
    ledger.failNextReads = 1;
    const down = await send(key("chain-down"), "1000000");
    expect(down.json.request.state).toBe("PENDING_APPROVAL");
    expect(reasonsOf(down)).toContain("ALLOWANCE_UNAVAILABLE");
    // Once the chain answers again, auto-pay is back.
    const up = await send(key("chain-up"), "1000000");
    expect(up.json.request.state).toBe("APPROVED");
    await h.drain();
  });

  it("falls back with ALLOWANCE_EXPIRED after expiresAt (revoke still returns the rest)", async () => {
    h.clock.advance(2 * 86_400_000);
    expect((await get()).json.allowance.status).toBe("expired");
    const late = await send(key("expired"), "1000000");
    expect(late.json.request.state).toBe("PENDING_APPROVAL");
    expect(reasonsOf(late)).toContain("ALLOWANCE_EXPIRED");
    const prepared = await call(h, "POST", `${base()}/revoke`, { token: user.accessToken });
    expect(prepared.status).toBe(200);
    expect((await submit(prepared.json.review as AllowanceReview)).status).toBe(200);
    expect((await get()).json.allowance).toMatchObject({ status: "revoked" });
    const rows = await h.db.select().from(t.cardanoAllowances);
    expect(rows.every((r) => r.encryptedAgentKey === "destroyed")).toBe(true);
  });
});
