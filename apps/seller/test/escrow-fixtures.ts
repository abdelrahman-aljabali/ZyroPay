/*
 * Escrow test fixtures. TEST KEYS ONLY (never funded); synthetic Blockfrost data in the
 * documented response shapes (/epochs/latest/parameters, /addresses/{a}/utxos,
 * /txs/{hash}/utxos, /blocks/latest, /utils/txs/evaluate/utxos). Nothing is real chain data.
 */
import { Address, Data, KeyHash, PrivateKey, VKey } from "@evolution-sdk/evolution";
import type { CardanoExtraMasumi } from "@x402/cardano";
import { buildMasumiLock, issueMasumiRequirements, masumiEscrowAddress } from "@x402/cardano";
import type { PaymentRequirements } from "@x402/core/types";
import { decodeCardanoTx } from "@zyropay/blockchain";
import { loadSellerKey } from "../src/receipt";
import { masumiSellerSigner } from "../src/escrow/terms";
import type { SpendSeller } from "../src/escrow/spend";
import type { KvLike } from "../src/escrow/store";
import { BLOCKFROST, json, makeAddress } from "./helpers";
import type { Route } from "./helpers";

/** TEST ONLY: a fixed 32-byte Ed25519 seed. */
export const SELLER_SEED = "5e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11e75e11";

function enterpriseAddress(keyHash: string): string {
  return Address.toBech32(
    new Address.Address({ networkId: 0, paymentCredential: KeyHash.fromHex(keyHash) }),
  );
}

const SELLER_KEY_HASH = KeyHash.toHex(
  KeyHash.fromVKey(VKey.fromPrivateKey(PrivateKey.fromHex(SELLER_SEED))),
);
export const SELLER_ADDRESS = enterpriseAddress(SELLER_KEY_HASH);
const loaded = loadSellerKey(SELLER_SEED, SELLER_ADDRESS);
if (!loaded.ok) throw new Error(loaded.problem);
export const SELLER_KEY = loaded.key;
export const SELLER: SpendSeller = { ...SELLER_KEY, address: SELLER_ADDRESS };

const BUYER_ADDRESS = makeAddress(6, 0, 0x44);
export const ESCROW_ADDRESS = masumiEscrowAddress("cardano:preprod");
const PRICE = "5000000";

/** Synthetic PlutusV3 cost model (297 entries); only its bytes matter offline. */
export const PLUTUS_V3_COSTS = Array.from({ length: 297 }, (_, i) => 1000 + i);

/** Shaped like Blockfrost /epochs/latest/parameters (values close to preprod's). */
const PROTOCOL_PARAMS = {
  min_fee_a: 44,
  min_fee_b: 155381,
  max_block_size: 90112,
  max_tx_size: 16384,
  max_val_size: "5000",
  key_deposit: "2000000",
  pool_deposit: "500000000",
  price_mem: 0.0577,
  price_step: 0.0000721,
  max_tx_ex_mem: "14000000",
  max_tx_ex_steps: "10000000000",
  collateral_percent: 150,
  max_collateral_inputs: 3,
  coins_per_utxo_size: "4310",
  min_fee_ref_script_cost_per_byte: 15,
  drep_deposit: "500000000",
  gov_action_deposit: "100000000000",
  cost_models_raw: { PlutusV3: PLUTUS_V3_COSTS },
};

export const EX_UNITS = { memory: 1_200_000, steps: 400_000_000 };

/** A seller-signed quote for `url`, issued at `nowMs` (route defaults: +5/+15/+30/+45 min). */
export async function issueQuote(nowMs: number, url: string): Promise<PaymentRequirements> {
  const signer = masumiSellerSigner(SELLER_KEY, SELLER_ADDRESS);
  const payBy = nowMs + 300_000;
  const issued = await issueMasumiRequirements({
    network: "cardano:preprod",
    asset: "lovelace",
    amount: PRICE,
    maxTimeoutSeconds: 300,
    sellerAddress: SELLER_ADDRESS,
    signTerms: signer.signTerms,
    commitment: [
      {
        name: "resource",
        canonicalization: "jcs",
        mediaType: "application/json",
        content: { url },
      },
    ],
    payByTime: String(payBy),
    submitResultTime: String(payBy + 600_000),
    unlockTime: String(payBy + 1_500_000),
    externalDisputeUnlockTime: String(payBy + 2_400_000),
    confirmationPolicy: { l1Confirmations: 0 },
  });
  return issued;
}

export function lockDatumHex(quote: PaymentRequirements, buyer = BUYER_ADDRESS) {
  const lock = buildMasumiLock(
    quote.extra as unknown as CardanoExtraMasumi,
    buyer,
    "lovelace",
    BigInt(quote.amount),
    4310n,
  );
  return { datum: Data.toCBORHex(lock.datum.data), lockedLovelace: lock.lockedLovelace, lock };
}

export interface FixtureUtxo {
  readonly txHash: string;
  readonly index: number;
  readonly address: string;
  readonly lovelace: bigint;
  readonly inlineDatum?: string | null;
  readonly consumedBy?: string | null;
}

/** Blockfrost /addresses/{a}/utxos element. */
function bfAddressUtxo(u: FixtureUtxo) {
  return {
    address: u.address,
    tx_hash: u.txHash,
    tx_index: u.index,
    output_index: u.index,
    amount: [{ unit: "lovelace", quantity: u.lovelace.toString() }],
    block: "b".repeat(64),
    data_hash: null,
    inline_datum: u.inlineDatum ?? null,
    reference_script_hash: null,
  };
}

/** Blockfrost /txs/{hash}/utxos body for the given outputs (all of one tx). */
export function bfTxUtxos(txHash: string, outputs: readonly FixtureUtxo[]) {
  return {
    hash: txHash,
    inputs: [],
    outputs: outputs.map((u) => ({
      address: u.address,
      amount: [{ unit: "lovelace", quantity: u.lovelace.toString() }],
      output_index: u.index,
      data_hash: null,
      inline_datum: u.inlineDatum ?? null,
      reference_script_hash: null,
      collateral: false,
      consumed_by_tx: u.consumedBy ?? null,
    })),
  };
}

/** Seller wallet: one pure-ADA UTxO big enough for fees and the 5 tADA Plutus collateral. */
export const WALLET_UTXOS: FixtureUtxo[] = [
  { txHash: "1".repeat(64), index: 0, address: SELLER_ADDRESS, lovelace: 20_000_000n },
  { txHash: "2".repeat(64), index: 1, address: SELLER_ADDRESS, lovelace: 9_000_000n },
];

/** Blockfrost fetch routes for the spend builder (evolution's provider) and our own reads. */
export function chainRoutes(opts: {
  tipMs: number;
  txs: Record<string, readonly FixtureUtxo[]>;
  escrowUtxos?: readonly FixtureUtxo[];
  wallet?: readonly FixtureUtxo[];
  onSubmit?: (body: Uint8Array) => Response;
  evaluate?: Route;
}): Record<string, Route> {
  const wallet = opts.wallet ?? WALLET_UTXOS;
  const routes: Record<string, Route> = {
    [`${BLOCKFROST}/epochs/latest/parameters`]: () => json(PROTOCOL_PARAMS),
    [`${BLOCKFROST}/blocks/latest`]: () =>
      json({ time: Math.floor(opts.tipMs / 1000), slot: 1, height: 1, hash: "c".repeat(64) }),
    [`${BLOCKFROST}/addresses/${SELLER_ADDRESS}/utxos`]: (url) =>
      json(url.searchParams.get("page") === "1" ? wallet.map(bfAddressUtxo) : []),
    [`${BLOCKFROST}/addresses/${ESCROW_ADDRESS}/utxos`]: (url) =>
      json(
        (url.searchParams.get("page") ?? "1") === "1"
          ? (opts.escrowUtxos ?? []).map(bfAddressUtxo)
          : [],
      ),
    [`${BLOCKFROST}/utils/txs/evaluate/utxos`]:
      opts.evaluate ??
      ((_url, init) => {
        // Ogmios-v5 JSON-WSP answer with the units for every redeemer the tx carries.
        const { cbor } = JSON.parse(init?.body as string) as { cbor: string };
        const tx = decodeCardanoTx(Uint8Array.from(Buffer.from(cbor, "hex")));
        const result = Object.fromEntries(tx.redeemers.map((r) => [`spend:${r.index}`, EX_UNITS]));
        return json({
          type: "jsonwsp/response",
          version: "1.0",
          servicename: "ogmios",
          methodname: "EvaluateTx",
          result: { EvaluationResult: result },
        });
      }),
    [`${BLOCKFROST}/tx/submit`]: async (_url, init) => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return opts.onSubmit?.(body) ?? json("submitted");
    },
  };
  for (const [hash, outputs] of Object.entries(opts.txs)) {
    routes[`${BLOCKFROST}/txs/${hash}/utxos`] = () => json(bfTxUtxos(hash, outputs));
  }
  return routes;
}

/** Map-backed fake of the ESCROW_KV namespace. */
export function memoryKv(): KvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    put: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
    list: ({ prefix }) =>
      Promise.resolve({
        keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
  };
}
