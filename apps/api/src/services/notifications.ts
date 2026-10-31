/*
 * Push notifications (Expo via the `Notifier` port). Producers enqueue; the queue consumer
 * dispatches exactly once per dedupe key. The `data` of every push is the shared
 * `PushData` (@zyropay/shared push.ts): version, event type, opaque ids and one in-app deep
 * link. Never amounts, addresses, tokens or stamps; title/body are short generic text.
 */
import type { Notification, PushData, PushIds } from "@zyropay/shared";
import { buildPushData, NotificationEventSchema } from "@zyropay/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NotificationEvent } from "../contracts";
import * as t from "../db/tables";
import type { AppDeps, Ctx } from "../deps";

export interface PushRequest {
  readonly userId: string;
  readonly event: NotificationEvent;
  /** Stable key per logical notification, e.g. `approval:<id>`. */
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  /** Opaque ids only; the deep link is derived from the event and these ids. */
  readonly data: PushIds;
}

const PORT_KIND: Record<NotificationEvent, Notification["kind"]> = {
  approval_requested: "approval_requested",
  approval_expired: "transaction_failed",
  transaction_executed: "transaction_confirmed",
  transaction_confirmed: "transaction_confirmed",
  transaction_failed: "transaction_failed",
  incoming_payment: "transaction_confirmed",
  agent_connected: "agent_connected",
  onramp_completed: "onramp_completed",
  security_event: "transaction_failed",
};

const ID_KEYS = ["approvalId", "requestId", "agentId", "orderId", "transferId"] as const;

/** Enqueue; never throws into the caller's business flow (push is best effort). */
export async function enqueueNotification(ctx: Ctx, push: PushRequest): Promise<void> {
  const data: Record<string, string> = {};
  for (const key of ID_KEYS) {
    const value = push.data[key];
    if (value !== undefined) data[key] = value;
  }
  try {
    await ctx.deps.queue.send({
      type: "notify",
      dedupeKey: push.dedupeKey.slice(0, 200),
      userId: push.userId,
      event: push.event,
      title: push.title.slice(0, 120),
      body: push.body.slice(0, 400),
      data,
    });
  } catch (error) {
    ctx.deps.logger.warn("notification.enqueue_failed", { event: push.event, error });
  }
}

/** Queue consumer step. Idempotent through notification_dispatches. */
export async function dispatchNotification(
  deps: AppDeps,
  msg: {
    dedupeKey: string;
    userId: string;
    event: string;
    title: string;
    body: string;
    data: Record<string, string>;
  },
): Promise<void> {
  const db = deps.db;
  await db
    .insert(t.notificationDispatches)
    .values({
      dedupeKey: msg.dedupeKey,
      userId: msg.userId,
      kind: msg.event,
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(t.notificationDispatches)
    .where(eq(t.notificationDispatches.dedupeKey, msg.dedupeKey));
  if (row === undefined || row.status === "sent") return;
  if (row.attempts >= 8) {
    await db
      .update(t.notificationDispatches)
      .set({ status: "failed" })
      .where(eq(t.notificationDispatches.dedupeKey, msg.dedupeKey));
    return;
  }
  await db
    .update(t.notificationDispatches)
    .set({ attempts: row.attempts + 1 })
    .where(eq(t.notificationDispatches.dedupeKey, msg.dedupeKey));

  const devices = await db
    .select({ id: t.notificationDevices.id })
    .from(t.notificationDevices)
    .where(
      and(eq(t.notificationDevices.userId, msg.userId), isNull(t.notificationDevices.disabledAt)),
    )
    .limit(1);
  if (devices.length === 0) {
    await db
      .update(t.notificationDispatches)
      .set({ status: "sent", sentAt: deps.clock.now() })
      .where(eq(t.notificationDispatches.dedupeKey, msg.dedupeKey));
    return;
  }
  const parsedEvent = NotificationEventSchema.safeParse(msg.event);
  const event: NotificationEvent = parsedEvent.success ? parsedEvent.data : "security_event";
  await deps.notifier.notify({
    userId: msg.userId,
    notification: {
      kind: PORT_KIND[event],
      title: msg.title,
      body: msg.body,
      data: pushDataFor(event, msg.data, deps.config.deepLinkScheme),
    },
  });
  await db
    .update(t.notificationDispatches)
    .set({ status: "sent", sentAt: deps.clock.now() })
    .where(eq(t.notificationDispatches.dedupeKey, msg.dedupeKey));
}

/**
 * The push `data` for an event (shared PushData). Ids that are not UUIDs are dropped rather
 * than sent, so a malformed producer can only lose its deep link, never leak a value.
 */
function pushDataFor(
  event: NotificationEvent,
  ids: Readonly<Record<string, string>>,
  scheme: string,
): PushData {
  const clean: PushIds = Object.fromEntries(
    ID_KEYS.filter((k) => typeof ids[k] === "string").map((k) => [k, ids[k]]),
  );
  try {
    return buildPushData(event, clean, scheme);
  } catch {
    return buildPushData(event, {}, scheme);
  }
}

/** Expo push tokens of a user's active devices (for the real Expo `Notifier` adapter). */
export async function activePushTokens(deps: AppDeps, userId: string): Promise<string[]> {
  const rows = await deps.db
    .select({ token: t.notificationDevices.expoPushToken })
    .from(t.notificationDevices)
    .where(and(eq(t.notificationDevices.userId, userId), isNull(t.notificationDevices.disabledAt)));
  return rows.map((r) => r.token);
}

/** Expo said DeviceNotRegistered: stop sending to these tokens (idempotent). */
export async function deactivatePushTokens(
  deps: AppDeps,
  tokens: readonly string[],
): Promise<void> {
  if (tokens.length === 0) return;
  await deps.db
    .update(t.notificationDevices)
    .set({ disabledAt: deps.clock.now() })
    .where(
      and(
        inArray(t.notificationDevices.expoPushToken, [...tokens]),
        isNull(t.notificationDevices.disabledAt),
      ),
    );
}
