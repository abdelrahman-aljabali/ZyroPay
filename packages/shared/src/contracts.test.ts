import { describe, expect, it } from "vitest";
import { api, buildPath } from "./api/contracts";
import { apiError, ApiErrorBodySchema, ERROR_CODES, httpStatusFor } from "./api/errors";
import { apiExt } from "./api/ext";
import {
  apiWallets,
  CreateWalletBodySchema,
  CreateWatchWalletBodySchema,
  WalletNameSchema,
  WatchWalletSchema,
} from "./api/wallet-management";
import { mcpTools } from "./mcp";
import { MCP_TOOL_NAMES, VALUE_MOVING_TOOLS } from "./tools";
import { KNOWN_PLUGIN_IDS, PLUGIN_REGISTRY, PluginManifestSchema } from "./plugins";

describe("api contracts", () => {
  const entries = Object.entries(api);

  it("method+path pairs are unique", () => {
    const keys = entries.map(([, e]) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(entries)("%s: path params match the params schema", (_, e) => {
    const inPath = [...e.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]).sort();
    const declared = "params" in e ? Object.keys(e.params.shape).sort() : [];
    expect(declared).toEqual(inPath);
  });

  it("internal endpoints live under /internal and use internal auth", () => {
    for (const [, e] of entries) {
      expect(e.path.startsWith("/internal/")).toBe(e.auth === "internal");
    }
  });

  it("GET/DELETE endpoints have no body", () => {
    for (const [, e] of entries) {
      if (e.method === "GET" || e.method === "DELETE") expect("body" in e).toBe(false);
    }
  });

  it("buildPath substitutes and encodes", () => {
    expect(buildPath(api.getAgent.path, { agentId: "a b" })).toBe("/v1/agents/a%20b");
    expect(() => buildPath(api.getAgent.path)).toThrow();
  });
});

describe("wallet management contracts (apiWallets)", () => {
  const all = [...Object.values(api), ...Object.values(apiExt), ...Object.values(apiWallets)];
  const entries = Object.entries(apiWallets);

  it("method+path pairs are unique across api + apiExt + apiWallets", () => {
    const keys = all.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names do not collide with api or apiExt", () => {
    for (const name of Object.keys(apiWallets)) {
      expect(name in api || name in apiExt, name).toBe(false);
    }
  });

  it.each(entries)("%s: path params match the params schema", (_, e) => {
    const inPath = [...e.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]).sort();
    const declared = "params" in e ? Object.keys(e.params.shape).sort() : [];
    expect(declared).toEqual(inPath);
  });

  it("all are user endpoints under /v1; GET/DELETE have no body; creates are idempotent", () => {
    for (const [name, e] of entries) {
      expect(e.auth, name).toBe("user");
      expect(e.path.startsWith("/v1/"), name).toBe(true);
      if (e.method === "GET" || e.method === "DELETE") expect("body" in e, name).toBe(false);
      if (e.method === "POST") {
        expect("idempotent" in e && e.idempotent, name).toBe(true);
        const shape = "body" in e ? (e.body as { shape: Record<string, unknown> }).shape : {};
        expect("idempotencyKey" in shape, name).toBe(true);
      }
    }
  });

  it("WalletNameSchema trims and rejects empty, too long and control characters", () => {
    expect(WalletNameSchema.parse("  Savings  ")).toBe("Savings");
    expect(WalletNameSchema.parse("Ünïcode ✓ 💰")).toBe("Ünïcode ✓ 💰");
    expect(WalletNameSchema.parse("x".repeat(64))).toHaveLength(64);
    for (const bad of [
      "",
      "   ",
      "x".repeat(65),
      "a\u0000b",
      "tab\there",
      "new\nline",
      "del\u007f",
    ]) {
      expect(WalletNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("WatchWalletSchema is always watch-only", () => {
    const valid = {
      id: "0199f3a0-0000-7000-8000-000000000001",
      userId: "0199f3a0-0000-7000-8000-000000000002",
      name: "Watched Base Sepolia",
      family: "evm",
      network: "base-sepolia",
      address: "0x52908400098527886E0F7030069857D2E4169EE7",
      watchOnly: true,
      createdAt: "2026-10-30T12:00:00.000Z",
    };
    expect(WatchWalletSchema.parse(valid)).toEqual(valid);
    expect(WatchWalletSchema.safeParse({ ...valid, watchOnly: false }).success).toBe(false);
    expect(WatchWalletSchema.safeParse({ ...valid, network: "dogecoin" }).success).toBe(false);
    expect(WatchWalletSchema.safeParse({ ...valid, address: "" }).success).toBe(false);
    expect(WatchWalletSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("create bodies: trimmed address, optional name, idempotency key required", () => {
    const body = CreateWatchWalletBodySchema.parse({
      network: "solana-devnet",
      address: "  9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM ",
      idempotencyKey: "abcdefgh",
    });
    expect(body.address).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(body.name).toBeUndefined();
    expect(
      CreateWatchWalletBodySchema.safeParse({ network: "solana-devnet", address: "x" }).success,
    ).toBe(false);
    expect(
      CreateWalletBodySchema.safeParse({
        turnkeyWalletId: "w",
        network: "base-sepolia",
        idempotencyKey: "abcdefgh",
      }).success,
    ).toBe(true);
    expect(
      CreateWalletBodySchema.safeParse({
        turnkeyWalletId: "",
        network: "base-sepolia",
        idempotencyKey: "abcdefgh",
      }).success,
    ).toBe(false);
  });

  it("watch portfolio defaults the currency to USD", () => {
    expect(apiWallets.getWatchWalletPortfolio.query.parse({})).toEqual({ currency: "USD" });
  });
});

describe("errors", () => {
  it("builds a valid envelope for every code", () => {
    for (const code of ERROR_CODES) {
      expect(ApiErrorBodySchema.parse(apiError(code, "x"))).toEqual({
        error: { code, message: "x" },
      });
      expect(httpStatusFor(code)).toBeGreaterThanOrEqual(400);
    }
  });
  it("rejects unknown codes", () => {
    expect(ApiErrorBodySchema.safeParse({ error: { code: "NOPE", message: "x" } }).success).toBe(
      false,
    );
  });
});

describe("mcp tools", () => {
  it("defines every tool exactly once", () => {
    expect(Object.keys(mcpTools).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });
  it("valueMoving flags agree with VALUE_MOVING_TOOLS", () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(mcpTools[name].valueMoving).toBe(
        (VALUE_MOVING_TOOLS as readonly string[]).includes(name),
      );
    }
  });
  it("send rejects float amounts", () => {
    const ok = mcpTools.send.input.safeParse({
      walletId: "0199f3a0-0000-7000-8000-000000000001",
      network: "base-sepolia",
      idempotencyKey: "abcdefgh",
      to: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      assetId: "base-sepolia:native",
      amount: "1000",
      decimals: 18,
    });
    expect(ok.success).toBe(true);
    const bad = mcpTools.send.input.safeParse({ ...(ok.success ? ok.data : {}), amount: "0.5" });
    expect(bad.success).toBe(false);
  });
});

describe("plugin registry", () => {
  it("contains exactly the known plugins, all valid", () => {
    expect(PLUGIN_REGISTRY.map((p) => p.id).sort()).toEqual([...KNOWN_PLUGIN_IDS].sort());
    for (const p of PLUGIN_REGISTRY) expect(() => PluginManifestSchema.parse(p)).not.toThrow();
  });
});
