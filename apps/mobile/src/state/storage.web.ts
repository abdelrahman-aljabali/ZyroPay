import type { StateStorage } from "zustand/middleware";
import type { SecureKeyValue } from "./session";

/*
 * Web build (PWA). Metro picks this file over storage.ts for the web platform; native
 * builds never include it.
 *
 * Browsers have no keychain, so the "secure" store is sessionStorage. Security notes:
 *  - What is stored: only the ZyroPay API session (opaque access + refresh tokens). No key
 *    material ever exists in ZyroPay: keys live in Turnkey's enclaves, the passkey lives in
 *    the platform authenticator, and every value-moving request needs a fresh passkey
 *    assertion, so a stolen token alone cannot move funds.
 *  - sessionStorage is scoped to this origin AND this tab, and is wiped when the tab or
 *    window closes. A new tab means a new passkey login. Nothing about the session
 *    survives a browser restart.
 *  - It is readable by any script running on the origin, so XSS would expose the tokens:
 *    apps/web-host serves a strict Content-Security-Policy and no third-party scripts.
 *  - Turnkey's own session key (@turnkey/core) is a non-extractable P-256 CryptoKey in
 *    IndexedDB: script can use it to stamp read-only queries while the Turnkey session is
 *    valid (15 min by default), but cannot read it out. Logging out deletes it.
 * Preferences (theme, currency, hidden wallets) are not secrets and use localStorage.
 */

function store(kind: "session" | "local"): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null; // storage disabled (privacy mode, sandboxed iframe)
  }
}

export const secureStorage: SecureKeyValue = {
  getItem: (key) => Promise.resolve(store("session")?.getItem(key) ?? null),
  setItem: (key, value) => {
    store("session")?.setItem(key, value);
    return Promise.resolve();
  },
  deleteItem: (key) => {
    store("session")?.removeItem(key);
    // Older web builds kept the session in localStorage: never leave a copy behind.
    store("local")?.removeItem(key);
    return Promise.resolve();
  },
};

export const prefsStorage: StateStorage = {
  getItem: (name) => store("local")?.getItem(name) ?? null,
  setItem: (name, value) => {
    store("local")?.setItem(name, value);
  },
  removeItem: (name) => {
    store("local")?.removeItem(name);
  },
};
