import { describe, expect, it } from "vitest";
import { createPrefsStore } from "./prefs";
import {
  createSessionStore,
  SESSION_KEY,
  type SecureKeyValue,
  type StoredSession,
} from "./session";

function memorySecure(): SecureKeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
    deleteItem: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
}

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

const session: StoredSession = {
  accessToken: "a",
  accessTokenExpiresAt: "2026-10-30T12:15:00.000Z",
  refreshToken: "r",
  refreshTokenExpiresAt: "2026-11-30T12:00:00.000Z",
  user: {
    id: "0192f3a1-0001-7000-8000-000000000001",
    email: null,
    displayName: "Ada",
    turnkeySubOrganizationId: "org",
    createdAt: "2026-10-30T00:00:00.000Z",
  },
  simulated: false,
};

const NOW = () => new Date("2026-10-30T12:00:00.000Z").getTime();

describe("session store", () => {
  it("starts loading, hydrates to signedOut when empty", async () => {
    const store = createSessionStore(memorySecure(), NOW);
    expect(store.getState().status).toBe("loading");
    await store.getState().hydrate();
    expect(store.getState().status).toBe("signedOut");
  });

  it("persists sign-in to secure storage and restores it", async () => {
    const secure = memorySecure();
    await createSessionStore(secure, NOW).getState().signIn(session);
    expect(secure.data.has(SESSION_KEY)).toBe(true);
    const restored = createSessionStore(secure, NOW);
    await restored.getState().hydrate();
    expect(restored.getState().status).toBe("signedIn");
    expect(restored.getState().session?.user.displayName).toBe("Ada");
  });

  it("drops expired or corrupt sessions", async () => {
    const secure = memorySecure();
    secure.data.set(
      SESSION_KEY,
      JSON.stringify({ ...session, refreshTokenExpiresAt: "2026-10-30T00:00:00.000Z" }),
    );
    const s1 = createSessionStore(secure, NOW);
    await s1.getState().hydrate();
    expect(s1.getState().status).toBe("signedOut");
    expect(secure.data.has(SESSION_KEY)).toBe(false);
    secure.data.set(SESSION_KEY, "{not json");
    const s2 = createSessionStore(secure, NOW);
    await s2.getState().hydrate();
    expect(s2.getState().status).toBe("signedOut");
  });

  it("rotates tokens and signs out", async () => {
    const secure = memorySecure();
    const store = createSessionStore(secure, NOW);
    await store.getState().signIn(session);
    await store.getState().updateTokens({
      accessToken: "a2",
      accessTokenExpiresAt: "x",
      refreshToken: "r2",
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    });
    expect(JSON.parse(secure.data.get(SESSION_KEY) ?? "{}")).toMatchObject({
      accessToken: "a2",
      refreshToken: "r2",
    });
    await store.getState().signOut();
    expect(store.getState().status).toBe("signedOut");
    expect(secure.data.size).toBe(0);
  });
});

describe("prefs store", () => {
  it("has safe defaults", () => {
    const s = createPrefsStore(memoryKv(), "development").getState();
    expect(s.theme).toBe("light");
    expect(s.hideBalances).toBe(false);
    expect(s.onboardingComplete).toBe(false);
  });

  it("refuses networks from the other side of the mainnet/testnet divide", () => {
    const store = createPrefsStore(memoryKv(), "development");
    store.getState().setPreferredNetwork("solana-mainnet");
    expect(store.getState().preferredNetwork).toBeNull();
    store.getState().setPreferredNetwork("base-sepolia");
    expect(store.getState().preferredNetwork).toBe("base-sepolia");
  });

  it("persists and rehydrates, discarding a cross-mode network", async () => {
    const kv = memoryKv();
    const dev = createPrefsStore(kv, "development");
    dev.getState().setTheme("dark");
    dev.getState().setPreferredNetwork("solana-devnet");
    const prod = createPrefsStore(kv, "production");
    await prod.persist.rehydrate();
    expect(prod.getState().theme).toBe("dark");
    expect(prod.getState().preferredNetwork).toBeNull();
  });

  it("keeps an explicit System or Dark choice across restarts", async () => {
    const kv = memoryKv();
    createPrefsStore(kv, "development").getState().setTheme("system");
    const next = createPrefsStore(kv, "development");
    await next.persist.rehydrate();
    expect(next.getState().theme).toBe("system");
  });

  it("migrates the v1 default (system) to light, keeping explicit v1 choices", async () => {
    const v1 = (theme: string) => {
      const kv = memoryKv();
      kv.setItem("zyropay.prefs.v1", JSON.stringify({ state: { theme }, version: 1 }));
      return kv;
    };
    for (const [stored, expected] of [
      ["system", "light"],
      ["dark", "dark"],
      ["light", "light"],
    ] as const) {
      const store = createPrefsStore(v1(stored), "development");
      await store.persist.rehydrate();
      expect(store.getState().theme).toBe(expected);
    }
  });

  it("drops the retired hiddenWalletIds from v2 prefs", async () => {
    const kv = memoryKv();
    kv.setItem(
      "zyropay.prefs.v1",
      JSON.stringify({ state: { theme: "dark", hiddenWalletIds: ["w1"] }, version: 2 }),
    );
    const store = createPrefsStore(kv, "development");
    await store.persist.rehydrate();
    expect(store.getState().theme).toBe("dark");
    expect("hiddenWalletIds" in store.getState()).toBe(false);
  });

  it("toggles balance hiding", () => {
    const store = createPrefsStore(memoryKv(), "development");
    store.getState().toggleHideBalances();
    expect(store.getState().hideBalances).toBe(true);
  });
});
