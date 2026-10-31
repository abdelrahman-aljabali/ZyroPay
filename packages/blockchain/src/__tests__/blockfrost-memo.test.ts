/*
 * BlockfrostClient's per-isolate memo: clients on the global fetch (Workers build them per
 * request) check /genesis once per project and share the epoch's protocol parameters for a
 * minute; `fresh` bypasses it; an injected fetch never touches it; failures are not cached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockfrostClient } from "../cardano/blockfrost";

const PARAMS = {
  min_fee_a: 44,
  min_fee_b: 155381,
  coins_per_utxo_size: "4310",
  max_tx_size: 16384,
  max_val_size: "5000",
  price_mem: 0.0577,
  price_step: 0.0000721,
  collateral_percent: 150,
  max_collateral_inputs: 3,
  max_tx_ex_mem: "14000000",
  max_tx_ex_steps: "10000000000",
  cost_models_raw: { PlutusV3: [1, 2, 3] },
};

function stubFetch(failParams = 0) {
  const calls: string[] = [];
  let failures = failParams;
  const fetch = vi.fn((input: string) => {
    const path = new URL(input).pathname.replace(/^\/api\/v0/, "");
    calls.push(path);
    if (path === "/genesis") return Promise.resolve(Response.json({ network_magic: 1 }));
    if (path === "/epochs/latest/parameters") {
      if (failures > 0) {
        failures--;
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      return Promise.resolve(Response.json(PARAMS));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

/** A project id per test: the memo is module state, keyed by project. */
let n = 0;
const client = (extra: Record<string, unknown> = {}) =>
  new BlockfrostClient({
    projectId: `preprodMEMO${String(++n).padStart(4, "0")}`,
    network: "cardano-preprod",
    maxRetries: 0,
    ...extra,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BlockfrostClient per-isolate memo", () => {
  it("checks /genesis once per project and shares protocol parameters for a minute", async () => {
    const calls = stubFetch();
    const first = client();
    const projectId = (first as unknown as { projectId: string }).projectId;
    const again = () =>
      new BlockfrostClient({ projectId, network: "cardano-preprod", maxRetries: 0 });
    expect((await first.protocolParams()).coinsPerUtxoByte).toBe(4310n);
    expect((await again().protocolParams()).minFeeA).toBe(44n);
    expect((await again().scriptProtocolParams()).plutusV3CostModel).toEqual([1n, 2n, 3n]);
    expect(calls.filter((c) => c === "/genesis")).toHaveLength(1);
    expect(calls.filter((c) => c === "/epochs/latest/parameters")).toHaveLength(1);
    // `fresh` reads them again.
    await again().scriptProtocolParams({ fresh: true });
    expect(calls.filter((c) => c === "/epochs/latest/parameters")).toHaveLength(2);
  });

  it("expires the parameters after a minute and never caches a failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls = stubFetch(1);
    const c = client();
    await expect(c.protocolParams()).rejects.toThrow();
    await c.protocolParams();
    await c.protocolParams();
    expect(calls.filter((p) => p === "/epochs/latest/parameters")).toHaveLength(2);
    vi.setSystemTime(Date.now() + 61_000);
    await c.protocolParams();
    expect(calls.filter((p) => p === "/epochs/latest/parameters")).toHaveLength(3);
  });

  it("an injected fetch is never memoized", async () => {
    const calls: string[] = [];
    const fetch = (input: string) => {
      const path = new URL(input).pathname.replace(/^\/api\/v0/, "");
      calls.push(path);
      return Promise.resolve(
        path === "/genesis" ? Response.json({ network_magic: 1 }) : Response.json(PARAMS),
      );
    };
    const c = client({ fetch });
    await c.protocolParams();
    await c.protocolParams();
    expect(calls.filter((p) => p === "/epochs/latest/parameters")).toHaveLength(2);
  });
});
