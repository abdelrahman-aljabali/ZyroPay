import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { isSecretFieldName, looksLikeRecoveryPhrase } from "./secret-material";

/*
 * Scrubbing for error-monitoring events (Sentry `beforeSend` / `beforeBreadcrumb`), shared
 * by the app (native and web) and both workers. docs/MONITORING.md.
 *
 * Fail closed: anything that could carry a secret or personal data is removed, not masked
 * selectively.
 *  - request: body, headers, cookies and query string are dropped; the URL keeps only its
 *    origin and path.
 *  - user: dropped entirely (no id, e-mail, IP or username).
 *  - every key named like a credential (authorization, cookie, token, secret, password,
 *    api key, stamp, signature, session, mnemonic, seed, private key...) is replaced.
 *  - every string value is scanned: BIP-39-looking word runs (12+ wordlist words, checksum
 *    or not), JWTs, bearer tokens, ZyroPay session tokens, PEM keys, long hex (private keys,
 *    raw transactions), long base58 (Solana secret keys), long base64 blobs (stamps,
 *    bundles), provider keys in URLs, e-mail addresses and IP addresses.
 */

export const FILTERED = "[Filtered]";

const SECRET_KEY_RE =
  /(authorization|cookie|token|secret|password|passwd|private|api[-_]?key|apikey|stamp|signature|session|credential|mnemonic|seed|phrase|bundle|jwt|bearer)/i;

const WORDS = new Set<string>(english);

const VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bBearer\s+[^\s"',;]+/gi,
  /\bzp_(?:at|rt)_[A-Za-z0-9_-]+/g, // ZyroPay session tokens
  /\b(?:0x)?[0-9a-fA-F]{64,}\b/g, // private keys, raw transactions, stamps
  /\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, // base58 Solana secret keys (64 bytes => ~88 chars)
  /[A-Za-z0-9+/_-]{120,}={0,2}/g, // long base64 / base64url blobs
  /(?<=[?&#](?:api[-_]?key|apikey|key|token|access_token|project_id|code|state)=)[^&#\s"']+/gi,
  /(?<=\.alchemy\.com\/v2\/)[^/?#\s"']+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // e-mail
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IPv4
  /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, // IPv6 (full-ish forms)
];

/** Replace every run of 12+ consecutive BIP-39 English words (any checksum). */
function redactWordRuns(text: string): string {
  const tokens = text.split(/(\s+)/);
  let runStart = -1;
  let runWords = 0;
  const out = [...tokens];
  const flush = (end: number) => {
    if (runWords >= 12) {
      for (let i = runStart; i < end; i++) out[i] = "";
      out[runStart] = FILTERED;
    }
    runStart = -1;
    runWords = 0;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (/^\s+$/.test(t)) continue;
    const word = t.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
    if (WORDS.has(word)) {
      if (runStart === -1) runStart = i;
      runWords++;
    } else {
      flush(i);
    }
  }
  flush(tokens.length);
  return out.join("");
}

/** Scrub one string value. */
export function scrubString(value: string): string {
  if (looksLikeRecoveryPhrase(value)) return FILTERED;
  let out = value.length > 20_000 ? value.slice(0, 20_000) : value;
  for (const re of VALUE_PATTERNS) out = out.replace(re, FILTERED);
  return redactWordRuns(out);
}

function isSecretKey(key: string): boolean {
  return isSecretFieldName(key) || SECRET_KEY_RE.test(key);
}

/** Deep-scrub any JSON-like value (objects, arrays, strings). */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return FILTERED;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? FILTERED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Origin + path only: no query string, fragment or credentials. */
export function scrubUrl(raw: string): string {
  // String operations only: this package runs without DOM/Node globals (no URL type).
  const withoutQuery = raw.split(/[?#]/)[0] ?? "";
  return scrubString(withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1"));
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Sentry `beforeSend` for every ZyroPay runtime. Structural removals first (request
 * body/headers/cookies/query, user, server name), then a deep scrub of everything left.
 */
export function scrubTelemetryEvent<T extends object>(event: T): T {
  const e: Json = { ...(event as Json) };
  if (isObject(e.request)) {
    const req: Json = { ...e.request };
    delete req.data;
    delete req.headers;
    delete req.cookies;
    delete req.query_string;
    delete req.env;
    if (typeof req.url === "string") req.url = scrubUrl(req.url);
    e.request = req;
  }
  delete e.user;
  delete e.server_name;
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = (e.breadcrumbs as unknown[]).map((b): unknown =>
      isObject(b) ? scrubBreadcrumb(b) : b,
    );
  }
  return scrubValue(e) as T;
}

/** Sentry `beforeBreadcrumb`: URLs lose their query, request/response bodies are dropped. */
export function scrubBreadcrumb<T extends object>(breadcrumb: T): T {
  const b: Json = { ...(breadcrumb as Json) };
  if (isObject(b.data)) {
    const data: Json = { ...b.data };
    for (const key of ["url", "to", "from"]) {
      if (typeof data[key] === "string") data[key] = scrubUrl(data[key]);
    }
    delete data.body;
    delete data.request_body;
    delete data.response_body;
    delete data.input;
    b.data = data;
  }
  return scrubValue(b) as T;
}
