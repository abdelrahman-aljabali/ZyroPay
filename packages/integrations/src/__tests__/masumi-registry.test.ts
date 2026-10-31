import * as x402c from "@x402/cardano";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/masumi-registry/preprod.json";
import {
  createMasumiRegistryClient,
  createMemoryRegistryCache,
  MASUMI_REGISTRY_POLICY_IDS,
  normalizeMasumiUnit,
  type MasumiRegistryConfig,
} from "../masumi-registry";

/*
 * Masumi registry discovery + seller verification. Offline: Blockfrost responses recorded
 * read-only from cardano-preprod on 2026-10-30 (fixtures/masumi-registry/preprod.json).
 * One LIVE_TESTS=1 test reads the real registry (BLOCKFROST_PROJECT_ID_PREPROD).
 */

const BASE = "https://cardano-preprod.blockfrost.io/api/v0";
const POLICY = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";
const PPB = `${POLICY}10e01432821eb869e1711c8fdaec0090f133ae05941f68b4916cf4a0bb000000`; // 5 ADA fixed, https
const ARDA = `${POLICY}10d32fc52f86241613227bd00e03d8f64d5fa2cf84969060e914237115000000`; // 1 tUSDM fixed
const MILKY = `${POLICY}10e054a0de39e1903a5af0893fee3691b79aba9911f031ce0cbefed343000000`; // dynamic, 127.0.0.1
const BURNED = `${POLICY}1097b7aee0459af30fe27b79330074d703900a670bfbd3d50ab3d26a56000000`;
const PPB_HOLDER =
  "addr_test1qr3l0k6npvhznqv8u0x7v6www8p4phnsjq8m8cxlmynpyxrdt6tjh8gq2f8m95av4jl0dpzxlugtg6v8aaafl2725kyqhuz79v";
const ARDA_HOLDER =
  "addr_test1qr98r6ej55v5zz5wrqu50vh2mrurtvc0d03rkzumpk8wkjcuqgpcuqjhdh7dghcnq9kw283tg66svw7wzycmlmcys3ksq6nl4z";
const TUSDM = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

type Route = { status: number; body: unknown };
const ROUTES = (fixture as { routes: Record<string, Route> }).routes;

function fixtureFetch(extra: Record<string, Route> = {}) {
  const calls: string[] = [];
  const fn = vi.fn((input: string, init?: RequestInit) => {
    expect(input.startsWith(BASE)).toBe(true);
    expect((init?.headers as Record<string, string>).project_id).toBe("preprodTESTKEY");
    const path = input.slice(BASE.length);
    calls.push(path);
    const route = extra[path] ?? ROUTES[path];
    if (route === undefined)
      return Promise.resolve(
        new Response(JSON.stringify({ status_code: 404, error: "Not Found" }), { status: 404 }),
      );
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return { fn, calls };
}

function client(fetchFn: MasumiRegistryConfig["fetch"], over: Partial<MasumiRegistryConfig> = {}) {
  return createMasumiRegistryClient({
    network: "cardano-preprod",
    blockfrostProjectId: "preprodTESTKEY",
    fetch: fetchFn,
    sleep: () => Promise.resolve(),
    ...over,
  });
}

/** A recorded asset with its holder and endpoint swapped (synthetic, for identity tests). */
function synthetic(unit: string, holder: string, apiBaseUrl: string): Record<string, Route> {
  const asset = structuredClone(ROUTES[`/assets/${PPB}`]!.body) as Record<string, unknown>;
  asset.asset = unit;
  asset.asset_name = unit.slice(56);
  (asset.onchain_metadata as Record<string, unknown>).api_base_url = [apiBaseUrl];
  return {
    [`/assets/${unit}`]: { status: 200, body: asset },
    [`/assets/${unit}/addresses?order=desc&count=2`]: {
      status: 200,
      body: [{ address: holder, quantity: "1" }],
    },
  };
}

describe("masumi registry: constants", () => {
  it("uses the V2 policy @x402/cardano enforces, on both networks", () => {
    expect(x402c.MASUMI_REGISTRY_POLICY_ID).toBe(POLICY);
    expect(MASUMI_REGISTRY_POLICY_IDS["cardano-preprod"]).toBe(POLICY);
    expect(MASUMI_REGISTRY_POLICY_IDS["cardano-mainnet"]).toBe(POLICY);
  });

  it("normalizes price units", () => {
    expect(normalizeMasumiUnit("")).toBe("lovelace");
    expect(normalizeMasumiUnit("lovelace")).toBe("lovelace");
    expect(normalizeMasumiUnit(`${TUSDM.slice(0, 56)}.${TUSDM.slice(56)}`)).toBe(TUSDM);
    expect(normalizeMasumiUnit("nope")).toBeNull();
  });

  it("binds the Blockfrost key to the network", () => {
    expect(() =>
      createMasumiRegistryClient({ network: "cardano-preprod", blockfrostProjectId: "mainnetX" }),
    ).toThrow(/preprod/);
    expect(() =>
      createMasumiRegistryClient({ network: "solana-devnet", blockfrostProjectId: "preprodX" }),
    ).toThrow(/no Masumi registry/);
  });
});

describe("masumi registry: resolve", () => {
  it("resolves a live agent: metadata chunks joined, seller = NFT holder", async () => {
    const { fn } = fixtureFetch();
    const r = await client(fn).resolveAgent(PPB);
    expect(r.status).toBe("active");
    if (r.status !== "active") return;
    const a = r.agent;
    expect(a.name).toBe("ppb pay-on-pass agent");
    expect(a.apiBaseUrl).toBe("https://teenage-newly-warming-shore.trycloudflare.com");
    expect(a.capability).toEqual({ name: "pay on pass gate", version: "0.1.0" });
    expect(a.tags).toContain("tum-hackathon");
    expect(a.pricing).toEqual({
      type: "Fixed",
      amounts: [{ unit: "lovelace", amount: "5000000" }],
    });
    expect(a.masumiEscrow).toBe(true);
    expect(a.paymentSources[0]?.address).toBe(
      "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g",
    );
    expect(a.holderAddress).toBe(PPB_HOLDER);
    expect(a.sellerPaymentKeyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(a.version).toBe(0);
    expect(a.registeredAt).toMatch(/^2026-/);
    expect(a.txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports burned, not found and invalid identifiers", async () => {
    const { fn } = fixtureFetch();
    const c = client(fn);
    expect((await c.resolveAgent(BURNED)).status).toBe("burned");
    expect((await c.resolveAgent(`${POLICY}10${"ff".repeat(28)}000000`)).status).toBe("not_found");
    expect((await c.resolveAgent("abc")).status).toBe("invalid");
    // V1 policy / foreign policy: refused before any request.
    const v1 = `7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77${"10".repeat(32)}`;
    expect((await c.resolveAgent(v1)).status).toBe("invalid");
    // Reserved CIP-67-like nonce.
    expect((await c.resolveAgent(`${POLICY}0f${"ab".repeat(31)}`)).status).toBe("invalid");
  });

  it("caches immutable metadata; liveness is re-read when it expires", async () => {
    let t = 0;
    const cache = createMemoryRegistryCache({ now: () => t });
    const { fn, calls } = fixtureFetch();
    const c = client(fn, { cache });
    await c.resolveAgent(PPB);
    const first = calls.length;
    await c.resolveAgent(PPB);
    expect(calls.length).toBe(first); // all cached
    t += 61_000;
    await c.resolveAgent(PPB);
    expect(calls.slice(first)).toEqual([`/assets/${PPB}/addresses?order=desc&count=2`]);
  });
});

describe("masumi registry: search", () => {
  it("lists live agents only (burned entries skipped)", async () => {
    const { fn } = fixtureFetch();
    const r = await client(fn).searchAgents({ limit: 50 });
    const ids = r.agents.map((a) => a.agentIdentifier);
    expect(ids).toContain(PPB);
    expect(ids).toContain(ARDA);
    expect(ids).not.toContain(BURNED);
    expect(r.scanned).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.agents.every((a) => a.active && a.holderAddress !== null)).toBe(true);
  });

  it("filters by query, capability, tag, maxPrice", async () => {
    const { fn } = fixtureFetch();
    const c = client(fn);
    expect(
      (await c.searchAgents({ query: "PAY-ON-PASS" })).agents.map((a) => a.agentIdentifier),
    ).toEqual([PPB]);
    expect(
      (await c.searchAgents({ capability: "claude-opus-5-5" })).agents.map((a) => a.name),
    ).toEqual(["Hakimi Milky"]);
    expect((await c.searchAgents({ tag: "tum-hackathon" })).agents).toHaveLength(2);
    const cheapAda = await c.searchAgents({ maxPrice: { unit: "lovelace", amount: "1000000" } });
    expect(cheapAda.agents.map((a) => a.name)).toEqual(["Basic Test Agent"]);
    const usdm = await c.searchAgents({ maxPrice: { unit: TUSDM, amount: "1000000" } });
    expect(usdm.agents.map((a) => a.agentIdentifier).sort()).toEqual(
      [ARDA, `${POLICY}118644e262a3e7c8da68ec66c971f2bbecf0d39851fe19a6d122fa878e000000`].sort(),
    );
    const withDynamic = await c.searchAgents({
      maxPrice: { unit: TUSDM, amount: "1" },
      includeDynamic: true,
    });
    expect(withDynamic.agents.map((a) => a.agentIdentifier)).toEqual([MILKY]);
  });

  it("honours limit and the scan budget", async () => {
    const { fn } = fixtureFetch();
    const r = await client(fn).searchAgents({ maxScan: 2 });
    expect(r.scanned).toBe(2);
    expect(r.truncated).toBe(true);
    const l = await client(fn).searchAgents({ limit: 1 });
    expect(l.agents).toHaveLength(1);
  });

  it("fails on an upstream outage of the listing (no silent empty result)", async () => {
    const fn = vi.fn(() => Promise.resolve(new Response("down", { status: 503 })));
    await expect(client(fn).searchAgents()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fn).toHaveBeenCalledTimes(2); // one retry
  });
});

describe("masumi registry: verifySeller", () => {
  it("accepts the NFT holder at the registered endpoint and price", async () => {
    const { fn } = fixtureFetch();
    const r = await client(fn).verifySeller({
      agentIdentifier: PPB,
      sellerAddress: PPB_HOLDER,
      resourceUrl: "https://teenage-newly-warming-shore.trycloudflare.com/start_job",
      asset: "lovelace",
      amount: "5000000",
    });
    expect(r).toMatchObject({ ok: true, reasons: [] });
    expect(r.agent?.agentIdentifier).toBe(PPB);
  });

  it("accepts a token price given as policy.name", async () => {
    const { fn } = fixtureFetch();
    const r = await client(fn).verifySeller({
      agentIdentifier: ARDA,
      sellerAddress: ARDA_HOLDER,
      asset: `${TUSDM.slice(0, 56)}.${TUSDM.slice(56)}`,
      amount: "1000000",
    });
    expect(r.reasons).toEqual([]);
  });

  it("rejects another key claiming the agent (identity theft)", async () => {
    const { fn } = fixtureFetch();
    const r = await client(fn).verifySeller({ agentIdentifier: PPB, sellerAddress: ARDA_HOLDER });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(["seller_mismatch"]);
  });

  it("rejects a mismatched endpoint, price, burned NFT and insecure endpoint", async () => {
    const { fn } = fixtureFetch();
    const c = client(fn);
    const host = await c.verifySeller({
      agentIdentifier: PPB,
      sellerAddress: PPB_HOLDER,
      resourceUrl: "https://evil.example/start_job",
    });
    expect(host.reasons).toEqual(["endpoint_mismatch"]);
    const price = await c.verifySeller({
      agentIdentifier: PPB,
      sellerAddress: PPB_HOLDER,
      asset: "lovelace",
      amount: "5000001",
    });
    expect(price.reasons).toEqual(["price_mismatch"]);
    const burned = await c.verifySeller({ agentIdentifier: BURNED, sellerAddress: PPB_HOLDER });
    expect(burned.reasons).toContain("burned");
    const local = await c.verifySeller({ agentIdentifier: MILKY, sellerVkey: "00".repeat(28) });
    expect(local.reasons).toContain("endpoint_insecure");
    expect(local.reasons).toContain("seller_mismatch");
    const dev = await client(fn, { allowInsecureEndpoints: true }).verifySeller({
      agentIdentifier: MILKY,
      sellerAddress:
        "addr_test1qqp4e8zusckq0p5ys69nv6nm65als36ka6n3a0ec5dlvtwga6k89kvsx2am6tee4t2pv5npgdkqrt69seu2ga296p56qegqsee",
      asset: "lovelace",
      amount: "123", // Dynamic: any signed price
    });
    expect(dev.reasons).toEqual([]);
  });

  it("rejects the wrong policy, missing seller, other network, and an allowlist miss", async () => {
    const { fn } = fixtureFetch();
    const c = client(fn);
    const v1 = `7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77${"10".repeat(32)}`;
    expect(
      (await c.verifySeller({ agentIdentifier: v1, sellerAddress: PPB_HOLDER })).reasons,
    ).toEqual(["wrong_policy"]);
    expect((await c.verifySeller({ agentIdentifier: PPB })).reasons).toEqual(["seller_missing"]);
    const mainnetAddr =
      "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
    expect(
      (await c.verifySeller({ agentIdentifier: PPB, sellerAddress: mainnetAddr })).reasons,
    ).toContain("network_mismatch");
    const trusted = client(fn, { trust: { agentIdentifiers: [ARDA] } });
    expect(
      (await trusted.verifySeller({ agentIdentifier: PPB, sellerAddress: PPB_HOLDER })).reasons,
    ).toEqual(["not_trusted"]);
  });

  it("fails closed when Blockfrost is down", async () => {
    const fn = vi.fn(() => Promise.reject(new TypeError("network down")));
    const r = await client(fn).verifySeller({ agentIdentifier: PPB, sellerAddress: PPB_HOLDER });
    expect(r).toMatchObject({ ok: false, reasons: ["upstream_unavailable"], agent: null });
  });

  it("caps response size", async () => {
    const big = JSON.stringify({ asset: PPB, pad: "x".repeat(300_000) });
    const fn = vi.fn(() => Promise.resolve(new Response(big, { status: 200 })));
    const r = await client(fn).verifySeller({ agentIdentifier: PPB, sellerAddress: PPB_HOLDER });
    expect(r.reasons).toEqual(["upstream_unavailable"]);
    expect(r.details[0]).toMatch(/too large/);
  });

  it("times out a hanging request", async () => {
    const fn = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const r = await client(fn, { timeoutMs: 20, maxRetries: 0 }).verifySeller({
      agentIdentifier: PPB,
      sellerAddress: PPB_HOLDER,
    });
    expect(r.reasons).toEqual(["upstream_unavailable"]);
  });
});

describe("masumi registry: @x402/cardano registry hook", () => {
  /** TEST ONLY: a throwaway BIP-39 phrase, never funded (same as x402-masumi.test.ts). */
  const SELLER = x402c.toMasumiSellerSigner({
    mnemonic: "test walk nut penalty hip pave soap entry language right filter choice",
    network: "cardano:preprod",
  });
  const NOW = new Date("2026-10-30T12:00:00.000Z");
  const PAY_BY = NOW.getTime() + 4 * 60_000;
  const RESOURCE = "https://seller.example.com/v1/jobs/42";
  const AGENT = `${POLICY}10${"5a".repeat(28)}000000`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function issue(agentIdentifier: string, amount = "5000000") {
    return x402c.issueMasumiRequirements({
      network: "cardano:preprod",
      asset: "lovelace",
      amount,
      maxTimeoutSeconds: 300,
      sellerAddress: SELLER.sellerAddress,
      signTerms: SELLER.signTerms,
      agentIdentifier,
      commitment: [
        {
          name: "resource",
          canonicalization: "jcs",
          mediaType: "application/json",
          content: { url: RESOURCE },
        },
      ],
      payByTime: String(PAY_BY),
      submitResultTime: String(PAY_BY + 15 * 60_000),
      unlockTime: String(PAY_BY + 35 * 60_000),
      externalDisputeUnlockTime: String(PAY_BY + 55 * 60_000),
    });
  }

  async function authorize(
    routes: Record<string, Route>,
    agentIdentifier: string,
    amount?: string,
  ) {
    const { fn } = fixtureFetch(routes);
    const req = await issue(agentIdentifier, amount);
    const extra = req.extra as unknown as x402c.CardanoExtraMasumi;
    return x402c.verifyMasumiAuthorization(extra, req, {
      requireAllPartContent: true,
      resource: { url: RESOURCE },
      validateRegistryClaim: client(fn).registryValidator(),
    });
  }

  it("lets a registered seller's signed terms through", async () => {
    const r = await authorize(
      synthetic(AGENT, SELLER.sellerAddress, "https://seller.example.com/v1"),
      AGENT,
    );
    expect(r.ok).toBe(true);
  });

  it("refuses the claim when the signer does not hold the NFT", async () => {
    const r = await authorize({}, PPB); // PPB is held by someone else
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/registry validation rejected/);
  });

  it("refuses the claim for another endpoint or price", async () => {
    const other = await authorize(
      synthetic(AGENT, SELLER.sellerAddress, "https://other.example.com"),
      AGENT,
    );
    expect(other.ok).toBe(false);
    const price = await authorize(
      synthetic(AGENT, SELLER.sellerAddress, "https://seller.example.com/v1"),
      AGENT,
      "9000000",
    );
    expect(price.ok).toBe(false);
  });

  it("without a validator @x402/cardano refuses any claim (why ZyroPay needs this module)", async () => {
    const req = await issue(AGENT);
    const r = await x402c.verifyMasumiAuthorization(req.extra as never, req, {
      requireAllPartContent: true,
    });
    expect(r.ok).toBe(false);
  });
});

const LIVE_KEY = process.env.BLOCKFROST_PROJECT_ID_PREPROD ?? process.env.BLOCKFROST_PROJECT_ID;
describe.skipIf(process.env.LIVE_TESTS !== "1" || !LIVE_KEY?.startsWith("preprod"))(
  "live: Masumi registry on preprod (read-only)",
  () => {
    it("discovers agents and verifies one against its own holder", async () => {
      const c = createMasumiRegistryClient({
        network: "cardano-preprod",
        blockfrostProjectId: LIVE_KEY ?? "",
        allowInsecureEndpoints: true,
      });
      const r = await c.searchAgents({ limit: 3, maxScan: 20 });
      expect(r.agents.length).toBeGreaterThan(0);
      const agent = r.agents.find((a) => a.sellerPaymentKeyHash !== null);
      expect(agent).toBeDefined();
      if (agent === undefined) return;
      const v = await c.verifySeller({
        agentIdentifier: agent.agentIdentifier,
        sellerVkey: agent.sellerPaymentKeyHash ?? "",
        requireEscrow: false,
      });
      expect(v.reasons).toEqual([]);
    }, 60_000);
  },
);
