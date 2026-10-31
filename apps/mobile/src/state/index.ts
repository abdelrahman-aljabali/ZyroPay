import { useStore } from "zustand";
import { env } from "@/lib/env";
import { createPrefsStore, type PrefsState } from "./prefs";
import { createSessionStore, type SessionState } from "./session";
import { prefsStorage, secureStorage } from "./storage";

export const sessionStore = createSessionStore(secureStorage);

export const prefsStore = createPrefsStore(prefsStorage, env.mode);

export function useSession<T>(selector: (s: SessionState) => T): T {
  return useStore(sessionStore, selector);
}

export function usePrefs<T>(selector: (s: PrefsState) => T): T {
  return useStore(prefsStore, selector);
}

export type { PrefsState, SessionState };
