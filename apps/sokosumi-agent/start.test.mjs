import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "./start.mjs";
import { sokosumiRoot } from "./sokosumi-runtime.mjs";

const ready = { COWORKER_ID: "coworker", BLOCKFROST_API_KEY_PREPROD: "preprodTEST" };

test("preflight passes without a model and fails on each missing requirement", () => {
  assert.equal(preflight(ready, { nodeVersion: "24.1.0", cliVersion: "1.1.0" }).ok, true);
  assert.equal(preflight(ready, { nodeVersion: "22.9.0", cliVersion: "1.1.0" }).ok, false);
  assert.equal(preflight(ready, { nodeVersion: "24.1.0", cliVersion: "1.0.4" }).ok, false);
  assert.equal(preflight(ready, { nodeVersion: "24.1.0", cliVersion: undefined }).ok, false);
  assert.equal(
    preflight({ ...ready, COWORKER_ID: "" }, { nodeVersion: "24.1.0", cliVersion: "1.1.0" }).ok,
    false,
  );
  assert.equal(
    preflight(
      { ...ready, BLOCKFROST_API_KEY_PREPROD: " " },
      { nodeVersion: "24.1.0", cliVersion: "1.1.0" },
    ).ok,
    false,
  );
  const halfOrg = preflight(
    { ...ready, SOKOSUMI_ORGANIZATION_ID: "org" },
    { nodeVersion: "24.1.0", cliVersion: "1.1.0" },
  );
  assert.equal(halfOrg.ok, false);
  assert.ok(halfOrg.checks.some((c) => /Set both/.test(c.text)));
});

test("paid flag without confirmed registration warns but does not block the unpaid path", () => {
  const r = preflight(
    { ...ready, PAID_TASKS_ENABLED: "true" },
    { nodeVersion: "24.1.0", cliVersion: "1.1.0" },
  );
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => !c.ok && !c.required && /registration ready: false/.test(c.text)));
});

test("runtime root derives from supported installed CLI output", () => {
  assert.equal(
    sokosumiRoot((command, args) => {
      assert.equal(command, "sokosumi");
      assert.deepEqual(args, ["skills", "path"]);
      return "/opt/node/lib/node_modules/@masumi_network/sokosumi/skills\n";
    }),
    "/opt/node/lib/node_modules/@masumi_network/sokosumi/dist/src",
  );
  assert.throws(() => sokosumiRoot(() => "/unrelated"), /invalid package path/);
});
