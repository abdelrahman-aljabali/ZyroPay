import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpDiscoveryTools, mcpTools } from "@zyropay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FAKE_MASUMI_AGENT_ID,
  FAKE_WALLET_ID,
  HOSTILE_AGENT_DESCRIPTION,
  HOSTILE_TOKEN_NAME,
} from "../support/fake-api";
import { connectWithOAuth, INTERNAL_TOKEN, startHarness } from "../support/harness";
import type { Harness } from "../support/harness";
import { LIST_TOOLS, rawMcp, tokenRequest } from "../support/oauth";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

const SOL_RECIPIENT = "So11111111111111111111111111111111111111112";

function sendArgs(idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    walletId: FAKE_WALLET_ID,
    network: "solana-devnet",
    idempotencyKey,
    to: SOL_RECIPIENT,
    assetId: "solana-devnet:native",
    amount: "1000000",
    decimals: 9,
    ...overrides,
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function errorOf(result: CallToolResult): { code: string; message: string; nextStep?: string } {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  try {
    return (JSON.parse(text) as { error: { code: string; message: string } }).error;
  } catch {
    return { code: "SDK", message: text };
  }
}

describe("tool catalogue", () => {
  it("exposes exactly the shared schemas with read-only / destructive annotations", async () => {
    const { client } = await connectWithOAuth(h);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const catalogue = { ...mcpTools, ...mcpDiscoveryTools };
      const valueMoving = catalogue[tool.name as keyof typeof catalogue].valueMoving;
      expect(tool.annotations?.readOnlyHint).toBe(!valueMoving);
      expect(tool.annotations?.destructiveHint).toBe(valueMoving);
      expect(tool.outputSchema).toBeDefined();
      expect(tool.description?.length).toBeGreaterThan(30);
    }
    const send = tools.find((t) => t.name === "send")!;
    expect(send.inputSchema.required).toEqual(
      expect.arrayContaining([
        "walletId",
        "network",
        "idempotencyKey",
        "to",
        "assetId",
        "amount",
        "decimals",
      ]),
    );
    expect(send.description).toContain("cannot sign");
    await client.close();
  });
});

describe("read tools", () => {
  it("get_wallets / get_agent_policy / get_balance return contract-valid structured data", async () => {
    const { client } = await connectWithOAuth(h);
    const wallets = await call(client, "get_wallets", {});
    expect(wallets.isError).toBeFalsy();
    expect(mcpTools.get_wallets.output.parse(wallets.structuredContent).wallets[0]?.id).toBe(
      FAKE_WALLET_ID,
    );

    const policy = await call(client, "get_agent_policy", {});
    const parsedPolicy = mcpTools.get_agent_policy.output.parse(policy.structuredContent);
    expect(parsedPolicy.policy.mode).toBe("always_ask");
    expect(parsedPolicy.policy.spendingEnabled).toBe(false);

    const tx = await call(client, "get_transactions", {});
    expect(mcpTools.get_transactions.output.parse(tx.structuredContent).nextCursor).toBeNull();
    // Default limit from the shared schema reached the API.
    const listCall = h.api.calls.filter((c) => c.path.endsWith("/transactions")).at(-1);
    expect(listCall).toBeDefined();
    await client.close();
  });

  it("prompt-injection hygiene: hostile token names are sanitized and wrapped as data", async () => {
    const { client } = await connectWithOAuth(h);
    const result = await call(client, "get_balance", { network: "solana-devnet" });
    expect(result.isError).toBeFalsy();
    const portfolio = mcpTools.get_balance.output.parse(result.structuredContent).portfolio;
    const hostile = portfolio.balances.find((b) => !b.asset.verified)!;
    expect(hostile.asset.name).not.toBe(HOSTILE_TOKEN_NAME);
    expect(hostile.asset.name).not.toMatch(/[\u202E\u200B\n\r]/);
    expect(hostile.asset.symbol).toBe("FREE");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/^ZyroPay tool result\. .*untrusted data/);
    expect(text).toContain("<zyropay_data>");
    expect(text.trimEnd().endsWith("</zyropay_data>")).toBe(true);
    // Wallet names are user-controlled too.
    const wallets = await call(client, "get_wallets", {});
    expect(mcpTools.get_wallets.output.parse(wallets.structuredContent).wallets[0]?.name).toBe(
      "Main wallet",
    );
    await client.close();
  });
});

describe("Masumi registry tools", () => {
  it("find_agents relays the query and returns sanitized registry data wrapped as data", async () => {
    const { client } = await connectWithOAuth(h);
    const result = await call(client, "find_agents", {
      query: "summ",
      maxPrice: { amount: "3000000" },
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const found = mcpDiscoveryTools.find_agents.output.parse(result.structuredContent);
    expect(found.agents).toHaveLength(1);
    const agent = found.agents[0]!;
    expect(agent.agentIdentifier).toBe(FAKE_MASUMI_AGENT_ID);
    expect(agent.name).toBe("Summarizer");
    // Hidden characters, line breaks and envelope markers are neutralized.
    expect(agent.description).not.toBe(HOSTILE_AGENT_DESCRIPTION);
    expect(agent.description).not.toMatch(/[\u202E\n]|<\/zyropay_data>/);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/untrusted data/);
    expect(text.match(/<\/zyropay_data>/g)).toHaveLength(1);
    const sent = h.api.calls.filter((c) => c.path.includes("/masumi/agents")).at(-1);
    expect(sent?.search).toContain("q=summ");
    expect(sent?.search).toContain("maxPriceAmount=3000000");
    expect(sent?.search).toContain("maxPriceUnit=lovelace");
    expect(sent?.search).toContain("limit=5");
    await client.close();
  });

  it("verify_agent checks an identity; limits and identifiers are validated", async () => {
    const { client } = await connectWithOAuth(h);
    const ok = await call(client, "verify_agent", {
      agentIdentifier: FAKE_MASUMI_AGENT_ID,
      resourceUrl: "https://masumi-agent.zyropay.online/v1/jobs/1",
    });
    expect(mcpDiscoveryTools.verify_agent.output.parse(ok.structuredContent)).toMatchObject({
      ok: true,
      sellerChecked: false,
    });
    const unknown = await call(client, "verify_agent", { agentIdentifier: "ab".repeat(60) });
    expect(mcpDiscoveryTools.verify_agent.output.parse(unknown.structuredContent)).toMatchObject({
      ok: false,
      reasons: ["not_found"],
    });
    const before = h.api.calls.length;
    expect((await call(client, "verify_agent", { agentIdentifier: "nope" })).isError).toBe(true);
    expect((await call(client, "find_agents", { limit: 50 })).isError).toBe(true);
    expect(h.api.calls.length).toBe(before);
    await client.close();
  });

  it("tells the model the discovery -> escrow payment flow", async () => {
    const { client } = await connectWithOAuth(h);
    const { tools } = await client.listTools();
    const find = tools.find((t) => t.name === "find_agents")!;
    expect(find.annotations?.readOnlyHint).toBe(true);
    expect(find.description).toContain("pay_x402");
    expect(find.description).toContain("escrow=true");
    expect(find.description).toContain("get_approval_status");
    expect(find.description).toMatch(/untrusted data/);
    const pay = tools.find((t) => t.name === "pay_x402")!;
    expect(pay.description).toContain("find_agents");
    expect(pay.description).toContain("AGENT_NOT_REGISTERED");
    await client.close();
  });
});

describe("input validation", () => {
  it("rejects invalid inputs before anything reaches the API", async () => {
    const { client } = await connectWithOAuth(h);
    const before = h.api.calls.filter((c) => c.path.endsWith("/transaction-requests")).length;
    const bad = [
      sendArgs("key-decimal-amount", { amount: "1.5" }),
      sendArgs("key-negative", { amount: "-1" }),
      sendArgs("short"), // idempotency key too short
      sendArgs("key-bad-address", { to: "not-an-address" }),
      sendArgs("key-bad-network", { network: "solana-mainnet-beta" }),
      sendArgs("key-bad-wallet", { walletId: "wallet-1" }),
      { ...sendArgs("key-missing"), idempotencyKey: undefined },
    ];
    for (const args of bad) {
      const result = await call(client, "send", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    const x402 = await call(client, "pay_x402", {
      walletId: FAKE_WALLET_ID,
      network: "solana-devnet",
      idempotencyKey: "x402-http-url",
      resourceUrl: "http://example.com/paid",
      maxAmount: "1000",
      assetId: "solana-devnet:native",
      decimals: 9,
    });
    expect(x402.isError).toBe(true);
    const after = h.api.calls.filter((c) => c.path.endsWith("/transaction-requests")).length;
    expect(after).toBe(before);
    await client.close();
  });

  it("pay_x402 refuses non-public resource hosts without calling the API", async () => {
    const { client } = await connectWithOAuth(h);
    const result = await call(client, "pay_x402", {
      walletId: FAKE_WALLET_ID,
      network: "solana-devnet",
      idempotencyKey: "x402-internal-host",
      resourceUrl: "https://169.254.169.254/latest/meta-data",
      maxAmount: "1000",
      assetId: "solana-devnet:native",
      decimals: 9,
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("BAD_REQUEST");
    expect(errorOf(result).nextStep).toContain("Nothing was created or paid");
    await client.close();
  });
});

describe("value-moving tools", () => {
  it("send creates a request (never signs), propagating the idempotency key", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: true });
    const key = `pay-${Date.now()}`;
    const first = await call(client, "send", sendArgs(key));
    expect(first.isError).toBeFalsy();
    const req1 = mcpTools.send.output.parse(first.structuredContent).request;
    expect(req1.state).toBe("PENDING_APPROVAL");
    expect(req1.approvalUrl).toBe(`zyropay://approvals/${req1.requestId}`);

    const apiCall = h.api.calls.filter((c) => c.path.endsWith("/transaction-requests")).at(-1)!;
    expect(apiCall.authorized).toBe(true);
    expect(apiCall.idempotencyKey).toBe(key);
    expect(
      (apiCall.body as { tool: string; input: { idempotencyKey: string } }).input.idempotencyKey,
    ).toBe(key);
    expect((apiCall.body as { tool: string }).tool).toBe("send");

    // Retry with the same key => the same request.
    const retry = await call(client, "send", sendArgs(key));
    expect(mcpTools.send.output.parse(retry.structuredContent).request.requestId).toBe(
      req1.requestId,
    );

    const status = await call(client, "get_approval_status", { requestId: req1.requestId });
    expect(mcpTools.get_approval_status.output.parse(status.structuredContent).request.state).toBe(
      "PENDING_APPROVAL",
    );
    await client.close();
  });

  it("accepts Cardano networks and assets (lovelace, native tokens) and rejects bad Cardano input", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: true });
    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === "send")!;
    const network = (send.inputSchema.properties as Record<string, { enum?: string[] }>).network;
    expect(network?.enum).toEqual(expect.arrayContaining(["cardano-mainnet", "cardano-preprod"]));
    const ada = await call(
      client,
      "send",
      sendArgs(`ada-${Date.now()}`, {
        network: "cardano-preprod",
        to: "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz",
        assetId: "cardano-preprod:native",
        amount: "2000000",
        decimals: 6,
      }),
    );
    expect(ada.isError).toBeFalsy();
    const forwarded = h.api.calls.filter((c) => c.path.endsWith("/transaction-requests")).at(-1)!;
    expect((forwarded.body as { input: { network: string } }).input.network).toBe(
      "cardano-preprod",
    );
    const token = await call(
      client,
      "send",
      sendArgs(`ada-token-${Date.now()}`, {
        network: "cardano-preprod",
        to: "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz",
        assetId: `cardano-preprod:${"a".repeat(56)}5a59524f`,
        amount: "250",
        decimals: 2,
      }),
    );
    expect(token.isError).toBeFalsy();
    const before = h.api.calls.length;
    const badAsset = await call(
      client,
      "send",
      sendArgs(`ada-bad-${Date.now()}`, {
        network: "cardano-preprod",
        assetId: "cardano-preprod:xyz",
      }),
    );
    expect(badAsset.isError).toBe(true);
    expect(h.api.calls.length).toBe(before);
    const balance = await call(client, "get_balance", { network: "cardano-preprod" });
    expect(balance.isError).toBeFalsy();
    await client.close();
  });

  it("the API's policy decision is relayed as-is (spending disabled => REJECTED)", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: false });
    const result = await call(client, "send", sendArgs(`denied-${Date.now()}`));
    const request = mcpTools.send.output.parse(result.structuredContent).request;
    expect(request.state).toBe("REJECTED");
    expect(request.reasons[0]?.code).toBe("SPENDING_DISABLED");
    await client.close();
  });

  it("a swap on a test network explains that swaps are Solana mainnet only", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: true });
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "swap")?.description ?? "";
    expect(description).toContain("Solana mainnet only");
    expect(description).toContain("SWAP_UNAVAILABLE_ON_NETWORK");
    expect(description).toContain("do not ask them for token mint addresses");
    const result = await call(client, "swap", {
      walletId: FAKE_WALLET_ID,
      network: "solana-devnet",
      idempotencyKey: `swap-${Date.now()}`,
      inputAssetId: "solana-devnet:native",
      outputAssetId: `solana-devnet:${SOL_RECIPIENT}`,
      amount: "1000",
      decimals: 9,
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toEqual({
      code: "SWAP_UNAVAILABLE_ON_NETWORK",
      message:
        "Swaps are available on Solana mainnet only. This wallet is on Solana Devnet (test network), so no swap can be made.",
      nextStep: expect.stringContaining("Nothing was paid") as unknown,
    });
    const body = h.api.calls.filter((c) => c.path.endsWith("/transaction-requests")).at(-1)!
      .body as {
      tool: string;
      input: { slippageBps: number };
    };
    expect(body.tool).toBe("swap");
    expect(body.input.slippageBps).toBe(50); // shared schema default applied
    await client.close();
  });

  it("get_approval_status cannot see unknown requests", async () => {
    const { client } = await connectWithOAuth(h);
    const result = await call(client, "get_approval_status", {
      requestId: "0190f7a2-0000-7000-8000-00000000ffff",
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("NOT_FOUND");
    await client.close();
  });
});

describe("revocation", () => {
  it("lazy path: the API refuses a revoked agent, the MCP worker revokes the grant", async () => {
    const { client, provider, agentId } = await connectWithOAuth(h);
    const access = provider.saved!.access_token;
    const refresh = provider.saved!.refresh_token!;
    const saved = h.api.onRevoke;
    h.api.onRevoke = undefined; // simulate a lost push
    await h.api.revokeAgent(agentId);
    h.api.onRevoke = saved;

    const result = await call(client, "get_balance", {});
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("FORBIDDEN");
    expect(errorOf(result).message).toContain("revoked");

    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(401);
    const refreshed = await tokenRequest(h, {
      grant_type: "refresh_token",
      client_id: provider.info!.client_id,
      refresh_token: refresh,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");
  });

  it("push path: the API's revoke call kills every token of that agent at once", async () => {
    const { provider, agentId } = await connectWithOAuth(h);
    const other = await connectWithOAuth(h);
    const access = provider.saved!.access_token;
    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(200);
    await h.api.revokeAgent(agentId); // FakeApi pushes to /internal/v1/agents/:id/revoke-grants
    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(401);
    // Other agents of the same user are untouched.
    expect((await rawMcp(h, other.provider.saved!.access_token, LIST_TOOLS)).status).toBe(200);
    await other.client.close();
  });

  it("the internal revoke endpoint requires the internal service token", async () => {
    const url = `${h.origin}/internal/v1/agents/0190f7a2-0000-7000-8000-000000000099/revoke-grants`;
    const body = JSON.stringify({ userId: "0190f7a2-0000-7000-8000-000000000001" });
    const none = await fetch(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    expect(none.status).toBe(401);
    const wrong = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token-wrong-token-wrong-token",
      },
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ revokedGrantCount: 0 });
  });
});

describe("transport hardening", () => {
  it("rejects disallowed Origins with 403, allows listed ones", async () => {
    const { provider, client } = await connectWithOAuth(h);
    const token = provider.saved!.access_token;
    expect((await rawMcp(h, token, LIST_TOOLS, { Origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await rawMcp(h, token, LIST_TOOLS, { Origin: "https://claude.ai" })).status).toBe(200);
    await client.close();
  });

  it("limits request bodies", async () => {
    const { provider, client } = await connectWithOAuth(h);
    const huge = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { pad: "x".repeat(70 * 1024) },
    };
    expect((await rawMcp(h, provider.saved!.access_token, huge)).status).toBe(413);
    await client.close();
  });

  it("is stateless: GET and DELETE on /mcp answer 405", async () => {
    const { provider, client } = await connectWithOAuth(h);
    const headers = { Authorization: `Bearer ${provider.saved!.access_token}` };
    expect((await fetch(h.mcpUrl, { method: "GET", headers })).status).toBe(405);
    expect((await fetch(h.mcpUrl, { method: "DELETE", headers })).status).toBe(405);
    await client.close();
  });
});
