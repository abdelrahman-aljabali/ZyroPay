import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { ConfigError, loadConfig } from "../../src/env";
import { checkRateLimit, enforceBodyLimit, isOriginAllowed } from "../../src/security/limits";

describe("enforceBodyLimit", () => {
  it("passes small bodies and rejects declared oversize", async () => {
    const small = new Request("https://x/mcp", { method: "POST", body: "{}" });
    const passed = await enforceBodyLimit(small, 10);
    expect(passed).toBeInstanceOf(Request);
    expect(await (passed as Request).text()).toBe("{}");
    const big = new Request("https://x/mcp", {
      method: "POST",
      body: "x".repeat(20),
      headers: { "Content-Length": "20" },
    });
    const res = await enforceBodyLimit(big, 10);
    expect(res instanceof Response && res.status).toBe(413);
  });

  it("caps streamed bodies without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    const req = new Request("https://x/mcp", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await enforceBodyLimit(req, 16);
    expect(res instanceof Response && res.status).toBe(413);
  });
});

describe("checkRateLimit", () => {
  it("returns 429 with Retry-After when the binding says no", async () => {
    const res = await checkRateLimit({ limit: () => Promise.resolve({ success: false }) }, "k");
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("60");
    expect(
      await checkRateLimit({ limit: () => Promise.resolve({ success: true }) }, "k"),
    ).toBeNull();
  });
});

describe("isOriginAllowed", () => {
  const allowed = new Set(["https://claude.ai"]);
  it("allows absent and listed origins, refuses others", () => {
    expect(isOriginAllowed(null, allowed, false)).toBe(true);
    expect(isOriginAllowed("https://claude.ai", allowed, false)).toBe(true);
    expect(isOriginAllowed("https://evil.example", allowed, false)).toBe(false);
  });
  it("allows loopback origins only in development", () => {
    expect(isOriginAllowed("http://localhost:6274", allowed, true)).toBe(true);
    expect(isOriginAllowed("http://localhost:6274", allowed, false)).toBe(false);
  });
});

describe("loadConfig", () => {
  const base = {
    ZYROPAY_MODE: "development",
    MCP_PUBLIC_URL: "http://localhost:8788",
    INTERNAL_SERVICE_TOKEN: "i".repeat(32),
    MCP_OAUTH_COOKIE_SECRET: "c".repeat(32),
    API_INTERNAL_URL: "http://127.0.0.1:8787",
  } as unknown as Env;

  it("derives the canonical resource and default TTL", () => {
    const config = loadConfig(base);
    expect(config.resource).toBe("http://localhost:8788/mcp");
    expect(config.accessTokenTtlSeconds).toBe(900);
  });

  it("accepts a loopback x402 test upstream in development only", () => {
    expect(() =>
      loadConfig({ ...base, MCP_X402_TEST_UPSTREAM: "http://127.0.0.1:9999" }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        ...base,
        ZYROPAY_MODE: "production",
        MCP_PUBLIC_URL: "https://mcp.example.com",
        API_INTERNAL_URL: "https://api.example.com",
        MCP_X402_TEST_UPSTREAM: "http://127.0.0.1:9999",
      }),
    ).toThrow(ConfigError);
  });

  it.each([
    [{ MCP_PUBLIC_URL: "http://mcp.example.com" }, "plain http off loopback"],
    [{ MCP_PUBLIC_URL: "https://mcp.example.com/path" }, "a path"],
    [{ INTERNAL_SERVICE_TOKEN: "short" }, "a short internal token"],
    [{ MCP_OAUTH_COOKIE_SECRET: "" }, "a missing cookie secret"],
    [{ ZYROPAY_MODE: "staging" }, "an unknown mode"],
    [{ ZYROPAY_MODE: "production" }, "http in production"],
    [{ MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "86400" }, "a day-long access token"],
    [{ API_INTERNAL_URL: undefined }, "no route to the API"],
    [{ MCP_X402_TEST_UPSTREAM: "https://paid.example.com" }, "a non-loopback x402 test upstream"],
    [{ MCP_X402_TEST_UPSTREAM: "http://127.0.0.1:9/path" }, "an x402 test upstream with a path"],
  ] as [Partial<Record<keyof Env, string | undefined>>, string][])(
    "fails closed on %j (%s)",
    (override, _why) => {
      expect(() => loadConfig({ ...base, ...override } as Env)).toThrow(ConfigError);
    },
  );
});
