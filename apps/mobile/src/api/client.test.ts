import { apiError, payloadHash } from "@zyropay/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  errorMessage,
  SESSION_EXPIRED_MESSAGE,
  type Transport,
  type TransportRequest,
  withSessionHint,
} from "./client";
import { AGENT_CLAUDE, fakeId, WALLET_MAIN } from "./mock/fixtures";
import { mockTransport, resetMockState } from "./mock/transport";

function recording(respond: (req: TransportRequest) => { status: number; json: unknown }) {
  const calls: TransportRequest[] = [];
  const transport: Transport = (req) => {
    calls.push(req);
    return Promise.resolve(respond(req));
  };
  return { calls, transport };
}

const validMe = {
  user: {
    id: "0192f3a1-0001-7000-8000-000000000001",
    email: null,
    displayName: null,
    turnkeySubOrganizationId: "org",
    createdAt: "2026-10-30T12:00:00.000Z",
  },
};

describe("ApiClient", () => {
  it("sends the bearer token and validates the response", async () => {
    const { calls, transport } = recording(() => ({ status: 200, json: validMe }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    const res = await client.call("getMe", {});
    expect(res.user.turnkeySubOrganizationId).toBe("org");
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("/v1/me");
  });

  it("rejects responses that do not match the contract", async () => {
    const { transport } = recording(() => ({ status: 200, json: { user: { id: "nope" } } }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    await expect(client.call("getMe", {})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps the error envelope to ApiError", async () => {
    const { transport } = recording(() => ({
      status: 409,
      json: apiError("PAYLOAD_HASH_MISMATCH", "changed"),
    }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    const err = await client.call("getMe", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "PAYLOAD_HASH_MISMATCH", status: 409 });
    expect(errorMessage(err)).toMatch(/changed after you reviewed/);
  });

  it("treats unknown error bodies by status", async () => {
    const { transport } = recording(() => ({ status: 503, json: "<html>" }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    await expect(client.call("getMe", {})).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("validates request bodies before sending", async () => {
    const { calls, transport } = recording(() => ({ status: 200, json: {} }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    await expect(
      client.call("claimAgentConnection", { body: { userCode: "bad" } }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });

  it("never sends a recovery phrase or private key (ADR-003), even in an ordinary field", async () => {
    const { calls, transport } = recording(() => ({ status: 200, json: {} }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    for (const body of [
      {
        turnkeyWalletId: "w",
        network: "solana-devnet",
        idempotencyKey: "import:0123456789",
        name: phrase,
      },
      {
        turnkeyWalletId: "w",
        network: "solana-devnet",
        idempotencyKey: "import:0123456789",
        mnemonic: "x",
      },
    ]) {
      const err: unknown = await client
        .call("createWallet", { body: body as never })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).not.toContain("abandon");
    }
    expect(calls).toHaveLength(0);
  });

  it("substitutes path params and serialises queries", async () => {
    const { calls, transport } = recording(() => ({ status: 200, json: { wallets: [] } }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    await client
      .call("listTransactions", { query: { walletId: WALLET_MAIN, network: "solana-devnet" } })
      .catch(() => undefined);
    expect(calls[0]?.url).toBe(
      `/v1/transactions?walletId=${WALLET_MAIN}&network=solana-devnet&limit=20`,
    );
    await client.call("getAgent", { params: { agentId: AGENT_CLAUDE } }).catch(() => undefined);
    expect(calls[1]?.url).toBe(`/v1/agents/${AGENT_CLAUDE}`);
  });

  it("puts the idempotency key in a header for idempotent endpoints", async () => {
    const { calls, transport } = recording(() => ({
      status: 500,
      json: apiError("INTERNAL_ERROR", "x"),
    }));
    const client = new ApiClient({ transport, getAccessToken: () => "tok" });
    await client
      .call("quoteSend", {
        body: {
          walletId: WALLET_MAIN,
          network: "solana-devnet",
          to: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
          assetId: "solana-devnet:native",
          amount: "1000",
          decimals: 9,
          idempotencyKey: "send:abc12345",
        },
      })
      .catch(() => undefined);
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("send:abc12345");
  });

  it("refreshes once on 401 and retries", async () => {
    let n = 0;
    const { calls, transport } = recording(() =>
      n++ === 0
        ? { status: 401, json: apiError("UNAUTHENTICATED", "expired") }
        : { status: 200, json: validMe },
    );
    let token = "old";
    const refresh = vi.fn(() => {
      token = "new";
      return Promise.resolve(true);
    });
    const client = new ApiClient({ transport, getAccessToken: () => token, refresh });
    await client.call("getMe", {});
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("refuses user endpoints without a session", async () => {
    const { transport } = recording(() => ({ status: 200, json: validMe }));
    const client = new ApiClient({ transport, getAccessToken: () => null });
    await expect(client.call("getMe", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("mock transport (contract-valid simulated fixtures)", () => {
  const client = () =>
    new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "simulated",
    });

  it("serves every read endpoint with data that passes the shared schemas", async () => {
    resetMockState();
    const c = client();
    const portfolio = await c.call("getPortfolio", { query: {} });
    expect(portfolio.portfolio.simulated).toBe(true);
    expect(
      portfolio.portfolio.networks.every(
        (n) => n.endsWith("devnet") || n.endsWith("sepolia") || n === "cardano-preprod",
      ),
    ).toBe(true);
    expect(portfolio.portfolio.unpricedAssetCount).toBeGreaterThan(0);
    const wallets = await c.call("listWallets", {});
    expect(wallets.wallets.length).toBeGreaterThan(0);
    const txs = await c.call("listTransactions", { query: {} });
    expect(txs.transactions.every((t) => t.simulated)).toBe(true);
    const agents = await c.call("listAgents", {});
    expect(agents.agents.length).toBe(3);
    const approvals = await c.call("listApprovals", { query: { status: "pending" } });
    expect(approvals.approvals.length).toBe(5);
    // Cardano approvals carry the raw payload (body hash) the passkey signs (ADR-002).
    const ada = approvals.approvals.find((a) => a.id === fakeId(7, 5));
    if (!ada) throw new Error("Cardano fixture missing");
    const adaDetail = await c.call("getApproval", { params: { approvalId: ada.id } });
    expect(adaDetail.review.payload.network).toBe("cardano-preprod");
    expect(adaDetail.review.rawPayload?.payload).toMatch(/^[0-9a-f]{64}$/);
    const plugins = await c.call("listPlugins", {});
    expect(plugins.plugins.map((p) => p.manifest.id)).toContain("x402");
    const first = approvals.approvals[0];
    if (!first) throw new Error("fixture missing");
    const detail = await c.call("getApproval", { params: { approvalId: first.id } });
    expect(payloadHash(detail.review.payload)).toBe(detail.approval.payloadHash);
    const receive = await c.call("getReceiveInfo", {
      query: { walletId: WALLET_MAIN, network: "base-sepolia" },
    });
    expect(receive.qrPayload).toMatch(/^ethereum:0x[0-9a-fA-F]{40}@84532$/);
    const history = await c.call("getPriceHistory", {
      params: { assetId: "solana-devnet:native" },
      query: {},
    });
    expect(history.history.status).toBe("available");
    if (history.history.status === "available")
      expect(history.history.points.length).toBeGreaterThan(10);
  });

  it("requires a passkey stamp and the bound payload hash to approve", async () => {
    resetMockState();
    const c = client();
    const pending = await c.call("listApprovals", { query: { status: "pending" } });
    const id = pending.approvals[0]?.id ?? "";
    const detail = await c.call("getApproval", { params: { approvalId: id } });
    const signRequest = {
      url: "https://api.turnkey.com/public/v1/submit/sign_transaction",
      body: "{}",
      stamp: { stampHeaderName: "X-Stamp" as const, stampHeaderValue: "session" },
    };
    await expect(
      c.call("approveApproval", {
        params: { approvalId: id },
        body: { payloadHash: detail.review.payloadHash, signRequest },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const passkey = {
      ...signRequest,
      stamp: { stampHeaderName: "X-Stamp-Webauthn" as const, stampHeaderValue: "sim" },
    };
    await expect(
      c.call("approveApproval", {
        params: { approvalId: id },
        body: { payloadHash: "0".repeat(64), signRequest: passkey },
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_HASH_MISMATCH" });
    const ok = await c.call("approveApproval", {
      params: { approvalId: id },
      body: { payloadHash: detail.review.payloadHash, signRequest: passkey },
    });
    expect(ok.approval.status).toBe("approved");
    expect(ok.request.simulated).toBe(true);
  });

  it("validates sends like the API (address, decimals, balance)", async () => {
    resetMockState();
    const c = client();
    const base = {
      walletId: WALLET_MAIN,
      network: "solana-devnet" as const,
      assetId: "solana-devnet:native",
      decimals: 9,
      idempotencyKey: "send:test0001",
    };
    const to = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    await expect(
      c.call("quoteSend", { body: { ...base, to, amount: "999999999999999" } }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    await expect(
      c.call("quoteSend", { body: { ...base, to, amount: "1000", decimals: 6 } }),
    ).rejects.toMatchObject({ code: "DECIMALS_MISMATCH" });
    const q = await c.call("quoteSend", { body: { ...base, to, amount: "1000000000" } });
    expect(q.review.payload.amount).toBe("1000000000");
    expect(payloadHash(q.review.payload)).toBe(q.review.payloadHash);
  });

  it("returns 404 envelopes for unknown routes", async () => {
    const res = await mockTransport({ latencyMs: 0 })({
      method: "GET",
      url: "/v1/nope",
      path: "/v1/nope",
      headers: {},
      body: undefined,
    });
    expect(res.status).toBe(404);
  });
});

describe("expired sign-in session", () => {
  it("turns Turnkey's expired api key error into plain copy", () => {
    const raw =
      'Turnkey error 16: expired api key (Details: [{"@type":"errors.v1.TurnkeyErrorDetail","turnkeyErrorCode":"API_KEY_EXPIRED"}])';
    expect(withSessionHint(raw)).toBe(SESSION_EXPIRED_MESSAGE);
    expect(errorMessage(new Error(raw))).toBe(SESSION_EXPIRED_MESSAGE);
    expect(withSessionHint("Something else")).toBe("Something else");
  });
});
