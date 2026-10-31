import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectWithOAuth,
  openAuthorize,
  REDIRECT_URI,
  startHarness,
  submitConsent,
} from "../support/harness";
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

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

describe("discovery", () => {
  it("challenges unauthenticated MCP requests with RFC 9728 resource metadata", async () => {
    const res = await fetch(h.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(LIST_TOOLS),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${h.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="wallet:read payments:request"');
  });

  it("publishes protected resource metadata bound to the canonical /mcp resource", async () => {
    const prm = await (
      await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)
    ).json<Record<string, unknown>>();
    expect(prm.resource).toBe(h.mcpUrl);
    expect(prm.authorization_servers).toEqual([h.origin]);
    expect(prm.scopes_supported).toEqual(["wallet:read", "payments:request"]);
  });

  it("publishes RFC 8414 metadata: S256 only, revocation, iss, DCR, public clients", async () => {
    const meta = await (
      await fetch(`${h.origin}/.well-known/oauth-authorization-server`)
    ).json<Record<string, unknown>>();
    expect(meta.issuer).toBe(h.origin);
    expect(meta.authorization_endpoint).toBe(`${h.origin}/authorize`);
    expect(meta.token_endpoint).toBe(`${h.origin}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${h.origin}/oauth/register`);
    expect(meta.revocation_endpoint).toBe(`${h.origin}/oauth/token`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
    expect(meta.grant_types_supported).not.toContain("implicit");
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    // CIMD: advertised because clientIdMetadataDocumentEnabled + global_fetch_strictly_public.
    expect(meta.client_id_metadata_document_supported).toBe(true);
  });
});

describe("authorization code + PKCE happy path (MCP SDK client)", () => {
  it("connects through DCR, consent in the app, and lists the 10 tools", async () => {
    const { client, provider, agentId } = await connectWithOAuth(h);
    const auth = provider.authorizationUrl!;
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toBeTruthy();
    expect(auth.searchParams.get("resource")).toBe(h.mcpUrl);
    expect(provider.saved?.access_token).toBeTruthy();
    expect(provider.saved?.refresh_token).toBeTruthy();
    expect(provider.saved?.expires_in).toBe(900);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_agent_policy",
        "get_approval_status",
        "get_balance",
        "get_transactions",
        "get_wallets",
        "find_agents",
        "verify_agent",
        "pay_x402",
        "send",
        "swap",
      ].sort(),
    );

    // The grant maps to exactly the agent the user approved.
    const policy = await client.callTool({ name: "get_agent_policy", arguments: {} });
    expect(policy.isError).toBeFalsy();
    const created = h.api.agents.get(agentId)!;
    expect(created.policy.mode).toBe("always_ask");
    expect(created.policy.spendingEnabled).toBe(false);
    await client.close();
  });

  it("issues an iss parameter (RFC 9207) and returns state on the redirect", async () => {
    const { page } = await approvedCode(h);
    expect(page.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // approvedCode consumed the redirect; check on a fresh one.
    const { clientId } = await registerClient(h);
    const { challenge } = pkcePair();
    const fresh = await openAuthorize(
      authorizeUrl(h, { client_id: clientId, code_challenge: challenge }),
    );
    h.api.approve(fresh.userCode);
    const res = await submitConsent(h.origin, fresh);
    const location = new URL(res.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(h.origin);
  });

  it("rotates refresh tokens and rejects reuse of a superseded one", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const first = await exchange(h, { clientId, code, verifier });
    expect(first.status).toBe(200);
    const r1 = String(first.body.refresh_token);

    const second = await tokenRequest(h, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: r1,
    });
    expect(second.status).toBe(200);
    const r2 = String(second.body.refresh_token);
    expect(r2).not.toBe(r1);
    expect(second.body.access_token).not.toBe(first.body.access_token);

    const third = await tokenRequest(h, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: r2,
    });
    expect(third.status).toBe(200);
    // r1 was superseded once r2 was used.
    const replay = await tokenRequest(h, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: r1,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });
});

describe("PKCE", () => {
  it("rejects a token request with the wrong code_verifier", async () => {
    const { clientId, code } = await approvedCode(h);
    const res = await exchange(h, { clientId, code, verifier: pkcePair().verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("rejects a token request without code_verifier", async () => {
    const { clientId, code } = await approvedCode(h);
    const res = await tokenRequest(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      resource: h.mcpUrl,
    });
    expect(res.status).toBe(400);
  });

  it("refuses authorization without a code_challenge (redirects invalid_request)", async () => {
    const { clientId } = await registerClient(h);
    const res = await fetch(
      authorizeUrl(h, { client_id: clientId, code_challenge_method: undefined }),
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(
      h.api.calls.filter((c) => c.path === "/internal/v1/agent-connections").length,
    ).toBeGreaterThan(0);
  });

  it("refuses the plain code_challenge_method", async () => {
    const { clientId } = await registerClient(h);
    const before = h.api.connections.size;
    const res = await fetch(
      authorizeUrl(h, {
        client_id: clientId,
        code_challenge: "a".repeat(43),
        code_challenge_method: "plain",
      }),
      { redirect: "manual" },
    );
    const location = res.headers.get("Location");
    expect(
      res.status === 400 ||
        (res.status === 302 && new URL(location!).searchParams.get("error") === "invalid_request"),
    ).toBe(true);
    expect(h.api.connections.size).toBe(before); // no connection was started
  });
});

describe("redirect URI validation", () => {
  it("never redirects to an unregistered redirect_uri", async () => {
    const { clientId } = await registerClient(h);
    const { challenge } = pkcePair();
    const res = await fetch(
      authorizeUrl(h, {
        client_id: clientId,
        code_challenge: challenge,
        redirect_uri: "https://evil.example/callback",
      }),
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("requires an exact match (no prefix or port tricks beyond RFC 8252 loopback)", async () => {
    const { clientId } = await registerClient(h);
    const { challenge } = pkcePair();
    const res = await fetch(
      authorizeUrl(h, {
        client_id: clientId,
        code_challenge: challenge,
        redirect_uri: `${REDIRECT_URI}/extra`,
      }),
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("rejects DCR with a non-loopback http redirect URI", async () => {
    const res = await registerClient(h, { redirect_uris: ["http://evil.example/callback"] });
    expect(res.status).toBe(400);
    // RFC 7591 §3.2.2 allows either error code here.
    expect(String(res.body.error)).toMatch(/^invalid_(redirect_uri|client_metadata)$/);
  });

  it("rejects a code exchange with a different redirect_uri", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const res = await exchange(h, {
      clientId,
      code,
      verifier,
      redirectUri: "http://127.0.0.1:9/other",
    });
    expect(res.status).toBe(400);
  });
});

describe("consent outcomes", () => {
  async function startConsent() {
    const { clientId } = await registerClient(h);
    const { challenge } = pkcePair();
    return openAuthorize(authorizeUrl(h, { client_id: clientId, code_challenge: challenge }));
  }

  it("shows the user code and polls a pending status", async () => {
    const page = await startConsent();
    expect(page.html).toContain("Approve this connection in the ZyroPay app");
    const status = await (
      await fetch(`${h.origin}/authorize/status?ticket=${encodeURIComponent(page.ticket)}`)
    ).json<{ status: string }>();
    expect(status.status).toBe("pending");
    // Submitting early keeps the user on the waiting page.
    const early = await submitConsent(h.origin, page);
    expect(early.status).toBe(200);
  });

  it("rejects a forged poll ticket", async () => {
    const page = await startConsent();
    const forged = page.ticket.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const res = await fetch(`${h.origin}/authorize/status?ticket=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(400);
  });

  it("redirects access_denied when the user rejects in the app", async () => {
    const page = await startConsent();
    h.api.reject(page.userCode);
    const res = await submitConsent(h.origin, page);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("redirects access_denied when the code expires", async () => {
    const page = await startConsent();
    h.api.expire(page.userCode);
    const res = await submitConsent(h.origin, page);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toContain("expired");
  });

  it("CSRF: the form post without the browser-bound cookie is refused", async () => {
    const page = await startConsent();
    h.api.approve(page.userCode);
    const res = await submitConsent(h.origin, page, "");
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("CSRF: a cookie from another consent does not authorize this handle", async () => {
    const victim = await startConsent();
    const attacker = await startConsent();
    h.api.approve(victim.userCode);
    const res = await submitConsent(h.origin, victim, attacker.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("a consent handle works once", async () => {
    const page = await startConsent();
    h.api.approve(page.userCode);
    expect((await submitConsent(h.origin, page)).status).toBe(302);
    const again = await submitConsent(h.origin, page);
    expect(again.status).toBe(400);
  });
});

describe("tokens", () => {
  it("revocation (RFC 7009) makes the access token useless", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const tokens = await exchange(h, { clientId, code, verifier });
    const access = String(tokens.body.access_token);
    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(200);
    const revoke = await tokenRequest(h, {
      token: access,
      client_id: clientId,
      token_type_hint: "access_token",
    });
    expect(revoke.status).toBe(200);
    expect((await rawMcp(h, access, LIST_TOOLS)).status).toBe(401);
  });

  it("rejects malformed and unknown bearer tokens", async () => {
    expect((await rawMcp(h, "not-a-token", LIST_TOOLS)).status).toBe(401);
    expect(
      (await rawMcp(h, "0190f7a2-0000-7000-8000-000000000001:abc:def", LIST_TOOLS)).status,
    ).toBe(401);
  });

  it("binds tokens to the /mcp resource (RFC 8707): other resources are refused", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    const res = await exchange(h, { clientId, code, verifier, resource: `${h.origin}/other` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_target");
  });

  it("authorization codes are single-use", async () => {
    const { clientId, code, verifier } = await approvedCode(h);
    expect((await exchange(h, { clientId, code, verifier })).status).toBe(200);
    const replay = await exchange(h, { clientId, code, verifier });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });
});
