import { api, ApiErrorBodySchema, buildPath } from "@zyropay/shared";
import type { EndpointBody, EndpointQuery, EndpointResponse, ErrorCode } from "@zyropay/shared";
import type { z } from "zod";

/**
 * Typed client for the API's `/internal/v1/*` endpoints, driven entirely by the shared
 * contracts in `@zyropay/shared` (`api.internal*`). Requests are validated before they
 * leave, responses are validated before anyone uses them, and every failure is mapped to
 * the closed error-code set. This is the ONLY way the MCP worker talks to ZyroPay.
 */

export type InternalEndpoint = Extract<keyof typeof api, `internal${string}`>;

export interface ApiFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly status: number;
  /** What the agent should do next (ZyroPay's own text). Default: by tool and code (handler). */
  readonly nextStep?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

export interface InternalApiOptions {
  /** Service binding (production) or global fetch bound to API_INTERNAL_URL (dev/tests). */
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly baseUrl: string;
  readonly serviceToken: string;
  /** Overrides every endpoint's timeout (tests). Default: ENDPOINT_TIMEOUT_MS, else 10 s. */
  readonly timeoutMs?: number;
}

interface CallArgs<N extends InternalEndpoint> {
  params?: Record<string, string>;
  query?: EndpointQuery<N>;
  body?: EndpointBody<N>;
  idempotencyKey?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Endpoints whose realistic latency is close to the 10 s default. The client never retries
 * (a timeout is returned as UPSTREAM_UNAVAILABLE). MCP clients typically give a tool call
 * 60 s (the MCP SDK default); every tool stays well under it (call chains: tools.ts).
 *  - internalCreateTransactionRequest: send / swap / pay_x402. A Masumi escrow pay_x402
 *    validates the seller's signed terms, verifies its registry identity on chain
 *    (Blockfrost: asset record, then holders + mint tx), reads protocol parameters, and
 *    builds the lock transaction (payer UTxOs) inside a DB transaction: typically 2-5 s,
 *    and one slow Blockfrost call (4 s timeout, one retry inside the API) can pass
 *    10 s. Idempotent by key, so a timeout here is safe to retry with the same key.
 *    pay_x402 = probe (<= 8 s) + this (<= 25 s) = at most ~33 s.
 *  - internalFindMasumiAgents: a cold registry scan reads up to 100 entries from
 *    Blockfrost (8 at a time) plus holders of the matches: a few seconds before the cache is warm.
 *  - internalVerifyMasumiAgent: asset record, then holders + mint tx (two sequential hops).
 */
const ENDPOINT_TIMEOUT_MS: Partial<Record<InternalEndpoint, number>> = {
  internalCreateTransactionRequest: 25_000,
  internalFindMasumiAgents: 20_000,
  internalVerifyMasumiAgent: 15_000,
};

/** The timeout of one call to `name` (no option override). */
export function endpointTimeoutMs(name: InternalEndpoint): number {
  return ENDPOINT_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS;
}

function toQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export class InternalApiClient {
  readonly #options: InternalApiOptions;

  constructor(options: InternalApiOptions) {
    this.#options = options;
  }

  async call<N extends InternalEndpoint>(
    name: N,
    args: CallArgs<N> = {},
  ): Promise<ApiResult<EndpointResponse<N>>> {
    const contract = api[name];
    const contractBody = "body" in contract ? (contract.body as z.ZodType) : undefined;
    const contractQuery = "query" in contract ? (contract.query as z.ZodType) : undefined;

    let path: string;
    try {
      path = buildPath(contract.path, args.params);
    } catch (error) {
      return failure("BAD_REQUEST", String(error), 400);
    }

    let body: string | undefined;
    if (contractBody) {
      const parsed = contractBody.safeParse(args.body);
      if (!parsed.success)
        return failure("VALIDATION_FAILED", "request does not match contract", 422);
      body = JSON.stringify(parsed.data);
    }
    let query = "";
    if (contractQuery) {
      const parsed = contractQuery.safeParse(args.query ?? {});
      if (!parsed.success)
        return failure("VALIDATION_FAILED", "query does not match contract", 422);
      query = toQueryString(parsed.data as Record<string, unknown>);
    }

    const headers = new Headers({
      Authorization: `Bearer ${this.#options.serviceToken}`,
      Accept: "application/json",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    // Only idempotent contracts carry the field (always `true` when present).
    if ("idempotent" in contract) {
      if (!args.idempotencyKey) return failure("BAD_REQUEST", "idempotency key required", 400);
      headers.set("Idempotency-Key", args.idempotencyKey);
    }

    const url = new URL(path + query, this.#options.baseUrl);
    const timeoutMs = this.#options.timeoutMs ?? endpointTimeoutMs(name);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.#options.fetcher(
        new Request(url, {
          method: contract.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal,
          redirect: "manual",
        }),
      );
    } catch {
      return signal.aborted ? timedOut(timeoutMs) : unreachable();
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      if (signal.aborted) return timedOut(timeoutMs);
      return failure("UPSTREAM_UNAVAILABLE", "ZyroPay API returned a non-JSON response", 502);
    }

    if (!response.ok) {
      const parsedError = ApiErrorBodySchema.safeParse(json);
      if (parsedError.success) {
        return failure(
          parsedError.data.error.code,
          parsedError.data.error.message,
          response.status,
        );
      }
      return failure("UPSTREAM_UNAVAILABLE", `ZyroPay API error (${response.status})`, 502);
    }

    const parsed = (contract.response as z.ZodType).safeParse(json);
    if (!parsed.success) {
      // Fail closed: a response outside the contract is never passed on.
      return failure("UPSTREAM_UNAVAILABLE", "ZyroPay API response violated the contract", 502);
    }
    return { ok: true, data: parsed.data as EndpointResponse<N> };
  }
}

function unreachable(): { ok: false; error: ApiFailure } {
  return failure("UPSTREAM_UNAVAILABLE", "ZyroPay API unreachable", 502);
}

function timedOut(timeoutMs: number): { ok: false; error: ApiFailure } {
  return failure(
    "UPSTREAM_UNAVAILABLE",
    `ZyroPay API did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`,
    504,
  );
}

function failure(
  code: ErrorCode,
  message: string,
  status: number,
): { ok: false; error: ApiFailure } {
  return { ok: false, error: { code, message, status } };
}

/**
 * `internalGetAgentContext` "fails with FORBIDDEN if revoked/expired" (contract). Any other
 * endpoint answering FORBIDDEN is confirmed against the context endpoint before the MCP
 * worker revokes the OAuth grant.
 */
export function mayBeAgentGone(error: ApiFailure): boolean {
  return error.code === "FORBIDDEN";
}
