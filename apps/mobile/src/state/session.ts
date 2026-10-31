import { UserSchema } from "@zyropay/shared";
import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";

/*
 * Session store. The API session (access + refresh token) lives in the OS
 * keychain/keystore via a SecureKeyValue adapter; only non-secret user info is
 * kept in memory. Turnkey's own session key is managed by the Wallet Kit.
 */

export interface SecureKeyValue {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  deleteItem: (key: string) => Promise<void>;
}

export const StoredSessionSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.string(),
  user: UserSchema,
  /** The session was issued by the DEV mock transport. */
  simulated: z.boolean(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export type SessionStatus = "loading" | "signedOut" | "signedIn";

export interface SessionState {
  readonly status: SessionStatus;
  readonly session: StoredSession | null;
  hydrate: () => Promise<void>;
  signIn: (session: StoredSession) => Promise<void>;
  updateTokens: (
    tokens: Pick<
      StoredSession,
      "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "refreshTokenExpiresAt"
    >,
  ) => Promise<void>;
  signOut: () => Promise<void>;
}

export const SESSION_KEY = "zyropay.session.v1";

export function createSessionStore(
  storage: SecureKeyValue,
  now: () => number = Date.now,
): StoreApi<SessionState> {
  return createStore<SessionState>()((set, get) => ({
    status: "loading",
    session: null,
    async hydrate() {
      const raw = await storage.getItem(SESSION_KEY).catch(() => null);
      if (raw === null) {
        set({ status: "signedOut", session: null });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      const parsed = StoredSessionSchema.safeParse(json);
      if (!parsed.success || new Date(parsed.data.refreshTokenExpiresAt).getTime() <= now()) {
        await storage.deleteItem(SESSION_KEY).catch(() => undefined);
        set({ status: "signedOut", session: null });
        return;
      }
      set({ status: "signedIn", session: parsed.data });
    },
    async signIn(session) {
      const valid = StoredSessionSchema.parse(session);
      await storage.setItem(SESSION_KEY, JSON.stringify(valid));
      set({ status: "signedIn", session: valid });
    },
    async updateTokens(tokens) {
      const current = get().session;
      if (current === null) return;
      const next = { ...current, ...tokens };
      await storage.setItem(SESSION_KEY, JSON.stringify(next));
      set({ session: next });
    },
    async signOut() {
      await storage.deleteItem(SESSION_KEY).catch(() => undefined);
      set({ status: "signedOut", session: null });
    },
  }));
}
