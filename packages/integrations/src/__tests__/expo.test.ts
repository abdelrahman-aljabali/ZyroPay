import { ChainError } from "@zyropay/blockchain";
import { noSleep } from "@zyropay/blockchain/testing";
import type { Notification } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { buildPushData } from "@zyropay/shared";
import type { ExpoNotifierConfig } from "../expo";
import { createExpoNotifier } from "../expo";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const token = (i: number) => `ExponentPushToken[device-${String(i).padStart(4, "0")}]`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake Expo: every message gets an ok ticket unless `ticketFor` says otherwise. */
function harness(options: {
  tokens: readonly string[];
  accessToken?: string;
  ticketFor?: (to: string, i: number) => unknown;
  receipts?: (ids: string[]) => unknown;
  respond?: (call: Call) => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const deactivated: string[][] = [];
  const ticketBatches: string[][] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: input,
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown,
    };
    calls.push(call);
    if (options.respond !== undefined) return Promise.resolve(options.respond(call));
    if (call.url.endsWith("/push/send")) {
      const messages = call.body as { to: string }[];
      return Promise.resolve(
        json({
          data: messages.map(
            (m, i) =>
              options.ticketFor?.(m.to, i) ?? { status: "ok", id: `ticket-${m.to.slice(18, -1)}` },
          ),
        }),
      );
    }
    const { ids } = call.body as { ids: string[] };
    return Promise.resolve(json(options.receipts?.(ids) ?? { data: {} }));
  };
  const config: ExpoNotifierConfig = {
    fetch,
    sleep: noSleep,
    ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
    resolveTokens: () => Promise.resolve(options.tokens),
    deactivateTokens: (t) => {
      deactivated.push([...t]);
      return Promise.resolve();
    },
    onTickets: (t) => {
      ticketBatches.push(t.map((x) => x.ticketId));
      return Promise.resolve();
    },
  };
  return { notifier: createExpoNotifier(config), calls, deactivated, ticketBatches };
}

const APPROVAL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const approvalData = buildPushData("approval_requested", { approvalId: APPROVAL_ID });

const approval: Notification = {
  kind: "approval_requested",
  title: "Approve payment",
  body: "Agent wants to pay 10 USDC",
  data: approvalData,
};

describe("Expo push notifier", () => {
  it("posts to the v2 send endpoint, Bearer only with an access token", async () => {
    const withToken = harness({ tokens: [token(1)], accessToken: "expo-secret" });
    const r = await withToken.notifier.notify({ userId: "u1", notification: approval });
    expect(r).toEqual({ delivered: 1, failed: 0, simulated: false });
    const call = withToken.calls[0];
    expect(call?.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(call?.headers.authorization).toBe("Bearer expo-secret");
    expect(call?.headers.accept).toBe("application/json");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual([
      {
        to: token(1),
        title: "Approve payment",
        body: "Agent wants to pay 10 USDC",
        data: {
          v: "1",
          type: "approval_requested",
          url: `zyropay://approvals/${APPROVAL_ID}`,
          approvalId: APPROVAL_ID,
        },
        sound: "default",
        priority: "high",
      },
    ]);
    expect(withToken.ticketBatches).toEqual([["ticket-device-0001"]]);

    const without = harness({ tokens: [token(1)] });
    await without.notifier.notify({
      userId: "u1",
      notification: { ...approval, kind: "transaction_confirmed" },
    });
    expect(without.calls[0]?.headers.authorization).toBeUndefined();
    expect((without.calls[0]?.body as { priority: string }[])[0]?.priority).toBe("default");
  });

  it("chunks at 100 messages per request", async () => {
    const tokens = Array.from({ length: 250 }, (_, i) => token(i));
    const h = harness({ tokens });
    const r = await h.notifier.notify({ userId: "u1", notification: approval });
    expect(r).toEqual({ delivered: 250, failed: 0, simulated: false });
    expect(h.calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 100, 50]);
    expect(h.ticketBatches).toHaveLength(1);
    expect(h.ticketBatches[0]).toHaveLength(250);
  });

  it("sends only a valid shared PushData; anything else goes out with empty data", async () => {
    const h = harness({ tokens: [token(1)] });
    const send = (data: Record<string, string>) =>
      h.notifier.notify({ userId: "u1", notification: { ...approval, data } });
    await send({ ...approvalData, amount: "1000000" });
    await send({ ...approvalData, url: `https://evil.example/approvals/${APPROVAL_ID}` });
    await send({ ...approvalData, url: "zyropay://approvals" + "/../settings" });
    await send(approvalData);
    const sent = h.calls.map((c) => (c.body as { data: Record<string, string> }[])[0]?.data);
    expect(sent).toEqual([{}, {}, {}, approvalData]);
  });

  it("sanitizes payloads: allowlisted opaque ids only, truncated text, no control chars", async () => {
    const h = harness({ tokens: [token(1)] });
    await h.notifier.notify({
      userId: "u1",
      notification: {
        kind: "transaction_confirmed",
        title: `Payment${String.fromCharCode(7)} sent${String.fromCharCode(0x202e)} ${"x".repeat(100)}`,
        body: "y".repeat(500),
        data: {
          requestId: "req_42",
          explorerUrl: "https://basescan.org/tx/0xabc",
          address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          amount: "1000000",
          orderId: "has spaces not allowed",
          agentId: "a".repeat(129),
        },
      },
    });
    const [message] = h.calls[0]?.body as {
      title: string;
      body: string;
      data: Record<string, string>;
    }[];
    // Not a valid PushData (extra keys, malformed ids): nothing of it is sent.
    expect(message?.data).toEqual({});
    expect(Array.from(message?.title ?? "")).toHaveLength(64);
    expect(message?.title.startsWith("Payment sent x")).toBe(true);
    expect(
      Array.from(message?.title ?? "").some((c) => {
        const code = c.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x202e;
      }),
    ).toBe(false);
    expect(Array.from(message?.body ?? "")).toHaveLength(178);
    expect(message?.body.endsWith("…")).toBe(true);
  });

  it("skips malformed tokens and returns early when none are valid", async () => {
    const h = harness({ tokens: ["not-a-token", "ExponentPushToken[]", token(1)] });
    expect(await h.notifier.notify({ userId: "u1", notification: approval })).toEqual({
      delivered: 1,
      failed: 2,
      simulated: false,
    });
    expect((h.calls[0]?.body as { to: string }[]).map((m) => m.to)).toEqual([token(1)]);

    const none = harness({ tokens: ["apns:abcdef"] });
    expect(await none.notifier.notify({ userId: "u1", notification: approval })).toEqual({
      delivered: 0,
      failed: 1,
      simulated: false,
    });
    expect(none.calls).toHaveLength(0);
  });

  it("deactivates DeviceNotRegistered tokens from tickets, once", async () => {
    const h = harness({
      tokens: [token(1), token(2), token(3)],
      ticketFor: (to) =>
        to === token(1)
          ? undefined
          : to === token(2)
            ? {
                status: "error",
                message: `"${to}" is not a registered push notification recipient`,
                details: { error: "DeviceNotRegistered", expoPushToken: to },
              }
            : { status: "error", message: "too big", details: { error: "MessageTooBig" } },
    });
    expect(await h.notifier.notify({ userId: "u1", notification: approval })).toEqual({
      delivered: 1,
      failed: 2,
      simulated: false,
    });
    expect(h.deactivated).toEqual([[token(2)]]);
    expect(h.ticketBatches).toEqual([["ticket-device-0001"]]);
  });

  it("checks receipts: ok, DeviceNotRegistered deactivates, errors and pending counted", async () => {
    const ids: string[][] = [];
    const tickets = Array.from({ length: 1003 }, (_, i) => ({
      ticketId: `t${i}`,
      token: token(i),
    }));
    const h = harness({
      tokens: [],
      receipts: (batch) => {
        ids.push(batch);
        const data: Record<string, unknown> = {};
        for (const id of batch) {
          if (id === "t1")
            data[id] = { status: "error", details: { error: "DeviceNotRegistered" } };
          else if (id === "t2")
            data[id] = { status: "error", details: { error: "MessageRateExceeded" } };
          else if (id === "t3" || id === "t1002")
            continue; // not ready yet
          else data[id] = { status: "ok" };
        }
        return { data };
      },
    });
    const r = await h.notifier.checkReceipts(tickets);
    expect(ids.map((b) => b.length)).toEqual([1000, 3]);
    expect(h.calls[0]?.url).toBe("https://exp.host/--/api/v2/push/getReceipts");
    expect(r).toEqual({ ok: 999, errors: 1, deactivated: 1, pending: 2 });
    expect(h.deactivated).toEqual([[token(1)]]);
  });

  it("request-level failures throw UPSTREAM_UNAVAILABLE without leaking tokens", async () => {
    const cases: (() => Response)[] = [
      () => json({ errors: [{ code: "INTERNAL_SERVER_ERROR", message: "boom" }] }, 503),
      () => new Response("<html>not json</html>", { status: 200 }),
      () =>
        json({
          errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: `${token(1)} mixed` }],
        }),
    ];
    for (const respond of cases) {
      const h = harness({ tokens: [token(1)], respond });
      const error = await h.notifier
        .notify({ userId: "u1", notification: approval })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChainError);
      expect((error as ChainError).code).toBe("UPSTREAM_UNAVAILABLE");
      expect((error as ChainError).retryable).toBe(true);
      expect((error as ChainError).message).not.toContain("ExponentPushToken");
      expect(JSON.stringify((error as ChainError).details ?? {})).not.toContain(
        "ExponentPushToken",
      );
    }
    const net = harness({
      tokens: [token(1)],
      respond: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(
      net.notifier.checkReceipts([{ ticketId: "t1", token: token(1) }]),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.code === "UPSTREAM_UNAVAILABLE" && e.retryable,
    );
  });
});
