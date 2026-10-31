import {
  embedStore,
  isFramingPasskeyError,
  parseFrameParents,
  resolveParentOrigin,
  type EmbedMessage,
} from "./embed";

const FRAME_PARENTS = parseFrameParents(process.env.EXPO_PUBLIC_FRAME_PARENTS);

function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true; // reading window.top threw: certainly framed cross-origin
  }
}

function post(message: EmbedMessage): void {
  if (!isFramed() || FRAME_PARENTS.length === 0) return;
  // Chromium and WebKit only; Firefox has no ancestorOrigins (the referrer is used then).
  const ancestors = (window.location as Partial<Pick<Location, "ancestorOrigins">>).ancestorOrigins;
  const parent = resolveParentOrigin(
    FRAME_PARENTS,
    ancestors ? Array.from(ancestors) : undefined,
    document.referrer,
  );
  // Unknown or not allowlisted: say nothing. Never "*".
  if (parent === null) return;
  window.parent.postMessage(message, parent);
}

/** Passkeys cannot work here at all: no WebAuthn, or the Permissions Policy forbids it. */
function passkeysUnavailableInFrame(): boolean {
  if (typeof window.PublicKeyCredential === "undefined") return true;
  const policy = (
    document as Document & {
      featurePolicy?: { allowsFeature: (feature: string) => boolean };
    }
  ).featurePolicy;
  if (policy === undefined) return false;
  try {
    return (
      !policy.allowsFeature("publickey-credentials-get") ||
      !policy.allowsFeature("publickey-credentials-create")
    );
  } catch {
    return false;
  }
}

let started = false;

/** Called once when the app has rendered: announces it to an allowlisted parent. */
export function startEmbedBridge(): void {
  if (started || !isFramed()) return;
  started = true;
  if (passkeysUnavailableInFrame()) {
    embedStore.setState({ passkeyBlocked: true });
    post({ type: "zyropay:passkey-unavailable" });
  } else {
    post({ type: "zyropay:ready" });
  }
}

/** A signer call failed: when framing is the cause, offer the full-screen link. */
export function reportFramedPasskeyError(error: unknown): void {
  if (!isFramed() || !isFramingPasskeyError(error)) return;
  if (!embedStore.getState().passkeyBlocked) {
    embedStore.setState({ passkeyBlocked: true });
    post({ type: "zyropay:passkey-unavailable" });
  }
}
