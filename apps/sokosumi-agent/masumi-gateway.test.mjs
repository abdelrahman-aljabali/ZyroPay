import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../../infrastructure/masumi/gateway/gateway.mjs";

async function withGateway(fn) {
  const upstream = [];
  const server = createGateway({
    upstream: "http://node.internal",
    fetchImpl: async (url, init) => {
      upstream.push({ url, init });
      return new Response(JSON.stringify({ status: "success", data: { url } }), { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, upstream);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("only the three payment routes and health reach the Payment Service", async () => {
  await withGateway(async (base, upstream) => {
    const post = (path) =>
      fetch(base + path, { method: "POST", headers: { token: "scoped" }, body: "{}" });
    assert.equal((await post("/api/v1/payment")).status, 200);
    assert.equal((await post("/api/v1/payment/resolve-blockchain-identifier")).status, 200);
    assert.equal((await post("/api/v1/payment/submit-result/")).status, 200);
    assert.equal((await fetch(base + "/api/v1/health")).status, 200);
    for (const [method, path] of [
      ["GET", "/admin"],
      ["GET", "/docs"],
      ["POST", "/api/v1/api-key"],
      ["GET", "/api/v1/wallet"],
      ["POST", "/api/v1/registry"],
      ["POST", "/api/v1/purchase"],
      ["POST", "/api/v1/payment/authorize-refund"],
      ["GET", "/api/v1/payment"],
      ["POST", "/api/v1/../api-key"],
    ])
      assert.equal(
        (await fetch(base + path, { method, body: method === "POST" ? "{}" : undefined })).status,
        404,
        `${method} ${path}`,
      );
    assert.equal(upstream.length, 4);
    assert.equal(upstream[0].url, "http://node.internal/api/v1/payment");
    assert.equal(upstream[0].init.headers.token, "scoped");
    assert.equal(upstream[0].init.redirect, "manual");
  });
});

test("oversized bodies are refused before forwarding", async () => {
  await withGateway(async (base, upstream) => {
    const response = await fetch(base + "/api/v1/payment", {
      method: "POST",
      body: "x".repeat(70_000),
    });
    assert.equal(response.status, 413);
    assert.equal(upstream.length, 0);
  });
});

test("a node that is not running answers 503 (nothing sent); a hung node answers 504", async () => {
  for (const [error, status] of [
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), 503],
    [Object.assign(new Error("timeout"), { name: "TimeoutError" }), 504],
  ]) {
    const server = createGateway({
      upstream: "http://node.internal",
      fetchImpl: async () => {
        throw error;
      },
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/payment`, {
      method: "POST",
      body: "{}",
    });
    await new Promise((r) => server.close(r));
    assert.equal(response.status, status);
  }
});
