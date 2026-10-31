import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnswer, createSummarizer, followUp, parseTask } from "./report.mjs";

// Synthetic, checksum-valid addresses (fixed credential bytes), not real wallets.
const BASE =
  "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyfzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qwzdgzn";
const SCRIPT =
  "addr_test1zp24242424242424242424242424242424242424242424fzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qhnex3v";
const MAINNET =
  "addr1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyfzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qd5sgwv";
const STAKE = "stake_test1uq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsw4fsh7";
const NOW = new Date("2026-10-30T12:00:00Z");
const env = { BLOCKFROST_API_KEY_PREPROD: "preprodTESTONLYnotarealkey000000" };

/** Blockfrost stand-in: every path 404s (an address never seen on chain) unless `routes` says otherwise. */
function fakeBlockfrost(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace("/api/v0", "") + new URL(url).search;
    const route = routes[path];
    if (typeof route === "number") return new Response("{}", { status: route });
    if (route !== undefined) return Response.json(route);
    return new Response('{"status_code":404}', { status: 404 });
  };
  return { fetchImpl, calls };
}

test("Task text yields the first valid preprod payment address", () => {
  const t = parseTask(`Please report on ${BASE} before I pay it.`);
  assert.equal(t.ok, true);
  assert.equal(t.address.bech32, BASE);
  assert.equal(parseTask(`${MAINNET} and ${SCRIPT}`).address.bech32, SCRIPT);
  assert.match(parseTask("hello").reason, /No Cardano address found/);
  assert.match(parseTask(MAINNET).reason, /mainnet/);
  assert.match(parseTask(STAKE).reason, /stake/);
  assert.match(parseTask(`${BASE.slice(0, -1)}q`).reason, /not a valid/);
  assert.equal(parseTask("x".repeat(16001)).ok, false);
});

test("unused address: deterministic report from Blockfrost, sent with the project id only", async () => {
  const { fetchImpl, calls } = fakeBlockfrost();
  const answer = createAnswer({ env, fetchImpl, now: () => NOW, summarizer: null });
  const result = await answer(`report on ${BASE}`);
  assert.match(result, /Risk score: 30\/100/);
  assert.match(result, /NO_HISTORY/);
  const json = JSON.parse(result.split("```json\n")[1].split("\n```")[0]);
  assert.equal(json.address, BASE);
  assert.equal(json.network, "cardano:preprod");
  assert.equal(json.riskScore, 30);
  assert.equal(json.generatedAt, NOW.toISOString());
  assert.ok(
    calls.every((c) => c.url.startsWith("https://cardano-preprod.blockfrost.io/api/v0/addresses/")),
  );
  assert.ok(calls.every((c) => c.init.headers.project_id === env.BLOCKFROST_API_KEY_PREPROD));
  assert.equal(await answer(`report on ${BASE}`), result, "same chain state, same answer");
});

test("active address: balance, flags and the x402 link appear in the result", async () => {
  const a = `/addresses/${SCRIPT}`;
  const { fetchImpl } = fakeBlockfrost({
    [a]: {
      address: SCRIPT,
      amount: [{ unit: "lovelace", quantity: "500000" }],
      stake_address: null,
      type: "shelley",
      script: true,
    },
    [`${a}/total`]: {
      address: SCRIPT,
      received_sum: [{ unit: "lovelace", quantity: "25000000" }],
      sent_sum: [],
      tx_count: 2,
    },
    [`${a}/transactions?order=desc&count=20`]: [
      {
        tx_hash: "b".repeat(64),
        tx_index: 0,
        block_height: 2,
        block_time: NOW.getTime() / 1000 - 3600,
      },
      {
        tx_hash: "a".repeat(64),
        tx_index: 0,
        block_height: 1,
        block_time: NOW.getTime() / 1000 - 7200,
      },
    ],
    [`${a}/utxos?count=100`]: [
      {
        tx_hash: "b".repeat(64),
        output_index: 0,
        amount: [{ unit: "lovelace", quantity: "500000" }],
      },
    ],
  });
  const result = await createAnswer({ env, fetchImpl, now: () => NOW, summarizer: null })(SCRIPT);
  for (const code of ["NEW_ADDRESS", "LOW_ACTIVITY", "SCRIPT_ADDRESS", "DRAINED"])
    assert.match(result, new RegExp(code));
  assert.match(result, /Risk score: 60\/100 \(high caution\)/);
  assert.match(result, /Balance: 0\.5 ADA/);
  assert.match(result, /address-intel\.zyropay\.online\/v1\/address-report\?address=addr_test1z/);
});

test("bad input completes with an explanation and makes no data request", async () => {
  const { fetchImpl, calls } = fakeBlockfrost();
  const result = await createAnswer({ env, fetchImpl, summarizer: null })("what is my risk?");
  assert.match(result, /No Cardano address found/);
  assert.equal(calls.length, 0);
});

test("data source outage throws so the worker retries; a missing key is reported by name", async () => {
  const { fetchImpl } = fakeBlockfrost({ [`/addresses/${BASE}`]: 429 });
  await assert.rejects(createAnswer({ env, fetchImpl, summarizer: null })(BASE), /rate limited/);
  await assert.rejects(
    createAnswer({ env: {}, fetchImpl, summarizer: null })(BASE),
    /BLOCKFROST_API_KEY_PREPROD/,
  );
  await assert.rejects(
    createAnswer({ env, fetchImpl: fakeBlockfrost().fetchImpl, summarizer: null })(
      BASE,
      null,
      Date.now() - 1,
    ),
    /deadline expired/,
  );
});

test("summary model is optional: off without ZAI_*, labelled when on, ignored when it fails", async () => {
  assert.equal(createSummarizer({}), null);
  assert.equal(createSummarizer({ ZAI_API_KEY: "k", ZAI_BASE_URL: "https://m.test/v1" }), null);
  let request;
  const model = async (url, init) => {
    request = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return Response.json({ choices: [{ message: { content: "Never used on chain." } }] });
  };
  const summarizer = createSummarizer(
    { ZAI_API_KEY: "k", ZAI_BASE_URL: "https://m.test/v1/", ZAI_MODEL: "m" },
    model,
  );
  const { fetchImpl } = fakeBlockfrost();
  const withSummary = await createAnswer({ env, fetchImpl, now: () => NOW, summarizer })(BASE);
  assert.equal(request.url, "https://m.test/v1/chat/completions");
  assert.equal(request.auth, "Bearer k");
  assert.match(withSummary, /Summary \(model-written[^\n]*\nNever used on chain\./);
  const failing = async () => {
    throw new Error("down");
  };
  const quiet = { warn: () => {} };
  const without = await createAnswer({
    env,
    fetchImpl,
    now: () => NOW,
    summarizer: failing,
    log: quiet,
  })(BASE);
  assert.doesNotMatch(without, /Summary/);
  assert.match(without, /Risk score: 30\/100/);
});

test("follow-up comments: new address, refresh of the Task's address, or help", () => {
  assert.deepEqual(followUp(`and ${SCRIPT}?`, BASE), { kind: "report", input: `and ${SCRIPT}?` });
  assert.deepEqual(followUp("Refresh please", `report ${BASE}`), {
    kind: "report",
    input: `report ${BASE}`,
  });
  assert.equal(followUp("thanks!", BASE).kind, "help");
  assert.equal(followUp("refresh", "no address here").kind, "help");
});
