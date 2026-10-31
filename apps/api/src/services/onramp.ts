import type {
  FiatValue,
  HeaderReader,
  JsonObject,
  NetworkId,
  OnrampWebhookEvent,
} from "@zyropay/shared";
import { assertNetworkAllowedInMode, chainFamilyOf, parseAssetId } from "@zyropay/shared";
import { and, desc, eq } from "drizzle-orm";
import * as t from "../db/tables";
import type { AppDeps, Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";
import { addressFor, getOwnedWallet } from "./wallets";

export async function quoteOnramp(
  ctx: Ctx,
  userId: string,
  body: { fiat: FiatValue; network: NetworkId; assetId: string; walletId: string },
) {
  const { deps } = ctx;
  assertNetworkAllowedInMode(body.network, deps.config.mode);
  if (parseAssetId(body.assetId).network !== body.network)
    throw new AppError("BAD_REQUEST", "asset is on a different network");
  if (body.fiat.value.startsWith("-") || /^0(\.0*)?$/.test(body.fiat.value))
    throw new AppError("BAD_REQUEST", "amount must be positive");
  const { addresses } = await getOwnedWallet(ctx, userId, body.walletId);
  const address = addressFor(addresses, chainFamilyOf(body.network));
  if (address === undefined)
    throw new AppError("NETWORK_NOT_SUPPORTED", "wallet has no address on this network");
  let quote;
  try {
    quote = await deps.onramp.getQuote({
      fiat: body.fiat,
      network: body.network,
      assetId: body.assetId,
      walletAddress: address.address,
    });
  } catch {
    throw new AppError("UPSTREAM_UNAVAILABLE", "on-ramp quote unavailable");
  }
  if (quote.simulated && !deps.config.useMocks)
    throw new AppError("UPSTREAM_UNAVAILABLE", "simulated quote refused");
  if (quote.network !== body.network || quote.assetId !== body.assetId)
    throw new AppError("UPSTREAM_UNAVAILABLE", "on-ramp returned a different asset");
  const now = deps.clock.now();
  const inserted = await deps.db
    .insert(t.onrampOrders)
    .values({
      id: deps.ids.newId(),
      userId,
      walletId: body.walletId,
      provider: deps.onramp.id,
      quoteId: quote.quoteId,
      network: body.network,
      assetId: body.assetId,
      walletAddress: address.address,
      status: "quoted",
      simulated: quote.simulated,
      quoteExpiresAt: new Date(quote.expiresAt),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: t.onrampOrders.id });
  if (inserted.length === 0) throw new AppError("CONFLICT", "duplicate quote id from provider");
  return quote;
}

export async function createOnrampSession(
  ctx: Ctx,
  userId: string,
  body: { quoteId: string; walletId: string },
) {
  const { deps } = ctx;
  const [order] = await deps.db
    .select()
    .from(t.onrampOrders)
    .where(
      and(
        eq(t.onrampOrders.provider, deps.onramp.id),
        eq(t.onrampOrders.quoteId, body.quoteId),
        eq(t.onrampOrders.userId, userId),
        eq(t.onrampOrders.walletId, body.walletId),
      ),
    );
  if (order === undefined) throw notFound("quote");
  if (order.status !== "quoted")
    throw new AppError("CONFLICT", "a session already exists for this quote");
  if (order.quoteExpiresAt <= deps.clock.now())
    throw new AppError("REQUEST_EXPIRED", "quote expired");
  // Transak requires the end user's IP (x-user-ip): CF-Connecting-IP, set by Cloudflare's
  // edge and not spoofable by the client. Without it a real session cannot be created.
  if (ctx.ip === null && !deps.config.useMocks) {
    throw new AppError("BAD_REQUEST", "the client IP is unavailable");
  }
  let session;
  try {
    session = await deps.onramp.createSession({
      quoteId: body.quoteId,
      walletAddress: order.walletAddress,
      userId,
      ...(ctx.ip !== null ? { userIp: ctx.ip } : {}),
    });
  } catch {
    throw new AppError("UPSTREAM_UNAVAILABLE", "on-ramp session unavailable");
  }
  if (!session.url.startsWith("https://"))
    throw new AppError("UPSTREAM_UNAVAILABLE", "on-ramp returned an insecure URL");
  if (session.simulated && !deps.config.useMocks)
    throw new AppError("UPSTREAM_UNAVAILABLE", "simulated session refused");
  await deps.db
    .update(t.onrampOrders)
    .set({ status: "session_created", sessionId: session.sessionId, updatedAt: deps.clock.now() })
    .where(eq(t.onrampOrders.id, order.id));
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "onramp.session_created",
    targetType: "onramp_order",
    targetId: order.id,
  });
  return session;
}

/** Verify (adapter, raw body), store idempotently, enqueue. Signature failure => 401. */
export async function receiveOnrampWebhook(
  ctx: Ctx,
  provider: string,
  rawBody: string,
  headers: HeaderReader,
): Promise<void> {
  const { deps } = ctx;
  if (provider !== deps.onramp.id) throw notFound("provider");
  let event: OnrampWebhookEvent | null;
  try {
    event = await deps.onramp.verifyWebhook(rawBody, headers);
  } catch {
    event = null;
  }
  if (event === null) {
    await audit(ctx, {
      actorType: "webhook",
      actorId: provider,
      action: "security.webhook_signature_invalid",
      metadata: { provider },
    });
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "invalid webhook signature");
  }
  if (event.simulated && !deps.config.useMocks)
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "simulated event refused");
  const payload: JsonObject = {
    orderId: event.orderId,
    type: event.type,
    walletAddress: event.walletAddress,
    raw: event.raw,
  };
  const [row] = await deps.db
    .insert(t.webhookEvents)
    .values({
      id: deps.ids.newId(),
      provider: `onramp:${provider}`,
      eventId: event.eventId,
      eventType: event.type,
      payload,
      receivedAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .returning({ id: t.webhookEvents.id });
  if (row !== undefined) await deps.queue.send({ type: "webhook", webhookEventId: row.id });
}

const STATUS_FOR: Record<
  OnrampWebhookEvent["type"],
  "session_created" | "processing" | "completed" | "failed"
> = {
  order_created: "session_created",
  order_processing: "processing",
  order_completed: "completed",
  order_failed: "failed",
};

export async function processOnrampEvent(
  deps: AppDeps,
  provider: string,
  payload: JsonObject,
): Promise<void> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  const type = payload.type as OnrampWebhookEvent["type"];
  const walletAddress = typeof payload.walletAddress === "string" ? payload.walletAddress : null;
  if (orderId === null || !(type in STATUS_FOR)) return;
  let [order] = await deps.db
    .select()
    .from(t.onrampOrders)
    .where(and(eq(t.onrampOrders.provider, provider), eq(t.onrampOrders.orderId, orderId)));
  if (order === undefined && walletAddress !== null) {
    [order] = await deps.db
      .select()
      .from(t.onrampOrders)
      .where(
        and(
          eq(t.onrampOrders.provider, provider),
          eq(t.onrampOrders.walletAddress, walletAddress),
          eq(t.onrampOrders.status, "session_created"),
        ),
      )
      .orderBy(desc(t.onrampOrders.createdAt))
      .limit(1);
  }
  if (order === undefined) return; // unknown order: stored, nothing to update
  if (order.status === "completed" || order.status === "failed") return; // terminal
  const status = STATUS_FOR[type];
  await deps.db
    .update(t.onrampOrders)
    .set({ status, orderId, updatedAt: deps.clock.now() })
    .where(eq(t.onrampOrders.id, order.id));
  if (status === "completed") {
    await enqueueNotification(
      { deps, requestId: "webhook", ip: null },
      {
        userId: order.userId,
        event: "onramp_completed",
        dedupeKey: `onramp:${order.id}:completed`,
        title: "Purchase complete",
        body: "Your crypto purchase completed. It will appear once confirmed on chain.",
        data: { orderId: order.id },
      },
    );
  }
}
