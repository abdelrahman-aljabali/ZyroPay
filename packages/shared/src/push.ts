/*
 * Push notification payload (the `data` of an Expo push), shared by the API notifier and
 * the mobile handler.
 *
 * Push payloads transit Expo, APNs and FCM and can show on a lock screen, so the data is
 * opaque ids plus one in-app deep link: never amounts, addresses, tokens, stamps or any
 * other secret. Every value is a string (Expo `data` is a string map in our port).
 *
 * The deep link is always `<scheme>://<route>` where route is one of a closed set of app
 * screens; the app opens nothing else, so a crafted notification can at most open one of
 * these screens (which re-load everything from the API anyway).
 */
import { z } from "zod";
import { NotificationEventSchema, type NotificationEvent } from "./api/ext";

export const DEFAULT_DEEP_LINK_SCHEME = "zyropay";

/** URL scheme: lowercase letters, digits, `+ . -`, starting with a letter (RFC 3986). */
export const DeepLinkSchemeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9+.-]{0,31}$/, "invalid deep link scheme");

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** In-app destinations a push may open. */
export type PushRoute =
  | { readonly screen: "approval"; readonly approvalId: string }
  | { readonly screen: "approvals" }
  | { readonly screen: "activity" }
  | { readonly screen: "agent"; readonly agentId: string }
  | { readonly screen: "settings" };

const ROUTE_PATTERN = new RegExp(
  `^(approvals/(${UUID.source})|approvals|activity|agents/(${UUID.source})|settings)$`,
);

export function pushRoutePath(route: PushRoute): string {
  switch (route.screen) {
    case "approval":
      return `approvals/${route.approvalId}`;
    case "agent":
      return `agents/${route.agentId}`;
    case "approvals":
    case "activity":
    case "settings":
      return route.screen;
  }
}

export function pushDeepLink(route: PushRoute, scheme = DEFAULT_DEEP_LINK_SCHEME): string {
  return `${DeepLinkSchemeSchema.parse(scheme)}://${pushRoutePath(route)}`;
}

/** Parse a deep link of exactly `<scheme>://<route>`; anything else is null. */
export function parsePushDeepLink(
  url: string,
  scheme = DEFAULT_DEEP_LINK_SCHEME,
): PushRoute | null {
  const prefix = `${scheme}://`;
  if (!url.startsWith(prefix)) return null;
  const match = ROUTE_PATTERN.exec(url.slice(prefix.length));
  if (match === null) return null;
  if (match[2] !== undefined) return { screen: "approval", approvalId: match[2] };
  if (match[3] !== undefined) return { screen: "agent", agentId: match[3] };
  const screen = match[1];
  if (screen === "approvals" || screen === "activity" || screen === "settings") return { screen };
  return null;
}

const IdString = z.uuid();

/**
 * The data dictionary of every ZyroPay push. Strict: unknown keys are refused, so nothing
 * else (amounts, addresses, …) can ride along.
 */
export const PushDataSchema = z.strictObject({
  /** Payload version. */
  v: z.literal("1"),
  type: NotificationEventSchema,
  /** `<scheme>://<route>`, checked against the closed route set by `parsePushData`. */
  url: z.string().max(128),
  approvalId: IdString.optional(),
  requestId: IdString.optional(),
  agentId: IdString.optional(),
  orderId: IdString.optional(),
  transferId: IdString.optional(),
});
export type PushData = z.infer<typeof PushDataSchema>;

/** Keys a push `data` may carry (for transport-level allowlists such as the Expo notifier). */
export const PUSH_DATA_KEYS = Object.keys(PushDataSchema.shape) as readonly (keyof PushData)[];

export interface PushIds {
  readonly approvalId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly orderId?: string | undefined;
  readonly transferId?: string | undefined;
}

/** Where a push of this type opens the app. */
export function pushRouteFor(type: NotificationEvent, ids: PushIds): PushRoute {
  switch (type) {
    case "approval_requested":
      return ids.approvalId !== undefined
        ? { screen: "approval", approvalId: ids.approvalId }
        : { screen: "approvals" };
    case "approval_expired":
      return { screen: "approvals" };
    case "agent_connected":
      return ids.agentId !== undefined
        ? { screen: "agent", agentId: ids.agentId }
        : { screen: "activity" };
    case "security_event":
      return ids.agentId !== undefined
        ? { screen: "agent", agentId: ids.agentId }
        : { screen: "settings" };
    case "transaction_executed":
    case "transaction_confirmed":
    case "transaction_failed":
    case "incoming_payment":
    case "onramp_completed":
      return { screen: "activity" };
  }
}

/** Build (and validate) the push data for an event. Throws on anything malformed. */
export function buildPushData(
  type: NotificationEvent,
  ids: PushIds,
  scheme = DEFAULT_DEEP_LINK_SCHEME,
): PushData {
  const data: Record<string, string> = {
    v: "1",
    type,
    url: pushDeepLink(pushRouteFor(type, ids), scheme),
  };
  const keys = ["approvalId", "requestId", "agentId", "orderId", "transferId"] as const;
  for (const key of keys) {
    const value = ids[key];
    if (value !== undefined) data[key] = value;
  }
  return PushDataSchema.parse(data);
}

/**
 * Parse a received push `data` into a validated payload and the route to open. Returns
 * null for anything that is not a well-formed ZyroPay push (the app then ignores it).
 */
export function parsePushData(
  data: unknown,
  scheme = DEFAULT_DEEP_LINK_SCHEME,
): { readonly data: PushData; readonly route: PushRoute } | null {
  const parsed = PushDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const route = parsePushDeepLink(parsed.data.url, scheme);
  if (route === null) return null;
  // The link must agree with the ids it claims to be about.
  if (route.screen === "approval" && route.approvalId !== parsed.data.approvalId) return null;
  if (route.screen === "agent" && route.agentId !== parsed.data.agentId) return null;
  return { data: parsed.data, route };
}
