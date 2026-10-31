import { test } from "node:test";
import assert from "node:assert/strict";
import { doctor } from "./doctor.mjs";

const env = { COWORKER_ID: "cw_1", BLOCKFROST_API_KEY_PREPROD: "preprodKEY" };
const masumiEnv = { ADMIN_KEY: "x".repeat(32) };

function io({ cli = {}, docker = "", fetch = {} } = {}) {
  const calls = [];
  return {
    calls,
    cli: (args) => {
      calls.push(["cli", ...args]);
      const out = cli[args.slice(0, 2).join(" ")];
      if (out === undefined) throw new Error("command failed");
      return JSON.stringify(out);
    },
    exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      return docker;
    },
    fetch: async (url, init) => {
      calls.push(["fetch", url, init?.method ?? "GET"]);
      const entry = Object.entries(fetch).find(([k]) => url.includes(k));
      if (!entry) throw new TypeError("fetch failed");
      const [status, body] = entry[1];
      return new Response(JSON.stringify(body), { status });
    },
  };
}

const healthy = () =>
  io({
    cli: {
      "auth whoami": { user: { email: "me@example.com" }, target: "preprod" },
      "vendors me": { vendors: [{ id: "v1", name: "ZyroPay", role: "admin" }] },
      "coworkers list": { coworkers: [{ id: "cw_1", name: "Cardano Address Intelligence" }] },
      "workspaces list": { hasPersonalWorkspace: true },
    },
    docker:
      "zyropay-masumi-payment-service Up 5 minutes (healthy)\nzyropay-masumi-gateway Up 5 minutes\nzyropay-masumi-tunnel Up 5 minutes",
    fetch: {
      "/blocks/latest": [200, {}],
      "/api/v1/health": [200, { status: "success" }],
      "/availability": [200, { status: "available", type: "masumi-agent" }],
    },
  });

const levels = (checks) => checks.filter((c) => c.level !== "head");
const fails = (checks) => levels(checks).filter((c) => c.level === "fail");

test("a complete setup has no FAIL lines", async () => {
  const checks = await doctor({
    env,
    masumiEnv,
    nodeVersion: "24.1.0",
    cliVersion: "1.1.0",
    paidReady: true,
    io: healthy(),
  });
  assert.deepEqual(fails(checks), []);
});

test("offline mode never touches the network or the CLI", async () => {
  const fake = healthy();
  const checks = await doctor({
    env,
    offline: true,
    nodeVersion: "24.1.0",
    cliVersion: "1.1.0",
    io: fake,
  });
  assert.deepEqual(fails(checks), []);
  assert.equal(fake.calls.length, 0);
});

test("doctor only runs read commands", async () => {
  const fake = healthy();
  await doctor({
    env: { ...env, SOKOSUMI_ORGANIZATION_ID: "org", SOKOSUMI_ORGANIZATION_SLUG: "tum" },
    masumiEnv,
    nodeVersion: "24.1.0",
    cliVersion: "1.1.0",
    io: fake,
  });
  const writes = /^(create|register|connect|api-key|key-import|start|complete|login|logout)$/u;
  for (const call of fake.calls.filter((c) => c[0] === "cli"))
    assert.ok(!call.some((part) => writes.test(part)), call.join(" "));
  for (const call of fake.calls.filter((c) => c[0] === "fetch")) assert.equal(call[2], "GET");
  assert.ok(fake.calls.some((c) => c.join(" ") === "cli workspaces check org"));
});

test("each missing piece names its fix", async () => {
  const fake = io({ fetch: { "/blocks/latest": [403, {}] } });
  const checks = await doctor({
    env: { ...env, PAID_TASKS_ENABLED: "true", COWORKER_ID: "" },
    masumiEnv: { ...masumiEnv, COLLECTION_WALLET_PREPROD_ADDRESS: "addr_test1x" },
    nodeVersion: "24.1.0",
    cliVersion: "1.1.0",
    paidReady: false,
    io: fake,
  });
  const text = fails(checks)
    .map((c) => c.text)
    .join("\n");
  assert.match(text, /COWORKER_ID/);
  assert.match(text, /Blockfrost rejected/);
  assert.match(text, /auth login/);
  assert.match(text, /docker compose up -d|Docker Desktop/);
  assert.match(text, /PAID_TASKS_ENABLED=true/);
  assert.match(text, /COLLECTION_WALLET_PREPROD_ADDRESS/);
  assert.match(text, /mip003:deploy/);
});

test("wrong CLI version skips the account checks with the install command", async () => {
  const checks = await doctor({ env, nodeVersion: "24.1.0", cliVersion: "1.0.4", io: healthy() });
  assert.ok(fails(checks).some((c) => /@masumi_network\/sokosumi@1\.1\.0/u.test(c.text)));
});
