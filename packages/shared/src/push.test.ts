import { describe, expect, it } from "vitest";
import {
  buildPushData,
  parsePushData,
  parsePushDeepLink,
  PUSH_DATA_KEYS,
  pushDeepLink,
} from "./push";

const A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("push payload", () => {
  it("approval_requested deep-links to the approval and round-trips", () => {
    const data = buildPushData("approval_requested", { approvalId: A, requestId: B });
    expect(data).toEqual({
      v: "1",
      type: "approval_requested",
      url: `zyropay://approvals/${A}`,
      approvalId: A,
      requestId: B,
    });
    expect(parsePushData(data)?.route).toEqual({ screen: "approval", approvalId: A });
  });

  it("every event maps to a route in the closed set", () => {
    expect(buildPushData("transaction_confirmed", { requestId: A }).url).toBe("zyropay://activity");
    expect(buildPushData("agent_connected", { agentId: A }).url).toBe(`zyropay://agents/${A}`);
    expect(buildPushData("security_event", {}).url).toBe("zyropay://settings");
    expect(buildPushData("approval_expired", { requestId: A }).url).toBe("zyropay://approvals");
  });

  it("honours a custom scheme and refuses a bad one", () => {
    const data = buildPushData("approval_requested", { approvalId: A }, "zyropay-dev");
    expect(data.url).toBe(`zyropay-dev://approvals/${A}`);
    expect(parsePushData(data)).toBeNull(); // wrong scheme for the default parser
    expect(parsePushData(data, "zyropay-dev")?.route.screen).toBe("approval");
    expect(() => pushDeepLink({ screen: "activity" }, "Evil Scheme")).toThrow();
  });

  it("refuses amounts, addresses and unknown keys (strict schema)", () => {
    const base = buildPushData("incoming_payment", { transferId: A });
    expect(parsePushData({ ...base, amount: "1000000" })).toBeNull();
    expect(parsePushData({ ...base, address: "0xabc" })).toBeNull();
    expect(() => buildPushData("incoming_payment", { transferId: "not-a-uuid" })).toThrow();
    expect(PUSH_DATA_KEYS).not.toContain("amount");
  });

  it("refuses foreign or mismatched deep links", () => {
    const data = buildPushData("approval_requested", { approvalId: A });
    expect(parsePushData({ ...data, url: `https://evil.example/approvals/${A}` })).toBeNull();
    expect(parsePushData({ ...data, url: `zyropay://approvals/${B}` })).toBeNull();
    expect(parsePushData({ ...data, url: "zyropay://approvals/../settings" })).toBeNull();
    expect(parsePushDeepLink(`zyropay://approvals/${A}?x=1`)).toBeNull();
    expect(parsePushDeepLink("zyropay://wallets")).toBeNull();
  });
});
