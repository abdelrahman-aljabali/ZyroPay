import {
  api,
  X402_RECEIPT_HEADER,
  X402_RECEIPT_MAX_HEADER_BYTES,
  X402ResourceResponseSchema,
} from "@zyropay/shared";
import type {
  EndpointBody,
  EndpointResponse,
  McpToolOutput,
  TransactionRequestResult,
  X402ResourceResponse,
} from "@zyropay/shared";
import { z } from "zod";
import type { ApiResult } from "../api/client";
import { sanitizeString } from "./sanitize";
import type { ToolContext } from "./tools";
import { decodeBase64Json, isPublicHttpsUrl, isRecord, X402_MAX_BODY_BYTES } from "./x402";

/**
 * Delivery of a signed x402 payment (get_approval_status). Once the user approved a pay_x402
 * request and the API signed it (`request.x402.status === "ready"`), this worker fetches the
 * payment header from the API, retries the resource with it, reports the outcome to the API
 * and returns the paid response to the agent. It never signs: the header comes from the API.
 *
 * The paid retry is hardened like the probe (public https only, no redirects, size cap), and
 * it must target exactly the URL the API bound into the request.
 *
 * Timeout: 90 s. On Cardano the facilitator settles before the resource answers (20-60 s,
 * up to ~75 s when the seller waits for a confirmation). Workers do not limit wall-clock time
 * while the client is connected; the MCP SDK's default client timeout is 60 s, though. So the
 * delivery runs under ctx.waitUntil (it keeps going for up to 30 s after the client gives up),
 * its result is parked in KV before it is reported, and the next get_approval_status call
 * hands it over. The paid response is returned to the agent once.
 *
 * Concurrency: a KV lock per request avoids two simultaneous calls delivering the same
 * payment. KV is eventually consistent, so the lock is best effort; a double delivery is
 * still safe: the API returns the same header for the same request (idempotent) and the
 * chain cannot spend the same signed transaction twice.
 *
 * Verified delivery: a successful answer's X-Delivery-Receipt header (capped) is forwarded
 * to the API together with this worker's OWN SHA-256 of the exact body bytes it read (never
 * the seller's claim). The API verifies the receipt; its verdict is returned to the agent in
 * `resource.receipt`.
 */

const X402_DELIVERY_TIMEOUT_MS = 90_000;
/** Longer than the delivery timeout plus the three API calls (10 s each). */
const LOCK_TTL_SECONDS = 150;
const RESULT_TTL_SECONDS = 15 * 60;
const MAX_PAYMENT_RESPONSE_HEADER = 8 * 1024;
const TX_ID = /^[A-Za-z0-9:._-]{1,128}$/;
/**
 * The payment header value is base64 (x402 v1 and v2). Anything else (CR/LF, spaces) is
 * refused before a Request is built: never a header injection, and never a malformed
 * header mistaken for an unreachable resource (which would ask the agent to retry).
 */
const PAYMENT_HEADER_VALUE = /^[A-Za-z0-9+/_-]+={0,2}$/;

type ReportBody = EndpointBody<"internalReportX402Delivery">;
type X402Payment = EndpointResponse<"internalGetX402Payment">["payment"];
type Output = McpToolOutput<"get_approval_status">;
type Params = { agentId: string; requestId: string };

const StoredDeliverySchema = z.object({
  report: api.internalReportX402Delivery.body,
  resource: X402ResourceResponseSchema,
});
type StoredDelivery = z.infer<typeof StoredDeliverySchema>;

/** Short-lived per-request state (lock + undelivered result). Keys are agent-scoped. */
export interface X402DeliveryStore {
  /** Best effort: false when another call is delivering this request right now. */
  lock(key: string): Promise<boolean>;
  unlock(key: string): Promise<void>;
  saveResult(key: string, result: StoredDelivery): Promise<void>;
  loadResult(key: string): Promise<StoredDelivery | null>;
  dropResult(key: string): Promise<void>;
}

function warn(event: string, requestId: string): void {
  // Ids only: never headers, payment values or resource bodies.
  console.warn(JSON.stringify({ x402Delivery: event, requestId }));
}

/** KV-backed store. Every failure degrades to "no lock / no cached result". */
export function kvDeliveryStore(kv: KVNamespace): X402DeliveryStore {
  const lockKey = (key: string) => `x402:lock:${key}`;
  const resultKey = (key: string) => `x402:result:${key}`;
  const quietly = async <T>(fallback: T, op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch {
      return fallback;
    }
  };
  return {
    lock: (key) =>
      quietly(true, async () => {
        if ((await kv.get(lockKey(key))) !== null) return false;
        await kv.put(lockKey(key), "1", { expirationTtl: LOCK_TTL_SECONDS });
        return true;
      }),
    unlock: (key) => quietly(undefined, () => kv.delete(lockKey(key))),
    saveResult: (key, result) =>
      quietly(undefined, () =>
        kv.put(resultKey(key), JSON.stringify(result), { expirationTtl: RESULT_TTL_SECONDS }),
      ),
    loadResult: (key) =>
      quietly(null, async () => {
        const raw = await kv.get(resultKey(key));
        if (raw === null) return null;
        const parsed = StoredDeliverySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      }),
    dropResult: (key) => quietly(undefined, () => kv.delete(resultKey(key))),
  };
}

// ---- the paid retry ------------------------------------------------------------------

type PaidFetch =
  | { ok: true; resource: X402ResourceResponse; report: ReportBody }
  | { ok: false; reason: "timeout" | "unreachable" };

function textOrNull(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? sanitizeString(value, max) : null;
}

/** PAYMENT-RESPONSE (v2) or X-PAYMENT-RESPONSE (v1): base64 JSON settlement receipt. */
function decodeSettlement(headers: Headers): X402ResourceResponse["settlement"] {
  const raw = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw || raw.length > MAX_PAYMENT_RESPONSE_HEADER) return null;
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(raw);
  } catch {
    return null;
  }
  if (!isRecord(decoded) || typeof decoded.success !== "boolean") return null;
  return {
    success: decoded.success,
    transaction:
      typeof decoded.transaction === "string" && TX_ID.test(decoded.transaction)
        ? decoded.transaction
        : null,
    network: textOrNull(decoded.network, 64),
    errorReason: textOrNull(decoded.errorReason, 200),
  };
}

/** `error` of a 402 answer: v2 PAYMENT-REQUIRED header, else the v1 JSON body. */
function rejectionReason(headers: Headers, text: string): string | null {
  const candidates: (() => unknown)[] = [
    () => {
      const header = headers.get("PAYMENT-REQUIRED");
      return header && header.length <= X402_MAX_BODY_BYTES ? decodeBase64Json(header) : null;
    },
    () => JSON.parse(text) as unknown,
  ];
  for (const candidate of candidates) {
    try {
      const value = candidate();
      if (isRecord(value)) {
        const reason = textOrNull(value.error, 200) ?? textOrNull(value.errorReason, 200);
        if (reason) return reason;
      }
    } catch {
      // next
    }
  }
  return null;
}

/** Reads at most `maxBytes`; stops early (truncated) on the cap or the deadline. */
async function readUpTo(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; text: string; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), text: "", truncated: false };
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted");
    signal.addEventListener(
      "abort",
      () => {
        resolve("aborted");
      },
      { once: true },
    );
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next === "aborted") {
        truncated = true;
        break;
      }
      if (next.done) break;
      const room = maxBytes - total;
      if (next.value.byteLength > room) {
        chunks.push(next.value.subarray(0, room));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    truncated = true;
  }
  if (truncated) void reader.cancel().catch(() => undefined);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: all, text: new TextDecoder().decode(all), truncated };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The receipt header verbatim, or null when absent or over the cap (never parsed here). */
function receiptHeader(headers: Headers): string | null {
  const raw = headers.get(X402_RECEIPT_HEADER)?.trim() ?? "";
  return raw !== "" && raw.length <= X402_RECEIPT_MAX_HEADER_BYTES ? raw : null;
}

function isJsonType(contentType: string | null): boolean {
  return contentType !== null && /^(application|text)\/([\w.-]+\+)?json\b/i.test(contentType);
}

function isTextual(contentType: string | null): boolean {
  if (contentType === null) return true;
  return (
    /^text\//i.test(contentType) ||
    isJsonType(contentType) ||
    /^application\/([\w.-]+\+)?(xml|javascript|yaml|x-yaml|csv|x-www-form-urlencoded)\b/i.test(
      contentType,
    )
  );
}

function parseBody(text: string, contentType: string | null, truncated: boolean): unknown {
  if (text.length === 0) return null;
  if (isJsonType(contentType) && !truncated) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // fall back to text
    }
  }
  return text;
}

async function fetchPaidResource(
  payment: X402Payment,
  fetchImpl: (request: Request) => Promise<Response> = (r) => fetch(r),
  timeoutMs = X402_DELIVERY_TIMEOUT_MS,
): Promise<PaidFetch> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(
      new Request(payment.resourceUrl, {
        method: payment.method,
        headers: {
          Accept: "application/json, text/*;q=0.9, */*;q=0.5",
          [payment.header.name]: payment.header.value,
        },
        redirect: "manual",
        signal,
      }),
    );
  } catch {
    return { ok: false, reason: signal.aborted ? "timeout" : "unreachable" };
  }
  const httpStatus = response.status;
  if (httpStatus < 100 || httpStatus > 599) {
    await response.body?.cancel();
    return { ok: false, reason: "unreachable" };
  }
  const contentType = textOrNull(response.headers.get("Content-Type"), 128);
  const settlement = decodeSettlement(response.headers);

  let body: unknown = null;
  let truncated = false;
  let text = "";
  /** SHA-256 of the complete body, when it was read in full. */
  let contentSha256: string | null = null;
  const redirect = httpStatus >= 300 && httpStatus < 400;
  if (redirect || !isTextual(contentType)) {
    // A redirect is never followed; binary content is not shown to the model.
    await response.body?.cancel().catch(() => undefined);
  } else {
    const read = await readUpTo(response, X402_MAX_BODY_BYTES, signal);
    text = read.text;
    truncated = read.truncated;
    body = parseBody(text, contentType, truncated);
    if (!truncated) contentSha256 = await sha256Hex(read.bytes);
  }

  let errorReason = settlement?.errorReason ?? null;
  let settled = settlement?.success ?? null;
  if (redirect) {
    errorReason ??= `redirect (HTTP ${httpStatus}) not followed`;
  } else if (httpStatus === 402) {
    settled = settlement?.success ?? false;
    errorReason ??= rejectionReason(response.headers, text) ?? "payment rejected (HTTP 402)";
  } else if (httpStatus >= 400) {
    errorReason ??= `resource answered HTTP ${httpStatus}`;
  }

  const report: ReportBody = {
    httpStatus,
    settled,
    transaction: settlement?.transaction ?? null,
    errorReason,
  };
  if (httpStatus >= 200 && httpStatus < 300)
    report.receipt = { header: receiptHeader(response.headers), contentSha256 };
  return { ok: true, resource: { httpStatus, contentType, body, truncated, settlement }, report };
}

// ---- get_approval_status ------------------------------------------------------------

function ok(data: Output): ApiResult<Output> {
  return { ok: true, data };
}

/** The resource response plus the API's verdict on its delivery receipt. */
function withVerdict(
  resource: X402ResourceResponse,
  request: TransactionRequestResult,
): X402ResourceResponse {
  const receipt = request.x402?.receipt;
  return receipt === undefined || resource.httpStatus < 200 || resource.httpStatus >= 300
    ? resource
    : { ...resource, receipt };
}

function report(ctx: ToolContext, params: Params, body: ReportBody) {
  return ctx.api.call("internalReportX402Delivery", { params, body });
}

const DELIVERY_FAILED =
  "The paid resource did not answer (timeout or network error), so nothing was delivered yet.";
const DELIVERY_RETRY =
  "Call get_approval_status again in a few seconds: ZyroPay resends the same signed payment, which cannot be charged twice.";

async function deliver(
  ctx: ToolContext,
  params: Params,
  request: TransactionRequestResult,
  boundUrl: string,
  key: string,
): Promise<ApiResult<Output>> {
  const store = ctx.x402Store;
  const release = () => store?.unlock(key) ?? Promise.resolve();

  const payment = await ctx.api.call("internalGetX402Payment", { params });
  if (!payment.ok) {
    await release();
    // Not signed after all (409): the agent keeps polling.
    return payment.error.code === "CONFLICT" ? ok({ request }) : payment;
  }
  const { payment: p } = payment.data;
  if (
    p.resourceUrl !== boundUrl ||
    !isPublicHttpsUrl(p.resourceUrl) ||
    !PAYMENT_HEADER_VALUE.test(p.header.value)
  ) {
    await release();
    warn("payment_mismatch", params.requestId);
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message:
          "The signed payment failed ZyroPay's checks (resource URL or payment header), so it was not sent to the resource.",
        status: 500,
        nextStep: "Tell the user the payment was not delivered; do not retry.",
      },
    };
  }

  const work = (async () => {
    const fetched = await fetchPaidResource(p, ctx.fetchExternal, ctx.x402TimeoutMs);
    if (!fetched.ok) return { fetched, reported: null };
    // Parked first: if the MCP client went away, the next call still gets the response.
    await store?.saveResult(key, { report: fetched.report, resource: fetched.resource });
    const reported = await report(ctx, params, fetched.report);
    return { fetched, reported };
  })();
  ctx.waitUntil?.(work);
  const { fetched, reported } = await work;

  if (!fetched.ok) {
    await release();
    warn(`retry_${fetched.reason}`, params.requestId);
    return {
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: DELIVERY_FAILED,
        status: 502,
        nextStep: DELIVERY_RETRY,
      },
    };
  }
  if (!reported?.ok) {
    // The agent paid: hand over the response anyway. The parked result stays, so the next
    // call retries the report instead of delivering again (the lock expires by itself).
    warn("report_failed", params.requestId);
    return ok({ request, resource: fetched.resource });
  }
  const cleanup = Promise.all([store?.dropResult(key), release()]);
  ctx.waitUntil?.(cleanup);
  await cleanup;
  return ok({
    request: reported.data.request,
    resource: withVerdict(fetched.resource, reported.data.request),
  });
}

/**
 * get_approval_status: the request's state, plus — for a signed pay_x402 request — the
 * paid response of the resource (`resource`), delivered here and returned once.
 */
export async function getApprovalStatus(
  ctx: ToolContext,
  requestId: string,
): Promise<ApiResult<Output>> {
  const params = { agentId: ctx.agentId, requestId };
  const current = await ctx.api.call("internalGetTransactionRequest", { params });
  if (!current.ok) return current;
  const { request } = current.data;
  const x402 = request.x402;
  // awaiting_signature (keep polling), closed / unsupported (nothing to deliver), or not x402.
  if (!x402 || (x402.status !== "ready" && x402.status !== "delivered")) return ok({ request });

  const store = ctx.x402Store;
  const key = `${ctx.agentId}:${requestId}`;
  const parked = store ? await store.loadResult(key) : null;
  if (store && parked) {
    let latest = request;
    if (x402.status === "ready") {
      const reported = await report(ctx, params, parked.report);
      if (!reported.ok) return ok({ request, resource: parked.resource });
      latest = reported.data.request;
    }
    await store.dropResult(key);
    return ok({ request: latest, resource: withVerdict(parked.resource, latest) });
  }
  if (x402.status === "delivered") return ok({ request });

  // ready: deliver, unless another call is doing it right now (the agent polls again).
  if (store && !(await store.lock(key))) return ok({ request });
  return deliver(ctx, params, request, x402.resourceUrl, key);
}
