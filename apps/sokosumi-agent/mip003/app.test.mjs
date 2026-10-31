import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  createMip003,
  createPaymentNode,
  DEADLINES,
  EXAMPLE_ADDRESS,
  INPUT_SCHEMA,
  mip004InputHash,
  mip004ResultHash,
  PaymentNodeError,
} from "./app.mjs";
import { parseTask } from "../report.mjs";

const NONCE = "aabbccddeeff00112233";
const AGENT = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "11".repeat(32);
const VKEY = "c".repeat(56);
const BASE = "https://agent.example";
const config = { agentIdentifier: AGENT, sellerVkey: VKEY, supportedPaymentSourceIndex: 0 };

function memoryStore() {
  const map = new Map();
  return {
    map,
    get: async (k) => structuredClone(map.get(k)),
    put: async (k, v) => void map.set(k, structuredClone(v)),
    delete: async (k) => map.delete(k),
    list: async (prefix) => [...map].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
  };
}

/** A fake Masumi Payment Service whose escrow state the test moves by hand. */
function fakeNode(clock) {
  const node = { calls: [], onChain: null, history: [], nextAction: null, resultHash: null };
  node.mps = async (path, body) => {
    node.calls.push({ path, body });
    if (node.fail) throw node.fail;
    if (path === "/payment")
      return {
        blockchainIdentifier: "bcid-1",
        payByTime: String(clock.t + DEADLINES.payBy * 60_000),
        submitResultTime: String(clock.t + DEADLINES.submitResult * 60_000),
        unlockTime: String(clock.t + DEADLINES.unlock * 60_000),
        externalDisputeUnlockTime: String(clock.t + DEADLINES.externalDispute * 60_000),
        SmartContractWallet: { walletVkey: VKEY },
      };
    if (path === "/payment/resolve-blockchain-identifier")
      return {
        onChainState: node.onChain,
        resultHash: node.resultHash,
        NextAction: node.nextAction,
        TransactionHistory: node.history,
      };
    if (path === "/payment/submit-result") {
      node.nextAction = { requestedAction: "SubmitResultRequested" };
      return {};
    }
    throw new Error(`unexpected ${path}`);
  };
  node.confirm = (state) => {
    node.onChain = state;
    node.history.push({ status: "Confirmed", newOnChainState: state });
  };
  return node;
}

function setup({ withNode = true, reportImpl } = {}) {
  const clock = { t: Date.UTC(2026, 9, 31, 9, 0, 0) };
  const store = memoryStore();
  const node = fakeNode(clock);
  let reports = 0;
  const app = createMip003({
    store,
    mps: withNode ? node.mps : undefined,
    report:
      reportImpl ??
      (async (address) => {
        reports++;
        return `# Report\n\nAddress: ${address}\n"quoted"`;
      }),
    parseAddress: parseTask,
    config,
    now: () => clock.t,
    newId: () => "00000000-0000-4000-8000-000000000001",
    log: { warn() {}, error() {} },
  });
  const call = (method, path, body) =>
    app.fetch(
      new Request(BASE + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { app, store, node, clock, call, reports: () => reports };
}

const start = (call, input = { address: EXAMPLE_ADDRESS }, nonce = NONCE) =>
  call("POST", "/start_job", { identifier_from_purchaser: nonce, input_data: input });

test("canonical JSON sorts keys and matches the MIP-004 input hash pre-image", async () => {
  assert.equal(
    canonicalJson({ b: 1, a: ["x", { d: null, c: true }] }),
    '{"a":["x",{"c":true,"d":null}],"b":1}',
  );
  const expected = createHash("sha256")
    .update(`${NONCE};{"address":"${EXAMPLE_ADDRESS}"}`, "utf8")
    .digest("hex");
  assert.equal(await mip004InputHash({ address: EXAMPLE_ADDRESS }, NONCE), expected);
  const raw = createHash("sha256").update(`${NONCE};a\nb`, "utf8").digest("hex");
  assert.equal(await mip004ResultHash("a\nb", NONCE), raw);
});

test("availability, input_schema and demo follow MIP-003", async () => {
  const { call } = setup();
  assert.deepEqual(await (await call("GET", "/availability")).json(), {
    status: "available",
    type: "masumi-agent",
    message: "Cardano Address Intelligence",
  });
  assert.deepEqual(await (await call("GET", "/input_schema")).json(), INPUT_SCHEMA);
  const demo = await (await call("GET", "/demo")).json();
  assert.equal(demo.input.address, EXAMPLE_ADDRESS);
  assert.equal(typeof demo.output.result, "string");
});

test("unconfigured agent stays a masumi-agent but refuses jobs", async () => {
  const { call } = setup({ withNode: false });
  const availability = await (await call("GET", "/availability")).json();
  assert.equal(availability.type, "masumi-agent");
  assert.equal(availability.status, "unavailable");
  assert.match(availability.message, /MPS_URL/);
  assert.equal((await start(call)).status, 424);
});

test("bad input is rejected before any payment request", async () => {
  const { call, node } = setup();
  assert.equal((await start(call, { address: EXAMPLE_ADDRESS }, "xyz")).status, 400);
  assert.equal(
    (
      await start(call, {
        address:
          "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv",
      })
    ).status,
    400,
  );
  assert.equal((await start(call, { prompt: EXAMPLE_ADDRESS })).status, 400);
  assert.equal((await start(call, { address: EXAMPLE_ADDRESS, extra: "x" })).status, 400);
  assert.equal(node.calls.length, 0);
});

test("start_job returns signed escrow terms without RequestedFunds (Fixed pricing)", async () => {
  const { call, node, clock } = setup();
  const response = await start(call);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(body.blockchainIdentifier, "bcid-1");
  assert.equal(body.agentIdentifier, AGENT);
  assert.equal(body.sellerVKey, VKEY);
  assert.equal(body.identifierFromPurchaser, NONCE);
  assert.equal(body.input_hash, await mip004InputHash({ address: EXAMPLE_ADDRESS }, NONCE));
  assert.equal(body.payByTime, clock.t + DEADLINES.payBy * 60_000);
  assert.equal(body.supportedPaymentSourceIndex, 0);
  const [request] = node.calls;
  assert.equal(request.path, "/payment");
  assert.equal("RequestedFunds" in request.body, false);
  assert.equal(request.body.paymentSourceType, "Web3CardanoV2");
  assert.equal(
    Date.parse(request.body.submitResultTime) - clock.t >= 15 * 60_000,
    true,
    "Payment Service requires submitResultTime >= now + 15 min",
  );
  assert.equal(
    Date.parse(request.body.unlockTime) - Date.parse(request.body.submitResultTime) >= 15 * 60_000,
    true,
  );
});

test("same nonce + same input is idempotent; another input is a conflict", async () => {
  const { call, node } = setup();
  const first = await (await start(call)).json();
  const again = await start(call);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), first);
  const other =
    "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyfzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qwzdgzn";
  assert.equal(parseTask(other).ok, true);
  assert.equal((await start(call, { address: other })).status, 409);
  assert.equal(node.calls.filter((c) => c.path === "/payment").length, 1);
});

test("uncertain payment request is never replayed; a definite refusal frees the nonce", async () => {
  const uncertain = setup();
  uncertain.node.fail = new PaymentNodeError("timeout");
  assert.equal((await start(uncertain.call)).status, 500);
  uncertain.node.fail = null;
  assert.equal((await start(uncertain.call)).status, 409);
  assert.equal(uncertain.node.calls.length, 1);

  const refused = setup();
  refused.node.fail = new PaymentNodeError("bad", { status: 400, definite: true });
  assert.equal((await start(refused.call)).status, 424);
  refused.node.fail = null;
  assert.equal((await start(refused.call)).status, 200);
});

test("full paid job: awaiting payment -> report only after confirmed lock -> completed after confirmed result", async () => {
  const { call, node, app, reports } = setup();
  const { id } = await (await start(call)).json();
  const status = async () => (await call("GET", `/status?job_id=${id}`)).json();

  assert.equal((await status()).status, "awaiting_payment");
  node.onChain = "FundsLocked"; // seen but not yet confirmed
  assert.equal((await status()).status, "awaiting_payment");
  assert.equal(reports(), 0);

  node.confirm("FundsLocked");
  await app.advanceAll();
  assert.equal(reports(), 1);
  const submit = node.calls.find((c) => c.path === "/payment/submit-result");
  const result = `# Report\n\nAddress: ${EXAMPLE_ADDRESS}\n"quoted"`;
  assert.equal(submit.body.submitResultHash, await mip004ResultHash(result, NONCE));
  assert.equal((await status()).status, "running");

  node.resultHash = submit.body.submitResultHash;
  node.confirm("ResultSubmitted");
  const done = await status();
  assert.equal(done.status, "completed");
  assert.equal(done.result, result);
  assert.equal(reports(), 1);
  assert.equal((await app.activeJobs()).length, 0);
});

test("a lock that never arrives fails after the grace period; refunds fail the job", async () => {
  const late = setup();
  const { id } = await (await start(late.call)).json();
  late.clock.t += (DEADLINES.payBy + 11) * 60_000;
  const body = await (await late.call("GET", `/status?job_id=${id}`)).json();
  assert.equal(body.status, "failed");
  assert.match(body.message, /not locked/);

  const refund = setup();
  const job = await (await start(refund.call)).json();
  refund.node.confirm("RefundRequested");
  assert.equal(
    (await (await refund.call("GET", `/status?job_id=${job.id}`)).json()).status,
    "failed",
  );
});

test("no work starts too close to submitResultTime", async () => {
  const { call, node, clock, reports } = setup();
  const { id } = await (await start(call)).json();
  node.confirm("FundsLocked");
  clock.t += (DEADLINES.submitResult - 1) * 60_000;
  assert.equal((await (await call("GET", `/status?job_id=${id}`)).json()).status, "failed");
  assert.equal(reports(), 0);
});

test("a data-source outage keeps the job active and is retried", async () => {
  let attempts = 0;
  const { call, node, app } = setup({
    reportImpl: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Blockfrost 503");
      return "ok";
    },
  });
  const { id } = await (await start(call)).json();
  node.confirm("FundsLocked");
  await app.advanceAll();
  assert.equal((await (await call("GET", `/status?job_id=${id}`)).json()).status, "running");
  await app.advanceAll();
  assert.ok(node.calls.some((c) => c.path === "/payment/submit-result"));
});

test("an uncertain submit is not repeated when the node already queued it", async () => {
  const { call, node, app } = setup();
  await (await start(call)).json();
  node.confirm("FundsLocked");
  const original = node.mps;
  node.mps = async (path, body) => {
    if (path === "/payment/submit-result") {
      node.calls.push({ path, body });
      node.nextAction = { requestedAction: "SubmitResultRequested" };
      throw new PaymentNodeError("timeout");
    }
    return original(path, body);
  };
  await app.advanceAll();
  await app.advanceAll();
  assert.equal(node.calls.filter((c) => c.path === "/payment/submit-result").length, 1);
  const [job] = await app.activeJobs();
  assert.equal(job.phase, "awaiting-result");
});

test("status rejects malformed and unknown job ids", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/status?job_id=nope")).status, 400);
  assert.equal(
    (await call("GET", "/status?job_id=00000000-0000-4000-8000-00000000000f")).status,
    404,
  );
  assert.equal((await call("GET", "/nothing")).status, 404);
});

test("payment node client never follows redirects and classifies refusals", async () => {
  const seen = [];
  const mps = createPaymentNode({
    url: "https://node.example/",
    token: "scoped",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ status: "error", error: { message: "nope" } }), {
        status: 400,
      });
    },
  });
  await assert.rejects(mps("/payment", { a: 1 }), (e) => e.definite === true && e.status === 400);
  for (const [status, definite] of [
    [503, true],
    [530, true],
    [502, false],
    [504, false],
    [500, false],
  ]) {
    const node = createPaymentNode({
      url: "https://node.example",
      token: "t",
      fetchImpl: async () => new Response("<html>", { status }),
    });
    await assert.rejects(node("/payment", {}), (e) => e.definite === definite, String(status));
  }
  assert.equal(seen[0].url, "https://node.example/api/v1/payment");
  assert.equal(seen[0].init.redirect, "manual");
  assert.equal(seen[0].init.headers.token, "scoped");
  const down = createPaymentNode({
    url: "https://node.example",
    token: "t",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    down("/payment/resolve-blockchain-identifier", {}),
    (e) => e.definite === false,
  );
});
