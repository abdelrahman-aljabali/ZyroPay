/**
 * pay_x402 needs the resource's payment requirements (contract:
 * AgentTransactionRequestBodySchema.paymentRequirements, "fetched by MCP"). We fetch the
 * resource once, expect HTTP 402, and pass the requirements to the API, which validates
 * them, values them and applies the policy. Nothing from this response is shown to the
 * model. The fetch is hardened: https only, no IP literals or internal hostnames, no
 * redirects, a timeout and a size cap.
 *
 * Supported shapes:
 *  - x402 v2: `PAYMENT-REQUIRED` response header, base64-encoded JSON.
 *  - x402 v1: JSON response body `{ x402Version, accepts: [...] }`.
 */

export const X402_MAX_BODY_BYTES = 64 * 1024;
/** Whole probe (headers and body). A 402 is cheap to produce; a slow one is refused. */
const X402_PROBE_TIMEOUT_MS = 8_000;

/** `retryable`: the resource did not answer (try again later), not a malformed answer. */
export type X402ProbeResult =
  | { ok: true; requirements: Record<string, unknown> }
  | { ok: false; reason: string; retryable?: true };

const NO_ANSWER = {
  ok: false,
  reason: "the resource did not answer (unreachable, or slower than 8 s)",
  retryable: true,
} as const;

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa"];

export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  // A trailing dot ("svc.internal.") is the same host: never let it skip the checks below.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || !host.includes(".")) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // IPv4 literal or IPv6 literal: refuse (no way to rule out private ranges cheaply).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return false;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeRequirements(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.x402Version === "number" &&
    Array.isArray(value.accepts) &&
    value.accepts.length > 0 &&
    value.accepts.length <= 32
  );
}

export function decodeBase64Json(value: string): unknown {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

type CappedRead = { ok: true; text: string } | { ok: false; reason: "too_large" | "failed" };

/** The body as text; fails over the cap, or when the stream errors or times out. */
async function readCapped(response: Response, maxBytes: number): Promise<CappedRead> {
  if (!response.body) return { ok: true, text: "" };
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // The signal's timeout also aborts the body stream.
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "failed" };
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

export async function probeX402(
  resourceUrl: string,
  method: "GET" | "POST",
  fetchImpl: (request: Request) => Promise<Response> = (r) => fetch(r),
): Promise<X402ProbeResult> {
  if (!isPublicHttpsUrl(resourceUrl)) {
    return { ok: false, reason: "resourceUrl must be a public https URL" };
  }
  let response: Response;
  try {
    response = await fetchImpl(
      new Request(resourceUrl, {
        method,
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(X402_PROBE_TIMEOUT_MS),
      }),
    );
  } catch {
    return NO_ANSWER;
  }
  if (response.status !== 402) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: `resource answered HTTP ${response.status}, not 402 Payment Required`,
    };
  }

  const header = response.headers.get("PAYMENT-REQUIRED");
  if (header !== null) {
    await response.body?.cancel().catch(() => undefined);
    if (header.length > X402_MAX_BODY_BYTES)
      return { ok: false, reason: "payment requirements too large" };
    try {
      const decoded = decodeBase64Json(header);
      if (looksLikeRequirements(decoded)) return { ok: true, requirements: decoded };
    } catch {
      // fall through
    }
    return { ok: false, reason: "malformed PAYMENT-REQUIRED header" };
  }

  const read = await readCapped(response, X402_MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_large"
      ? { ok: false, reason: "payment requirements too large" }
      : NO_ANSWER;
  }
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (looksLikeRequirements(parsed)) return { ok: true, requirements: parsed };
  } catch {
    // fall through
  }
  return { ok: false, reason: "402 response did not contain x402 payment requirements" };
}

/**
 * TEST ONLY (e2e): when MCP_X402_TEST_UPSTREAM is a loopback http origin and the worker runs
 * in development mode, every x402 resource fetch (probe and paid retry) goes to that origin
 * instead, keeping path and query. The URL checks still run on the agent's original URL.
 * loadConfig refuses any other value, so this cannot redirect payments in production.
 */
export function testUpstreamFetcher(
  mode: string,
  upstream: string | undefined,
): ((request: Request) => Promise<Response>) | undefined {
  if (!upstream || mode !== "development" || !isLoopbackHttpOrigin(upstream)) return undefined;
  return (request) => {
    const original = new URL(request.url);
    const target = new URL(original.pathname + original.search, upstream);
    const rerouted = new Request(target, request);
    rerouted.headers.set("X-Test-Original-Host", original.host);
    return fetch(rerouted);
  };
}

export function isLoopbackHttpOrigin(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.pathname === "/" &&
      !url.search
    );
  } catch {
    return false;
  }
}
