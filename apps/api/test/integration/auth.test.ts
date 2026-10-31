import { mockPasskeyStamp } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../../src/db/tables";
import type { Harness } from "../helpers";
import { call, createHarness, signUp, stampedWhoami } from "../helpers";

describe("auth / session lifecycle", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });

  it("health works without touching the database", async () => {
    const res = await call(h, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, mode: "development" });
  });

  it("signs up with a passkey-stamped whoami, mirrors wallets, issues opaque tokens stored hashed", async () => {
    const user = await signUp(h);
    expect(user.accessToken).toMatch(/^zp_at_/);
    expect(user.refreshToken).toMatch(/^zp_rt_/);
    const me = await call(h, "GET", "/v1/me", { token: user.accessToken });
    expect(me.status).toBe(200);
    expect(me.json.user.turnkeySubOrganizationId).toBe(user.organizationId);
    const wallets = await call(h, "GET", "/v1/wallets", { token: user.accessToken });
    expect(
      wallets.json.wallets[0].addresses.map((a: { family: string }) => a.family).sort(),
    ).toEqual(["cardano", "evm", "solana"]); // sub-orgs carry a Cardano account (ADR-002)
    // Only hashes at rest.
    const sessions = await h.db.select().from(t.sessions).where(eq(t.sessions.userId, user.userId));
    expect(sessions[0]?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sessions)).not.toContain(user.refreshToken);
    const access = await h.db
      .select()
      .from(t.sessionAccessTokens)
      .where(eq(t.sessionAccessTokens.userId, user.userId));
    expect(JSON.stringify(access)).not.toContain(user.accessToken);
  });

  it("refuses a replayed login stamp", async () => {
    const credentialId = "cred-replay";
    const org = h.turnkey.createSubOrg({ credentialId });
    const stamped = stampedWhoami(credentialId, org.organizationId);
    expect(
      (await call(h, "POST", "/v1/auth/session", { body: { whoamiRequest: stamped } })).status,
    ).toBe(200);
    const replay = await call(h, "POST", "/v1/auth/session", { body: { whoamiRequest: stamped } });
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe("UNAUTHENTICATED");
  });

  it("existing users can sign in again with a new stamp", async () => {
    const credentialId = "cred-relogin";
    const org = h.turnkey.createSubOrg({ credentialId });
    const first = await call(h, "POST", "/v1/auth/session", {
      body: { whoamiRequest: stampedWhoami(credentialId, org.organizationId) },
    });
    expect(first.json.isNewUser).toBe(true);
    // A different (still valid) whoami body: organizationId may be the parent org for WebAuthn users.
    const body = JSON.stringify({ organizationId: "parent-org-id" });
    const second = await call(h, "POST", "/v1/auth/session", {
      body: {
        whoamiRequest: {
          url: "https://api.turnkey.com/public/v1/query/whoami",
          body,
          stamp: mockPasskeyStamp(credentialId, body),
        },
      },
    });
    expect(second.status).toBe(200);
    expect(second.json.isNewUser).toBe(false);
    expect(second.json.user.id).toBe(first.json.user.id);
  });

  it("enforces the root-quorum check on first login (non-custodial)", async () => {
    const credentialId = "cred-custodial";
    const org = h.turnkey.createSubOrg({ credentialId, extraUsers: ["zyropay-root"] });
    h.turnkey.setRootQuorum(org.organizationId, {
      threshold: 1,
      userIds: [org.userId, "zyropay-root"],
    });
    const res = await call(h, "POST", "/v1/auth/session", {
      body: { whoamiRequest: stampedWhoami(credentialId, org.organizationId) },
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
    const users = await h.db
      .select()
      .from(t.users)
      .where(eq(t.users.turnkeySubOrganizationId, org.organizationId));
    expect(users).toHaveLength(0);
  });

  it("rejects stamps that do not cover the body, wrong URLs and unknown credentials", async () => {
    const org = h.turnkey.createSubOrg({ credentialId: "cred-x" });
    const good = stampedWhoami("cred-x", org.organizationId);
    const tampered = { ...good, body: JSON.stringify({ organizationId: "other" }) };
    expect(
      (await call(h, "POST", "/v1/auth/session", { body: { whoamiRequest: tampered } })).status,
    ).toBe(401);
    const wrongUrl = {
      ...stampedWhoami("cred-x", org.organizationId),
      url: "https://evil.example/public/v1/query/whoami",
    };
    expect(
      (await call(h, "POST", "/v1/auth/session", { body: { whoamiRequest: wrongUrl } })).status,
    ).toBe(401);
    const unknown = stampedWhoami("cred-unknown", org.organizationId);
    expect(
      (await call(h, "POST", "/v1/auth/session", { body: { whoamiRequest: unknown } })).status,
    ).toBe(401);
  });

  it("rotates refresh tokens; reuse of a rotated token revokes every session", async () => {
    const user = await signUp(h);
    const r1 = await call(h, "POST", "/v1/auth/refresh", {
      body: { refreshToken: user.refreshToken },
    });
    expect(r1.status).toBe(200);
    expect(r1.json.session.refreshToken).not.toBe(user.refreshToken);
    // old access token was revoked by rotation
    expect((await call(h, "GET", "/v1/me", { token: user.accessToken })).status).toBe(401);
    expect((await call(h, "GET", "/v1/me", { token: r1.json.session.accessToken })).status).toBe(
      200,
    );
    // replay the old refresh token => theft signal => everything revoked
    const reuse = await call(h, "POST", "/v1/auth/refresh", {
      body: { refreshToken: user.refreshToken },
    });
    expect(reuse.status).toBe(401);
    expect((await call(h, "GET", "/v1/me", { token: r1.json.session.accessToken })).status).toBe(
      401,
    );
    expect(
      (
        await call(h, "POST", "/v1/auth/refresh", {
          body: { refreshToken: r1.json.session.refreshToken },
        })
      ).status,
    ).toBe(401);
    const audits = await h.db
      .select()
      .from(t.auditLogs)
      .where(eq(t.auditLogs.action, "security.refresh_token_reuse"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("access tokens expire; logout revokes the session", async () => {
    const user = await signUp(h);
    h.clock.advance(16 * 60_000);
    expect((await call(h, "GET", "/v1/me", { token: user.accessToken })).status).toBe(401);
    const refreshed = await call(h, "POST", "/v1/auth/refresh", {
      body: { refreshToken: user.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    const token = refreshed.json.session.accessToken;
    expect((await call(h, "DELETE", "/v1/auth/session", { token })).status).toBe(200);
    expect((await call(h, "GET", "/v1/me", { token })).status).toBe(401);
    expect(
      (
        await call(h, "POST", "/v1/auth/refresh", {
          body: { refreshToken: refreshed.json.session.refreshToken },
        })
      ).status,
    ).toBe(401);
  });

  it("rejects missing / malformed bearer tokens with the error envelope", async () => {
    const res = await call(h, "GET", "/v1/me");
    expect(res.status).toBe(401);
    expect(res.json).toEqual({
      error: { code: "UNAUTHENTICATED", message: "missing bearer token" },
    });
    expect((await call(h, "GET", "/v1/me", { token: "zp_at_nope" })).status).toBe(401);
  });
});
