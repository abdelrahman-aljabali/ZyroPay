/*
 * SECURITY.md T6/T7: concurrent requests must not exceed limits, and concurrent duplicates
 * with one idempotency key must create one request.
 *
 * PGlite is single-connection: interactive transactions are serialized by the driver,
 * so this exercises the API's logic under interleaved async requests (reads outside the
 * transaction, idempotency races, reservation accounting), while the row lock
 * (SELECT … FOR UPDATE on agent_policies) is what serializes them on real Postgres.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Harness, TestUser } from "../helpers";
import {
  call,
  connectAgent,
  createHarness,
  enableDelegatedSigner,
  sendInput,
  setPolicy,
  signUp,
} from "../helpers";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const N = 25;

async function fire(h: Harness, agentId: string, bodies: any[]) {
  return Promise.all(
    bodies.map((body) =>
      call(h, "POST", `/internal/v1/agents/${agentId}/transaction-requests`, {
        internal: true,
        body,
        idempotencyKey: body.input.idempotencyKey,
      }),
    ),
  );
}

async function reservedTotal(h: Harness, agentId: string): Promise<bigint> {
  const [r] = await h.db
    .select({
      total: sql<string>`coalesce(sum(${t.spendingReservations.amountUsdMinor}), 0)::text`,
    })
    .from(t.spendingReservations)
    .where(
      and(eq(t.spendingReservations.agentId, agentId), eq(t.spendingReservations.status, "active")),
    );
  return BigInt(r?.total ?? "0");
}

describe("concurrent limit-bypass attempts", () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    user = await signUp(h);
    await enableDelegatedSigner(h, user);
  });

  it(`${N} parallel autonomous requests never reserve more than the daily limit (hard cap)`, async () => {
    const agentId = await connectAgent(h, user);
    await setPolicy(h, user, agentId, {
      mode: "autonomous",
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
      limits: { perTransactionUsdMinor: "2000", dailyUsdMinor: "5000", monthlyUsdMinor: "100000" },
      overLimitBehavior: "deny",
    });
    const results = await fire(
      h,
      agentId,
      Array.from({ length: N }, () => sendInput(user)),
    ); // $15 each
    expect(results.every((r) => r.status === 200)).toBe(true);
    const approved = results.filter((r) => r.json.request.state === "APPROVED");
    const rejected = results.filter((r) => r.json.request.state === "REJECTED");
    expect(approved).toHaveLength(3); // floor(5000 / 1500)
    expect(rejected).toHaveLength(N - 3);
    expect(await reservedTotal(h, agentId)).toBeLessThanOrEqual(5000n);
    // After execution + confirmation: spent (ledger) still within the limit.
    await h.drain();
    const [spent] = await h.db
      .select({ total: sql<string>`coalesce(sum(${t.spendingLedger.amountUsdMinor}), 0)::text` })
      .from(t.spendingLedger)
      .where(eq(t.spendingLedger.agentId, agentId));
    expect(BigInt(spent?.total ?? "0")).toBeLessThanOrEqual(5000n);
    // And the next request is still over the limit.
    const next = await fire(h, agentId, [sendInput(user)]);
    expect(next[0]?.json.request.state).toBe("REJECTED");
  });

  it("with overLimitBehavior=require_approval, autonomous executions stay within the limit", async () => {
    const agentId = await connectAgent(h, user);
    await setPolicy(h, user, agentId, {
      mode: "autonomous",
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
      limits: { perTransactionUsdMinor: "2000", dailyUsdMinor: "5000", monthlyUsdMinor: "100000" },
      overLimitBehavior: "require_approval",
    });
    const results = await fire(
      h,
      agentId,
      Array.from({ length: N }, () => sendInput(user)),
    );
    const autonomous = results.filter((r) => r.json.request.state === "APPROVED");
    expect(autonomous.length).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.json.request.state === "PENDING_APPROVAL").length).toBe(
      N - autonomous.length,
    );
    const [auto] = await h.db
      .select({
        total: sql<string>`coalesce(sum(${t.spendingReservations.amountUsdMinor}), 0)::text`,
      })
      .from(t.spendingReservations)
      .innerJoin(
        t.transactionRequests,
        eq(t.transactionRequests.id, t.spendingReservations.transactionRequestId),
      )
      .where(
        and(
          eq(t.spendingReservations.agentId, agentId),
          eq(t.transactionRequests.state, "APPROVED"),
        ),
      );
    expect(BigInt(auto?.total ?? "0")).toBeLessThanOrEqual(5000n);
  });

  it("parallel duplicates with one idempotency key create exactly one request", async () => {
    const agentId = await connectAgent(h, user);
    await setPolicy(h, user, agentId, {
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
    });
    const body = sendInput(user);
    const results = await fire(
      h,
      agentId,
      Array.from({ length: 10 }, () => body),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(new Set(ok.map((r) => r.json.request.requestId)).size).toBe(1);
    const rows = await h.db
      .select()
      .from(t.transactionRequests)
      .where(
        and(
          eq(t.transactionRequests.userId, user.userId),
          eq(t.transactionRequests.idempotencyKey, body.input.idempotencyKey),
        ),
      );
    expect(rows).toHaveLength(1);
    const reservations = await h.db
      .select()
      .from(t.spendingReservations)
      .where(eq(t.spendingReservations.transactionRequestId, rows[0]!.id));
    expect(reservations.length).toBeLessThanOrEqual(1);
  });
});
