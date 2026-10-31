/*
 * Minimal CBOR (RFC 8949) codec for Cardano transactions. Pure TypeScript, no runtime
 * dependencies, so it bundles for Cloudflare Workers without nodejs_compat.
 *
 * Encoding is deterministic: shortest-form heads, definite lengths, map keys sorted in
 * RFC 7049 canonical order (shorter encoding first, then bytewise).
 *
 * Decoding records the byte span of every item, because a Cardano transaction id is the
 * blake2b-256 of the body's ORIGINAL bytes (never of a re-encoding). `strict` mode (used
 * on everything ZyroPay signs) refuses indefinite lengths, non-shortest heads, duplicate
 * map keys, floats and undefined: a body that would re-encode differently is rejected.
 */

export type Cbor =
  | { readonly t: "uint"; readonly v: bigint }
  | { readonly t: "nint"; readonly v: bigint }
  | { readonly t: "bytes"; readonly v: Uint8Array }
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "array"; readonly v: readonly Cbor[] }
  | { readonly t: "map"; readonly v: ReadonlyArray<readonly [Cbor, Cbor]> }
  | { readonly t: "tag"; readonly tag: bigint; readonly v: Cbor }
  | { readonly t: "simple"; readonly v: boolean | null };

/** A decoded item plus where it sat in the input. */
export interface Decoded {
  readonly value: Cbor;
  readonly start: number;
  readonly end: number;
  /** Spans of children (array items, map key/value pairs, tag content). */
  readonly items: readonly Decoded[];
}

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

// --- constructors ------------------------------------------------------------------

export const uint = (v: bigint | number): Cbor => {
  const n = BigInt(v);
  if (n < 0n) throw new CborError("uint must be non-negative");
  return { t: "uint", v: n };
};
/** Any integer: major type 0 when >= 0, else major type 1 (argument = -1 - n). */
export const int = (v: bigint | number): Cbor => {
  const n = BigInt(v);
  return n >= 0n ? { t: "uint", v: n } : { t: "nint", v: -1n - n };
};
export const bytes = (v: Uint8Array): Cbor => ({ t: "bytes", v });
export const array = (v: readonly Cbor[]): Cbor => ({ t: "array", v });
export const map = (v: ReadonlyArray<readonly [Cbor, Cbor]>): Cbor => ({ t: "map", v });
export const tag = (t: bigint | number, v: Cbor): Cbor => ({ t: "tag", tag: BigInt(t), v });
export const bool = (v: boolean): Cbor => ({ t: "simple", v });
export const nil: Cbor = { t: "simple", v: null };

// --- encoder -------------------------------------------------------------------------

const MAX_U64 = (1n << 64n) - 1n;

function head(major: number, value: bigint, out: number[]): void {
  if (value < 0n || value > MAX_U64) throw new CborError("integer out of range");
  const m = major << 5;
  if (value < 24n) {
    out.push(m | Number(value));
  } else if (value <= 0xffn) {
    out.push(m | 24, Number(value));
  } else if (value <= 0xffffn) {
    out.push(m | 25, Number(value >> 8n), Number(value & 0xffn));
  } else if (value <= 0xffffffffn) {
    out.push(m | 26);
    for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((value >> s) & 0xffn));
  } else {
    out.push(m | 27);
    for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((value >> s) & 0xffn));
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function write(value: Cbor, out: number[]): void {
  switch (value.t) {
    case "uint":
      head(0, value.v, out);
      return;
    case "nint":
      head(1, value.v, out);
      return;
    case "bytes":
      head(2, BigInt(value.v.length), out);
      for (const b of value.v) out.push(b);
      return;
    case "text": {
      const encoded = new TextEncoder().encode(value.v);
      head(3, BigInt(encoded.length), out);
      for (const b of encoded) out.push(b);
      return;
    }
    case "array":
      head(4, BigInt(value.v.length), out);
      for (const item of value.v) write(item, out);
      return;
    case "map": {
      const entries = value.v.map(([k, v]) => ({ key: encodeCbor(k), value: v }));
      entries.sort((a, b) => compareBytes(a.key, b.key));
      for (let i = 1; i < entries.length; i++) {
        if (
          compareBytes(
            entries[i - 1]?.key ?? new Uint8Array(),
            entries[i]?.key ?? new Uint8Array(),
          ) === 0
        ) {
          throw new CborError("duplicate map key");
        }
      }
      head(5, BigInt(entries.length), out);
      for (const e of entries) {
        for (const b of e.key) out.push(b);
        write(e.value, out);
      }
      return;
    }
    case "tag":
      head(6, value.tag, out);
      write(value.v, out);
      return;
    case "simple":
      out.push(value.v === null ? 0xf6 : value.v ? 0xf5 : 0xf4);
      return;
  }
}

export function encodeCbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}

// --- decoder -------------------------------------------------------------------------

const MAX_DEPTH = 32;
const MAX_ITEMS = 100_000;

class Reader {
  pos = 0;
  items = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly strict: boolean,
  ) {}

  byte(): number {
    const b = this.buf[this.pos];
    if (b === undefined) throw new CborError("unexpected end of input");
    this.pos++;
    return b;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new CborError("unexpected end of input");
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Returns the argument, or null for an indefinite length (additional info 31). */
  argument(info: number): bigint | null {
    if (info < 24) return BigInt(info);
    if (info === 31) return null;
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0) throw new CborError("reserved additional information");
    let v = 0n;
    for (const b of this.take(width)) v = (v << 8n) | BigInt(b);
    if (this.strict) {
      const minimal =
        (width === 1 && v >= 24n) ||
        (width === 2 && v > 0xffn) ||
        (width === 4 && v > 0xffffn) ||
        (width === 8 && v > 0xffffffffn);
      if (!minimal) throw new CborError("non-shortest integer encoding");
    }
    return v;
  }

  length(info: number): number | null {
    const arg = this.argument(info);
    if (arg === null) {
      if (this.strict) throw new CborError("indefinite length in strict mode");
      return null;
    }
    if (arg > BigInt(this.buf.length)) throw new CborError("length exceeds input");
    return Number(arg);
  }

  isBreak(): boolean {
    if (this.buf[this.pos] === 0xff) {
      this.pos++;
      return true;
    }
    return false;
  }

  item(depth: number): Decoded {
    if (depth > MAX_DEPTH) throw new CborError("nesting too deep");
    if (++this.items > MAX_ITEMS) throw new CborError("too many items");
    const start = this.pos;
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;
    const done = (value: Cbor, items: Decoded[] = []): Decoded => ({
      value,
      start,
      end: this.pos,
      items,
    });
    switch (major) {
      case 0:
      case 1: {
        const v = this.argument(info);
        if (v === null) throw new CborError("indefinite integer");
        return done(major === 0 ? { t: "uint", v } : { t: "nint", v });
      }
      case 2:
      case 3: {
        const len = this.length(info);
        let data: Uint8Array;
        if (len === null) {
          const chunks: Uint8Array[] = [];
          while (!this.isBreak()) {
            const chunk = this.item(depth + 1).value;
            if (chunk.t !== (major === 2 ? "bytes" : "text")) {
              throw new CborError("bad indefinite string chunk");
            }
            chunks.push(chunk.t === "bytes" ? chunk.v : new TextEncoder().encode(chunk.v));
          }
          data = Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
        } else {
          data = this.take(len);
        }
        if (major === 2) return done({ t: "bytes", v: data });
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          throw new CborError("invalid UTF-8 text");
        }
        return done({ t: "text", v: text });
      }
      case 4: {
        const len = this.length(info);
        const items: Decoded[] = [];
        if (len === null) {
          while (!this.isBreak()) items.push(this.item(depth + 1));
        } else {
          for (let i = 0; i < len; i++) items.push(this.item(depth + 1));
        }
        return done({ t: "array", v: items.map((i) => i.value) }, items);
      }
      case 5: {
        const len = this.length(info);
        const items: Decoded[] = [];
        const pairs: Array<readonly [Cbor, Cbor]> = [];
        const seen = new Set<string>();
        const add = () => {
          const k = this.item(depth + 1);
          const v = this.item(depth + 1);
          if (this.strict) {
            const key = Array.from(this.buf.slice(k.start, k.end)).join(",");
            if (seen.has(key)) throw new CborError("duplicate map key");
            seen.add(key);
          }
          items.push(k, v);
          pairs.push([k.value, v.value]);
        };
        if (len === null) {
          while (!this.isBreak()) add();
        } else {
          for (let i = 0; i < len; i++) add();
        }
        return done({ t: "map", v: pairs }, items);
      }
      case 6: {
        const t = this.argument(info);
        if (t === null) throw new CborError("indefinite tag");
        const inner = this.item(depth + 1);
        return done({ t: "tag", tag: t, v: inner.value }, [inner]);
      }
      default: {
        if (info === 20) return done({ t: "simple", v: false });
        if (info === 21) return done({ t: "simple", v: true });
        if (info === 22) return done({ t: "simple", v: null });
        throw new CborError("unsupported simple value or float");
      }
    }
  }
}

/** Decode exactly one CBOR item spanning the whole input. Throws CborError. */
export function decodeCbor(input: Uint8Array, options: { strict?: boolean } = {}): Decoded {
  const reader = new Reader(input, options.strict ?? true);
  const decoded = reader.item(0);
  if (reader.pos !== input.length) throw new CborError("trailing bytes after CBOR item");
  return decoded;
}
