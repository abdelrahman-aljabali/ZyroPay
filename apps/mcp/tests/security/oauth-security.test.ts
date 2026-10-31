/**
 * Cross-cutting OAuth security properties of the MCP worker, end to end in workerd.
 * Complements tests/e2e/oauth.test.ts (protocol behaviour) with attack-shaped cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness } from "../support/harness";
import type { Harness } from "../support/harness";
import {
  approvedCode,
  authorizeUrl,
  exchange,
  LIST_TOOLS,
  pkcePair,
  rawMcp,
  registerClient,
  tokenRequest,
} from "../support/oauth";

describe("with a 60 s access-token TTL", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "60" });
  });
  afterAll(async () => {
    await h.stop();
  });

  it("access tokens expire (and a refresh restores access)", { timeout: 120_000 }, async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const tokens = await exchange(h, { clientId, code, verifier });
    expect(tokens.body.expires_in).toBe(60);
    const access = String(tokens.body.access_token);
    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 62_000));
    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(401);
    const refreshed = await tokenRequest(h, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(tokens.body.refresh_token),
    });
    expect(refreshed.status).toBe(200);
    expect((await rawMcp(h, String(refreshed.body.access_token), LIST_TOOLS)).status).toBe(200);
  });
});

describe("attack-shaped cases", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.stop();
  });

  it("the authorize page cannot be framed, cached or scripted by the client", async () => {
    const { clientId } = await registerClient(h, {
      client_name: '<script>alert("x")</script><img src=x onerror=alert(1)>',
    });
    const url = authorizeUrl(h, { client_id: clientId, code_challenge: pkcePair().challenge });
    const res = await fetch(url, { redirect: "manual" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&#60;script&#62;");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toMatch(/__Host-/);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    // The self-registered name reaches the app marked as unverified.
    const connection = [...h.api.connections.values()].at(-1)!;
    expect(connection.clientName).toContain("(unverified)");
  });

  it("a code issued to one client cannot be redeemed by another", async () => {
    const { code, verifier } = await approvedCode(h);
    const { clientId: otherClient } = await registerClient(h);
    const res = await exchange(h, { clientId: otherClient, code, verifier });
    expect(res.status).toBe(400);
  });

  it("a refresh token cannot be used by another client", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const tokens = await exchange(h, { clientId, code, verifier });
    const { clientId: otherClient } = await registerClient(h);
    const res = await tokenRequest(h, {
      grant_type: "refresh_token",
      client_id: otherClient,
      refresh_token: String(tokens.body.refresh_token),
    });
    expect(res.status).toBe(400);
  });

  it("the implicit grant and token response types are refused", async () => {
    const { clientId } = await registerClient(h);
    const res = await fetch(
      authorizeUrl(h, {
        client_id: clientId,
        response_type: "token",
        code_challenge: pkcePair().challenge,
      }),
      {
        redirect: "manual",
      },
    );
    const location = res.headers.get("Location");
    expect(
      res.status === 400 ||
        (location !== null && new URL(location).searchParams.get("error") !== null),
    ).toBe(true);
  });

  it("unknown client ids get a local error page, never a redirect", async () => {
    const res = await fetch(
      authorizeUrl(h, { client_id: "does-not-exist", code_challenge: pkcePair().challenge }),
      {
        redirect: "manual",
      },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("the OAuth access token never reaches the API; only the internal token does", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const tokens = await exchange(h, { clientId, code, verifier });
    await rawMcp(h, String(tokens.body.access_token), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_wallets", arguments: {} },
    });
    expect(h.api.calls.length).toBeGreaterThan(0);
    expect(h.api.calls.every((c) => c.authorized)).toBe(true);
    expect(JSON.stringify(h.api.calls)).not.toContain(String(tokens.body.access_token));
  });

  it("rate-limits the authorize endpoint per IP", async () => {
    const { clientId } = await registerClient(h);
    // AUTH_RATE_LIMITER allows 60 per 60 s in windows aligned to the wall clock, so a burst
    // of 70 that straddles a minute boundary can split 35/35 and never see a 429 (this
    // flaked under load). 2 * 60 + 1 requests guarantee one window gets more than 60.
    const statuses: number[] = [];
    for (let i = 0; i < 121 && !statuses.includes(429); i++) {
      const res = await fetch(
        authorizeUrl(h, { client_id: clientId, code_challenge: pkcePair().challenge }),
        {
          redirect: "manual",
        },
      );
      statuses.push(res.status);
      await res.body?.cancel();
    }
    expect(statuses).toContain(429);
  });
});
