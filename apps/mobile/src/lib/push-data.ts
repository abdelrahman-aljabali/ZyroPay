import { parsePushData, type PushRoute } from "@zyropay/shared";
import { env } from "@/lib/env";

/*
 * Push payload parsing (unit-tested). The payload is the shared `PushData`
 * (@zyropay/shared push.ts): version, event type, opaque ids and one deep link
 * of the form <scheme>://<route> from a closed set of screens. Anything else is
 * ignored, so a crafted notification can at most open one of those screens,
 * which reload everything from the API.
 */

export function pushRouteFromData(data: unknown, scheme = env.deepLinkScheme): PushRoute | null {
  return parsePushData(data, scheme)?.route ?? null;
}

/** Approval id when the push opens an approval review, otherwise null. */
export function approvalIdFromPushData(data: unknown, scheme = env.deepLinkScheme): string | null {
  const route = pushRouteFromData(data, scheme);
  return route?.screen === "approval" ? route.approvalId : null;
}
