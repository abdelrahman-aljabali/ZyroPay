/*
 * Test support: TEST KEYS ONLY (never funded), synthetic Blockfrost data in the documented
 * response shapes (asset, asset_addresses, asset_history, asset_policy, tx_content), a fake
 * x402 facilitator and a fetch stub. Nothing touches the network or pays anything.
 */
import { Address, KeyHash, PrivateKey, VKey } from "@evolution-sdk/evolution";
import type { FacilitatorClient } from "@x402/core/server";
import { vi } from "vitest";

export const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";
/** Shaped like a Blockfrost id; NOT a real key. */
export const TEST_PROJECT_ID = "preprodTESTONLYnotarealkey000000";
export const NOW = new Date("2026-10-30T12:00:00Z");
const DAY = 86_400;

export function enterpriseAddress(seedHex: string): string {
  return Address.toBech32(
    new Address.Address({
      networkId: 0,
      paymentCredential: KeyHash.fromVKey(VKey.fromPrivateKey(PrivateKey.fromHex(seedHex))),
    }),
  );
}

/** TEST ONLY: the specialist's payTo key. */
export const SPEC_SEED = "5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec5bec";
export const SPEC_ADDRESS = enterpriseAddress(SPEC_SEED);

export const POLICY = "aa".repeat(28);
export const UNIT = `${POLICY}74657374746f6b656e`; // "testtoken"
export const OTHER_UNIT = `${POLICY}6f74686572`; // "other"
const MINT_TX = "1".repeat(64);
const holder = (n: number) => `addr_test1vz${String(n).padStart(2, "0")}${"q".repeat(51)}`;

export const ASSET = {
  asset: UNIT,
  policy_id: POLICY,
  asset_name: "74657374746f6b656e",
  fingerprint: "asset1testonlynotarealfingerprint000000",
  quantity: "1000000",
  initial_mint_tx_hash: MINT_TX,
  mint_or_burn_count: 3,
  onchain_metadata: null,
  onchain_metadata_standard: null,
  metadata: null,
};
export const HOLDERS = [
  { address: holder(2), quantity: "50000" },
  { address: holder(1), quantity: "940000" },
  { address: holder(3), quantity: "10000" },
];
export const HISTORY = [
  { tx_hash: "3".repeat(64), amount: "1000", action: "burned" },
  { tx_hash: "2".repeat(64), amount: "1000", action: "minted" },
  { tx_hash: MINT_TX, amount: "1000000", action: "minted" },
];
export const MINT = { hash: MINT_TX, block_time: Math.floor(NOW.getTime() / 1000) - DAY / 2 };
export const POLICY_ASSETS = [
  { asset: OTHER_UNIT, quantity: "5" },
  { asset: UNIT, quantity: "1000000" },
];

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type Route = (req: Request) => Response | Promise<Response>;

export function blockfrostRoutes(): Record<string, Route> {
  const u = `${BLOCKFROST}/assets/${UNIT}`;
  return {
    [u]: () => json(ASSET),
    [`${u}/addresses?count=100`]: () => json(HOLDERS),
    [`${u}/history?order=desc&count=20`]: () => json(HISTORY),
    [`${BLOCKFROST}/txs/${MINT_TX}`]: () => json(MINT),
    [`${BLOCKFROST}/assets/policy/${POLICY}?count=100`]: () => json(POLICY_ASSETS),
  };
}

/** Replace global fetch (exact URL or longest prefix ending in "/"); unmatched URLs throw. */
export function stubFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.url);
    const key =
      routes[req.url] !== undefined
        ? req.url
        : Object.keys(routes)
            .filter((k) => k.endsWith("/") && req.url.startsWith(k))
            .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unexpected fetch in test: ${req.url}`);
    return routes[key]!(req);
  });
  return calls;
}

export function decodeHeader(value: string | null): any {
  if (value === null) throw new Error("header missing");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** A FAKE facilitator: accepts every payment and "settles" it as `tx`. */
export function fakeFacilitator(tx: string) {
  const calls = { verify: 0, settle: 0 };
  const facilitator: FacilitatorClient = {
    verify: () => {
      calls.verify++;
      return Promise.resolve({ isValid: true, payer: SPEC_ADDRESS });
    },
    settle: (_payload, req) => {
      calls.settle++;
      return Promise.resolve({ success: true, transaction: tx, network: req.network });
    },
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: "exact", network: "cardano:preprod" }],
        extensions: [],
        signers: {},
      }),
  };
  return { facilitator, calls };
}

/** A PAYMENT-SIGNATURE for the first option of a 402 (dummy tx bytes). */
export function paymentFor(required: any): string {
  return encodeHeader({
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { transaction: "AAAA", nonce: `${"a".repeat(64)}#0` },
  });
}
