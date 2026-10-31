import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CanonicalTransactionPayload } from "@zyropay/shared";
import { cardanoEnterpriseAddress, createCanonicalPayload } from "@zyropay/shared";
import { HttpReply } from "../testing";
import RECORDED from "./fixtures/cardano/mainnet-recorded.json";

/** Public test keys (fixed bytes), never funded on any network. */
export const SENDER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
export const SENDER_PK = bytesToHex(ed25519.getPublicKey(SENDER_SECRET));
export const OTHER_PK = bytesToHex(ed25519.getPublicKey(OTHER_SECRET));
export const FROM = cardanoEnterpriseAddress(SENDER_PK, "cardano-preprod");
export const TO = cardanoEnterpriseAddress(OTHER_PK, "cardano-preprod");

/** A test token (policy id + "ZYRO"). */
const POLICY = "a".repeat(56);
export const UNIT = `${POLICY}5a59524f`;

export const NOW = new Date("2026-10-30T12:00:00.000Z");
export const TIP = { slot: 105_000_000, height: 4_200_000, time: NOW.getTime() / 1000 };

/** Recorded mainnet protocol parameters (epoch 662), reused on preprod (same values today). */
export const PARAMS = RECORDED.parameters;

export function cardanoPayload(
  overrides: Partial<CanonicalTransactionPayload> = {},
): CanonicalTransactionPayload {
  return createCanonicalPayload({
    version: 1,
    network: "cardano-preprod",
    from: FROM,
    to: TO,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: "2000000",
    feeCap: "1000000",
    plugin: null,
    tool: "app_send",
    pluginData: null,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    idempotencyKey: "cardano-idem-001",
    ...overrides,
  });
}

export function utxo(
  txByte: string,
  index: number,
  lovelace: string,
  tokens: Record<string, string> = {},
) {
  return {
    address: FROM,
    tx_hash: txByte.repeat(64).slice(0, 64),
    tx_index: index,
    output_index: index,
    amount: [
      { unit: "lovelace", quantity: lovelace },
      ...Object.entries(tokens).map(([unit, quantity]) => ({ unit, quantity })),
    ],
    block: "b".repeat(64),
    data_hash: null,
    inline_datum: null,
    reference_script_hash: null,
  };
}

const DEFAULT_UTXOS = [
  utxo("1", 0, "5000000"),
  utxo("2", 1, "3000000", { [UNIT]: "1000" }),
  utxo("3", 0, "1500000"),
];

/** Blockfrost REST fixtures for preprod (URL-substring keyed; order matters). */
export function blockfrostPreprod(
  options: {
    utxos?: unknown[];
    asset?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    ...(options.extra ?? {}),
    "/genesis": { ...RECORDED.genesis, network_magic: 1 },
    "/epochs/latest/parameters": PARAMS,
    "/blocks/latest": { ...RECORDED.latestBlock, ...TIP },
    // fixtureFetch treats an array as a reply sequence: wrap list replies in a function.
    "/utxos?count=100&page=1": () => options.utxos ?? DEFAULT_UTXOS,
    [`/assets/${UNIT}`]: options.asset ?? {
      asset: UNIT,
      policy_id: POLICY,
      asset_name: "5a59524f",
      quantity: "1000000000",
      metadata: { name: "Zyro Test", ticker: "ZYRO", decimals: 2 },
      onchain_metadata: null,
    },
    "/assets/": new HttpReply(404, { status_code: 404, error: "Not Found", message: "x" }),
  };
}

export { RECORDED };
