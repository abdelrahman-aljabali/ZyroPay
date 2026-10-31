import { ed25519 } from "@noble/curves/ed25519.js";
import type { FetchLike } from "./http";

/*
 * Test helpers: a fetch replacement that answers from recorded fixtures, so no unit test
 * touches the network. Exported (as "@zyropay/blockchain/testing") for the integrations tests.
 */

export type RpcHandler = (params: unknown) => unknown;

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export class RpcErrorReply {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data?: unknown,
  ) {}
}

export class HttpReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

/**
 * JSON-RPC fixtures keyed by method, plus REST fixtures keyed by a URL substring. A handler
 * may return an `RpcErrorReply` (JSON-RPC error) or an `HttpReply` (HTTP status/body). An
 * array of handlers is consumed in order (last one repeats).
 */
export function fixtureFetch(fixtures: {
  rpc?: Record<string, unknown>;
  rest?: Record<string, unknown>;
}): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();
  const next = (key: string, value: unknown, arg: unknown): unknown => {
    let handler = value;
    if (Array.isArray(value)) {
      const i = counters.get(key) ?? 0;
      counters.set(key, i + 1);
      handler = value[Math.min(i, value.length - 1)];
    }
    return typeof handler === "function" ? (handler as RpcHandler)(arg) : handler;
  };
  const toResponse = (reply: unknown, id: unknown, rpc: boolean): Response => {
    if (reply instanceof HttpReply) {
      return new Response(
        typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: reply.headers,
        },
      );
    }
    if (!rpc) return new Response(JSON.stringify(reply), { status: 200 });
    if (reply instanceof RpcErrorReply) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: reply.code, message: reply.message, data: reply.data },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: reply }), { status: 200 });
  };
  const fn = (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h !== undefined && !(h instanceof Headers) && !Array.isArray(h)) Object.assign(headers, h);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const method =
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      typeof body.method === "string"
        ? body.method
        : (init?.method ?? "GET");
    calls.push({ url, method, body, headers });
    if (typeof body === "object" && body !== null && "jsonrpc" in body) {
      const rpcBody = body as unknown as { id: unknown; method: string; params: unknown };
      const fixture = fixtures.rpc?.[rpcBody.method];
      if (fixture === undefined) {
        return Promise.reject(new Error(`no fixture for RPC method ${rpcBody.method}`));
      }
      return Promise.resolve(
        toResponse(next(rpcBody.method, fixture, rpcBody.params), rpcBody.id, true),
      );
    }
    for (const [pattern, fixture] of Object.entries(fixtures.rest ?? {})) {
      if (url.includes(pattern))
        return Promise.resolve(toResponse(next(pattern, fixture, { url, body }), null, false));
    }
    return Promise.reject(new Error(`no fixture for ${init?.method ?? "GET"} ${url}`));
  };
  return Object.assign(fn, { calls });
}

export const noSleep = (): Promise<void> => Promise.resolve();

export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// --- Cardano (Blockfrost REST fixtures + a test-only Ed25519 signer) --------------------

/** Mainnet protocol parameters of epoch 662, cost models omitted. */
export const CARDANO_TEST_PARAMS = {
  min_fee_a: 44,
  min_fee_b: 155381,
  max_tx_size: 16384,
  max_val_size: "5000",
  coins_per_utxo_size: "4310",
} as const;

/**
 * Blockfrost REST fixtures for `fixtureFetch({ rest })`. Keys are URL substrings, matched
 * in insertion order; list replies are wrapped in functions (arrays mean reply sequences).
 */
export function blockfrostRest(input: {
  networkMagic: number;
  utxos: readonly unknown[];
  tip: { slot: number; height: number; time: number };
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.extra ?? {}),
    "/genesis": { network_magic: input.networkMagic, slot_length: 1 },
    "/epochs/latest/parameters": CARDANO_TEST_PARAMS,
    "/blocks/latest": input.tip,
    "/utxos?count=100&page=1": () => input.utxos,
  };
}

/** TEST ONLY: Ed25519 public key / signature for fixture keys (never real funds). */
export function testEd25519PublicKey(secret: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secret);
}
export function testEd25519Sign(secret: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secret);
}
