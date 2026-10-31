import type { WatchedAddress } from "@zyropay/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ChainError } from "../errors";
import type { FetchLike } from "../http";
import { JsonRpcClient, resolveHttpOptions } from "../http";
import type { KeyFailoverEvent } from "../key-failover";
import {
  ApiKeyPool,
  HELIUS_HOSTS,
  heliusKeyPool,
  parseKeyList,
  redactUrl,
  resetHeliusKeyPools,
} from "../key-failover";
import { rpcUrlFor } from "../networks";
import { createSolanaPortfolioProvider } from "../portfolio/solana";
import { noSleep } from "../testing";
import { SOL_FROM } from "./fixtures";

const K1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const K2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const K3 = "33333333-cccc-4ccc-8ccc-333333333333";

type Reply = { status: number; body: string; headers?: Record<string, string> };

/** Fetch stub answering per API key; records which key each attempt used. */
function keyedFetch(byKey: Record<string, Reply | (() => Reply)>): FetchLike & { used: string[] } {
  const used: string[] = [];
  const fn = (input: string): Promise<Response> => {
    const url = new URL(input);
    const key = url.searchParams.get("api-key") ?? "";
    used.push(key);
    const entry = byKey[key] ?? { status: 401, body: "Unauthorized" };
    const reply = typeof entry === "function" ? entry() : entry;
    return Promise.resolve(
      new Response(reply.body, { status: reply.status, headers: reply.headers ?? {} }),
    );
  };
  return Object.assign(fn, { used });
}

const ok = (result: unknown): Reply => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
});
const maxUsage: Reply = { status: 429, body: "max usage reached" };

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function pool(keys: string[], c = clock(), events: KeyFailoverEvent[] = []): ApiKeyPool {
  return new ApiKeyPool(keys, {
    provider: "helius",
    hosts: HELIUS_HOSTS,
    now: c.now,
    onEvent: (e) => events.push(e),
  });
}

const devnetUrl = (key: string) => rpcUrlFor("solana-devnet", { heliusApiKey: key });

async function rpcCall(fetch: FetchLike, url: string) {
  const http = resolveHttpOptions({ fetch, sleep: noSleep, maxRetries: 0 });
  return new JsonRpcClient(url, http, "helius").call("getGenesisHash", []);
}

afterEach(() => {
  resetHeliusKeyPools();
});

describe("Helius key failover", () => {
  it("uses the primary key while it works", async () => {
    const stub = keyedFetch({ [K1]: ok("g1"), [K2]: ok("g2") });
    const p = pool([K1, K2]);
    await expect(rpcCall(p.wrap(stub), devnetUrl(K1))).resolves.toBe("g1");
    expect(stub.used).toEqual([K1]);
  });

  it("fails over on 429 'max usage reached' and cools the exhausted key down for an hour", async () => {
    const c = clock();
    const events: KeyFailoverEvent[] = [];
    const stub = keyedFetch({ [K1]: maxUsage, [K2]: ok("g2") });
    const p = pool([K1, K2], c, events);
    const fetch = p.wrap(stub);

    await expect(rpcCall(fetch, devnetUrl(K1))).resolves.toBe("g2");
    expect(stub.used).toEqual([K1, K2]);
    expect(events).toEqual([
      {
        provider: "helius",
        keyIndex: 0,
        keyCount: 2,
        status: 429,
        reason: "quota_exhausted",
        cooldownMs: 3_600_000,
        failedOver: true,
      },
    ]);

    // During the cooldown the exhausted key is skipped entirely.
    stub.used.length = 0;
    await expect(rpcCall(fetch, devnetUrl(K1))).resolves.toBe("g2");
    expect(stub.used).toEqual([K2]);

    // After the cooldown the primary is tried first again.
    c.advance(3_600_001);
    stub.used.length = 0;
    await rpcCall(fetch, devnetUrl(K1));
    expect(stub.used).toEqual([K1, K2]);
  });

  it("fails over on 401 (invalid key) with a 15 minute cooldown", async () => {
    const events: KeyFailoverEvent[] = [];
    const stub = keyedFetch({ [K1]: { status: 401, body: "Unauthorized" }, [K2]: ok("g2") });
    await expect(rpcCall(pool([K1, K2], clock(), events).wrap(stub), devnetUrl(K1))).resolves.toBe(
      "g2",
    );
    expect(events[0]).toMatchObject({ reason: "unauthorized", status: 401, cooldownMs: 900_000 });
  });

  it("treats a plain 429 as a short rate-limit cooldown and honours Retry-After", async () => {
    const events: KeyFailoverEvent[] = [];
    const stub = keyedFetch({
      [K1]: { status: 429, body: "Too Many Requests", headers: { "retry-after": "30" } },
      [K2]: ok("g2"),
    });
    await rpcCall(pool([K1, K2], clock(), events).wrap(stub), devnetUrl(K1));
    expect(events[0]).toMatchObject({ reason: "rate_limited", cooldownMs: 30_000 });
  });

  it("walks a list of three keys in order", async () => {
    const stub = keyedFetch({ [K1]: maxUsage, [K2]: { status: 403, body: "" }, [K3]: ok("g3") });
    await expect(rpcCall(pool([K1, K2, K3]).wrap(stub), devnetUrl(K1))).resolves.toBe("g3");
    expect(stub.used).toEqual([K1, K2, K3]);
  });

  it("returns the provider's error when every key fails, without leaking a key", async () => {
    const stub = keyedFetch({ [K1]: maxUsage, [K2]: maxUsage });
    const error = await rpcCall(pool([K1, K2]).wrap(stub), devnetUrl(K1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe("RATE_LIMITED");
    const text = JSON.stringify({ m: (error as Error).message, d: (error as ChainError).details });
    expect(text).not.toContain(K1);
    expect(text).not.toContain(K2);
  });

  it("when every key is cooling down, still tries the one whose cooldown ends first", () => {
    const c = clock();
    const p = pool([K1, K2], c);
    p.markFailed(0, "quota_exhausted", null); // 1 h
    p.markFailed(1, "unauthorized", null); // 15 min
    expect(p.order()).toEqual([1]);
    c.advance(900_001);
    expect(p.order()).toEqual([1]);
    expect(p.status()[0]).toBeGreaterThan(0);
  });

  it("does not fail over on other errors (500, JSON-RPC errors are the node's answer)", async () => {
    const stub = keyedFetch({ [K1]: { status: 500, body: "oops" }, [K2]: ok("g2") });
    await expect(rpcCall(pool([K1, K2]).wrap(stub), devnetUrl(K1))).rejects.toThrow(/HTTP 500/);
    expect(stub.used).toEqual([K1]);
  });

  it("leaves requests to other hosts untouched", async () => {
    const seen: string[] = [];
    const base: FetchLike = (input) => {
      seen.push(input);
      return Promise.resolve(new Response("{}", { status: 429 }));
    };
    const url = "https://eth-sepolia.g.alchemy.com/v2/alchemy-key";
    await pool([K1, K2]).wrap(base)(url, { method: "POST" });
    expect(seen).toEqual([url]);
  });

  it("replays the same body and method with the next key", async () => {
    const bodies: string[] = [];
    const base: FetchLike = (input, init) => {
      bodies.push(`${init?.method ?? ""} ${typeof init?.body === "string" ? init.body : ""}`);
      const key = new URL(input).searchParams.get("api-key");
      return Promise.resolve(
        key === K1
          ? new Response("max usage reached", { status: 429 })
          : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 })),
      );
    };
    await rpcCall(pool([K1, K2]).wrap(base), devnetUrl(K1));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("the shared pool keeps cooldowns across provider rebuilds (per isolate)", async () => {
    const stub = keyedFetch({ [K1]: maxUsage, [K2]: ok("g2") });
    await rpcCall(heliusKeyPool([K1, K2]).wrap(stub), devnetUrl(K1));
    stub.used.length = 0;
    // A fresh request builds a fresh provider, but gets the same pool.
    await rpcCall(heliusKeyPool([K1, K2]).wrap(stub), devnetUrl(K1));
    expect(stub.used).toEqual([K2]);
  });

  it("Solana portfolio (DAS getAssetsByOwner) fails over between keys", async () => {
    const das = {
      items: [],
      nativeBalance: { lamports: 5 },
    };
    const stub = keyedFetch({ [K1]: maxUsage, [K2]: ok(das) });
    const provider = createSolanaPortfolioProvider({
      heliusApiKey: [K1, K2],
      network: "solana-devnet",
      fetch: stub,
      sleep: noSleep,
    });
    const address: WatchedAddress = {
      walletId: "0199e7a0-0000-7000-8000-000000000001",
      network: "solana-devnet",
      address: SOL_FROM,
    };
    const snap = await provider.getSnapshot({ addresses: [address], currency: "USD" });
    expect(snap.stale).toBe(false);
    expect(stub.used).toEqual([K1, K2]);
  });

  it("Solana history (getTransactionsForAddress) fails over between keys", async () => {
    const stub = keyedFetch({
      [K1]: { status: 401, body: "Unauthorized" },
      [K2]: ok({ data: [] }),
    });
    const provider = createSolanaPortfolioProvider({
      heliusApiKey: [K1, K2],
      network: "solana-devnet",
      fetch: stub,
      sleep: noSleep,
    });
    const page = await provider.getTransactions({
      address: {
        walletId: "0199e7a0-0000-7000-8000-000000000001",
        network: "solana-devnet",
        address: SOL_FROM,
      },
      limit: 10,
    });
    expect(page.transactions).toEqual([]);
    expect(stub.used).toEqual([K1, K2]);
  });
});

describe("key helpers", () => {
  it("parseKeyList trims, splits commas, drops empties and duplicates", () => {
    expect(parseKeyList(` ${K1} `, undefined, `${K2},${K1}, ,${K3}`, "")).toEqual([K1, K2, K3]);
  });

  it("ApiKeyPool refuses an empty list", () => {
    expect(() => new ApiKeyPool([" ", ""], { provider: "helius", hosts: HELIUS_HOSTS })).toThrow(
      /no API key/,
    );
  });

  it("rpcUrlFor puts the first key of a list in the URL", () => {
    expect(rpcUrlFor("solana-mainnet", { heliusApiKey: [K2, K1] })).toBe(
      `https://mainnet.helius-rpc.com/?api-key=${K2}`,
    );
  });

  it("redactUrl strips Helius, Alchemy and Blockfrost style credentials", () => {
    const text = [
      `https://devnet.helius-rpc.com/?api-key=${K1}`,
      `https://api.helius.xyz/v0/addresses?foo=1&api-key=${K2}`,
      "https://eth-sepolia.g.alchemy.com/v2/abcDEF123_secret",
      "https://x.example/?token=sekrit1&key=sekrit2&project_id=preprodXYZ",
    ].join(" ");
    const out = redactUrl(text);
    for (const secret of [K1, K2, "abcDEF123_secret", "sekrit1", "sekrit2", "preprodXYZ"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("https://devnet.helius-rpc.com/?api-key=REDACTED");
    expect(out).toContain("foo=1");
  });
});
