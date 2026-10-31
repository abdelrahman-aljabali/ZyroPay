import { ChainError } from "./errors";

/**
 * Minimal HTTP layer shared by every provider adapter. Runtime-agnostic: it only uses the
 * global `fetch`, `AbortController` and `setTimeout`, which exist on Cloudflare Workers,
 * Node >= 18 and React Native. Everything is injectable for tests.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Defaults to the global fetch. Tests inject a fixture-backed fetch. */
  readonly fetch?: FetchLike;
  /** Per-attempt timeout. Default 10 s. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt for 429 / 5xx / network errors. Default 2. */
  readonly maxRetries?: number;
  /** Base backoff; doubles per retry, capped by `maxBackoffMs`. Default 250 ms. */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injectable sleep (tests use a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedHttpOptions {
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function resolveHttpOptions(options: HttpOptions = {}): ResolvedHttpOptions {
  return {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRetries: options.maxRetries ?? 2,
    backoffMs: options.backoffMs ?? 250,
    maxBackoffMs: options.maxBackoffMs ?? 4_000,
    sleep: options.sleep ?? defaultSleep,
  };
}

/**
 * JSON.parse that keeps integers too large for a double exact by turning them into strings.
 * Solana RPC returns u64 lamports and slots as bare JSON numbers; a balance above 2^53
 * lamports (~9M SOL) would otherwise be silently rounded. Callers read numeric fields with
 * `toBigInt`, which accepts both forms.
 */
export function parseJsonLossless(text: string): unknown {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text.charAt(i + 1);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9eE.+-]/.test(text.charAt(j))) j++;
      const token = text.slice(i, j);
      if (/^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += `"${token}"`;
      } else {
        out += token;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out) as unknown;
}

/** Read an integer field that may be a JSON number, a decimal string or a 0x-hex string. */
export function toBigInt(value: unknown, field = "value"): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: unsafe integer from provider`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|-?\d+)$/.test(value)) return BigInt(value);
  throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: expected an integer from provider`);
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return null;
}

export interface HttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** Raw request body sent as-is (e.g. Cardano `application/cbor`); excludes `body`. */
  readonly rawBody?: { readonly bytes: Uint8Array; readonly contentType: string };
  /** Label used in error messages (never includes the URL, which may embed an API key). */
  readonly label: string;
}

/**
 * Fetch JSON with timeout, retry with exponential backoff on 429/5xx/network errors, and
 * error mapping to shared error codes. Never puts the URL in error messages: provider URLs
 * carry API keys (Helius, Alchemy).
 */
export async function requestJson(http: ResolvedHttpOptions, req: HttpRequest): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, http.timeoutMs);
    let response: Response;
    try {
      const headers: Record<string, string> = { accept: "application/json", ...req.headers };
      const init: RequestInit = {
        method:
          req.method ?? (req.body === undefined && req.rawBody === undefined ? "GET" : "POST"),
        headers,
        signal: controller.signal,
      };
      if (req.rawBody !== undefined) {
        headers["content-type"] = req.rawBody.contentType;
        init.body = new Uint8Array(req.rawBody.bytes); // copy: BodyInit needs an ArrayBuffer view
      } else if (req.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body);
      }
      response = await http.fetch(req.url, init);
    } catch (error) {
      clearTimeout(timer);
      if (attempt < http.maxRetries) {
        await http.sleep(Math.min(http.backoffMs * 2 ** attempt, http.maxBackoffMs));
        attempt++;
        continue;
      }
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${req.label}: network error or timeout`, {
        retryable: true,
        cause: error,
      });
    }
    clearTimeout(timer);

    if (response.status === 429 || response.status >= 500) {
      if (attempt < http.maxRetries) {
        const wait =
          retryAfterMs(response) ?? Math.min(http.backoffMs * 2 ** attempt, http.maxBackoffMs);
        await http.sleep(wait);
        attempt++;
        continue;
      }
      throw new ChainError(
        response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
        `${req.label}: HTTP ${response.status}`,
        { retryable: true, details: { status: response.status } },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${req.label}: HTTP ${response.status}`, {
        retryable: false,
        details: { status: response.status, body: text.slice(0, 500) },
      });
    }
    try {
      return parseJsonLossless(text);
    } catch (error) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${req.label}: invalid JSON`, { cause: error });
    }
  }
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** JSON-RPC error returned by a node. Kept distinct so broadcasters can map messages. */
export class JsonRpcError extends ChainError {
  readonly rpcCode: number;
  readonly rpcMessage: string;
  readonly rpcData: unknown;
  constructor(label: string, error: JsonRpcErrorObject) {
    super("UPSTREAM_UNAVAILABLE", `${label}: RPC error ${error.code}: ${error.message}`, {
      details: { rpcCode: error.code },
    });
    this.name = "JsonRpcError";
    this.rpcCode = error.code;
    this.rpcMessage = error.message;
    this.rpcData = error.data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JsonRpcClient {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly http: ResolvedHttpOptions,
    private readonly label: string,
  ) {}

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    this.id += 1;
    const body = await requestJson(this.http, {
      url: this.url,
      body: { jsonrpc: "2.0", id: this.id, method, params },
      label: `${this.label} ${method}`,
    });
    if (!isRecord(body)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${this.label} ${method}: malformed response`);
    }
    const error = body.error;
    if (isRecord(error)) {
      throw new JsonRpcError(`${this.label} ${method}`, {
        code: typeof error.code === "number" ? error.code : -1,
        message: typeof error.message === "string" ? error.message : "unknown error",
        data: error.data,
      });
    }
    if (!("result" in body)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${this.label} ${method}: missing result`);
    }
    return body.result as T;
  }
}

export { isRecord };
