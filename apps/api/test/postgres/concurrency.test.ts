/*
 * The concurrency guarantees against REAL Postgres (SECURITY.md T6/T7), not PGlite:
 * requests run on separate pooled connections, so the `SELECT … FOR UPDATE` row lock on
 * agent_policies is what serializes them.
 *
 * Runs only when TEST_DATABASE_URL is set (skipped otherwise), e.g.
 *   docker run --rm -d --name zyropay-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres \
 *     pnpm --filter @zyropay/api test:pg
 * The role needs CREATEDB: each run creates a throwaway database, applies every migration
 * from drizzle's journal, and drops it afterwards. The given database is never modified.
 */
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client";
import * as t from "../../src/db/tables";
import type { Harness, TestUser } from "../helpers";
import {
  applyMigrations,
  call,
  connectAgent,
  createHarness,
  enableDelegatedSigner,
  sendInput,
  setPolicy,
  signUp,
} from "../helpers";

const url = process.env.TEST_DATABASE_URL;
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const N = 25;

function fire(h: Harness, agentId: string, bodies: ReturnType<typeof sendInput>[]) {
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

describe.skipIf(url === undefined || url === "")("real Postgres: concurrent limit bypass", () => {
  const dbName = `zyropay_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const target = new URL(url ?? "");
    target.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: target.toString(), max: 30 });
    // Idle clients are terminated when the throwaway database is dropped (57P01).
    pool.on("error", () => undefined);
    const client = await pool.connect();
    try {
      await applyMigrations((statement) => client.query(statement));
    } finally {
      client.release();
    }
    h = await createHarness(
      { SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" },
      { db: drizzle({ client: pool }) as unknown as Db },
    );
    user = await signUp(h);
    await enableDelegatedSigner(h, user);
  });

  afterAll(async () => {
    await pool.end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  async function autonomousAgent(): Promise<string> {
    const agentId = await connectAgent(h, user);
    await setPolicy(h, user, agentId, {
      mode: "autonomous",
      spendingEnabled: true,
      recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: null }],
      limits: { perTransactionUsdMinor: "2000", dailyUsdMinor: "5000", monthlyUsdMinor: "100000" },
      overLimitBehavior: "deny",
    });
    return agentId;
  }

  it(`${N} parallel requests on separate connections never reserve more than the daily limit`, async () => {
    const agentId = await autonomousAgent();
    const results = await fire(
      h,
      agentId,
      Array.from({ length: N }, () => sendInput(user)),
    ); // $15 each, $50 per day
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.json.request.state === "APPROVED")).toHaveLength(3);
    const [reserved] = await h.db
      .select({
        total: sql<string>`coalesce(sum(${t.spendingReservations.amountUsdMinor}), 0)::text`,
      })
      .from(t.spendingReservations)
      .where(
        and(
          eq(t.spendingReservations.agentId, agentId),
          eq(t.spendingReservations.status, "active"),
        ),
      );
    expect(BigInt(reserved?.total ?? "0")).toBeLessThanOrEqual(5000n);
  });

  it("a request waits for the agent_policies row lock held by another connection", async () => {
    const agentId = await autonomousAgent();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM agent_policies WHERE agent_id = $1 FOR UPDATE", [agentId]);
      let settled = false;
      const pending = fire(h, agentId, [sendInput(user)]).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false); // blocked on the row lock
      await holder.query("COMMIT");
      const [result] = await pending;
      expect(result?.json.request.state).toBe("APPROVED");
    } finally {
      holder.release();
    }
  });

  it("parallel duplicates with one idempotency key create exactly one request", async () => {
    const agentId = await autonomousAgent();
    const body = sendInput(user);
    const results = await fire(
      h,
      agentId,
      Array.from({ length: 10 }, () => body),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json.request.requestId)).size).toBe(1);
  });

  it("concurrent EVM nonce allocation for one address never hands out a nonce twice", async () => {
    const { allocateEvmNonce } = await import("../../src/services/build");
    const base = h.deps.chain.builder("base-sepolia");
    const builder = { ...base, getNonceState: () => Promise.resolve({ latest: 0, pending: 3 }) };
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const body = {
        walletId: user.walletId,
        network: "base-sepolia",
        to: "0x52908400098527886E0F7030069857D2E4169EE7",
        assetId: "base-sepolia:native",
        amount: "1000",
        decimals: 18,
        idempotencyKey: `pg-nonce-${i}-${Date.now()}`,
      };
      const res = await call(h, "POST", "/v1/send/quote", {
        token: user.accessToken,
        body,
        idempotencyKey: body.idempotencyKey,
      });
      expect(res.status).toBe(200);
      ids.push(res.json.review.request.id as string);
    }
    const ctx = { deps: h.deps, requestId: "pg-test", ip: null };
    const [{ evm }] = [user];
    const nonces = await Promise.all(
      ids.map((id) => allocateEvmNonce(ctx, id, "base-sepolia", evm, builder)),
    );
    expect(new Set(nonces).size).toBe(ids.length);
    expect(Math.min(...nonces)).toBeGreaterThanOrEqual(3);
  });
});
