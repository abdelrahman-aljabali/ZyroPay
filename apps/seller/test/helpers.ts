/*
 * Test helpers: a bech32 ENCODER (production code only decodes) to build CIP-19 test
 * addresses from fixed bytes, and a fetch stub that routes Blockfrost and facilitator URLs.
 * Nothing here touches the network.
 */
import { vi } from "vitest";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const codes = Array.from({ length: hrp.length }, (_, i) => hrp.charCodeAt(i));
  const expand = [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
  const mod = polymod([...expand, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** CIP-19 address of `type` (0-7, 14) on `networkId`, credentials filled with fixed bytes. */
export function makeAddress(type: number, networkId: 0 | 1, fill = 0x11): string {
  const cred = new Array<number>(28).fill(fill);
  const stake = new Array<number>(28).fill(0x22);
  const header = (type << 4) | networkId;
  let body: number[];
  if (type <= 3) body = [...cred, ...stake];
  else if (type <= 5) body = [...cred, 0x01, 0x02, 0x03];
  else body = cred;
  const hrp =
    type === 14
      ? networkId === 1
        ? "stake"
        : "stake_test"
      : networkId === 1
        ? "addr"
        : "addr_test";
  return bech32Encode(hrp, Uint8Array.from([header, ...body]));
}

/** Testnet base address, key payment credential (0x11..), key stake credential (0x22..). */
export const TEST_BASE_ADDRESS = makeAddress(0, 0);
/** Its reward address. */
export const TEST_STAKE_ADDRESS = makeAddress(14, 0, 0x22);
/** Seller payTo used in tests: testnet enterprise address, key credential (0x33..). */
export const TEST_PAY_TO = makeAddress(6, 0, 0x33);
/** Shaped like a Blockfrost id; NOT a real key. */
export const TEST_PROJECT_ID = "preprodTESTONLYnotarealkey000000";

export const FACILITATOR = "https://facilitator.test";
export const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";

/** The hosted preprod facilitator's GET /supported body, as observed on 2026-10-30. */
export const SUPPORTED_FIXTURE = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: "cardano:preprod",
      extra: {
        assetTransferMethods: ["default", "masumi", "script"],
        areFeesSponsored: false,
        l1Confirmations: { minimum: 0, maximum: 20 },
      },
    },
  ],
  extensions: [],
  signers: { "cardano:*": [] },
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replace global fetch; unmatched URLs fail the test loudly. Returns the call log. */
export function stubFetch(routes: Record<string, Route>) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      url: url.href,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const key = Object.keys(routes)
      .filter((k) => url.href.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unexpected fetch in test: ${url.href}`);
    return routes[key]!(url, init);
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

export function decodeHeader(value: string | null): any {
  if (value === null) throw new Error("header missing");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
