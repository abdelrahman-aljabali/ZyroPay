import { describe, expect, it } from "vitest";
import { endpointTimeoutMs, InternalApiClient } from "../../src/api/client";

const AGENT = "0190f7a2-0000-7000-8000-000000000001";
const TOKEN = "t".repeat(40);

function client(handler: (request: Request) => Response | Promise<Response>, seen: Request[] = []) {
  return new InternalApiClient({
    baseUrl: "https://api.test",
    serviceToken: TOKEN,
    fetcher: async (request) => {
      seen.push(request);
      return handler(request);
    },
  });
}

const sendInput = {
  walletId: AGENT,
  network: "solana-devnet" as const,
  idempotencyKey: "idem-key-1",
  to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  assetId: "solana-devnet:native",
  amount: "1",
  decimals: 9,
};

describe("InternalApiClient", () => {
  it("sends the internal token and the Idempotency-Key header", async () => {
    const seen: Request[] = [];
    const c = client(
      () => Response.json({ error: { code: "POLICY_DENIED", message: "no" } }, { status: 403 }),
      seen,
    );
    const result = await c.call("internalCreateTransactionRequest", {
      params: { agentId: AGENT },
      body: { tool: "send", input: sendInput },
      idempotencyKey: "idem-key-1",
    });
    expect(seen[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers.get("Idempotency-Key")).toBe("idem-key-1");
    expect(new URL(seen[0]!.url).pathname).toBe(
      `/internal/v1/agents/${AGENT}/transaction-requests`,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "POLICY_DENIED", message: "no", status: 403 },
    });
  });

  it("refuses to call an idempotent endpoint without a key", async () => {
    const seen: Request[] = [];
    const result = await client(() => new Response("{}"), seen).call(
      "internalCreateTransactionRequest",
      {
        params: { agentId: AGENT },
        body: { tool: "send", input: sendInput },
      },
    );
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("validates bodies against the contract before sending", async () => {
    const seen: Request[] = [];
    const result = await client(() => new Response("{}"), seen).call(
      "internalCreateTransactionRequest",
      {
        params: { agentId: AGENT },
        body: { tool: "send", input: { ...sendInput, amount: "1.5" } },
        idempotencyKey: "idem-key-1",
      },
    );
    expect(result.ok || result.error.code).toBe("VALIDATION_FAILED");
    expect(seen).toHaveLength(0);
  });

  it("fails closed on a response outside the contract", async () => {
    const result = await client(() => Response.json({ agent: { id: "nope" }, wallets: [] })).call(
      "internalGetAgentContext",
      { params: { agentId: AGENT } },
    );
    expect(result.ok || result.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("maps non-contract errors and network failures to UPSTREAM_UNAVAILABLE", async () => {
    const html = await client(() => new Response("<html>bad gateway</html>", { status: 502 })).call(
      "internalGetAgentContext",
      { params: { agentId: AGENT } },
    );
    expect(html.ok || html.error.code).toBe("UPSTREAM_UNAVAILABLE");
    const down = await client(() => Promise.reject(new Error("ECONNREFUSED"))).call(
      "internalGetAgentContext",
      {
        params: { agentId: AGENT },
      },
    );
    expect(down.ok || down.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("serializes queries through the contract (defaults applied, undefined dropped)", async () => {
    const seen: Request[] = [];
    await client(() => Response.json({ transactions: [], nextCursor: null }), seen).call(
      "internalListAgentTransactions",
      {
        params: { agentId: AGENT },
        query: { walletId: undefined, limit: 5 },
      },
    );
    expect(new URL(seen[0]!.url).search).toBe("?limit=5");
  });

  it("gives slow endpoints a longer timeout and reports a timeout as such (no retry)", async () => {
    expect(endpointTimeoutMs("internalCreateTransactionRequest")).toBe(25_000);
    expect(endpointTimeoutMs("internalFindMasumiAgents")).toBe(20_000);
    expect(endpointTimeoutMs("internalVerifyMasumiAgent")).toBe(15_000);
    expect(endpointTimeoutMs("internalGetTransactionRequest")).toBe(10_000);
    expect(endpointTimeoutMs("internalGetX402Payment")).toBe(10_000);

    let calls = 0;
    const slow = new InternalApiClient({
      baseUrl: "https://api.test",
      serviceToken: TOKEN,
      timeoutMs: 20,
      fetcher: (request) => {
        calls += 1;
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      },
    });
    const result = await slow.call("internalCreateTransactionRequest", {
      params: { agentId: AGENT },
      body: { tool: "send", input: sendInput },
      idempotencyKey: "idem-key-1",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", message: "ZyroPay API did not answer within 20 ms" },
    });
    expect(calls).toBe(1);
  });
});
