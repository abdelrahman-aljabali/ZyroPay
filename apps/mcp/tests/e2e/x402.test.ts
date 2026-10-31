import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpTools } from "@zyropay/shared";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_WALLET_ID, FAKE_X402_TX, fakeX402Header } from "../support/fake-api";
import { FakeResource, PAID_REPORT } from "../support/fake-resource";
import { connectWithOAuth, startHarness } from "../support/harness";
import type { Harness } from "../support/harness";

let h: Harness;
const resource = new FakeResource();
beforeAll(async () => {
  await resource.start();
  h = await startHarness({ MCP_X402_TEST_UPSTREAM: resource.url });
});
afterAll(async () => {
  await h.stop();
  await resource.stop();
});

const RESOURCE_URL = "https://weather.example.com/v1/report?city=munich";

describe("x402 end to end", () => {
  it("pay_x402 -> user approves -> get_approval_status returns the paid resource exactly once", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: true });
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === "pay_x402")?.description ?? "";
    expect(pay).toContain("cardano-preprod:native");
    expect(pay).toContain('"2000000"');
    expect(tools.find((t) => t.name === "get_approval_status")?.description).toContain(
      "exactly once",
    );

    const created = (await client.callTool({
      name: "pay_x402",
      arguments: {
        walletId: FAKE_WALLET_ID,
        network: "cardano-preprod",
        idempotencyKey: `x402-e2e-${Date.now()}`,
        resourceUrl: RESOURCE_URL,
        maxAmount: "2000000",
        assetId: "cardano-preprod:native",
        decimals: 6,
      },
    })) as CallToolResult;
    expect(created.isError).toBeFalsy();
    const request = mcpTools.pay_x402.output.parse(created.structuredContent).request;
    expect(request.state).toBe("PENDING_APPROVAL");
    expect(request.x402?.status).toBe("awaiting_signature");
    // The probe went to the seller (unpaid) and its requirements reached the API.
    expect(resource.seen).toHaveLength(1);
    expect(resource.seen[0]).toMatchObject({
      payment: null,
      originalHost: "weather.example.com",
      path: "/v1/report?city=munich",
    });

    const status = async () => {
      const result = (await client.callTool({
        name: "get_approval_status",
        arguments: { requestId: request.requestId },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      return {
        output: mcpTools.get_approval_status.output.parse(result.structuredContent),
        text: result.content[0]?.type === "text" ? result.content[0].text : "",
      };
    };

    // Still waiting for the user: no delivery.
    const waiting = await status();
    expect(waiting.output.resource).toBeUndefined();
    expect(resource.seen).toHaveLength(1);

    h.api.signX402(request.requestId); // the user approved with a passkey; the API signed

    const paid = await status();
    expect(resource.seen).toHaveLength(2);
    expect(resource.seen[1]?.payment).toBe(fakeX402Header(request.requestId));
    expect(paid.output.request.x402?.status).toBe("delivered");
    expect(paid.output.request.x402?.httpStatus).toBe(200);
    expect(paid.output.resource).toMatchObject({
      httpStatus: 200,
      contentType: "application/json",
      truncated: false,
      settlement: { success: true, transaction: FAKE_X402_TX, network: "cardano:preprod" },
    });
    const body = paid.output.resource?.body as typeof PAID_REPORT;
    expect(body.readings).toEqual(PAID_REPORT.readings);
    // Untrusted seller content cannot close ZyroPay's data envelope.
    expect(body.summary).toContain("[zyropay_data]");
    expect(paid.text.match(/<\/zyropay_data>/g)).toHaveLength(1);
    expect(h.api.x402Reports.get(request.requestId)).toEqual([
      {
        httpStatus: 200,
        settled: true,
        transaction: FAKE_X402_TX,
        errorReason: null,
        // This resource sends no delivery receipt; the worker still hashed what it got.
        receipt: {
          header: null,
          contentSha256: createHash("sha256").update(JSON.stringify(PAID_REPORT)).digest("hex"),
        },
      },
    ]);
    expect(paid.output.resource?.receipt).toMatchObject({ verified: false, reason: "missing" });

    // Second call: already delivered, no second payment, no resource.
    const again = await status();
    expect(again.output.resource).toBeUndefined();
    expect(again.output.request.x402?.status).toBe("delivered");
    expect(resource.seen).toHaveLength(2);
    await client.close();
  });
});

describe("x402 escrow (Masumi)", () => {
  it("pay_x402 forwards `escrow` to the API and the tools document the escrow state", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: true });
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === "pay_x402");
    expect(pay?.description).toContain("escrow=true");
    expect(JSON.stringify(pay?.inputSchema)).toContain('"escrow"');
    expect(tools.find((t) => t.name === "get_approval_status")?.description).toContain(
      "request.x402.escrow",
    );
    const key = `x402-escrow-${Date.now()}`;
    const created = (await client.callTool({
      name: "pay_x402",
      arguments: {
        walletId: FAKE_WALLET_ID,
        network: "cardano-preprod",
        idempotencyKey: key,
        resourceUrl: RESOURCE_URL,
        maxAmount: "2000000",
        assetId: "cardano-preprod:native",
        decimals: 6,
        escrow: true,
      },
    })) as CallToolResult;
    expect(created.isError).toBeFalsy();
    const apiCall = h.api.calls.filter((c) => c.path.endsWith("/transaction-requests")).at(-1);
    expect((apiCall?.body as { input: { escrow?: boolean } }).input.escrow).toBe(true);
    // A non-boolean is refused by the tool schema before anything reaches the API.
    const before = h.api.calls.length;
    const bad = (await client.callTool({
      name: "pay_x402",
      arguments: {
        walletId: FAKE_WALLET_ID,
        network: "cardano-preprod",
        idempotencyKey: `${key}-bad`,
        resourceUrl: RESOURCE_URL,
        maxAmount: "2000000",
        assetId: "cardano-preprod:native",
        decimals: 6,
        escrow: "yes",
      },
    })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect(h.api.calls.length).toBe(before);
    await client.close();
  });
});

describe("x402 auto-pay on Cardano (on-chain allowance)", () => {
  const ALLOWANCE_ID = "0190f7a2-0000-7000-8000-00000000a110";
  const payArgs = (idempotencyKey: string) => ({
    walletId: FAKE_WALLET_ID,
    network: "cardano-preprod",
    idempotencyKey,
    resourceUrl: RESOURCE_URL,
    maxAmount: "2000000",
    assetId: "cardano-preprod:native",
    decimals: 6,
  });

  it("the tools explain auto-pay and every fallback reason", async () => {
    const { client } = await connectWithOAuth(h, { spendingEnabled: true });
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === "pay_x402")?.description ?? "";
    expect(pay).toContain(
      "Auto-paid 2 ADA from your on-chain allowance (no tap needed); 3 ADA left today.",
    );
    for (const code of [
      "AUTO_PAY_ALLOWANCE",
      "ALLOWANCE_PAYEE_NOT_LISTED",
      "ALLOWANCE_LIMIT_EXCEEDED",
      "ALLOWANCE_INSUFFICIENT",
      "ALLOWANCE_EXPIRED",
      "ALLOWANCE_BUSY",
      "ALLOWANCE_UNAVAILABLE",
    ])
      expect(pay).toContain(code);
    expect(tools.find((t) => t.name === "get_approval_status")?.description).toContain(
      "autoPay.message",
    );
    await client.close();
  });

  it("pays without a tap, says so, then delivers the resource; over the limit it asks the passkey", async () => {
    h.api.autoPayAllowance = {
      allowanceId: ALLOWANCE_ID,
      perPaymentLovelace: 3_000_000n,
      leftTodayLovelace: 5_000_000n,
      balanceLovelace: 20_000_000n,
    };
    try {
      const { client } = await connectWithOAuth(h, { spendingEnabled: true });
      const created = (await client.callTool({
        name: "pay_x402",
        arguments: payArgs(`x402-autopay-${Date.now()}`),
      })) as CallToolResult;
      expect(created.isError).toBeFalsy();
      const request = mcpTools.pay_x402.output.parse(created.structuredContent).request;
      expect(request).toMatchObject({
        state: "APPROVED",
        decision: "allow",
        approvalUrl: null,
        reasons: [{ code: "AUTO_PAY_ALLOWANCE" }],
        autoPay: {
          allowanceId: ALLOWANCE_ID,
          lovelace: "2000000",
          remainingTodayLovelace: "3000000",
          message:
            "Auto-paid 2 ADA from your on-chain allowance (no tap needed); 3 ADA left today.",
        },
      });
      const text = created.content[0]?.type === "text" ? created.content[0].text : "";
      expect(text).toContain(
        "Auto-paid 2 ADA from your on-chain allowance (no tap needed); 3 ADA left today.",
      );

      // The API's executor signs from the allowance (no passkey); the worker delivers.
      h.api.signX402(request.requestId);
      const paid = (await client.callTool({
        name: "get_approval_status",
        arguments: { requestId: request.requestId },
      })) as CallToolResult;
      const out = mcpTools.get_approval_status.output.parse(paid.structuredContent);
      expect(out.request.x402?.status).toBe("delivered");
      expect(out.request.autoPay).toMatchObject({ txHash: FAKE_X402_TX, lovelace: "2000000" });
      expect(out.resource).toMatchObject({ httpStatus: 200 });

      // 2 + 2 > 3 ADA left today: the passkey pays, and the reason says why.
      h.api.autoPayAllowance.leftTodayLovelace = 1_000_000n;
      const capped = (await client.callTool({
        name: "pay_x402",
        arguments: payArgs(`x402-autopay-cap-${Date.now()}`),
      })) as CallToolResult;
      const fallback = mcpTools.pay_x402.output.parse(capped.structuredContent).request;
      expect(fallback.state).toBe("PENDING_APPROVAL");
      expect(fallback.autoPay).toBeUndefined();
      expect(fallback.reasons.map((r) => r.code)).toContain("ALLOWANCE_LIMIT_EXCEEDED");
      await client.close();
    } finally {
      h.api.autoPayAllowance = null;
    }
  });
});
