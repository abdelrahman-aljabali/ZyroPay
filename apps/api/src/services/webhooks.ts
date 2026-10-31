/*
 * Chain webhooks (Helius for Solana, Alchemy Notify for EVM), ARCHITECTURE.md §2.6.
 *  1. Authenticate the raw body (Helius: shared secret in Authorization; Alchemy:
 *     HMAC-SHA256 hex of the raw body in X-Alchemy-Signature). Missing secret => refuse.
 *  2. Store under UNIQUE(provider, event_id); duplicates are acknowledged, not reprocessed.
 *  3. Process asynchronously: normalize to incoming transfers for OUR addresses in THIS
 *     mode's networks, notify, and reconcile our own broadcasts by polling RPC (a webhook
 *     never confirms a request by itself).
 */
import type { HeaderReader, JsonObject, NetworkId } from "@zyropay/shared";
import {
  isNetworkAllowedInMode,
  isValidEvmAddress,
  nativeAssetId,
  NETWORKS,
  normalizeAddress,
  tokenAssetId,
  toChecksumAddress,
} from "@zyropay/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import * as t from "../db/tables";
import type { AppDeps, Ctx } from "../deps";
import { hmacSha256Hex, timingSafeEqualString } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";
import { processOnrampEvent } from "./onramp";

export type ChainProvider = "helius" | "alchemy";

const HeliusTxSchema = z
  .object({
    signature: z.string().min(32).max(128),
    type: z.string().optional(),
    transactionError: z.unknown().optional(),
    nativeTransfers: z
      .array(
        z
          .object({
            fromUserAccount: z.string().nullable().optional(),
            toUserAccount: z.string(),
            amount: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
          })
          .loose(),
      )
      .optional(),
    tokenTransfers: z
      .array(
        z
          .object({
            fromUserAccount: z.string().nullable().optional(),
            toUserAccount: z.string(),
            mint: z.string(),
            rawTokenAmount: z
              .object({ tokenAmount: z.string().regex(/^\d+$/), decimals: z.number().int() })
              .optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
const HeliusPayloadSchema = z.array(HeliusTxSchema).max(1000);

const ALCHEMY_NETWORKS: Readonly<Record<string, NetworkId>> = {
  ETH_MAINNET: "ethereum-mainnet",
  ETH_SEPOLIA: "ethereum-sepolia",
  BASE_MAINNET: "base-mainnet",
  BASE_SEPOLIA: "base-sepolia",
};
const AlchemyPayloadSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.string(),
    event: z
      .object({
        network: z.string(),
        activity: z
          .array(
            z
              .object({
                fromAddress: z.string().optional(),
                toAddress: z.string(),
                hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
                category: z.string(),
                rawContract: z
                  .object({
                    rawValue: z.string().regex(/^0x[0-9a-fA-F]*$/),
                    address: z.string().optional(),
                  })
                  .loose(),
              })
              .loose(),
          )
          .max(1000),
      })
      .loose(),
  })
  .loose();

interface NormalizedTransfer {
  network: NetworkId;
  txHash: string;
  assetId: string;
  fromAddress: string | null;
  toAddress: string;
  amount: string;
}

async function authenticate(
  ctx: Ctx,
  provider: ChainProvider,
  rawBody: string,
  headers: HeaderReader,
): Promise<boolean> {
  const secrets = ctx.deps.config.webhookSecrets;
  if (provider === "helius") {
    const expected = secrets.helius;
    const got = headers.get("authorization");
    return expected !== null && got !== null && timingSafeEqualString(got, expected);
  }
  const key = secrets.alchemy;
  const got = headers.get("x-alchemy-signature");
  if (key === null || got === null || !/^[0-9a-fA-F]{64}$/.test(got)) return false;
  return timingSafeEqualString(got.toLowerCase(), await hmacSha256Hex(key, rawBody));
}

export async function receiveChainWebhook(
  ctx: Ctx,
  provider: ChainProvider,
  rawBody: string,
  headers: HeaderReader,
): Promise<void> {
  const { deps } = ctx;
  if (!(await authenticate(ctx, provider, rawBody, headers))) {
    await audit(ctx, {
      actorType: "webhook",
      actorId: provider,
      action: "security.webhook_signature_invalid",
      metadata: { provider },
    });
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "invalid webhook signature");
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new AppError("BAD_REQUEST", "invalid JSON");
  }
  const events: { eventId: string; eventType: string; payload: JsonObject }[] = [];
  if (provider === "helius") {
    const parsed = HeliusPayloadSchema.safeParse(json);
    if (!parsed.success) throw new AppError("BAD_REQUEST", "unexpected Helius payload");
    for (const tx of parsed.data)
      events.push({
        eventId: tx.signature,
        eventType: tx.type ?? "TRANSACTION",
        payload: tx as JsonObject,
      });
  } else {
    const parsed = AlchemyPayloadSchema.safeParse(json);
    if (!parsed.success) throw new AppError("BAD_REQUEST", "unexpected Alchemy payload");
    events.push({
      eventId: parsed.data.id,
      eventType: parsed.data.type,
      payload: parsed.data as JsonObject,
    });
  }
  for (const e of events) {
    const [row] = await deps.db
      .insert(t.webhookEvents)
      .values({
        id: deps.ids.newId(),
        provider,
        eventId: e.eventId,
        eventType: e.eventType.slice(0, 64),
        payload: e.payload,
        receivedAt: deps.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: t.webhookEvents.id });
    if (row !== undefined) await deps.queue.send({ type: "webhook", webhookEventId: row.id });
  }
}

function toAmount(v: number | string): string | null {
  if (typeof v === "string") return v.replace(/^0+(?=\d)/, "");
  return Number.isSafeInteger(v) ? String(v) : null;
}

function normalizeChainEvent(
  deps: AppDeps,
  provider: string,
  payload: JsonObject,
): NormalizedTransfer[] {
  const out: NormalizedTransfer[] = [];
  if (provider === "helius") {
    const parsed = HeliusTxSchema.safeParse(payload);
    if (
      !parsed.success ||
      (parsed.data.transactionError !== undefined && parsed.data.transactionError !== null)
    )
      return out;
    const network: NetworkId =
      deps.config.mode === "production" ? "solana-mainnet" : "solana-devnet";
    for (const n of parsed.data.nativeTransfers ?? []) {
      const amount = toAmount(n.amount);
      if (amount === null || amount === "0") continue;
      out.push({
        network,
        txHash: parsed.data.signature,
        assetId: nativeAssetId(network),
        fromAddress: n.fromUserAccount ?? null,
        toAddress: n.toUserAccount,
        amount,
      });
    }
    for (const tk of parsed.data.tokenTransfers ?? []) {
      if (tk.rawTokenAmount === undefined) continue;
      const amount = toAmount(tk.rawTokenAmount.tokenAmount);
      if (amount === null || amount === "0") continue;
      out.push({
        network,
        txHash: parsed.data.signature,
        assetId: tokenAssetId(network, tk.mint),
        fromAddress: tk.fromUserAccount ?? null,
        toAddress: tk.toUserAccount,
        amount,
      });
    }
    return out;
  }
  const parsed = AlchemyPayloadSchema.safeParse(payload);
  if (!parsed.success) return out;
  const network = ALCHEMY_NETWORKS[parsed.data.event.network];
  if (network === undefined) return out;
  for (const a of parsed.data.event.activity) {
    if (!isValidEvmAddress(a.toAddress)) continue;
    const raw = a.rawContract.rawValue === "0x" ? 0n : BigInt(a.rawContract.rawValue);
    if (raw === 0n) continue;
    let assetId: string;
    if (a.category === "external") assetId = nativeAssetId(network);
    else if (
      (a.category === "token" || a.category === "erc20") &&
      a.rawContract.address !== undefined &&
      isValidEvmAddress(a.rawContract.address)
    ) {
      assetId = tokenAssetId(network, toChecksumAddress(a.rawContract.address));
    } else continue;
    out.push({
      network,
      txHash: a.hash.toLowerCase(),
      assetId,
      fromAddress:
        a.fromAddress !== undefined && isValidEvmAddress(a.fromAddress)
          ? toChecksumAddress(a.fromAddress)
          : null,
      toAddress: normalizeAddress("evm", a.toAddress),
      amount: raw.toString(),
    });
  }
  return out;
}

/** Queue consumer: process one stored webhook event (idempotent). */
export async function processWebhookEvent(deps: AppDeps, webhookEventId: string): Promise<void> {
  const [event] = await deps.db
    .select()
    .from(t.webhookEvents)
    .where(eq(t.webhookEvents.id, webhookEventId));
  if (event === undefined || event.processedAt !== null) return;
  await deps.db
    .update(t.webhookEvents)
    .set({ attempts: event.attempts + 1 })
    .where(eq(t.webhookEvents.id, event.id));
  try {
    if (event.provider.startsWith("onramp:")) {
      await processOnrampEvent(deps, event.provider.slice("onramp:".length), event.payload);
    } else {
      await processChainTransfers(
        deps,
        event.id,
        event.provider,
        normalizeChainEvent(deps, event.provider, event.payload),
      );
    }
    await deps.db
      .update(t.webhookEvents)
      .set({ processedAt: deps.clock.now(), processingError: null })
      .where(eq(t.webhookEvents.id, event.id));
  } catch (error) {
    await deps.db
      .update(t.webhookEvents)
      .set({ processingError: "processing failed" })
      .where(eq(t.webhookEvents.id, event.id));
    throw error;
  }
}

async function processChainTransfers(
  deps: AppDeps,
  webhookEventId: string,
  provider: string,
  transfers: NormalizedTransfer[],
): Promise<void> {
  const inMode = transfers.filter((tr) => isNetworkAllowedInMode(tr.network, deps.config.mode));
  if (inMode.length === 0) return;
  const owned = await deps.db
    .select({
      address: t.walletAddresses.address,
      family: t.walletAddresses.family,
      walletId: t.walletAddresses.walletId,
      userId: t.wallets.userId,
    })
    .from(t.walletAddresses)
    .innerJoin(t.wallets, eq(t.wallets.id, t.walletAddresses.walletId))
    .where(
      and(
        inArray(t.walletAddresses.address, [...new Set(inMode.map((x) => x.toAddress))]),
        // Removed (archived) wallets are invisible: no incoming-transfer push for them.
        isNull(t.wallets.archivedAt),
      ),
    );
  for (const tr of inMode) {
    const match = owned.find(
      (o) => o.address === tr.toAddress && o.family === NETWORKS[tr.network].family,
    );
    if (match === undefined) continue;
    const [inserted] = await deps.db
      .insert(t.incomingTransfers)
      .values({
        id: deps.ids.newId(),
        userId: match.userId,
        walletId: match.walletId,
        network: tr.network,
        txHash: tr.txHash,
        assetId: tr.assetId,
        fromAddress: tr.fromAddress,
        toAddress: tr.toAddress,
        amount: tr.amount,
        provider,
        webhookEventId,
        createdAt: deps.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: t.incomingTransfers.id });
    if (inserted !== undefined && tr.fromAddress !== tr.toAddress) {
      const native = tr.assetId.endsWith(":native");
      await enqueueNotification(
        { deps, requestId: "webhook", ip: null },
        {
          userId: match.userId,
          event: "incoming_payment",
          dedupeKey: `incoming:${inserted.id}`,
          title: "Payment received",
          // No amount: push text transits Expo/APNs/FCM and shows on the lock screen.
          body: native
            ? `You received ${NETWORKS[tr.network].nativeCurrency.symbol} on ${NETWORKS[tr.network].displayName}.`
            : `You received a token transfer on ${NETWORKS[tr.network].displayName}.`,
          data: { transferId: inserted.id },
        },
      );
    }
  }
  // Reconciliation: our own broadcasts seen on chain get an immediate RPC status poll.
  const hashes = [...new Set(inMode.map((x) => x.txHash))];
  const ours = await deps.db
    .select({ requestId: t.executedTransactions.transactionRequestId })
    .from(t.executedTransactions)
    .where(
      and(
        inArray(t.executedTransactions.txHash, hashes),
        eq(t.executedTransactions.status, "pending"),
      ),
    );
  for (const o of ours) await deps.queue.send({ type: "confirm", requestId: o.requestId });
}
