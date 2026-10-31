/**
 * Request size limits and rate limiting. Pure helpers (no Workers-only imports) so they
 * are unit-testable in Node.
 */

export const MAX_MCP_BODY_BYTES = 64 * 1024;
export const MAX_FORM_BODY_BYTES = 16 * 1024;

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: h });
}

/**
 * Returns the request unchanged when its body fits, a buffered copy when the size was not
 * declared, or a 413 response. Never reads more than `maxBytes + 1` bytes.
 */
export async function enforceBodyLimit(
  request: Request,
  maxBytes: number,
): Promise<Request | Response> {
  if (request.body === null || request.method === "GET" || request.method === "HEAD") {
    return request;
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      return jsonError(400, "BAD_REQUEST", "invalid Content-Length");
    }
    if (length > maxBytes)
      return jsonError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
    return request;
  }
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return jsonError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

/** Minimal shape of the Workers rate limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Returns a 429 response when the key is over its limit. Fails open only when the binding
 * itself is unavailable (it is a best-effort control; the API enforces spending limits).
 */
export async function checkRateLimit(
  limiter: RateLimiter | undefined,
  key: string,
  retryAfterSeconds = 60,
): Promise<Response | null> {
  if (!limiter) return null;
  let outcome: { success: boolean };
  try {
    outcome = await limiter.limit({ key });
  } catch {
    return null;
  }
  if (outcome.success) return null;
  return jsonError(429, "RATE_LIMITED", "too many requests", {
    "Retry-After": String(retryAfterSeconds),
  });
}

/** Origin check for /mcp (Streamable HTTP: servers MUST validate Origin when present). */
export function isOriginAllowed(
  origin: string | null,
  allowed: ReadonlySet<string>,
  allowLoopback: boolean,
): boolean {
  if (origin === null) return true; // server-to-server clients send no Origin
  if (allowed.has(origin)) return true;
  if (!allowLoopback) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}
