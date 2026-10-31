/*
 * Structured JSON logs with secret redaction (SECURITY.md C13).
 * Keys that look like credentials are replaced, and string values that look like bearer
 * tokens, stamps, keys or serialized transactions are masked, at any depth.
 */

const SECRET_KEY_RE =
  /(authorization|token|secret|password|private|apikey|api_key|stamp|signature|cookie|unsigned|signed|seed|mnemonic|encrypted|refresh|access)/i;
const SECRET_VALUE_RES: readonly RegExp[] = [
  /Bearer\s+\S+/gi,
  /zp_(at|rt)_[A-Za-z0-9_-]+/g,
  /\b[0-9a-f]{64,}\b/gi, // hex keys, hashes, raw txs
  /\b[A-Za-z0-9+/]{120,}={0,2}/g, // long base64 blobs (transactions, stamps)
  // Provider keys inside URLs (Helius ?api-key=, Alchemy /v2/<key>, Blockfrost project ids).
  /(?<=[?&](?:api[-_]?key|apikey|key|token|access_token|project_id)=)[^&#\s"']+/gi,
  /(?<=\.alchemy\.com\/v2\/)[^/?#\s"']+/gi,
];

export function redact(value: unknown, depth = 0, keysOnly = false): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    if (keysOnly) return value;
    let out = value;
    for (const re of SECRET_VALUE_RES) out = out.replace(re, "[redacted]");
    return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, keysOnly));
  if (value instanceof Error)
    return { name: value.name, message: redact(value.message, depth + 1, keysOnly) };
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1, keysOnly);
    }
    return out;
  }
  return value;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => {
    console.log(l);
  },
): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>) => {
    sink(
      JSON.stringify(redact({ level, event, ts: new Date().toISOString(), ...base, ...fields })),
    );
  };
  return {
    info: (e, f) => {
      write("info", e, f);
    },
    warn: (e, f) => {
      write("warn", e, f);
    },
    error: (e, f) => {
      write("error", e, f);
    },
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
