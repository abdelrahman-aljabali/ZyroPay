import type { HttpOptions, ResolvedHttpOptions } from "@zyropay/blockchain";
import { ChainError, isChainError, requestJson, resolveHttpOptions } from "@zyropay/blockchain";
import type { Notification, Notifier, PushData } from "@zyropay/shared";
import { parsePushDeepLink, PUSH_DATA_KEYS, PushDataSchema } from "@zyropay/shared";
import { z } from "zod";

/*
 * Expo push notifications (Notifier port), per
 *   https://docs.expo.dev/push-notifications/sending-notifications/
 *   - POST https://exp.host/--/api/v2/push/send, JSON array of at most 100 messages; the
 *     response `data` is an array of push tickets in message order; `errors` (without `data`)
 *     is a request-level failure.
 *   - POST https://exp.host/--/api/v2/push/getReceipts {ids}, at most 1000 ids; the response
 *     `data` is an object keyed by ticket id; ids without a receipt yet are omitted.
 *   - Ticket/receipt {status:"error", details:{error:"DeviceNotRegistered"}}: stop sending to
 *     that token. Check receipts ~15 minutes after sending (kept 24 h).
 *   - Enhanced push security: `Authorization: Bearer <access token>`.
 *   - Retry 429/5xx with backoff (requestJson does); a 400 (malformed request) is not retried.
 * Runtime-agnostic: fetch only.
 *
 * Privacy: push payloads transit Expo, APNs and FCM and show on lock screens, so `data` must
 * be the shared `PushData` (@zyropay/shared push.ts: version, event type, opaque ids and one
 * in-app deep link; strict, so no addresses or amounts can ride along). Anything else is sent
 * with empty `data` (the tap then just opens the app). Title/body are stripped of control
 * characters and truncated. Tokens never appear in error messages.
 */

export interface ExpoPushTicketRef {
  readonly ticketId: string;
  readonly token: string;
}

export interface ExpoNotifierConfig extends HttpOptions {
  /** Optional: Expo access token (enhanced push security). Sent as Authorization: Bearer. */
  readonly accessToken?: string;
  /** Default "https://exp.host". */
  readonly baseUrl?: string;
  /** Active Expo push tokens of a user's devices. */
  resolveTokens(userId: string): Promise<readonly string[]>;
  /** Mark tokens inactive (DeviceNotRegistered). */
  deactivateTokens(tokens: readonly string[]): Promise<void>;
  /** Called with the ok tickets of a send so the caller can check receipts later (~15 min). */
  onTickets?(tickets: readonly ExpoPushTicketRef[]): Promise<void>;
}

export interface ExpoReceiptSummary {
  readonly ok: number;
  readonly errors: number;
  readonly deactivated: number;
  readonly pending: number;
}

export interface ExpoNotifier extends Notifier {
  checkReceipts(tickets: readonly ExpoPushTicketRef[]): Promise<ExpoReceiptSummary>;
}

/** Expo push token format (`ExponentPushToken[...]`, also the newer `ExpoPushToken[...]`). */
export const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^\]]{1,256}\]$/;
/** Keys allowed in `data` (the shared PushData keys). */
export const EXPO_DATA_KEYS: ReadonlySet<string> = new Set(PUSH_DATA_KEYS);
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 1000;
const TITLE_MAX = 64;
const BODY_MAX = 178;

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: PushData | Record<string, never>;
  readonly sound: "default";
  readonly priority: "default" | "high";
}

// C0, DEL, C1 controls plus bidi overrides/isolates (spoofable text on lock screens).
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanText(value: string, max: number): string {
  const chars = Array.from(value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** Push message for one device: allowlisted data, cleaned and truncated text. */
export function toExpoPushMessage(token: string, notification: Notification): ExpoPushMessage {
  const parsed = PushDataSchema.safeParse(notification.data);
  const scheme = parsed.success
    ? /^([a-z][a-z0-9+.-]{0,31}):\/\//.exec(parsed.data.url)?.[1]
    : null;
  const data =
    parsed.success &&
    scheme !== undefined &&
    scheme !== null &&
    parsePushDeepLink(parsed.data.url, scheme) !== null
      ? parsed.data
      : {};
  return {
    to: token,
    title: cleanText(notification.title, TITLE_MAX),
    body: cleanText(notification.body, BODY_MAX),
    data,
    sound: "default",
    priority: notification.kind === "approval_requested" ? "high" : "default",
  };
}

const TicketSchema = z.union([
  z.looseObject({ status: z.literal("ok"), id: z.string().min(1) }),
  z.looseObject({
    status: z.literal("error"),
    details: z.looseObject({ error: z.string().optional() }).optional(),
  }),
]);
const SendResponseSchema = z.looseObject({ data: z.array(z.unknown()) });
const ReceiptsResponseSchema = z.looseObject({ data: z.record(z.string(), z.unknown()) });
const ReceiptSchema = z.union([
  z.looseObject({ status: z.literal("ok") }),
  z.looseObject({
    status: z.literal("error"),
    details: z.looseObject({ error: z.string().optional() }).optional(),
  }),
]);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function upstream(label: string, reason: string, retryable = true): ChainError {
  return new ChainError("UPSTREAM_UNAVAILABLE", `${label}: ${reason}`, { retryable });
}

export function createExpoNotifier(config: ExpoNotifierConfig): ExpoNotifier {
  const http: ResolvedHttpOptions = resolveHttpOptions(config);
  const baseUrl = (config.baseUrl ?? "https://exp.host").replace(/\/+$/, "");
  const headers: Record<string, string> =
    config.accessToken !== undefined && config.accessToken.length > 0
      ? { authorization: `Bearer ${config.accessToken}` }
      : {};

  /**
   * POST and parse; every request-level failure becomes UPSTREAM_UNAVAILABLE. A fresh error
   * is thrown (no cause, no body) so nothing from the request or response (tokens) leaks.
   */
  async function post(path: string, body: unknown, label: string): Promise<unknown> {
    let response: unknown;
    try {
      response = await requestJson(http, { url: `${baseUrl}${path}`, body, headers, label });
    } catch (error) {
      const status = isChainError(error) ? error.details?.status : undefined;
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
        // Malformed request / unauthorized: retrying the same request will not help.
        throw upstream(label, `HTTP ${status}`, false);
      }
      throw upstream(
        label,
        typeof status === "number" ? `HTTP ${status}` : "network error, timeout or invalid JSON",
      );
    }
    return response;
  }

  function requestLevelErrors(response: unknown, label: string): never {
    const codes =
      typeof response === "object" && response !== null && "errors" in response
        ? z.array(z.looseObject({ code: z.string().max(64) })).safeParse(response.errors)
        : null;
    const code = codes?.success === true ? codes.data.map((e) => e.code).join(",") : "";
    throw upstream(label, code.length > 0 ? `request rejected (${code})` : "unexpected response");
  }

  return {
    async notify({ userId, notification }) {
      const all = [...new Set(await config.resolveTokens(userId))];
      const tokens = all.filter((t) => EXPO_PUSH_TOKEN_PATTERN.test(t));
      let failed = all.length - tokens.length;
      let delivered = 0;
      if (tokens.length === 0) return { delivered, failed, simulated: false };

      const okTickets: ExpoPushTicketRef[] = [];
      const unregistered = new Set<string>();
      const flush = async (): Promise<void> => {
        if (unregistered.size > 0) await config.deactivateTokens([...unregistered]);
        if (okTickets.length > 0 && config.onTickets !== undefined)
          await config.onTickets(okTickets);
      };
      try {
        // Chunks are sent in order; a failing chunk throws (the queue retries the job).
        for (const part of chunk(tokens, SEND_CHUNK)) {
          const messages = part.map((t) => toExpoPushMessage(t, notification));
          const response = await post("/--/api/v2/push/send", messages, "expo push send");
          const parsed = SendResponseSchema.safeParse(response);
          if (!parsed.success) requestLevelErrors(response, "expo push send");
          if (parsed.data.data.length !== messages.length)
            throw upstream("expo push send", "ticket count does not match the messages");
          parsed.data.data.forEach((raw, i) => {
            const token = part[i] ?? "";
            const ticket = TicketSchema.safeParse(raw);
            if (ticket.success && ticket.data.status === "ok") {
              delivered++;
              okTickets.push({ ticketId: ticket.data.id, token });
              return;
            }
            failed++;
            if (
              ticket.success &&
              ticket.data.status === "error" &&
              ticket.data.details?.error === "DeviceNotRegistered"
            )
              unregistered.add(token);
          });
        }
      } catch (error) {
        // Keep what earlier chunks learned, then let the caller retry.
        await flush().catch(() => undefined);
        throw error;
      }
      await flush();
      return { delivered, failed, simulated: false };
    },

    async checkReceipts(tickets) {
      const tokenOf = new Map<string, string>();
      for (const t of tickets) tokenOf.set(t.ticketId, t.token);
      let ok = 0;
      let errors = 0;
      let deactivated = 0;
      let pending = 0;
      const unregistered = new Set<string>();
      for (const ids of chunk([...tokenOf.keys()], RECEIPT_CHUNK)) {
        const response = await post(
          "/--/api/v2/push/getReceipts",
          { ids },
          "expo push getReceipts",
        );
        const parsed = ReceiptsResponseSchema.safeParse(response);
        if (!parsed.success) requestLevelErrors(response, "expo push getReceipts");
        const receipts = parsed.data.data;
        for (const id of ids) {
          if (!Object.hasOwn(receipts, id)) {
            pending++;
            continue;
          }
          const receipt = ReceiptSchema.safeParse(receipts[id]);
          if (receipt.success && receipt.data.status === "ok") {
            ok++;
          } else if (
            receipt.success &&
            receipt.data.status === "error" &&
            receipt.data.details?.error === "DeviceNotRegistered"
          ) {
            deactivated++;
            const token = tokenOf.get(id);
            if (token !== undefined) unregistered.add(token);
          } else {
            errors++;
          }
        }
      }
      if (unregistered.size > 0) await config.deactivateTokens([...unregistered]);
      return { ok, errors, deactivated, pending };
    },
  };
}
