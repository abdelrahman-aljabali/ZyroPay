import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { Jobs } from "./worker.mjs";
import { EXAMPLE_ADDRESS } from "./app.mjs";

const env = {
  MPS_URL: "https://node.example",
  MPS_TOKEN: "scoped",
  AGENT_IDENTIFIER: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "22".repeat(32),
  SELLER_VKEY: "d".repeat(56),
  SUPPORTED_PAYMENT_SOURCE_INDEX: "0",
  BLOCKFROST_API_KEY_PREPROD: "preprodTEST",
};

/** The Durable Object storage API subset worker.mjs uses. */
function fakeStorage() {
  const map = new Map();
  let alarm = null;
  return {
    alarms: () => alarm,
    get: async (k) => structuredClone(map.get(k)),
    put: async (k, v) => void map.set(k, structuredClone(v)),
    delete: async (k) => map.delete(k),
    list: async ({ prefix }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (t) => void (alarm = t),
  };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const ok = (data) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });

test("stateless routes answer without the Durable Object", async () => {
  const noDo = { ...env, JOBS: { get: () => assert.fail("woke the Durable Object") } };
  const r = await worker.fetch(new Request("https://w.example/availability"), noDo);
  assert.deepEqual(await r.json(), {
    status: "available",
    type: "masumi-agent",
    message: "Cardano Address Intelligence",
  });
  assert.equal(
    (await worker.fetch(new Request("https://w.example/input_schema"), noDo)).status,
    200,
  );
});

test("job routes go to the single Durable Object", async () => {
  const seen = [];
  const jobsNs = {
    idFromName: (name) => `id:${name}`,
    get: (id) => ({
      fetch: async (req) => (seen.push([id, new URL(req.url).pathname]), new Response("{}")),
    }),
  };
  await worker.fetch(new Request("https://w.example/status?job_id=x"), { ...env, JOBS: jobsNs });
  await worker.fetch(new Request("https://w.example/start_job", { method: "POST", body: "{}" }), {
    ...env,
    JOBS: jobsNs,
  });
  assert.deepEqual(seen, [
    ["id:jobs", "/status"],
    ["id:jobs", "/start_job"],
  ]);
});

test("a started job schedules the alarm, and the alarm keeps polling until the job settles", async () => {
  const storage = fakeStorage();
  const jobs = new Jobs({ storage }, env);
  const calls = [];
  const response = await withFetch(
    async (url, init) => {
      calls.push([url, init.headers.token]);
      const t = Date.now();
      return ok({
        blockchainIdentifier: "bcid",
        payByTime: String(t + 600_000),
        submitResultTime: String(t + 1_200_000),
        unlockTime: String(t + 2_160_000),
        externalDisputeUnlockTime: String(t + 3_120_000),
      });
    },
    () =>
      jobs.fetch(
        new Request("https://w.example/start_job", {
          method: "POST",
          body: JSON.stringify({
            identifier_from_purchaser: "0011223344556677",
            input_data: { address: EXAMPLE_ADDRESS },
          }),
        }),
      ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["https://node.example/api/v1/payment", "scoped"]]);
  assert.ok(storage.alarms() > Date.now(), "alarm scheduled");

  await storage.setAlarm(null);
  await withFetch(
    async () => ok({ onChainState: null, TransactionHistory: [] }),
    () => jobs.alarm(),
  );
  assert.ok(storage.alarms() !== null, "still awaiting payment, so the alarm re-arms");
});
