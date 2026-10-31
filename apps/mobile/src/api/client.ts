import {
  api,
  apiExt,
  apiWallets,
  ApiErrorBodySchema,
  buildPath,
  findSecretMaterial,
  type EndpointContract,
  type ErrorCode,
} from "@zyropay/shared";
import type { z } from "zod";

/*
 * Typed REST client generated from the shared `api` contracts plus the app-facing
 * additive ones in `apiExt` (delegated signer, price history, agent activity) and
 * `apiWallets` (create, watch, rename and remove wallets).
 * Every request body/query is validated with the contract schema before it
 * leaves the device, and every response is validated with Zod before the app
 * sees it.
 */

const {
  // Not for the app: webhook and MCP-worker endpoints.
  chainWebhook: _chainWebhook,
  internalRecordAuditEvent: _internalRecordAuditEvent,
  ...appExt
} = apiExt;

export const endpoints = { ...api, ...appExt, ...apiWallets } as const;
export type Endpoints = typeof endpoints;
export type EndpointKey = keyof Endpoints;

type SchemaOf<E, K extends string> = E extends Record<K, infer S extends z.ZodType> ? S : never;
type HasField<E, K extends string> = E extends Record<K, z.ZodType> ? true : false;

export type CallParams<N extends EndpointKey> = z.infer<SchemaOf<Endpoints[N], "params">>;
export type CallQuery<N extends EndpointKey> = z.input<SchemaOf<Endpoints[N], "query">>;
export type CallBody<N extends EndpointKey> = z.input<SchemaOf<Endpoints[N], "body">>;
export type CallResponse<N extends EndpointKey> = z.infer<Endpoints[N]["response"]>;

export type CallInput<N extends EndpointKey> = (HasField<Endpoints[N], "params"> extends true
  ? { readonly params: CallParams<N> }
  : { readonly params?: undefined }) &
  (HasField<Endpoints[N], "query"> extends true
    ? { readonly query: CallQuery<N> }
    : { readonly query?: undefined }) &
  (HasField<Endpoints[N], "body"> extends true
    ? { readonly body: CallBody<N> }
    : { readonly body?: undefined }) & {
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  };

/** Error codes the client adds on top of the API's closed set. */
export type ClientErrorCode = ErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE" | "INVALID_REQUEST";

export class ApiError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number | null,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(e: unknown, code?: ClientErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export interface TransportRequest {
  readonly method: EndpointContract["method"];
  /** Path with params substituted, plus query string. */
  readonly url: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly json: unknown;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

const TIMEOUT_MS = 20_000;

/** fetch-based transport with a timeout (fail closed: a hung request becomes an error). */
export function fetchTransport(baseUrl: string): Transport {
  return async (req) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    const onAbort = () => {
      controller.abort();
    };
    req.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(`${baseUrl}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? null,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } catch (e) {
      throw new ApiError(
        "NETWORK_ERROR",
        e instanceof Error ? e.message : "Network request failed",
        null,
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  };
}

export interface ApiClientOptions {
  readonly transport: Transport;
  /** Current access token, or null when signed out. */
  readonly getAccessToken: () => string | null;
  /** Called once on 401; resolves true when a new access token is available. */
  readonly refresh?: () => Promise<boolean>;
}

function serializeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async call<N extends EndpointKey>(name: N, input: CallInput<N>): Promise<CallResponse<N>> {
    const contract: EndpointContract = endpoints[name];
    const request = this.prepare(contract, input);
    let res = await this.options.transport(this.withAuth(contract, request));
    if (res.status === 401 && contract.auth === "user" && this.options.refresh) {
      const refreshed = await this.options.refresh();
      if (refreshed) res = await this.options.transport(this.withAuth(contract, request));
    }
    if (res.status < 200 || res.status >= 300) throw toApiError(res);
    const parsed = contract.response.safeParse(res.json);
    if (!parsed.success) {
      throw new ApiError(
        "INVALID_RESPONSE",
        `Response for ${name} did not match the contract`,
        res.status,
        {
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
        },
      );
    }
    return parsed.data as CallResponse<N>;
  }

  private prepare(contract: EndpointContract, input: CallInputLoose): TransportRequest {
    const params = contract.params ? validate(contract.params, input.params, "params") : undefined;
    const query = contract.query ? validate(contract.query, input.query ?? {}, "query") : undefined;
    // ADR-003: a recovery phrase or private key never goes to the ZyroPay API. Checked on
    // the raw input (before validation could echo it in an error) and refused unsent.
    if (input.body !== undefined && findSecretMaterial(input.body) !== null)
      throw new ApiError(
        "INVALID_REQUEST",
        "Refused to send a recovery phrase or private key to ZyroPay.",
        null,
      );
    const body = contract.body ? validate(contract.body, input.body, "body") : undefined;
    const path = buildPath(contract.path, (params ?? {}) as Record<string, string>);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (contract.idempotent === true) {
      const key = input.idempotencyKey ?? idempotencyKeyFromBody(body);
      if (key === undefined)
        throw new ApiError("INVALID_REQUEST", `${contract.path} requires an idempotency key`, null);
      headers["Idempotency-Key"] = key;
    }
    return {
      method: contract.method,
      path,
      url: `${path}${serializeQuery(query as Record<string, unknown> | undefined)}`,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  private withAuth(contract: EndpointContract, request: TransportRequest): TransportRequest {
    if (contract.auth !== "user") return request;
    const token = this.options.getAccessToken();
    if (token === null) throw new ApiError("UNAUTHENTICATED", "Not signed in", 401);
    return { ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } };
  }
}

interface CallInputLoose {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

function validate(schema: z.ZodType, value: unknown, part: string): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("INVALID_REQUEST", `Invalid request ${part}`, null, {
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data;
}

function idempotencyKeyFromBody(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "idempotencyKey" in body) {
    const key = body.idempotencyKey;
    return typeof key === "string" ? key : undefined;
  }
  return undefined;
}

function toApiError(res: TransportResponse): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(res.json);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, message, res.status, details);
  }
  return new ApiError(
    res.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "BAD_REQUEST",
    `HTTP ${res.status}`,
    res.status,
  );
}

const FRIENDLY: Partial<Record<ClientErrorCode, string>> = {
  NETWORK_ERROR: "Can't reach ZyroPay. Check your connection and try again.",
  UNAUTHENTICATED: "Your session ended. Sign in again.",
  INVALID_RESPONSE: "The server sent data this app version can't verify, so it was not shown.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  REQUEST_EXPIRED: "This request expired. Nothing was signed.",
  PAYLOAD_HASH_MISMATCH: "The request changed after you reviewed it, so it was not signed.",
  VALUATION_UNAVAILABLE: "Prices are unavailable right now, so this can't be valued safely.",
  INTERNAL_ERROR: "The service had a problem. Nothing changed; try again.",
  UPSTREAM_UNAVAILABLE: "The service had a problem. Nothing changed; try again.",
  SIGNING_FAILED: "The service had a problem. Nothing changed; try again.",
  BROADCAST_FAILED: "The service had a problem. Nothing changed; try again.",
};

/** Turnkey refused because this device's sign-in session ran out (error 16, API_KEY_EXPIRED). */
const SESSION_EXPIRED = /API_KEY_EXPIRED|expired api key|Turnkey error 16\b/i;
export const SESSION_EXPIRED_MESSAGE =
  "Your sign-in on this device has expired. Sign out and sign in again with your passkey, then try again. Nothing changed.";

/** The friendly copy when `message` is Turnkey's expired-session error, else the message itself. */
export function withSessionHint(message: string): string {
  return SESSION_EXPIRED.test(message) ? SESSION_EXPIRED_MESSAGE : message;
}

/** Human copy for an error, safe to show in the UI (never echoes raw server text for 5xx). */
export function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) {
    return withSessionHint(e instanceof Error ? e.message : "Unexpected error");
  }
  return FRIENDLY[e.code] ?? e.message;
}
