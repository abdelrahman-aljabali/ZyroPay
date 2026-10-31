import { createPriceProvider } from "@zyropay/blockchain";
import { fixtureFetch, noSleep } from "@zyropay/blockchain/testing";
import type { PriceProvider } from "@zyropay/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import { mockUsdcAssetId } from "../../src/providers/mocks";
import { sweep } from "../../src/services/execution";
import type { Harness, TestUser } from "../helpers";
import {
  call,
  connectAgent,
  createHarness,
  enableDelegatedSigner,
  sendInput,
  setPolicy,
  signUp,
  stampedSign,
} from "../helpers";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

async function agentRequest(h: Harness, agentId: string, body: any) {
  return call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
    internal: true,
    body,
    idempotencyKey: body.input.idempotencyKey,
  });
}

async function reservationOf(h: Harness, requestId: string) {
  const [r] = await h.db
    .select()
    .from(t.spendingReservations)
    .where(eq(t.spendingReservations.transactionRequestId, requestId));
  return r;
}

async function approvalIdOf(h: Harness, requestId: string): Promise<string> {
  const [a] = await h.db
    .select()
    .from(t.approvalRequests)
    .where(eq(t.approvalRequests.transactionRequestId, requestId));
  if (a === undefined) throw new Error("no approval");
  return a.id;
}

async function approve(
  h: Harness,
  user: TestUser,
  approvalId: string,
  mutate?: (s: ReturnType<typeof stampedSign>) => ReturnType<typeof stampedSign>,
) {
  const detail = await call(h, "GET", `/v1/approvals/${approvalId}`, { token: user.accessToken });
  const review = detail.json.review;
  let signRequest = stampedSign(user.credentialId, {
    organizationId: user.organizationId,
    signWith: review.payload.from,
    network: review.payload.network,
    unsigned: review.unsignedTransaction,
    timestampMs: h.clock.now().getTime(),
  });
  if (mutate) signRequest = mutate(signRequest);
  return call(h, "POST", `/v1/approvals/${approvalId}/approve`, {
    token: user.accessToken,
    body: { payloadHash: review.payloadHash, signRequest },
  });
}

describe("transaction request engine", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    const device = await call(h, "POST", "/v1/notifications/devices", {
      token: user.accessToken,
      body: { expoPushToken: "ExponentPushToken[test-device]", platform: "ios" },
    });
    expect(device.status).toBe(200);
    agentId = await connectAgent(h, user);
  });

  it("a freshly connected agent cannot spend (default policy denies)", async () => {
    const res = await agentRequest(h, agentId, sendInput(user));
    expect(res.status).toBe(200);
    expect(res.json.request.state).toBe("REJECTED");
    expect(res.json.request.decision).toBe("deny");
    expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toEqual(
      expect.arrayContaining(["SPENDING_DISABLED", "RECIPIENT_NOT_ALLOWED"]),
    );
    expect(await reservationOf(h, res.json.request.requestId)).toBeUndefined();
  });

  describe("always ask", () => {
    beforeAll(async () => {
      await setPolicy(h, user, agentId, {
        spendingEnabled: true,
        recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: "friend" }],
        limits: {
          perTransactionUsdMinor: "10000",
          dailyUsdMinor: "20000",
          monthlyUsdMinor: "100000",
        },
      });
    });

    it("creates a pending approval with a reservation and a push, then approve -> broadcast -> confirm -> ledger", async () => {
      const res = await agentRequest(h, agentId, sendInput(user));
      expect(res.json.request.state).toBe("PENDING_APPROVAL");
      expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain("ALWAYS_ASK");
      expect(res.json.request.approvalUrl).toMatch(/^zyropay:\/\/approvals\//);
      const requestId = res.json.request.requestId;
      expect((await reservationOf(h, requestId))?.status).toBe("active");
      expect((await reservationOf(h, requestId))?.amountUsdMinor).toBe("1500"); // 0.1 SOL @ $150, server-side valuation
      expect(h.queue.messages.some((m) => m.message.type === "notify")).toBe(true);
      await h.drain();
      expect(h.notifier.sent.some((n) => n.notification.kind === "approval_requested")).toBe(true);

      const approvalId = await approvalIdOf(h, requestId);
      const approved = await approve(h, user, approvalId);
      expect(approved.status).toBe(200);
      expect(approved.json.approval.status).toBe("approved");
      expect(approved.json.request.state).toBe("BROADCAST");
      expect(approved.json.request.txHash).toBeTruthy();
      expect(h.turnkey.signed.at(-1)?.via).toBe("passkey");

      await h.drain(); // confirmation poll
      const polled = await call(
        h,
        "GET",
        `/internal/v1/agents/${agentId}/transaction-requests/${requestId}`,
        { internal: true },
      );
      expect(polled.json.request.state).toBe("CONFIRMED");
      expect((await reservationOf(h, requestId))?.status).toBe("settled");
      const ledger = await h.db
        .select()
        .from(t.spendingLedger)
        .where(eq(t.spendingLedger.transactionRequestId, requestId));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.amountUsdMinor).toBe("1500");
      const executed = await h.db
        .select()
        .from(t.executedTransactions)
        .where(eq(t.executedTransactions.transactionRequestId, requestId));
      expect(executed[0]?.status).toBe("confirmed");
    });

    it("rejecting releases the reservation", async () => {
      const res = await agentRequest(h, agentId, sendInput(user));
      const approvalId = await approvalIdOf(h, res.json.request.requestId);
      const rejected = await call(h, "POST", `/v1/approvals/${approvalId}/reject`, {
        token: user.accessToken,
        body: { reason: "no" },
      });
      expect(rejected.status).toBe(200);
      expect(rejected.json.request.state).toBe("REJECTED");
      expect((await reservationOf(h, res.json.request.requestId))?.status).toBe("released");
      // Deciding again is refused.
      const again = await call(h, "POST", `/v1/approvals/${approvalId}/reject`, {
        token: user.accessToken,
        body: {},
      });
      expect(again.status).toBe(409);
    });

    it("idempotent retries return the original request; changed params conflict", async () => {
      const body = sendInput(user);
      const first = await agentRequest(h, agentId, body);
      const retry = await agentRequest(h, agentId, body);
      expect(retry.json.request.requestId).toBe(first.json.request.requestId);
      const changed = await agentRequest(h, agentId, {
        ...body,
        input: { ...body.input, amount: "200000000" },
      });
      expect(changed.status).toBe(409);
      expect(changed.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
      const rows = await h.db
        .select()
        .from(t.transactionRequests)
        .where(
          and(
            eq(t.transactionRequests.userId, user.userId),
            eq(t.transactionRequests.idempotencyKey, body.input.idempotencyKey),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it("requires the Idempotency-Key header to match the body", async () => {
      const body = sendInput(user);
      const missing = await call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
        internal: true,
        body,
      });
      expect(missing.status).toBe(400);
      const mismatch = await call(
        h,
        "POST",
        `/internal/v1/agents/${agentId}/transaction-requests`,
        { internal: true, body, idempotencyKey: "different-key-123" },
      );
      expect(mismatch.status).toBe(400);
    });

    it("fails closed without a price: approval required with VALUATION_UNAVAILABLE, no reservation amount guessed", async () => {
      h.prices.unpriced.add("solana-devnet:native");
      try {
        const res = await agentRequest(h, agentId, sendInput(user));
        expect(res.json.request.state).toBe("PENDING_APPROVAL");
        expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
          "VALUATION_UNAVAILABLE",
        );
        expect(await reservationOf(h, res.json.request.requestId)).toBeUndefined();
      } finally {
        h.prices.unpriced.clear();
      }
    });

    it("validates decimals, addresses, balances and network mode server side", async () => {
      const wrongDecimals = await agentRequest(h, agentId, sendInput(user, { decimals: 6 }));
      expect(wrongDecimals.json.error.code).toBe("DECIMALS_MISMATCH");
      const badAddress = await agentRequest(
        h,
        agentId,
        sendInput(user, { to: "0x52908400098527886E0F7030069857D2E4169EE7" }),
      );
      expect(badAddress.json.error.code).toBe("INVALID_ADDRESS");
      const tooMuch = await agentRequest(h, agentId, sendInput(user, { amount: "999000000000" }));
      expect(tooMuch.json.error.code).toBe("INSUFFICIENT_FUNDS");
      const mainnet = await agentRequest(
        h,
        agentId,
        sendInput(user, { network: "solana-mainnet", assetId: "solana-mainnet:native" }),
      );
      expect(mainnet.json.error.code).toBe("NETWORK_MODE_MISMATCH");
    });

    it("expiry sweeper expires pending approvals and releases reservations", async () => {
      const res = await agentRequest(h, agentId, sendInput(user));
      const requestId = res.json.request.requestId;
      h.clock.advance(16 * 60_000);
      const result = await sweep(h.deps);
      expect(result.expired).toBeGreaterThan(0);
      const [row] = await h.db
        .select()
        .from(t.transactionRequests)
        .where(eq(t.transactionRequests.id, requestId));
      expect(row?.state).toBe("EXPIRED");
      expect((await reservationOf(h, requestId))?.status).toBe("released");
      const [approval] = await h.db
        .select()
        .from(t.approvalRequests)
        .where(eq(t.approvalRequests.transactionRequestId, requestId));
      expect(approval?.status).toBe("expired");
      await h.drain();
      expect(h.notifier.sent.some((n) => n.notification.data.type === "approval_expired")).toBe(
        true,
      );
    });

    it("illegal transitions are refused", async () => {
      const res = await agentRequest(h, agentId, sendInput(user));
      const requestId = res.json.request.requestId;
      const cancelled = await call(h, "POST", `/v1/transaction-requests/${requestId}/cancel`, {
        token: user.accessToken,
      });
      expect(cancelled.json.request.state).toBe("CANCELLED");
      expect((await reservationOf(h, requestId))?.status).toBe("released");
      const again = await call(h, "POST", `/v1/transaction-requests/${requestId}/cancel`, {
        token: user.accessToken,
      });
      expect(again.status).toBe(409);
      expect(again.json.error.code).toBe("ILLEGAL_STATE_TRANSITION");
    });
  });

  describe("autonomous", () => {
    let autoAgent: string;
    beforeAll(async () => {
      autoAgent = await connectAgent(h, user);
      await enableDelegatedSigner(h, user);
      await setPolicy(h, user, autoAgent, {
        mode: "autonomous",
        spendingEnabled: true,
        recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
        limits: {
          perTransactionUsdMinor: "2000",
          dailyUsdMinor: "4000",
          monthlyUsdMinor: "100000",
        },
        overLimitBehavior: "deny",
      });
    });

    it("refuses autonomous mode without an active delegated signer", async () => {
      const other = await signUp(h);
      const a = await connectAgent(h, other);
      const current = await call(h, "GET", `/v1/agents/${a}/policy`, { token: other.accessToken });
      const { version, revoked: _r, ...policy } = current.json.policy;
      const res = await call(h, "PUT", `/v1/agents/${a}/policy`, {
        token: other.accessToken,
        body: { expectedVersion: version, policy: { ...policy, mode: "autonomous" } },
      });
      expect(res.status).toBe(403);
    });

    it("signs within limits with the delegated key, exactly once", async () => {
      const res = await agentRequest(h, autoAgent, sendInput(user));
      expect(res.json.request.state).toBe("APPROVED");
      const execute = h.queue.messages.filter((m) => m.message.type === "execute");
      expect(execute).toHaveLength(1);
      // Duplicate delivery of the execute message must not sign twice.
      h.queue.messages.push({ ...execute[0]!, delaySeconds: 0 });
      const before = h.turnkey.signed.length;
      await h.drain();
      expect(h.turnkey.signed.length - before).toBe(1);
      expect(h.turnkey.signed.at(-1)?.via).toBe("delegated");
      const polled = await call(
        h,
        "GET",
        `/internal/v1/agents/${autoAgent}/transaction-requests/${res.json.request.requestId}`,
        { internal: true },
      );
      expect(polled.json.request.state).toBe("CONFIRMED");
    });

    it("over the limit with overLimitBehavior=deny is rejected", async () => {
      const res = await agentRequest(h, autoAgent, sendInput(user, { amount: "200000000" })); // $30 > $20 per tx
      expect(res.json.request.state).toBe("REJECTED");
      expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
        "PER_TRANSACTION_LIMIT_EXCEEDED",
      );
    });

    it("version conflicts on policy updates are reported", async () => {
      const current = await call(h, "GET", `/v1/agents/${autoAgent}/policy`, {
        token: user.accessToken,
      });
      const { version, revoked: _r, ...policy } = current.json.policy;
      const stale = await call(h, "PUT", `/v1/agents/${autoAgent}/policy`, {
        token: user.accessToken,
        body: { expectedVersion: version - 1, policy },
      });
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe("VERSION_CONFLICT");
    });

    it("retries a failed broadcast from the queue with the same signed bytes", async () => {
      h.broadcaster.failNext = 1;
      const res = await agentRequest(h, autoAgent, sendInput(user, { amount: "10000000" }));
      expect(res.json.request.state).toBe("APPROVED");
      await h.drain();
      const polled = await call(
        h,
        "GET",
        `/internal/v1/agents/${autoAgent}/transaction-requests/${res.json.request.requestId}`,
        { internal: true },
      );
      expect(polled.json.request.state).toBe("CONFIRMED");
    });
  });

  describe("in-app send", () => {
    it("quote -> passkey submit -> broadcast; resubmit refused; idempotent quote", async () => {
      const key = `app-send-${Date.now()}`;
      const body = {
        walletId: user.walletId,
        network: "base-sepolia",
        to: "0x52908400098527886E0F7030069857D2E4169EE7",
        assetId: mockUsdcAssetId("base-sepolia"),
        amount: "5000000",
        decimals: 6,
        idempotencyKey: key,
      };
      const quote = await call(h, "POST", "/v1/send/quote", {
        token: user.accessToken,
        body,
        idempotencyKey: key,
      });
      expect(quote.status).toBe(200);
      const review = quote.json.review;
      expect(review.request.state).toBe("CREATED");
      expect(review.warnings.map((w: { code: string }) => w.code)).toEqual(
        expect.arrayContaining(["TESTNET", "SIMULATED", "FIRST_TIME_RECIPIENT"]),
      );
      const again = await call(h, "POST", "/v1/send/quote", {
        token: user.accessToken,
        body,
        idempotencyKey: key,
      });
      expect(again.json.review.request.id).toBe(review.request.id);

      const signRequest = stampedSign(user.credentialId, {
        organizationId: user.organizationId,
        signWith: user.evm,
        network: "base-sepolia",
        unsigned: review.unsignedTransaction,
        timestampMs: h.clock.now().getTime(),
      });
      const submitted = await call(h, "POST", `/v1/send/${review.request.id}/submit`, {
        token: user.accessToken,
        body: { payloadHash: review.payloadHash, signRequest },
      });
      expect(submitted.status).toBe(200);
      expect(submitted.json.request.state).toBe("BROADCAST");
      const twice = await call(h, "POST", `/v1/send/${review.request.id}/submit`, {
        token: user.accessToken,
        body: { payloadHash: review.payloadHash, signRequest },
      });
      expect(twice.status).toBe(409);
    });
  });

  describe("plugins", () => {
    it("a swap on a test network is refused with SWAP_UNAVAILABLE_ON_NETWORK, never simulated", async () => {
      const before = await h.db
        .select()
        .from(t.transactionRequests)
        .where(eq(t.transactionRequests.agentId, agentId));
      const res = await agentRequest(h, agentId, {
        tool: "swap",
        input: {
          walletId: user.walletId,
          network: "solana-devnet",
          inputAssetId: "solana-devnet:native",
          outputAssetId: mockUsdcAssetId("solana-devnet"),
          amount: "10000000",
          decimals: 9,
          slippageBps: 50,
          idempotencyKey: `swap-${Date.now()}`,
        },
      });
      expect(res.status).toBe(422);
      expect(res.json.error).toEqual({
        code: "SWAP_UNAVAILABLE_ON_NETWORK",
        message:
          "Swaps are available on Solana mainnet only. This wallet is on Solana Devnet (test network), so no swap can be made.",
        details: { network: "solana-devnet" },
      });
      const evm = await agentRequest(h, agentId, {
        tool: "swap",
        input: {
          walletId: user.walletId,
          network: "base-sepolia",
          inputAssetId: "base-sepolia:native",
          outputAssetId: mockUsdcAssetId("base-sepolia"),
          amount: "1000",
          decimals: 18,
          slippageBps: 50,
          idempotencyKey: `swap-evm-${Date.now()}`,
        },
      });
      expect(evm.json.error.code).toBe("SWAP_UNAVAILABLE_ON_NETWORK");
      expect(evm.json.error.message).toContain("Base Sepolia (test network)");
      // Nothing was created, and there is no swap plugin to enable in this deployment.
      const after = await h.db
        .select()
        .from(t.transactionRequests)
        .where(eq(t.transactionRequests.agentId, agentId));
      expect(after.length).toBe(before.length);
      const enable = await call(h, "PUT", "/v1/plugins/jupiter", {
        token: user.accessToken,
        body: { enabled: true },
      });
      expect(enable.json.error.code).toBe("PLUGIN_DISABLED");
    });

    it("x402 refuses requirements above the agent's maxAmount", async () => {
      const res = await agentRequest(h, agentId, {
        tool: "pay_x402",
        input: {
          walletId: user.walletId,
          network: "base-sepolia",
          resourceUrl: "https://api.example/paid",
          method: "GET",
          maxAmount: "1000",
          assetId: mockUsdcAssetId("base-sepolia"),
          decimals: 6,
          idempotencyKey: `x402-${Date.now()}`,
        },
        paymentRequirements: {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "5000",
          payTo: "0x52908400098527886E0F7030069857D2E4169EE7",
          asset: mockUsdcAssetId("base-sepolia").split(":")[1],
          resource: "https://api.example/paid",
        },
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("policy decisions on testnets valued at mainnet prices", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;
  const proxied = (on: boolean): PriceProvider =>
    createPriceProvider({
      fetch: fixtureFetch({
        rest: {
          "/price/v3": { So11111111111111111111111111111111111111112: { usdPrice: 150 } },
        },
      }),
      sleep: noSleep,
      now: h.clock.now,
      valueTestnetsAtMainnetPrices: on,
    });
  const usePrices = (p: PriceProvider) => {
    (h.deps as { prices: PriceProvider }).prices = p;
  };

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    agentId = await connectAgent(h, user);
    await enableDelegatedSigner(h, user);
    await setPolicy(h, user, agentId, {
      mode: "autonomous",
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
      limits: { perTransactionUsdMinor: "2000", dailyUsdMinor: "4000", monthlyUsdMinor: "100000" },
      overLimitBehavior: "deny",
    });
  });

  it("devnet SOL at the mainnet SOL price: within the limit it is signed autonomously", async () => {
    usePrices(proxied(true));
    const res = await agentRequest(h, agentId, sendInput(user)); // 0.1 SOL * $150 = $15
    expect(res.json.request.state).toBe("APPROVED");
    expect((await reservationOf(h, res.json.request.requestId))?.amountUsdMinor).toBe("1500");
  });

  it("devnet SOL at the mainnet SOL price: over the per-payment limit it is denied", async () => {
    usePrices(proxied(true));
    const res = await agentRequest(h, agentId, sendInput(user, { amount: "200000000" })); // $30
    expect(res.json.request.state).toBe("REJECTED");
    expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "PER_TRANSACTION_LIMIT_EXCEEDED",
    );
  });

  it("without the proxy a testnet payment has no valuation and never passes (fail closed)", async () => {
    usePrices(proxied(false));
    const res = await agentRequest(h, agentId, sendInput(user));
    expect(res.json.request.state).not.toBe("APPROVED");
    expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
      "VALUATION_UNAVAILABLE",
    );
  });
});
