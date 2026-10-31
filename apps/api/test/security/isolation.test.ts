/*
 * Ownership isolation (no cross-user leakage) and internal-token / agent-status
 * enforcement on every MCP endpoint (SECURITY.md T4, T5; ARCHITECTURE.md rule 1).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Harness, TestUser } from "../helpers";
import {
  call,
  connectAgent,
  createHarness,
  INTERNAL_TOKEN,
  sendInput,
  setPolicy,
  signUp,
  stampedSign,
} from "../helpers";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("ownership isolation", () => {
  let h: Harness;
  let alice: TestUser;
  let bob: TestUser;
  let aliceAgent: string;
  let aliceRequest: string;
  let aliceApproval: string;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    alice = await signUp(h, "alice");
    bob = await signUp(h, "bob");
    aliceAgent = await connectAgent(h, alice);
    await setPolicy(h, alice, aliceAgent, {
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
    });
    const body = sendInput(alice);
    const res = await call(h, "POST", `/internal/v1/agents/${aliceAgent}/transaction-requests`, {
      internal: true,
      body,
      idempotencyKey: body.input.idempotencyKey,
    });
    aliceRequest = res.json.request.requestId;
    const [a] = await h.db
      .select()
      .from(t.approvalRequests)
      .where(eq(t.approvalRequests.transactionRequestId, aliceRequest));
    aliceApproval = a!.id;
  });

  it("bob cannot read or act on alice's resources (404, never 403 with data)", async () => {
    const asBob = { token: bob.accessToken };
    const checks: [string, string, unknown?][] = [
      ["GET", `/v1/wallets/${alice.walletId}`],
      ["GET", `/v1/agents/${aliceAgent}`],
      ["GET", `/v1/agents/${aliceAgent}/policy`],
      ["PATCH", `/v1/agents/${aliceAgent}`, { name: "pwned" }],
      ["DELETE", `/v1/agents/${aliceAgent}`],
      ["GET", `/v1/approvals/${aliceApproval}`],
      ["POST", `/v1/approvals/${aliceApproval}/reject`, {}],
      ["POST", `/v1/transaction-requests/${aliceRequest}/cancel`],
      ["GET", `/v1/receive?walletId=${alice.walletId}&network=solana-devnet`],
      ["GET", `/v1/portfolio?walletId=${alice.walletId}`],
    ];
    for (const [method, path, body] of checks) {
      const res = await call(h, method, path, {
        ...asBob,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.json)).not.toContain(alice.solana);
    }
    const list = await call(h, "GET", "/v1/approvals", asBob);
    expect(list.json.approvals).toHaveLength(0);
    const agents = await call(h, "GET", "/v1/agents", asBob);
    expect(agents.json.agents).toHaveLength(0);
  });

  it("bob cannot approve alice's approval even with a valid stamp of his own", async () => {
    const detail = await call(h, "GET", `/v1/approvals/${aliceApproval}`, {
      token: alice.accessToken,
    });
    const review = detail.json.review;
    const signRequest = stampedSign(bob.credentialId, {
      organizationId: bob.organizationId,
      signWith: review.payload.from,
      network: "solana-devnet",
      unsigned: review.unsignedTransaction,
      timestampMs: h.clock.now().getTime(),
    });
    const res = await call(h, "POST", `/v1/approvals/${aliceApproval}/approve`, {
      token: bob.accessToken,
      body: { payloadHash: review.payloadHash, signRequest },
    });
    expect(res.status).toBe(404);
  });

  it("bob cannot give his agent access to alice's wallet", async () => {
    const bobAgent = await connectAgent(h, bob);
    const current = await call(h, "GET", `/v1/agents/${bobAgent}/policy`, {
      token: bob.accessToken,
    });
    const { version, revoked: _r, ...policy } = current.json.policy;
    const res = await call(h, "PUT", `/v1/agents/${bobAgent}/policy`, {
      token: bob.accessToken,
      body: { expectedVersion: version, policy: { ...policy, allowedWalletIds: [alice.walletId] } },
    });
    expect(res.status).toBe(400);
  });

  it("an agent only sees requests it created", async () => {
    const otherAgent = await connectAgent(h, alice);
    const res = await call(
      h,
      "GET",
      `/internal/v1/agents/${otherAgent}/transaction-requests/${aliceRequest}`,
      { internal: true },
    );
    expect(res.status).toBe(404);
  });

  it("agent reads are limited to the policy's wallets and networks", async () => {
    const ok = await call(h, "GET", `/internal/v1/agents/${aliceAgent}/portfolio`, {
      internal: true,
    });
    expect(ok.status).toBe(200);
    expect(
      ok.json.portfolio.balances.every((b: { walletId: string }) => b.walletId === alice.walletId),
    ).toBe(true);
    const foreign = await call(
      h,
      "GET",
      `/internal/v1/agents/${aliceAgent}/portfolio?walletId=${bob.walletId}`,
      { internal: true },
    );
    expect(foreign.status).toBe(403);
    const ctx = await call(h, "GET", `/internal/v1/agents/${aliceAgent}/context`, {
      internal: true,
    });
    expect(ctx.json.wallets.map((w: { id: string }) => w.id)).toEqual([alice.walletId]);
  });

  it("an agent cannot spend from another user's wallet", async () => {
    const body = sendInput(alice, { walletId: bob.walletId });
    const res = await call(h, "POST", `/internal/v1/agents/${aliceAgent}/transaction-requests`, {
      internal: true,
      body,
      idempotencyKey: body.input.idempotencyKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("internal endpoint protection", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;

  beforeAll(async () => {
    h = await createHarness({
      INTERNAL_SERVICE_TOKEN_PREVIOUS: "previous-internal-token-0123456789abcdef",
      SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400",
    });
    user = await signUp(h);
    agentId = await connectAgent(h, user);
  });

  const internalPaths = (id: string): [string, string][] => [
    ["GET", `/internal/v1/agents/${id}/context`],
    ["GET", `/internal/v1/agents/${id}/portfolio`],
    ["GET", `/internal/v1/agents/${id}/transactions`],
    ["GET", `/internal/v1/agents/${id}/transaction-requests/00000000-0000-4000-8000-000000000000`],
  ];

  it("requires the internal service token (no token, wrong token, user token)", async () => {
    for (const [method, path] of internalPaths(agentId)) {
      expect((await call(h, method, path)).status).toBe(401);
      expect(
        (await call(h, method, path, { internal: "wrong-token-wrong-token-wrong-token-xx" }))
          .status,
      ).toBe(401);
      expect((await call(h, method, path, { token: user.accessToken })).status).toBe(401);
    }
    expect((await call(h, "POST", "/internal/v1/agent-connections", { body: {} })).status).toBe(
      401,
    );
  });

  it("accepts the current and the previous token (rotation)", async () => {
    expect(
      (await call(h, "GET", `/internal/v1/agents/${agentId}/context`, { internal: INTERNAL_TOKEN }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(h, "GET", `/internal/v1/agents/${agentId}/context`, {
          internal: "previous-internal-token-0123456789abcdef",
        })
      ).status,
    ).toBe(200);
  });

  it("the user token never reaches internal endpoints and the internal token never reaches user endpoints", async () => {
    expect((await call(h, "GET", "/v1/me", { internal: true })).status).toBe(401);
  });

  it("unknown agents are forbidden", async () => {
    expect(
      (
        await call(h, "GET", "/internal/v1/agents/00000000-0000-4000-8000-000000000001/context", {
          internal: true,
        })
      ).status,
    ).toBe(403);
  });

  it("an expired agent session is rejected on every internal call", async () => {
    const a = await connectAgent(h, user);
    await setPolicy(h, user, a, {
      sessionExpiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
    });
    expect(
      (await call(h, "GET", `/internal/v1/agents/${a}/context`, { internal: true })).status,
    ).toBe(200);
    h.clock.advance(2 * 60_000);
    for (const [method, path] of internalPaths(a)) {
      expect((await call(h, method, path, { internal: true })).status, path).toBe(403);
    }
  });

  it("a revoked agent is rejected on every internal call, including spending", async () => {
    const a = await connectAgent(h, user);
    expect((await call(h, "DELETE", `/v1/agents/${a}`, { token: user.accessToken })).status).toBe(
      200,
    );
    for (const [method, path] of internalPaths(a)) {
      expect((await call(h, method, path, { internal: true })).status, path).toBe(403);
    }
    const body = sendInput(user);
    const spend = await call(h, "POST", `/internal/v1/agents/${a}/transaction-requests`, {
      internal: true,
      body,
      idempotencyKey: body.input.idempotencyKey,
    });
    expect(spend.status).toBe(403);
    // Revocation also revoked the OAuth grant.
    const grants = await h.db.select().from(t.oauthGrants).where(eq(t.oauthGrants.agentId, a));
    expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
    const audit = await h.db
      .select()
      .from(t.auditLogs)
      .where(eq(t.auditLogs.action, "agent.revoked"));
    expect(audit.length).toBeGreaterThan(0);
  });
});
