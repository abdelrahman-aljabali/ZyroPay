/*
 * Test harness: in-process Postgres (PGlite) with the REAL migrations applied, the real
 * Hono app and services, Mock* adapters and MockTurnkey. Requests go through app.request,
 * so auth, validation, rate limiting and error mapping are exercised end to end.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { NetworkId, StampedTurnkeyRequest } from "@zyropay/shared";
import { sha256Hex } from "@zyropay/shared";
import {
  MockTurnkey,
  mockPasskeyStamp,
  turnkeyTransactionType,
  decodeTransaction,
  bytesToHex,
} from "@zyropay/wallet";
import { drizzle } from "drizzle-orm/pglite";
import { createApp } from "../src/app";
import type { Db } from "../src/db/client";
import type { AppDeps } from "../src/deps";
import type { AppConfig, Env } from "../src/env";
import { parseConfig } from "../src/env";
import { uuidV7 } from "../src/lib/crypto";
import { silentLogger } from "../src/lib/logger";
import type { McpClient } from "../src/services/mcp";
import type { MockMasumiAgentSpec } from "../src/providers/mocks";
import {
  createMockChainAdapters,
  createMockMasumiRegistry,
  MockBroadcaster,
  MockNotifier,
  MockOnrampProvider,
  MockPluginAdapter,
  MockPortfolioProvider,
  MockPriceHistoryProvider,
  MockPriceProvider,
} from "../src/providers/mocks";
import { handleMessage } from "../src/queue/consumer";
import { InMemoryQueue } from "../src/queue/messages";
import { resolveDelegatedKey } from "../src/services/execution";

const migrationDir = new URL("../../../infrastructure/database/drizzle/", import.meta.url);

/** Every migration registered in drizzle-kit's journal, in order. */
function migrationFiles(): string[] {
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrationDir), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => `${e.tag}.sql`);
}

/** Apply the journal's migrations statement by statement (PGlite or any `exec`). */
export async function applyMigrations(exec: (sql: string) => Promise<unknown>): Promise<void> {
  for (const file of migrationFiles()) {
    const sql = readFileSync(new URL(file, migrationDir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await exec(statement);
    }
  }
}

/*
 * Booting PGlite (WASM compile + initdb) and applying every migration costs seconds of CPU.
 * Under `pnpm check` that cost ran in ~10 vitest workers at once next to tsc and type-aware
 * eslint, and the first harness of a file regularly exceeded the 60 s hook timeout. So each
 * worker builds ONE migrated template and every harness gets a clone of it (a datadir copy,
 * a few hundred ms). Each clone is a fully independent database, as before.
 */
let template: Promise<PGlite> | null = null;

function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await applyMigrations((sql) => pg.exec(sql));
    return pg;
  })();
  return template;
}

const openDbs: PGlite[] = [];

async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = (await (await migratedTemplate()).clone()) as PGlite;
  openDbs.push(pg);
  return { db: drizzle({ client: pg }) as unknown as Db, pg };
}

/** Close every PGlite this worker opened (called from the vitest setup file). */
export async function closeTestDbs(): Promise<void> {
  const all = openDbs.splice(0);
  const tpl = template;
  template = null;
  if (tpl !== null) all.push(await tpl);
  await Promise.allSettled(all.map((pg) => pg.close()));
}

export const INTERNAL_TOKEN = "internal-test-token-0123456789abcdefghijkl";
export const HELIUS_SECRET = "helius-test-secret";
export const ALCHEMY_KEY = "alchemy-test-signing-key";
export const TRANSAK_SECRET = "transak-test-secret";
export const KEK = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 32 bytes

export class TestClock {
  constructor(public current = new Date("2026-10-30T12:00:00.000Z")) {}
  now = (): Date => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Harness {
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  turnkey: MockTurnkey;
  queue: InMemoryQueue;
  clock: TestClock;
  broadcaster: MockBroadcaster;
  notifier: MockNotifier;
  prices: MockPriceProvider;
  onramp: MockOnrampProvider;
  mcp: FakeMcpClient;
  db: Db;
  /** Process queued messages (and the messages they enqueue) until empty. */
  drain(): Promise<void>;
}

const GENEROUS = { limit: 100_000, windowSeconds: 60 };

/** Records revocation pushes to the MCP worker; `failNext` simulates an unreachable MCP. */
export class FakeMcpClient implements McpClient {
  readonly revoked: { agentId: string; userId: string }[] = [];
  failNext = 0;
  revokeAgentGrants(input: { agentId: string; userId: string }): Promise<number> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error("mcp unreachable"));
    }
    this.revoked.push(input);
    return Promise.resolve(1);
  }
}

export async function createHarness(
  envOverrides: Partial<Env> = {},
  options: {
    rateLimits?: Partial<AppConfig["rateLimits"]>;
    db?: Db;
    /** Entries of the mock Masumi registry (default MOCK_MASUMI_AGENTS); null = not configured. */
    masumiAgents?: readonly MockMasumiAgentSpec[] | null;
  } = {},
): Promise<Harness> {
  const db = options.db ?? (await createTestDb()).db;
  const clock = new TestClock();
  const queue = new InMemoryQueue();
  const env: Env = {
    ZYROPAY_MODE: "development",
    ZYROPAY_USE_MOCK_ADAPTERS: "true",
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    DELEGATED_KEY_ENCRYPTION_KEY: KEK,
    HELIUS_WEBHOOK_SECRET: HELIUS_SECRET,
    ALCHEMY_WEBHOOK_SIGNING_KEY: ALCHEMY_KEY,
    TRANSAK_WEBHOOK_SECRET: TRANSAK_SECRET,
    AUDIT_IP_HASH_SALT: "test-salt",
    ...envOverrides,
  };
  const parsed = parseConfig(env);
  const config: AppConfig = {
    ...parsed,
    rateLimits: {
      auth: GENEROUS,
      user: GENEROUS,
      internal: GENEROUS,
      webhook: GENEROUS,
      connectionClaim: GENEROUS,
      ...options.rateLimits,
    },
  };
  const turnkey = new MockTurnkey({ apiBaseUrl: config.turnkeyApiBaseUrl });
  const broadcaster = new MockBroadcaster();
  const notifier = new MockNotifier();
  const prices = new MockPriceProvider(clock.now);
  const onramp = new MockOnrampProvider(TRANSAK_SECRET, clock.now);
  const mcp = new FakeMcpClient();
  const chain = createMockChainAdapters(clock.now, broadcaster);
  const masumiRegistry =
    options.masumiAgents === null ? null : createMockMasumiRegistry(options.masumiAgents);
  const deps: AppDeps = {
    config,
    db,
    turnkey,
    chain,
    portfolio: new MockPortfolioProvider(clock.now),
    prices,
    priceHistory: new MockPriceHistoryProvider(clock.now),
    onramp,
    notifier,
    plugins: {
      x402: new MockPluginAdapter("x402", clock.now, masumiRegistry),
    },
    masumiRegistry,
    queue,
    mcp,
    clock: { now: clock.now },
    ids: uuidV7,
    logger: silentLogger,
  };
  turnkey.setDelegatedKeyResolver((subOrgId) => resolveDelegatedKey(deps, subOrgId));
  const app = createApp({
    deps: () => deps,
    health: () => ({ mode: config.mode, mocks: config.useMocks }),
  });
  const drain = async () => {
    for (let i = 0; i < 50; i++) {
      const batch = queue.take();
      if (batch.length === 0) return;
      for (const m of batch) await handleMessage(deps, m);
    }
    throw new Error("queue did not drain");
  };
  return {
    deps,
    app,
    turnkey,
    queue,
    clock,
    broadcaster,
    notifier,
    prices,
    onramp,
    mcp,
    db,
    drain,
  };
}

// --- HTTP helpers --------------------------------------------------------------------

export interface CallOptions {
  token?: string;
  internal?: boolean | string;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: string;
  idempotencyKey?: string;
}

export async function call(
  h: Harness,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.internal !== undefined && opts.internal !== false) {
    headers.authorization = `Bearer ${opts.internal === true ? INTERNAL_TOKEN : opts.internal}`;
  }
  if (opts.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await h.app.request(path, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? null : JSON.parse(text) };
}

// --- Turnkey stamping helpers ------------------------------------------------------

const TK = "https://api.turnkey.com";

export function stampedWhoami(credentialId: string, organizationId: string): StampedTurnkeyRequest {
  const body = JSON.stringify({ organizationId });
  return { url: `${TK}/public/v1/query/whoami`, body, stamp: mockPasskeyStamp(credentialId, body) };
}

export function stampedSign(
  credentialId: string,
  opts: {
    organizationId: string;
    signWith: string;
    network: NetworkId;
    unsigned: { encoding: "base64" | "hex"; serialized: string };
    timestampMs?: number;
  },
): StampedTurnkeyRequest {
  const family = opts.network.startsWith("solana") ? "solana" : "evm";
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    timestampMs: String(opts.timestampMs ?? Date.parse("2026-10-30T12:00:00.000Z")),
    organizationId: opts.organizationId,
    parameters: {
      signWith: opts.signWith,
      unsignedTransaction: bytesToHex(
        decodeTransaction(opts.unsigned.serialized, opts.unsigned.encoding),
      ),
      type: turnkeyTransactionType(family),
    },
  });
  return {
    url: `${TK}/public/v1/submit/sign_transaction`,
    body,
    stamp: mockPasskeyStamp(credentialId, body),
  };
}

export interface TestUser {
  credentialId: string;
  organizationId: string;
  turnkeyUserId: string;
  solana: string;
  evm: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  walletId: string;
}

let userCounter = 0;

export async function signUp(h: Harness, label = "user"): Promise<TestUser> {
  userCounter++;
  const credentialId = `cred-${label}-${userCounter}-${sha256Hex(String(Math.random())).slice(0, 6)}`;
  const org = h.turnkey.createSubOrg({ credentialId });
  const res = await call(h, "POST", "/v1/auth/session", {
    body: { whoamiRequest: stampedWhoami(credentialId, org.organizationId) },
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${JSON.stringify(res.json)}`);
  const wallets = await call(h, "GET", "/v1/wallets", { token: res.json.session.accessToken });
  return {
    credentialId,
    organizationId: org.organizationId,
    turnkeyUserId: org.userId,
    solana: org.solana,
    evm: org.evm,
    userId: res.json.user.id,
    accessToken: res.json.session.accessToken,
    refreshToken: res.json.session.refreshToken,
    walletId: wallets.json.wallets[0].id,
  };
}

/** Run the full MCP connection flow; returns the agent id. */
export async function connectAgent(
  h: Harness,
  user: TestUser,
  networks: NetworkId[] = ["solana-devnet", "base-sepolia"],
): Promise<string> {
  const created = await call(h, "POST", "/internal/v1/agent-connections", {
    internal: true,
    body: {
      oauthClientId: `client-${user.userId}`,
      clientName: "Test Agent",
      clientUri: null,
      redirectUri: "https://agent.example/callback",
      scopes: ["mcp"],
    },
  });
  const claimed = await call(h, "POST", "/v1/agent-connections/claim", {
    token: user.accessToken,
    body: { userCode: created.json.connection.userCode },
  });
  const approved = await call(
    h,
    "POST",
    `/v1/agent-connections/${claimed.json.connection.id}/approve`,
    {
      token: user.accessToken,
      body: { name: "Agent", walletIds: [user.walletId], networks },
    },
  );
  if (approved.status !== 200) throw new Error(`connect failed: ${JSON.stringify(approved.json)}`);
  return approved.json.agent.id;
}

/** Set an agent's policy through the API (and the delegated signer for autonomous mode). */
export async function setPolicy(
  h: Harness,
  user: TestUser,
  agentId: string,
  patch: Record<string, unknown>,
): Promise<any> {
  const current = await call(h, "GET", `/v1/agents/${agentId}/policy`, { token: user.accessToken });
  const { version, revoked: _revoked, ...policy } = current.json.policy;
  const res = await call(h, "PUT", `/v1/agents/${agentId}/policy`, {
    token: user.accessToken,
    body: { expectedVersion: version, policy: { ...policy, ...patch } },
  });
  if (res.status !== 200) throw new Error(`policy update failed: ${JSON.stringify(res.json)}`);
  return res.json.policy;
}

/** Simulate the app enabling autonomous signing (ADR-001 D6) end to end. */
export async function enableDelegatedSigner(h: Harness, user: TestUser): Promise<void> {
  const created = await call(h, "POST", "/v1/delegated-signer", { token: user.accessToken });
  const turnkeyUserId = `delegated-${user.userId.slice(0, 8)}`;
  h.turnkey.addApiKeyUser(user.organizationId, turnkeyUserId, created.json.signer.apiPublicKey);
  h.turnkey.addPolicy(user.organizationId, {
    policyId: `p-${turnkeyUserId}`,
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${turnkeyUserId}')`,
  });
  const activated = await call(h, "POST", "/v1/delegated-signer/activate", {
    token: user.accessToken,
    body: { turnkeyUserId },
  });
  if (activated.status !== 200)
    throw new Error(`activation failed: ${JSON.stringify(activated.json)}`);
}

export const sendInput = (user: TestUser, overrides: Record<string, unknown> = {}) => ({
  tool: "send",
  input: {
    walletId: user.walletId,
    network: "solana-devnet",
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    assetId: "solana-devnet:native",
    amount: "100000000", // 0.1 SOL = $15 at the mock price
    decimals: 9,
    idempotencyKey: `idem-${sha256Hex(String(Math.random())).slice(0, 16)}`,
    ...overrides,
  },
});
