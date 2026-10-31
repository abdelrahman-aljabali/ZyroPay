import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/*
 * Embedding in the ZyroPay landing page (web only; docs/SECURITY.md "Framing").
 *
 * The landing page shows the real web app inside an iframe on desktop. Which sites may
 * frame it is decided by the host's CSP `frame-ancestors` (apps/web-host/scripts/build.mjs);
 * the same allowlist reaches the bundle as EXPO_PUBLIC_FRAME_PARENTS so the app talks only
 * to those origins. When framed, the app posts one of two minimal messages to its parent
 * (the landing page listens for exactly these), only when the parent's origin is known and
 * allowlisted, always with that exact target origin (never "*"): no user data, no state.
 *
 * Browsers can refuse WebAuthn inside a cross-origin frame (Permissions Policy not
 * delegated, older engines, no user activation). Then the app offers a link that reopens
 * the same page at the top level, where passkeys always work.
 */

/** The landing page's contract (apps/landing listens for exactly these). */
export type EmbedMessage =
  { readonly type: "zyropay:ready" } | { readonly type: "zyropay:passkey-unavailable" };

/** Origins from a space or comma separated list; anything that is not a bare origin is dropped. */
export function parseFrameParents(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const item of raw.split(/[\s,]+/)) {
    if (item === "") continue;
    try {
      const url = new URL(item);
      const local = url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
      if ((url.protocol === "https:" || local) && url.origin === item && !out.includes(item))
        out.push(item);
    } catch {
      // not an origin
    }
  }
  return out;
}

/**
 * The parent's origin when the browser tells us (location.ancestorOrigins in Chromium and
 * WebKit, else the referrer) and it is allowlisted; null when unknown or not allowlisted.
 */
export function resolveParentOrigin(
  allowed: readonly string[],
  ancestorOrigins: readonly string[] | undefined,
  referrer: string,
): string | null {
  let candidate: string | null = ancestorOrigins?.[0] ?? null;
  if (candidate === null && referrer !== "") {
    try {
      candidate = new URL(referrer).origin;
    } catch {
      candidate = null;
    }
  }
  return candidate !== null && allowed.includes(candidate) ? candidate : null;
}

/** WebAuthn refusals that framing causes (Turnkey wraps the DOMException in `cause`). */
export function isFramingPasskeyError(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 6 && e !== null && e !== undefined; depth++) {
    if (typeof e === "object") {
      const { name, message } = e as { name?: unknown; message?: unknown };
      if (name === "NotAllowedError" || name === "SecurityError") return true;
      if (
        typeof message === "string" &&
        /NotAllowedError|SecurityError|publickey-credentials|feature is not enabled|cross-origin/i.test(
          message,
        )
      )
        return true;
      e = (e as { cause?: unknown }).cause;
    } else {
      return false;
    }
  }
  return false;
}

interface EmbedState {
  /** A passkey prompt failed (or cannot run) because the app is framed. */
  readonly passkeyBlocked: boolean;
}

export const embedStore = createStore<EmbedState>()(() => ({ passkeyBlocked: false }));

export function usePasskeyBlockedInFrame(): boolean {
  return useStore(embedStore, (s) => s.passkeyBlocked);
}
