/* Rate limiting, CORS, mode separation, config fail-closed, error hygiene, delegated signer. */
import { decryptSecret } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import { ConfigError, parseConfig } from "../../src/env";
import { redact } from "../../src/lib/logger";
import { call, createHarness, KEK, signUp } from "../helpers";

describe("platform security", () => {
  it("rate limits unauthenticated auth endpoints per client", async () => {
    const h = await createHarness({}, { rateLimits: { auth: { limit: 5, windowSeconds: 60 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await call(h, "POST", "/v1/auth/refresh", {
        body: { refreshToken: "zp_rt_x" },
        headers: { "cf-connecting-ip": "203.0.113.7" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Another client is unaffected.
    expect(
      (
        await call(h, "POST", "/v1/auth/refresh", {
          body: { refreshToken: "zp_rt_x" },
          headers: { "cf-connecting-ip": "203.0.113.8" },
        })
      ).status,
    ).toBe(401);
    // Window rolls over.
    h.clock.advance(61_000);
    expect(
      (
        await call(h, "POST", "/v1/auth/refresh", {
          body: { refreshToken: "zp_rt_x" },
          headers: { "cf-connecting-ip": "203.0.113.7" },
        })
      ).status,
    ).toBe(401);
  });

  it("rate limits connection-code claims per user (brute force)", async () => {
    const h = await createHarness(
      {},
      { rateLimits: { connectionClaim: { limit: 3, windowSeconds: 300 } } },
    );
    const user = await signUp(h);
    const codes = ["AAAA-AAAA", "BBBB-BBBB", "CCCC-CCCC", "DDDD-DDDD"];
    const statuses = [];
    for (const userCode of codes)
      statuses.push(
        (
          await call(h, "POST", "/v1/agent-connections/claim", {
            token: user.accessToken,
            body: { userCode },
          })
        ).status,
      );
    expect(statuses).toEqual([404, 404, 404, 429]);
  });

  it("CORS: unknown browser origins are refused; internal/webhook routes are never CORS-enabled", async () => {
    const h = await createHarness({ CORS_ALLOWED_ORIGINS: "https://app.zyropay.example" });
    const user = await signUp(h);
    const evil = await call(h, "GET", "/v1/me", {
      token: user.accessToken,
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    const good = await h.app.request("/v1/me", {
      headers: {
        origin: "https://app.zyropay.example",
        authorization: `Bearer ${user.accessToken}`,
      },
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://app.zyropay.example");
    const preflight = await h.app.request("/internal/v1/agent-connections", {
      method: "OPTIONS",
      headers: { origin: "https://app.zyropay.example" },
    });
    expect(preflight.status).toBe(403);
  });

  it("mainnet networks are refused in development mode", async () => {
    const h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    const user = await signUp(h);
    const res = await call(
      h,
      "GET",
      `/v1/receive?walletId=${user.walletId}&network=solana-mainnet`,
      { token: user.accessToken },
    );
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("NETWORK_MODE_MISMATCH");
    const ok = await call(h, "GET", `/v1/receive?walletId=${user.walletId}&network=base-sepolia`, {
      token: user.accessToken,
    });
    expect(ok.json).toMatchObject({
      address: user.evm,
      isTestnet: true,
      qrPayload: `ethereum:${user.evm}@84532`,
    });
    const connect = await call(h, "POST", "/internal/v1/agent-connections", {
      internal: true,
      body: {
        oauthClientId: "c1",
        clientName: "x",
        clientUri: null,
        redirectUri: "https://a.example/cb",
        scopes: [],
      },
    });
    await call(h, "POST", "/v1/agent-connections/claim", {
      token: user.accessToken,
      body: { userCode: connect.json.connection.userCode },
    });
    const approve = await call(
      h,
      "POST",
      `/v1/agent-connections/${connect.json.connection.id}/approve`,
      {
        token: user.accessToken,
        body: { name: "a", walletIds: [user.walletId], networks: ["base-mainnet"] },
      },
    );
    expect(approve.json.error.code).toBe("NETWORK_MODE_MISMATCH");
  });

  it("configuration fails closed", () => {
    expect(() =>
      parseConfig({ ZYROPAY_MODE: "production", ZYROPAY_USE_MOCK_ADAPTERS: "true" }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ZYROPAY_MODE: "production", ZYROPAY_USE_MOCK_ADAPTERS: "false" }),
    ).toThrow(/production config incomplete/);
    expect(() => parseConfig({ ZYROPAY_MODE: "staging" })).toThrow(ConfigError);
    expect(() => parseConfig({ INTERNAL_SERVICE_TOKEN: "short" })).toThrow(ConfigError);
  });

  it("errors never leak internals; validation errors are structured", async () => {
    const h = await createHarness();
    const user = await signUp(h);
    const invalid = await call(h, "GET", "/v1/wallets/not-a-uuid", { token: user.accessToken });
    expect(invalid.status).toBe(422);
    expect(invalid.json.error.code).toBe("VALIDATION_FAILED");
    const notJson = await call(h, "POST", "/v1/auth/refresh", { rawBody: "{nope" });
    expect(notJson.json).toEqual({ error: { code: "BAD_REQUEST", message: "body must be JSON" } });
    const unknown = await call(h, "GET", "/v1/nope");
    expect(unknown.json.error.code).toBe("NOT_FOUND");
  });

  it("log redaction removes tokens, keys and stamps", () => {
    const out = JSON.stringify(
      redact({
        authorization: "Bearer zp_at_abc",
        note: "token zp_rt_secretvalue and Bearer xyz",
        nested: { stampHeaderValue: "x", privateKey: "y" },
        hex: "a".repeat(64),
      }),
    );
    expect(out).not.toContain("zp_at_abc");
    expect(out).not.toContain("secretvalue");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("a".repeat(64));
    expect(out).toContain("[redacted]");
  });

  it("delegated signer: key encrypted at rest, activation checks Turnkey, revocation destroys it", async () => {
    const h = await createHarness({ SESSION_ACCESS_TOKEN_TTL_SECONDS: "86400" });
    const user = await signUp(h);
    const created = await call(h, "POST", "/v1/delegated-signer", { token: user.accessToken });
    expect(created.json.signer.status).toBe("pending");
    const [row] = await h.db
      .select()
      .from(t.delegatedSigners)
      .where(eq(t.delegatedSigners.userId, user.userId));
    const plaintext = await decryptSecret(row!.encryptedApiPrivateKey, KEK, user.userId);
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.encryptedApiPrivateKey).not.toContain(plaintext);
    // Ciphertext is bound to its owner: it does not decrypt for another user id.
    await expect(decryptSecret(row!.encryptedApiPrivateKey, KEK, "someone-else")).rejects.toThrow();

    // Activation refuses a user that is in the root quorum or holds other keys.
    const refused = await call(h, "POST", "/v1/delegated-signer/activate", {
      token: user.accessToken,
      body: { turnkeyUserId: user.turnkeyUserId },
    });
    expect(refused.status).toBe(403);
    h.turnkey.addApiKeyUser(user.organizationId, "delegated-ok", created.json.signer.apiPublicKey);
    const ok = await call(h, "POST", "/v1/delegated-signer/activate", {
      token: user.accessToken,
      body: { turnkeyUserId: "delegated-ok" },
    });
    expect(ok.json.signer.status).toBe("active");

    expect(
      (await call(h, "DELETE", "/v1/delegated-signer", { token: user.accessToken })).status,
    ).toBe(200);
    const [revoked] = await h.db
      .select()
      .from(t.delegatedSigners)
      .where(eq(t.delegatedSigners.userId, user.userId));
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.encryptedApiPrivateKey).toBe("destroyed");
  });
});
