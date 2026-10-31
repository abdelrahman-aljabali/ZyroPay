import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockfrostClient, DataSourceError, mapBlockfrostStatus } from "../src/blockfrost";
import { blockfrostRoutes, fx } from "./fixtures";
import { BLOCKFROST, json, stubFetch, TEST_BASE_ADDRESS, TEST_PROJECT_ID } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BlockfrostClient.fetchAddressData", () => {
  it("calls the documented endpoints with the project_id header", async () => {
    const calls = stubFetch(blockfrostRoutes());
    const seen: (string | null)[] = [];
    const client = new BlockfrostClient(TEST_PROJECT_ID, BLOCKFROST, 8000, (url, init) => {
      seen.push(new Headers(init.headers).get("project_id"));
      return fetch(url, init);
    });
    const data = await client.fetchAddressData(TEST_BASE_ADDRESS);
    expect(data.address).toEqual(fx.address);
    expect(data.firstTx).toEqual(fx.txsAsc[0]);
    expect(data.account).toEqual(fx.account);
    expect(calls.map((c) => c.url.replace(`${BLOCKFROST}/`, "")).sort()).toEqual(
      [
        `accounts/${fx.address.stake_address!}`,
        `addresses/${TEST_BASE_ADDRESS}`,
        `addresses/${TEST_BASE_ADDRESS}/total`,
        `addresses/${TEST_BASE_ADDRESS}/transactions?order=asc&count=1`,
        `addresses/${TEST_BASE_ADDRESS}/transactions?order=desc&count=20`,
        `addresses/${TEST_BASE_ADDRESS}/utxos?count=100`,
      ].sort(),
    );
    expect(seen.every((v) => v === TEST_PROJECT_ID)).toBe(true);
  });

  it("skips the oldest-tx call when the recent page holds the whole history", async () => {
    const routes = blockfrostRoutes();
    routes[`${BLOCKFROST}/addresses/${TEST_BASE_ADDRESS}/total`] = () =>
      json({ ...fx.total, tx_count: 20 });
    const calls = stubFetch(routes);
    const data = await new BlockfrostClient(TEST_PROJECT_ID).fetchAddressData(TEST_BASE_ADDRESS);
    expect(calls.some((c) => c.url.includes("order=asc"))).toBe(false);
    expect(data.firstTx).toEqual(fx.txsDesc[19]);
  });

  it("maps 404 on every endpoint to an unused-address result", async () => {
    stubFetch({ [BLOCKFROST]: () => json(fx.notFound, 404) });
    const data = await new BlockfrostClient(TEST_PROJECT_ID).fetchAddressData(TEST_BASE_ADDRESS);
    expect(data).toEqual({
      address: null,
      total: null,
      recentTxs: [],
      firstTx: null,
      utxos: [],
      account: null,
    });
  });

  it.each([
    [402, 503, /quota/],
    [403, 503, /configuration/],
    [418, 503, /rate limited/],
    [429, 503, /rate limited/],
    [500, 503, /HTTP 500/],
    [503, 503, /HTTP 503/],
    [400, 400, /rejected the address/],
  ])("maps Blockfrost %i to %i", async (bfStatus, status, message) => {
    stubFetch({
      [BLOCKFROST]: () => json({ status_code: bfStatus, error: "x", message: "y" }, bfStatus),
    });
    const err = await new BlockfrostClient(TEST_PROJECT_ID)
      .fetchAddressData(TEST_BASE_ADDRESS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataSourceError);
    expect((err as DataSourceError).status).toBe(status);
    expect((err as DataSourceError).message).toMatch(message);
    expect((err as DataSourceError).message).not.toContain(TEST_PROJECT_ID);
  });

  it("times out a hanging request and maps it to 503", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      });
    const err = await new BlockfrostClient(TEST_PROJECT_ID, BLOCKFROST, 20, hang)
      .fetchAddressData(TEST_BASE_ADDRESS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataSourceError);
    expect((err as DataSourceError).status).toBe(503);
    expect((err as DataSourceError).message).toMatch(/timed out/);
  });

  it("maps network failure and malformed JSON to 503", async () => {
    const down = () => Promise.reject(new TypeError("fetch failed"));
    const e1 = await new BlockfrostClient(TEST_PROJECT_ID, BLOCKFROST, 8000, down)
      .fetchAddressData(TEST_BASE_ADDRESS)
      .catch((e: unknown) => e);
    expect((e1 as DataSourceError).message).toMatch(/unreachable/);
    stubFetch({ [BLOCKFROST]: () => new Response("<html>", { status: 200 }) });
    const e2 = await new BlockfrostClient(TEST_PROJECT_ID)
      .fetchAddressData(TEST_BASE_ADDRESS)
      .catch((e: unknown) => e);
    expect((e2 as DataSourceError).message).toMatch(/malformed/);
  });
});

describe("mapBlockfrostStatus", () => {
  it("keeps messages short", () => {
    for (const s of [400, 402, 403, 418, 429, 500, 502, 504]) {
      expect(mapBlockfrostStatus(s).message.length).toBeLessThan(80);
    }
  });
});
