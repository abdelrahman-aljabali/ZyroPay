/*
 * Approval integrity (SECURITY.md T2, T7, T9; ADR-001 D2): what the user reviewed is
 * exactly what gets signed, once.
 */
import { mockPasskeyStamp } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Harness, TestUser } from "../helpers";
import {
  call,
  connectAgent,
  createHarness,
  sendInput,
  setPolicy,
  signUp,
  stampedSign,
} from "../helpers";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("approval security", () => {
  let h: Harness;
  let user: TestUser;
  let agentId: string;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    agentId = await connectAgent(h, user);
    await setPolicy(h, user, agentId, {
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
    });
  });

  async function pending() {
    const body = sendInput(user);
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
    const detail = await call(h, "GET", `/v1/approvals/${a!.id}`, { token: user.accessToken });
    return {
      approvalId: a!.id,
      requestId: res.json.request.requestId as string,
      review: detail.json.review,
    };
  }

  function sign(
    review: any,
    overrides: Partial<Parameters<typeof stampedSign>[1]> = {},
    credentialId = user.credentialId,
  ) {
    return stampedSign(credentialId, {
      organizationId: user.organizationId,
      signWith: review.payload.from,
      network: review.payload.network,
      unsigned: review.unsignedTransaction,
      timestampMs: h.clock.now().getTime(),
      ...overrides,
    });
  }

  const approve = (approvalId: string, payloadHash: string, signRequest: unknown) =>
    call(h, "POST", `/v1/approvals/${approvalId}/approve`, {
      token: user.accessToken,
      body: { payloadHash, signRequest },
    });

  it("rejects a different payloadHash", async () => {
    const { approvalId, review } = await pending();
    const res = await approve(approvalId, "0".repeat(64), sign(review));
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("PAYLOAD_HASH_MISMATCH");
  });

  it("rejects an altered unsigned transaction (recipient swapped after review)", async () => {
    const { approvalId, review } = await pending();
    const decoded = JSON.parse(
      Buffer.from(review.unsignedTransaction.serialized, "base64").toString("utf8"),
    );
    decoded.to = "8WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const altered = {
      encoding: "base64",
      serialized: Buffer.from(JSON.stringify(decoded)).toString("base64"),
    };
    const res = await approve(
      approvalId,
      review.payloadHash,
      sign(review, { unsigned: altered as never }),
    );
    expect(res.status).toBe(409);
    expect(res.json.error.details.reason).toBe("UNSIGNED_TRANSACTION_MISMATCH");
    expect(h.turnkey.signed).toHaveLength(0);
  });

  it("rejects a stale stamp", async () => {
    const { approvalId, review } = await pending();
    const res = await approve(
      approvalId,
      review.payloadHash,
      sign(review, { timestampMs: h.clock.now().getTime() - 10 * 60_000 }),
    );
    expect(res.json.error.details.reason).toBe("STAMP_STALE");
  });

  it("rejects a session-key (non-passkey) stamp", async () => {
    const { approvalId, review } = await pending();
    const s = sign(review);
    const res = await approve(approvalId, review.payloadHash, {
      ...s,
      stamp: { stampHeaderName: "X-Stamp", stampHeaderValue: "eyJ4IjoxfQ" },
    });
    expect(res.json.error.details.reason).toBe("STAMP_NOT_PASSKEY");
  });

  it("rejects a stamp that does not cover the submitted body", async () => {
    const { approvalId, review } = await pending();
    const s = sign(review);
    const other = JSON.stringify({
      ...JSON.parse(s.body),
      timestampMs: String(h.clock.now().getTime() - 1),
    });
    const res = await approve(approvalId, review.payloadHash, {
      ...s,
      stamp: mockPasskeyStamp(user.credentialId, other),
    });
    expect(res.json.error.details.reason).toBe("STAMP_BODY_MISMATCH");
  });

  it("rejects signing for another organization or another address", async () => {
    const { approvalId, review } = await pending();
    const wrongOrg = await approve(
      approvalId,
      review.payloadHash,
      sign(review, { organizationId: "mock-org-attacker" }),
    );
    expect(wrongOrg.json.error.details.reason).toBe("ORGANIZATION_MISMATCH");
    const wrongFrom = await approve(
      approvalId,
      review.payloadHash,
      sign(review, { signWith: RECIPIENT }),
    );
    expect(wrongFrom.json.error.details.reason).toBe("SIGN_WITH_MISMATCH");
    const wrongUrl = await approve(approvalId, review.payloadHash, {
      ...sign(review),
      url: "https://api.turnkey.com.evil.example/public/v1/submit/sign_transaction",
    });
    expect(wrongUrl.json.error.details.reason).toBe("URL_NOT_ALLOWED");
  });

  it("an approval executes once; replaying the same stamp is refused", async () => {
    const { approvalId, review } = await pending();
    const signRequest = sign(review);
    const first = await approve(approvalId, review.payloadHash, signRequest);
    expect(first.status).toBe(200);
    const signedCount = h.turnkey.signed.length;
    const replay = await approve(approvalId, review.payloadHash, signRequest);
    expect(replay.status).toBe(409);
    expect(h.turnkey.signed.length).toBe(signedCount);
  });

  it("concurrent approvals of the same request sign exactly once", async () => {
    const { approvalId, review } = await pending();
    const before = h.turnkey.signed.length;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => approve(approvalId, review.payloadHash, sign(review))),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(h.turnkey.signed.length - before).toBe(1);
  });

  it("an expired approval cannot be approved", async () => {
    const { approvalId, review } = await pending();
    h.clock.advance(16 * 60_000);
    const res = await approve(approvalId, review.payloadHash, sign(review));
    expect(res.status).toBe(410);
    expect(res.json.error.code).toBe("REQUEST_EXPIRED");
  });

  it("approvals of a revoked agent are cancelled and cannot be approved", async () => {
    const { approvalId, review } = await pending();
    expect(
      (await call(h, "DELETE", `/v1/agents/${agentId}`, { token: user.accessToken })).status,
    ).toBe(200);
    const res = await approve(approvalId, review.payloadHash, sign(review));
    expect(res.status).toBe(409);
    const [a] = await h.db
      .select()
      .from(t.approvalRequests)
      .where(eq(t.approvalRequests.id, approvalId));
    expect(a?.status).toBe("cancelled");
  });
});
