import { describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import { AGENT_CLAUDE } from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import { ACTIVITY_STATE, activitySubtitle, activityTitle } from "./agent-activity";

describe("agent activity rows", () => {
  it("describe every request, autonomous ones included, in plain words", async () => {
    resetMockState();
    const client = new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "tok",
    });
    const { items } = await client.call("listAgentRequests", {
      params: { agentId: AGENT_CLAUDE },
      query: {},
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(activityTitle(item, new Map())).toMatch(
        /^(Send [\d.]+ \S+|Swap [\d.]+ \S+|x402 payment · [\d.]+ \S+|Escrow lock · [\d.]+ ADA)$/,
      );
      expect(activitySubtitle(item)).toMatch(/^(Autonomous|Needed you|Policy) · /);
      if (item.request.payload.tool === "pay_x402")
        expect(activityTitle(item, new Map())).toMatch(/^(x402 payment|Escrow lock) · /);
      expect(ACTIVITY_STATE[item.request.state].label.length).toBeGreaterThan(0);
    }
  });

  it("labels escrow locks and direct x402 payments apart", async () => {
    resetMockState();
    const client = new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "tok",
    });
    const { items } = await client.call("listAgentRequests", {
      params: { agentId: AGENT_CLAUDE },
      query: {},
    });
    const titles = items.map((i) => activityTitle(i, new Map()));
    expect(titles.some((t) => t.startsWith("Escrow lock · "))).toBe(true);
    expect(titles.some((t) => t.startsWith("x402 payment · "))).toBe(true);
    const escrow = items.find((i) => activityTitle(i, new Map()).startsWith("Escrow lock"));
    expect(escrow && activitySubtitle(escrow)).toMatch(/zyropay\.online/);
  });
});
