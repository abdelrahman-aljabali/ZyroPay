/*
 * Integration of the real-adapter contracts into the request engine, exercised with
 * instrumented mocks: fee caps from estimateTransferFee before hashing, EVM nonce
 * allocation, Solana rebuildIfExpiring at approval time, plugin/typed-data verifiers, x402 on
 * EVM through SIGN_RAW_PAYLOAD, broadcast reconciliation by the derived hash, the MCP
 * revocation push, the MCP audit sink and the on-ramp user IP.
 */
import type { CanonicalTransactionPayload, UnsignedTransaction } from "@zyropay/shared";
import { mockPasskeyStamp } from "@zyropay/wallet";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { ChainAdapters, NetworkBuilder } from "../../src/chain";
import * as t from "../../src/db/tables";
import { createMockChainAdapters, mockUsdcAssetId } from "../../src/providers/mocks";
import { broadcastSigned, sweep } from "../../src/services/execution";
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

const EVM_RECIPIENT = "0x52908400098527886E0F7030069857D2E4169EE7";

function setChain(h: Harness, chain: ChainAdapters): void {
  (h.deps as { chain: ChainAdapters }).chain = chain;
}

async function artifactsOf(h: Harness, requestId: string) {
  const [a] = await h.db
    .select()
    .from(t.transactionRequestArtifacts)
    .where(eq(t.transactionRequestArtifacts.transactionRequestId, requestId));
  return a;
}

async function requestRow(h: Harness, requestId: string) {
  const [r] = await h.db
    .select()
    .from(t.transactionRequests)
    .where(eq(t.transactionRequests.id, requestId));
  if (r === undefined) throw new Error("no request");
  return r;
}

function quoteBody(user: TestUser, overrides: Record<string, unknown> = {}) {
  return {
    walletId: user.walletId,
    network: "base-sepolia",
    to: EVM_RECIPIENT,
    assetId: mockUsdcAssetId("base-sepolia"),
    amount: "1000000",
    decimals: 6,
    idempotencyKey: `q-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

describe("real-adapter contracts in the request engine", () => {
  let h: Harness;
  let user: TestUser;
  let base: ChainAdapters;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    base = h.deps.chain;
  });

  it("fixes feeCap from estimateTransferFee().recommendedFeeCap before hashing", async () => {
    const evm = base.builder("base-sepolia");
    const seen: string[] = [];
    const builder: NetworkBuilder = {
      family: "evm",
      verifyMatchesPayload: (s, e, p) => evm.verifyMatchesPayload(s, e, p),
      buildTransfer: (p) => {
        seen.push(p.feeCap);
        return evm.buildTransfer(p);
      },
      estimateTransferFee: () =>
        Promise.resolve({ estimatedFee: "1000", recommendedFeeCap: "123456789" }),
    };
    setChain(h, { ...base, builder: (n) => (n === "base-sepolia" ? builder : base.builder(n)) });
    try {
      const body = quoteBody(user);
      const ok = await call(h, "POST", "/v1/send/quote", {
        token: user.accessToken,
        body,
        idempotencyKey: body.idempotencyKey,
      });
      expect(ok.status).toBe(200);
      expect(ok.json.review.payload.feeCap).toBe("123456789");
      expect(seen.at(-1)).toBe("123456789");

      // Above the static per-network ceiling: fail closed, nothing is quoted.
      builder.estimateTransferFee = () =>
        Promise.resolve({ estimatedFee: "1", recommendedFeeCap: "10000000000000000000" });
      const tooHigh = quoteBody(user);
      const refused = await call(h, "POST", "/v1/send/quote", {
        token: user.accessToken,
        body: tooHigh,
        idempotencyKey: tooHigh.idempotencyKey,
      });
      expect(refused.status).toBe(502);
      expect(refused.json.error.code).toBe("UPSTREAM_UNAVAILABLE");
    } finally {
      setChain(h, base);
    }
  });

  it("allocates distinct EVM nonces to concurrent requests and reuses a freed nonce", async () => {
    const evm = base.builder("base-sepolia");
    const nonces: number[] = [];
    const builder: NetworkBuilder = {
      family: "evm",
      verifyMatchesPayload: (s, e, p) => evm.verifyMatchesPayload(s, e, p),
      buildTransfer: (p, options) => {
        if (options?.nonce === undefined) throw new Error("nonce must be explicit");
        nonces.push(options.nonce);
        return evm.buildTransfer(p);
      },
      getNonceState: () => Promise.resolve({ latest: 7, pending: 9 }),
    };
    setChain(h, { ...base, builder: (n) => (n === "base-sepolia" ? builder : base.builder(n)) });
    try {
      const bodies = Array.from({ length: 6 }, () => quoteBody(user));
      const results = await Promise.all(
        bodies.map((body) =>
          call(h, "POST", "/v1/send/quote", {
            token: user.accessToken,
            body,
            idempotencyKey: body.idempotencyKey,
          }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const stored = await Promise.all(
        results.map(async (r) => (await artifactsOf(h, r.json.review.request.id))?.evmNonce),
      );
      expect([...stored].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([9, 10, 11, 12, 13, 14]);

      // Cancel the request holding nonce 11: the next request takes 11, not 15.
      const holder = results[stored.indexOf(11)];
      const cancelled = await call(
        h,
        "POST",
        `/v1/transaction-requests/${holder?.json.review.request.id}/cancel`,
        {
          token: user.accessToken,
        },
      );
      expect(cancelled.status).toBe(200);
      const next = quoteBody(user);
      const res = await call(h, "POST", "/v1/send/quote", {
        token: user.accessToken,
        body: next,
        idempotencyKey: next.idempotencyKey,
      });
      expect((await artifactsOf(h, res.json.review.request.id))?.evmNonce).toBe(11);
      expect(nonces.at(-1)).toBe(11);
    } finally {
      setChain(h, base);
    }
  });

  describe("approvals and broadcast", () => {
    let agentId: string;

    beforeAll(async () => {
      agentId = await connectAgent(h, user);
      await setPolicy(h, user, agentId, {
        spendingEnabled: true,
        recipientAllowlist: [
          {
            family: "solana",
            address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            label: null,
          },
          { family: "evm", address: EVM_RECIPIENT, label: null },
        ],
        allowedProtocols: ["x402"],
        limits: {
          perTransactionUsdMinor: "100000",
          dailyUsdMinor: "1000000",
          monthlyUsdMinor: "1000000",
        },
      });
    });

    async function pending(body = sendInput(user)) {
      const res = await call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
        internal: true,
        body,
        idempotencyKey: body.input.idempotencyKey,
      });
      expect(res.json.request.state).toBe("PENDING_APPROVAL");
      const [a] = await h.db
        .select()
        .from(t.approvalRequests)
        .where(eq(t.approvalRequests.transactionRequestId, res.json.request.requestId));
      return { requestId: res.json.request.requestId as string, approvalId: a!.id };
    }

    it("rebuilds an expiring Solana transfer with rebuildIfExpiring when the approval is opened", async () => {
      const sol = base.builder("solana-devnet");
      const calls: UnsignedTransaction[] = [];
      const builder: NetworkBuilder = {
        family: "solana",
        verifyMatchesPayload: (s, e, p) => sol.verifyMatchesPayload(s, e, p),
        buildTransfer: async (p) =>
          ({
            ...(await sol.buildTransfer(p)),
            lastValidBlockHeight: "1000",
            blockhash: "old",
          }) as UnsignedTransaction,
        rebuildIfExpiring: async (stored, payload: CanonicalTransactionPayload) => {
          calls.push(stored);
          return {
            rebuilt: true,
            transaction: {
              ...(await sol.buildTransfer(payload)),
              lastValidBlockHeight: "2000",
              blockhash: "new",
            } as UnsignedTransaction,
          };
        },
      };
      setChain(h, { ...base, builder: (n) => (n === "solana-devnet" ? builder : base.builder(n)) });
      try {
        const { requestId, approvalId } = await pending();
        const before = await requestRow(h, requestId);
        const detail = await call(h, "GET", `/v1/approvals/${approvalId}`, {
          token: user.accessToken,
        });
        expect(detail.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect((calls[0] as unknown as { lastValidBlockHeight: string }).lastValidBlockHeight).toBe(
          "1000",
        );
        const after = await requestRow(h, requestId);
        expect(after.payloadHash).toBe(before.payloadHash);
        expect(after.unsignedTransaction).not.toBe(before.unsignedTransaction);
        expect(detail.json.review.unsignedTransaction.serialized).toBe(after.unsignedTransaction);
        expect((await artifactsOf(h, requestId))?.unsignedMeta?.lastValidBlockHeight).toBe("2000");
      } finally {
        setChain(h, base);
      }
    });

    it("refuses to broadcast signed bytes that differ from the reviewed ones", async () => {
      setChain(h, {
        ...base,
        assertSignedMatchesUnsigned: () => Promise.reject(new Error("differs")),
      });
      try {
        const { requestId, approvalId } = await pending();
        const detail = await call(h, "GET", `/v1/approvals/${approvalId}`, {
          token: user.accessToken,
        });
        const review = detail.json.review;
        const sent = h.broadcaster.broadcasts.length;
        const res = await call(h, "POST", `/v1/approvals/${approvalId}/approve`, {
          token: user.accessToken,
          body: {
            payloadHash: review.payloadHash,
            signRequest: stampedSign(user.credentialId, {
              organizationId: user.organizationId,
              signWith: review.payload.from,
              network: review.payload.network,
              unsigned: review.unsignedTransaction,
              timestampMs: h.clock.now().getTime(),
            }),
          },
        });
        expect(res.json.request.state).toBe("FAILED");
        expect(h.broadcaster.broadcasts.length).toBe(sent);
        const [entry] = await h.db
          .select()
          .from(t.auditLogs)
          .where(
            and(
              eq(t.auditLogs.action, "security.signed_transaction_mismatch"),
              eq(t.auditLogs.targetId, requestId),
            ),
          );
        expect(entry).toBeDefined();
      } finally {
        setChain(h, base);
      }
    });

    async function approveAndSign(approvalId: string) {
      const detail = await call(h, "GET", `/v1/approvals/${approvalId}`, {
        token: user.accessToken,
      });
      const review = detail.json.review;
      return call(h, "POST", `/v1/approvals/${approvalId}/approve`, {
        token: user.accessToken,
        body: {
          payloadHash: review.payloadHash,
          signRequest: stampedSign(user.credentialId, {
            organizationId: user.organizationId,
            signWith: review.payload.from,
            network: review.payload.network,
            unsigned: review.unsignedTransaction,
            timestampMs: h.clock.now().getTime(),
          }),
        },
      });
    }

    it("reconciles a failed send by the derived hash instead of marking it FAILED", async () => {
      const failing = createMockChainAdapters(h.clock.now, h.broadcaster);
      let derived = "";
      setChain(h, {
        ...failing,
        txHashOf: (input) => (derived = failing.txHashOf(input)),
        broadcaster: () => ({
          broadcast: () => Promise.reject(new Error("timeout")),
          getStatus: () => Promise.reject(new Error("unused")),
        }),
        // The node knows the transaction although the send call failed.
        track: () =>
          Promise.resolve({
            status: "pending",
            confirmations: 0,
            error: null,
            rebroadcastSuggested: false,
            simulated: true,
          }),
      });
      try {
        const { requestId, approvalId } = await pending();
        const res = await approveAndSign(approvalId);
        expect(res.json.request.state).toBe("BROADCAST");
        expect(res.json.request.txHash).toBe(derived);
        expect((await artifactsOf(h, requestId))?.expectedTxHash).toBe(derived);
      } finally {
        setChain(h, base);
      }
    });

    it("keeps an unresolved send in SIGNING; fails only when the chain proves it cannot land", async () => {
      let status: "pending" | "expired" = "pending";
      setChain(h, {
        ...base,
        broadcaster: () => ({
          broadcast: () =>
            Promise.reject(Object.assign(new Error("send failed"), { code: "BROADCAST_FAILED" })),
          getStatus: () => Promise.reject(new Error("unused")),
        }),
        track: () =>
          Promise.resolve({
            status,
            confirmations: 0,
            error: null,
            rebroadcastSuggested: true,
            simulated: true,
          }),
      });
      try {
        const { requestId, approvalId } = await pending();
        const res = await approveAndSign(approvalId);
        expect(res.json.request.state).toBe("SIGNING");
        // Queued retries up to the attempt limit (the queue consumer rethrows to retry).
        h.queue.take();
        for (let i = 0; i < 6; i++) {
          await broadcastSigned(h.deps, requestId, { inline: false }).catch(() => undefined);
        }
        expect((await requestRow(h, requestId)).state).toBe("SIGNING");
        expect((await artifactsOf(h, requestId))?.broadcastAttempts).toBeGreaterThanOrEqual(5);

        status = "expired"; // blockhash provably past its last valid height
        h.clock.advance(10 * 60_000);
        await sweep(h.deps);
        h.queue.take();
        await broadcastSigned(h.deps, requestId, { inline: false }).catch(() => undefined);
        const row = await requestRow(h, requestId);
        expect(row.state).toBe("FAILED");
        expect(row.failureReason).toMatch(/expired/);
      } finally {
        setChain(h, base);
      }
    });

    it("x402 on EVM: never autonomous; the passkey signs the EIP-712 digest via SIGN_RAW_PAYLOAD", async () => {
      expect(
        (
          await call(h, "PUT", "/v1/plugins/x402", {
            token: user.accessToken,
            body: { enabled: true },
          })
        ).status,
      ).toBe(200);
      await enableDelegatedSigner(h, user);
      await setPolicy(h, user, agentId, { mode: "autonomous", overLimitBehavior: "deny" });
      const asset = mockUsdcAssetId("base-sepolia");
      const res = await call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
        internal: true,
        idempotencyKey: "x402-evm-1",
        body: {
          tool: "pay_x402",
          input: {
            walletId: user.walletId,
            network: "base-sepolia",
            resourceUrl: "https://api.example/paid",
            method: "GET",
            maxAmount: "5000",
            assetId: asset,
            decimals: 6,
            idempotencyKey: "x402-evm-1",
          },
          paymentRequirements: {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "base-sepolia",
                maxAmountRequired: "1000",
                payTo: EVM_RECIPIENT,
                asset: asset.split(":")[1],
                resource: "https://api.example/paid",
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
              },
            ],
          },
        },
      });
      expect(res.status).toBe(200);
      expect(res.json.request.state).toBe("PENDING_APPROVAL");
      expect(res.json.request.reasons.map((r: { code: string }) => r.code)).toContain(
        "AUTONOMY_NOT_SUPPORTED",
      );
      const requestId = res.json.request.requestId as string;
      const [approval] = await h.db
        .select()
        .from(t.approvalRequests)
        .where(eq(t.approvalRequests.transactionRequestId, requestId));
      const detail = await call(h, "GET", `/v1/approvals/${approval!.id}`, {
        token: user.accessToken,
      });
      const review = detail.json.review;
      expect(review.typedData.kind).toBe("eip712");
      expect(review.typedData.digest).toBe(review.unsignedTransaction.serialized);

      // A SIGN_TRANSACTION stamp over the digest is not accepted for typed data.
      const wrong = await call(h, "POST", `/v1/approvals/${approval!.id}/approve`, {
        token: user.accessToken,
        body: {
          payloadHash: review.payloadHash,
          signRequest: stampedSign(user.credentialId, {
            organizationId: user.organizationId,
            signWith: review.payload.from,
            network: "base-sepolia",
            unsigned: review.unsignedTransaction,
            timestampMs: h.clock.now().getTime(),
          }),
        },
      });
      expect(wrong.status).toBe(409);

      const body = JSON.stringify({
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        timestampMs: String(h.clock.now().getTime()),
        organizationId: user.organizationId,
        parameters: {
          signWith: review.payload.from,
          payload: review.typedData.digest,
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP",
        },
      });
      const signed = await call(h, "POST", `/v1/approvals/${approval!.id}/approve`, {
        token: user.accessToken,
        body: {
          payloadHash: review.payloadHash,
          signRequest: {
            url: "https://api.turnkey.com/public/v1/submit/sign_raw_payload",
            body,
            stamp: mockPasskeyStamp(user.credentialId, body),
          },
        },
      });
      expect(signed.status).toBe(200);
      // Signed, not broadcast: the authorization goes to the resource server.
      expect(signed.json.request.state).toBe("SIGNING");
      expect(h.turnkey.signed.at(-1)?.kind).toBe("raw_payload");
      const artifacts = await artifactsOf(h, requestId);
      expect(artifacts?.signedTransaction).toMatch(/^0x[0-9a-f]{130}$/);
    });
  });

  describe("agent revocation, MCP audit sink and on-ramp", () => {
    it("pushes the revocation to the MCP worker, retrying from the queue when it is down", async () => {
      const a = await connectAgent(h, user);
      h.mcp.failNext = 1;
      const res = await call(h, "DELETE", `/v1/agents/${a}`, { token: user.accessToken });
      expect(res.status).toBe(200);
      expect(h.mcp.revoked).toHaveLength(0);
      expect(h.queue.messages.some((m) => m.message.type === "mcp_revoke")).toBe(true);
      await h.drain();
      expect(h.mcp.revoked).toContainEqual({ agentId: a, userId: user.userId });
    });

    it("records MCP audit events; a user id that does not own the agent is dropped", async () => {
      const a = await connectAgent(h, user);
      const event = {
        type: "mcp.tool_call",
        at: h.clock.now().toISOString(),
        userId: user.userId,
        agentId: a,
        clientId: "client-1",
        connectionId: null,
        tool: "get_balance",
        outcome: "ok",
        errorCode: null,
        requestId: null,
        idempotencyKey: null,
        durationMs: 12,
      };
      const ok = await call(h, "POST", "/internal/v1/audit-events", {
        internal: true,
        body: event,
      });
      expect(ok.status).toBe(200);
      const other = await signUp(h);
      const spoofed = await call(h, "POST", "/internal/v1/audit-events", {
        internal: true,
        body: { ...event, userId: other.userId },
      });
      expect(spoofed.status).toBe(200);
      const rows = await h.db
        .select()
        .from(t.auditLogs)
        .where(and(eq(t.auditLogs.action, "mcp.mcp.tool_call"), eq(t.auditLogs.targetId, a)));
      expect(rows.map((r) => r.userId).sort()).toEqual([null, user.userId].sort());
      expect(rows.every((r) => r.actorType === "mcp")).toBe(true);
      const bad = await call(h, "POST", "/internal/v1/audit-events", {
        internal: true,
        body: { ...event, secret: "x" },
      });
      expect(bad.status).toBe(422);
      expect((await call(h, "POST", "/internal/v1/audit-events", { body: event })).status).toBe(
        401,
      );
    });

    it("passes CF-Connecting-IP to the on-ramp session", async () => {
      const quote = await call(h, "POST", "/v1/onramp/quote", {
        token: user.accessToken,
        body: {
          fiat: { value: "50.00", currency: "USD" },
          network: "base-sepolia",
          assetId: mockUsdcAssetId("base-sepolia"),
          walletId: user.walletId,
        },
      });
      expect(quote.status).toBe(200);
      const session = await call(h, "POST", "/v1/onramp/session", {
        token: user.accessToken,
        headers: { "cf-connecting-ip": "203.0.113.7" },
        body: { quoteId: quote.json.quote.quoteId, walletId: user.walletId },
      });
      expect(session.status).toBe(200);
      expect(h.onramp.sessions.at(-1)?.userIp).toBe("203.0.113.7");
    });
  });
});
