/*
 * Mobile <-> API gaps: the autonomous-mode setup exactly as the app performs it (ADR-001 D6),
 * the agent activity feed, price history and the shared push payload.
 */
import { buildDelegatedPolicyEnvelope, parsePushData, PushDataSchema } from "@zyropay/shared";
import { mockPasskeyStamp } from "@zyropay/wallet";
import { beforeAll, describe, expect, it } from "vitest";
import type { Harness, TestUser } from "../helpers";
import { call, connectAgent, createHarness, sendInput, setPolicy, signUp } from "../helpers";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function stampedCreatePolicies(
  h: Harness,
  user: TestUser,
  policies: ReturnType<typeof buildDelegatedPolicyEnvelope>,
) {
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_CREATE_POLICIES",
    timestampMs: String(h.clock.now().getTime()),
    organizationId: user.organizationId,
    parameters: { policies },
  });
  return {
    url: "https://api.turnkey.com/public/v1/submit/create_policies",
    body,
    stamp: mockPasskeyStamp(user.credentialId, body),
  };
}

async function agentRequest(h: Harness, agentId: string, body: ReturnType<typeof sendInput>) {
  return call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
    internal: true,
    body,
    idempotencyKey: body.input.idempotencyKey,
  });
}

describe("autonomous mode set up the way the app does it (ADR-001 D6)", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;
  let delegatedUserId: string;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    await call(h, "POST", "/v1/notifications/devices", {
      token: user.accessToken,
      body: { expoPushToken: "ExponentPushToken[activity-test]", platform: "ios" },
    });
    agentId = await connectAgent(h, user, ["solana-devnet"]);
    await setPolicy(h, user, agentId, {
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
      limits: { perTransactionUsdMinor: "2000", dailyUsdMinor: "4000", monthlyUsdMinor: "100000" },
    });
  });

  it("1. the app gets the delegated public key (pending signer, no key material returned)", async () => {
    expect(
      (await call(h, "GET", "/v1/delegated-signer", { token: user.accessToken })).json,
    ).toEqual({ signer: null });
    const created = await call(h, "POST", "/v1/delegated-signer", { token: user.accessToken });
    expect(created.status).toBe(200);
    expect(created.json.signer).toMatchObject({ status: "pending", turnkeyUserId: null });
    expect(JSON.stringify(created.json)).not.toMatch(/private/i);
    // The passkey session creates the non-root API-key user (fetchOrCreateP256ApiKeyUser).
    delegatedUserId = "delegated-app-flow";
    h.turnkey.addApiKeyUser(user.organizationId, delegatedUserId, created.json.signer.apiPublicKey);
    const activated = await call(h, "POST", "/v1/delegated-signer/activate", {
      token: user.accessToken,
      body: { turnkeyUserId: delegatedUserId },
    });
    expect(activated.json.signer).toMatchObject({
      status: "active",
      turnkeyUserId: delegatedUserId,
    });
  });

  it("2. autonomous needs the policy envelope; one bound to anyone else is refused", async () => {
    const current = await call(h, "GET", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
    });
    const { version, revoked: _r, ...policy } = current.json.policy;
    const without = await call(h, "PUT", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
      body: { expectedVersion: version, policy: { ...policy, mode: "autonomous" } },
    });
    expect(without.status).toBe(403);
    const foreign = buildDelegatedPolicyEnvelope({
      delegatedUserId: "someone-else",
      allowedNetworks: ["solana-devnet"],
      restrictRecipients: true,
      recipientAllowlist: policy.recipientAllowlist,
      perTransactionUsdMinor: "2000",
      nativeUsdPrice: { solana: "150" },
    });
    const refused = await call(h, "PUT", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
      body: {
        expectedVersion: version,
        policy: { ...policy, mode: "autonomous" },
        turnkeyPolicyRequest: stampedCreatePolicies(h, user, foreign),
      },
    });
    expect(refused.status).toBe(403);
  });

  it("3. the passkey-stamped CREATE_POLICIES envelope is verified, forwarded and recorded", async () => {
    const current = await call(h, "GET", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
    });
    const { version, revoked: _r, ...policy } = current.json.policy;
    const envelope = buildDelegatedPolicyEnvelope({
      delegatedUserId,
      allowedNetworks: policy.allowedNetworks,
      restrictRecipients: policy.restrictRecipients,
      recipientAllowlist: policy.recipientAllowlist,
      perTransactionUsdMinor: policy.limits.perTransactionUsdMinor,
      nativeUsdPrice: { solana: "150" },
    });
    const saved = await call(h, "PUT", `/v1/agents/${agentId}/policy`, {
      token: user.accessToken,
      body: {
        expectedVersion: version,
        policy: { ...policy, mode: "autonomous" },
        turnkeyPolicyRequest: stampedCreatePolicies(h, user, envelope),
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.policy.mode).toBe("autonomous");
    const signer = await call(h, "GET", "/v1/delegated-signer", { token: user.accessToken });
    expect(signer.json.signer.turnkeyPolicyIds).toHaveLength(envelope.length);
  });

  it("4. activity lists the autonomous execution and the approval-gated request", async () => {
    const auto = await agentRequest(h, agentId, sendInput(user));
    expect(auto.json.request.state).toBe("APPROVED");
    await h.drain();
    const asking = await agentRequest(h, agentId, sendInput(user, { amount: "200000000" })); // $30 > $20
    expect(asking.json.request.state).toBe("PENDING_APPROVAL");

    const feed = await call(h, "GET", `/v1/agents/${agentId}/requests`, {
      token: user.accessToken,
    });
    expect(feed.status).toBe(200);
    const byId = new Map(
      feed.json.items.map((i: { request: { id: string } }) => [i.request.id, i] as const),
    );
    expect(byId.get(auto.json.request.requestId)).toMatchObject({
      autonomous: true,
      approvalId: null,
      request: { state: "CONFIRMED", requester: { type: "agent", agentId } },
    });
    expect(byId.get(asking.json.request.requestId)).toMatchObject({
      autonomous: false,
      request: { state: "PENDING_APPROVAL" },
    });
    expect(
      (byId.get(asking.json.request.requestId) as { approvalId: string | null }).approvalId,
    ).toMatch(/^[0-9a-f-]{36}$/);

    const pending = await call(h, "GET", `/v1/agents/${agentId}/requests?state=PENDING_APPROVAL`, {
      token: user.accessToken,
    });
    expect(pending.json.items.map((i: { request: { state: string } }) => i.request.state)).toEqual([
      "PENDING_APPROVAL",
    ]);
  });

  it("5. activity pages newest first with a stable cursor", async () => {
    const all = await call(h, "GET", `/v1/agents/${agentId}/requests?limit=100`, {
      token: user.accessToken,
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string =
        cursor === null ? "limit=1" : `limit=1&cursor=${encodeURIComponent(cursor)}`;
      const page = await call(h, "GET", `/v1/agents/${agentId}/requests?${qs}`, {
        token: user.accessToken,
      });
      expect(page.status).toBe(200);
      seen.push(...page.json.items.map((i: { request: { id: string } }) => i.request.id));
      cursor = page.json.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.json.items.map((i: { request: { id: string } }) => i.request.id));
    expect(
      (
        await call(h, "GET", `/v1/agents/${agentId}/requests?cursor=nope`, {
          token: user.accessToken,
        })
      ).status,
    ).toBe(400);
  });

  it("6. another user cannot read this agent's activity", async () => {
    const other = await signUp(h, "other");
    const res = await call(h, "GET", `/v1/agents/${agentId}/requests`, {
      token: other.accessToken,
    });
    expect(res.status).toBe(404);
    expect((await call(h, "GET", `/v1/agents/${agentId}/requests`)).status).toBe(401);
  });

  it("7. pushes carry the shared payload: type, ids and a deep link, no amounts", async () => {
    await h.drain();
    const approvalPush = h.notifier.sent
      .map((n) => n.notification)
      .filter((n) => n.data.type === "approval_requested")
      .at(-1);
    expect(approvalPush).toBeDefined();
    const parsed = parsePushData(approvalPush?.data);
    expect(parsed?.route.screen).toBe("approval");
    expect(approvalPush?.data.url).toBe(`zyropay://approvals/${approvalPush?.data.approvalId}`);
    for (const n of h.notifier.sent) {
      expect(PushDataSchema.safeParse(n.notification.data).success).toBe(true);
      expect(`${n.notification.title} ${n.notification.body}`).not.toMatch(/\d+\.\d+|\$\d/);
    }
  });
});

describe("price history", () => {
  let h: Harness;
  let user: TestUser;
  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
  });

  it("returns a labelled simulated series in mock mode", async () => {
    const res = await call(h, "GET", "/v1/prices/solana-devnet:native/history?range=1M", {
      token: user.accessToken,
    });
    expect(res.status).toBe(200);
    expect(res.json.history).toMatchObject({
      status: "available",
      assetId: "solana-devnet:native",
      range: "1M",
      currency: "USD",
      source: "mock",
      simulated: true,
    });
    expect(res.json.history.points.at(-1).price).toBe("150.00");
  });

  it("fails closed: unpriced assets and other currencies are unavailable, mainnet is refused", async () => {
    const token = await call(
      h,
      "GET",
      "/v1/prices/base-sepolia:0x0000000000000000000000000000000000000001/history",
      { token: user.accessToken },
    );
    expect(token.json.history).toMatchObject({
      status: "unavailable",
      reason: "UNSUPPORTED_ASSET",
    });
    const eur = await call(h, "GET", "/v1/prices/solana-devnet:native/history?currency=EUR", {
      token: user.accessToken,
    });
    expect(eur.json.history).toMatchObject({
      status: "unavailable",
      reason: "CURRENCY_UNSUPPORTED",
    });
    const mainnet = await call(h, "GET", "/v1/prices/solana-mainnet:native/history", {
      token: user.accessToken,
    });
    expect(mainnet.json.error.code).toBe("NETWORK_MODE_MISMATCH");
    expect((await call(h, "GET", "/v1/prices/solana-devnet:native/history")).status).toBe(401);
  });
});
