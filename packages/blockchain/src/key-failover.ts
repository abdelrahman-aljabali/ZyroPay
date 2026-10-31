import type { FetchLike } from "./http";

/**
 * API-key failover for providers that authenticate with a key in the URL (Helius).
 *
 * A pool holds an ordered list of keys (primary first). The failover fetch rewrites the key
 * of every request to a provider host to the first key that is not cooling down. When a key
 * answers 401/403 (invalid or disabled key) or 429 (rate limit, or "max usage reached" when
 * the plan's credits are spent), the key is put on a cooldown and the SAME request is
 * replayed with the next key. Requests to any other host pass through untouched.
 *
 * Scope of the cooldown: plain memory of the pool object. On Cloudflare Workers that is one
 * isolate; other isolates (and every cold start) do not see it and each rediscovers an
 * exhausted key with one failed request per key per cooldown window. That costs one extra
 * round trip, never a wrong answer, so no shared store (KV, Durable Object) is used.
 *
 * Keys never leave this module in clear: events carry the key's index, error messages and
 * `redactUrl` strip them.
 */

export type KeyFailureReason = "unauthorized" | "quota_exhausted" | "rate_limited";

export interface KeyFailoverEvent {
  readonly provider: string;
  /** 0-based position of the failing key in the configured list (never the key itself). */
  readonly keyIndex: number;
  readonly keyCount: number;
  readonly status: number;
  readonly reason: KeyFailureReason;
  readonly cooldownMs: number;
  /** True when another key is tried for the same request. */
  readonly failedOver: boolean;
}

export interface KeyPoolOptions {
  /** Label used in events (e.g. "helius"). */
  readonly provider: string;
  /** Hostnames (exact or suffix match with a leading dot) whose requests carry the key. */
  readonly hosts: readonly string[];
  /** Query parameter that carries the key. Default `api-key`. */
  readonly queryParam?: string;
  /** Cooldowns per failure kind. Defaults: unauthorized 15 min, quota 1 h, rate limit 10 s. */
  readonly cooldownMs?: Partial<Record<KeyFailureReason, number>>;
  readonly now?: () => number;
  readonly onEvent?: (event: KeyFailoverEvent) => void;
}

const DEFAULT_COOLDOWN_MS: Record<KeyFailureReason, number> = {
  unauthorized: 15 * 60_000,
  quota_exhausted: 60 * 60_000,
  rate_limited: 10_000,
};

/** Max cooldown honoured from a Retry-After header on a plain rate limit. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

const WRAPPED_BY = Symbol("zyropay.keyPool");
type WrappedFetch = FetchLike & { [WRAPPED_BY]?: ApiKeyPool };

export class ApiKeyPool {
  readonly keys: readonly string[];
  readonly provider: string;
  private readonly hosts: readonly string[];
  private readonly param: string;
  private readonly cooldown: Record<KeyFailureReason, number>;
  private readonly now: () => number;
  private readonly coolUntil: number[];
  onEvent: ((event: KeyFailoverEvent) => void) | undefined;

  constructor(keys: readonly string[], options: KeyPoolOptions) {
    const unique = [...new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0))];
    if (unique.length === 0) throw new Error(`${options.provider}: no API key configured`);
    this.keys = unique;
    this.provider = options.provider;
    this.hosts = options.hosts;
    this.param = options.queryParam ?? "api-key";
    this.cooldown = { ...DEFAULT_COOLDOWN_MS, ...options.cooldownMs };
    this.now = options.now ?? (() => Date.now());
    this.coolUntil = unique.map(() => 0);
    this.onEvent = options.onEvent;
  }

  get primary(): string {
    return this.keys[0] as string;
  }

  /** True when `url` targets one of this pool's hosts. */
  matches(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return this.hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
  }

  /**
   * Key indexes in the order to try: every key not cooling down, in configured order. When
   * all are cooling down, the one whose cooldown ends first (a single attempt), so a request
   * still has a chance instead of failing without contacting the provider.
   */
  order(): number[] {
    const t = this.now();
    const ready = this.keys.map((_, i) => i).filter((i) => (this.coolUntil[i] ?? 0) <= t);
    if (ready.length > 0) return ready;
    let best = 0;
    for (let i = 1; i < this.keys.length; i++) {
      if ((this.coolUntil[i] ?? 0) < (this.coolUntil[best] ?? 0)) best = i;
    }
    return [best];
  }

  /** Remaining cooldown per key index in ms (0 = available). For tests and health output. */
  status(): number[] {
    const t = this.now();
    return this.coolUntil.map((until) => Math.max(0, until - t));
  }

  markFailed(index: number, reason: KeyFailureReason, retryAfterMs: number | null): number {
    let ms = this.cooldown[reason];
    if (reason === "rate_limited" && retryAfterMs !== null) {
      ms = Math.min(Math.max(ms, retryAfterMs), MAX_RETRY_AFTER_MS);
    }
    this.coolUntil[index] = Math.max(this.coolUntil[index] ?? 0, this.now() + ms);
    return ms;
  }

  markHealthy(index: number): void {
    this.coolUntil[index] = 0;
  }

  /** `url` with the key at `index` in place of whatever key it carried. */
  withKey(url: URL, index: number): string {
    const next = new URL(url.toString());
    next.searchParams.set(this.param, this.keys[index] as string);
    return next.toString();
  }

  /**
   * Wrap a fetch so requests to this pool's hosts fail over between keys. Wrapping a fetch
   * this pool already wrapped returns it unchanged (no nested retries).
   */
  wrap(base: FetchLike): FetchLike {
    if ((base as WrappedFetch)[WRAPPED_BY] === this) return base;
    const wrapped: WrappedFetch = (input, init) => failoverFetch(this, base, input, init);
    wrapped[WRAPPED_BY] = this;
    return wrapped;
  }
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** Classify a response as a key failure, or null when the key is fine. */
export async function classifyKeyFailure(response: Response): Promise<KeyFailureReason | null> {
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (response.status !== 429) return null;
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    // Body unreadable: treat as a plain rate limit.
  }
  // Helius answers a spent credit plan with HTTP 429 and the plain body "max usage reached".
  return /max usage|usage limit|credits?/i.test(text) ? "quota_exhausted" : "rate_limited";
}

async function failoverFetch(
  pool: ApiKeyPool,
  base: FetchLike,
  input: string,
  init: RequestInit | undefined,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return base(input, init);
  }
  if (!pool.matches(url)) return base(input, init);

  const order = pool.order();
  let last: Response | null = null;
  for (let n = 0; n < order.length; n++) {
    const index = order[n] as number;
    const response = await base(pool.withKey(url, index), init);
    const reason = await classifyKeyFailure(response);
    if (reason === null) {
      if (response.ok) pool.markHealthy(index);
      return response;
    }
    const cooldownMs = pool.markFailed(index, reason, retryAfterMs(response));
    const failedOver = n + 1 < order.length;
    pool.onEvent?.({
      provider: pool.provider,
      keyIndex: index,
      keyCount: pool.keys.length,
      status: response.status,
      reason,
      cooldownMs,
      failedOver,
    });
    if (!failedOver) return response;
    last = response;
    // Free the failed response's body before replaying with the next key.
    await response.body?.cancel().catch(() => undefined);
  }
  /* c8 ignore next */
  return last as Response;
}

// ---------------------------------------------------------------------------------------
// Helius
// ---------------------------------------------------------------------------------------

export const HELIUS_HOSTS: readonly string[] = [".helius-rpc.com", "api.helius.xyz"];

const heliusPools = new Map<string, ApiKeyPool>();

/**
 * The process-wide (per isolate) Helius key pool for this key list. The API rebuilds its
 * dependencies per request, so the pool, and with it the cooldowns, must outlive them.
 * `onEvent` is replaced on every call so the latest request's logger receives events.
 */
export function heliusKeyPool(
  keys: readonly string[],
  options: Omit<KeyPoolOptions, "provider" | "hosts"> = {},
): ApiKeyPool {
  const id = keys.join("\n");
  let pool = heliusPools.get(id);
  if (pool === undefined) {
    if (heliusPools.size >= 8) heliusPools.clear();
    pool = new ApiKeyPool(keys, { ...options, provider: "helius", hosts: HELIUS_HOSTS });
    heliusPools.set(id, pool);
  }
  if (options.onEvent !== undefined) pool.onEvent = options.onEvent;
  return pool;
}

/** Test hook: forget every cached Helius pool. */
export function resetHeliusKeyPools(): void {
  heliusPools.clear();
}

/** Normalise a key list from env-style input: trims, drops empties and duplicates. */
export function parseKeyList(...values: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    for (const part of value.split(",")) {
      const key = part.trim();
      if (key.length > 0 && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

const KEY_PARAM_RE = /([?&](?:api[-_]?key|apikey|key|token|access_token|project_id)=)[^&#\s"']+/gi;
const ALCHEMY_PATH_RE = /(\.alchemy\.com\/v2\/)[^/?#\s"']+/gi;

/** Strip API keys from a URL (or any text containing URLs) before it is logged or shown. */
export function redactUrl(text: string): string {
  return text.replace(KEY_PARAM_RE, "$1REDACTED").replace(ALCHEMY_PATH_RE, "$1REDACTED");
}
