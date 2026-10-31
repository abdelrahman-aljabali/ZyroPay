/*
 * Compatibility, offline: a Cardano x402 payment built, signed and encoded exactly the way
 * ZyroPay's API does it (its own CBOR codec in @zyropay/blockchain) must be accepted by the
 * OFFICIAL @x402/cardano facilitator verification (ExactCardanoScheme + the stock
 * Blockfrost-backed toFacilitatorCardanoSigner, i.e. the code a hosted facilitator runs),
 * decoding with the Evolution SDK.
 *
 * Nothing touches the network: global fetch is stubbed. The seller's Blockfrost, the
 * facilitator's HTTP API (served in-process by @x402/core's x402Facilitator) and the
 * facilitator's Blockfrost are local fakes. Keys are test-only fixtures, never funded.
 */
import {
  SlotConfig,
  Transaction,
  TransactionBody,
  TransactionHash,
} from "@evolution-sdk/evolution";
import {
  decodeCardanoTransaction,
  ERR_AMOUNT_INSUFFICIENT,
  ERR_FEE_BELOW_MINIMUM,
  ERR_INVALID_SIGNATURE,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_RECIPIENT_MISMATCH,
  ERR_TRANSACTION_UNSIGNED,
  ERR_TTL_EXPIRED,
  ERR_TTL_TOO_FAR,
  ERR_VALUE_NOT_CONSERVED,
  toFacilitatorCardanoSigner,
} from "@x402/cardano";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { attachCardanoWitness, createCardanoTransactionBuilder } from "@zyropay/blockchain";
import {
  blockfrostRest,
  CARDANO_TEST_PARAMS,
  fixtureFetch,
  noSleep,
  testEd25519PublicKey,
  testEd25519Sign,
} from "@zyropay/blockchain/testing";
import { cardanoPaymentPayload, createX402Adapter, x402PaymentHeader } from "@zyropay/integrations";
import type { CanonicalTransactionPayload, JsonObject } from "@zyropay/shared";
import { cardanoEnterpriseAddress, cardanoKeyHash, createCanonicalPayload } from "@zyropay/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { BLOCKFROST_PREPROD_BASE_URL } from "../src/blockfrost";
import { blockfrostRoutes, FIXTURE_NOW } from "./fixtures";
import type { Route } from "./helpers";
import {
  decodeHeader,
  FACILITATOR,
  json,
  makeAddress,
  stubFetch,
  TEST_BASE_ADDRESS,
  TEST_PAY_TO,
  TEST_PROJECT_ID,
} from "./helpers";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

/** A JSON request body (the clients under test always send strings). */
function jsonBody(init: RequestInit | undefined): any {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(init.body);
}

const NOW = FIXTURE_NOW;
const NETWORK = "cardano:preprod";
/** The facilitator's own Blockfrost (distinct from the seller's data source). */
const FAC_BF = "https://facilitator-blockfrost.test/api/v0";

// Preprod slot <-> time, from the same SlotConfig the facilitator uses (slotToPosixMs and
// getCurrentSlot). The builder's tip is made consistent with it: 20 s behind wall clock.
const PREPROD = SlotConfig.SLOT_CONFIG_NETWORK.Preprod;
const slotAt = (ms: number): number =>
  Number(PREPROD.zeroSlot) + Math.floor((ms - Number(PREPROD.zeroTime)) / PREPROD.slotLength);
const TIP = {
  slot: slotAt(NOW.getTime()) - 20,
  height: 4_300_000,
  time: NOW.getTime() / 1000 - 20,
};

const PAYER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PAYER_PK = hex(testEd25519PublicKey(PAYER_SECRET));
const PAYER = cardanoEnterpriseAddress(PAYER_PK, "cardano-preprod");
const INPUT_TX = "ab".repeat(32);
const INPUT_INDEX = 3;
const INPUT_LOVELACE = "10000000";

const ENV: Env = {
  SELLER_ADDRESS: TEST_PAY_TO,
  BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
  FACILITATOR_MODE: "hosted",
  FACILITATOR_URL: FACILITATOR,
};
const RESOURCE = `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;

/** Preprod-shaped /epochs/latest/parameters; fee and min-UTxO terms equal ZyroPay's. */
function protocolParameters(overrides: Record<string, unknown> = {}) {
  return {
    epoch: 270,
    min_fee_a: CARDANO_TEST_PARAMS.min_fee_a,
    min_fee_b: CARDANO_TEST_PARAMS.min_fee_b,
    max_block_size: 90112,
    max_tx_size: CARDANO_TEST_PARAMS.max_tx_size,
    max_block_header_size: 1100,
    key_deposit: "2000000",
    pool_deposit: "500000000",
    e_max: 18,
    n_opt: 500,
    a0: 0.3,
    rho: 0.003,
    tau: 0.2,
    protocol_major_ver: 10,
    protocol_minor_ver: 0,
    min_utxo: CARDANO_TEST_PARAMS.coins_per_utxo_size,
    min_pool_cost: "170000000",
    nonce: "0".repeat(64),
    price_mem: 0.0577,
    price_step: 0.0000721,
    max_tx_ex_mem: "14000000",
    max_tx_ex_steps: "10000000000",
    max_block_ex_mem: "62000000",
    max_block_ex_steps: "20000000000",
    max_val_size: CARDANO_TEST_PARAMS.max_val_size,
    collateral_percent: 150,
    max_collateral_inputs: 3,
    coins_per_utxo_size: CARDANO_TEST_PARAMS.coins_per_utxo_size,
    coins_per_utxo_word: CARDANO_TEST_PARAMS.coins_per_utxo_size,
    min_fee_ref_script_cost_per_byte: 15,
    drep_deposit: "500000000",
    gov_action_deposit: "100000000000",
    ...overrides,
  };
}

interface ChainState {
  /** Input UTxO value the facilitator's Blockfrost reports. */
  inputLovelace: string;
  /** consumed_by_tx of the input (null = unspent). */
  consumedBy: string | null;
  params: Record<string, unknown>;
  /** Transactions the fake node has accepted (by hash). */
  submitted: Map<string, Uint8Array>;
  /** CBOR the facilitator sent to /utils/txs/evaluate/utxos (Evolution's re-encoding). */
  evaluated: string[];
}

function chainState(overrides: Partial<ChainState> = {}): ChainState {
  return {
    inputLovelace: INPUT_LOVELACE,
    consumedBy: null,
    params: protocolParameters(),
    submitted: new Map(),
    evaluated: [],
    ...overrides,
  };
}

/** The facilitator's Blockfrost: exactly the endpoints @x402/cardano + Evolution call. */
function facilitatorBlockfrost(state: ChainState): Record<string, Route> {
  return {
    [`${FAC_BF}/epochs/latest/parameters`]: () => json(state.params),
    [`${FAC_BF}/blocks/latest`]: () => json({ slot: TIP.slot, height: TIP.height, time: TIP.time }),
    [`${FAC_BF}/utils/txs/evaluate/utxos`]: (_url, init) => {
      const body = jsonBody(init) as { cbor: string };
      state.evaluated.push(body.cbor);
      // Ogmios v5 JSON-WSP reply for a transaction without scripts: nothing to evaluate.
      return json({
        type: "jsonwsp/response",
        version: "1.0",
        servicename: "ogmios",
        methodname: "EvaluateTx",
        result: { EvaluationResult: {} },
        reflection: { id: "test" },
      });
    },
    [`${FAC_BF}/tx/submit`]: (_url, init) => {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      const txHash = decodeCardanoTransaction(Buffer.from(bytes).toString("base64")).txHash;
      state.submitted.set(txHash, bytes);
      return json(txHash);
    },
    [`${FAC_BF}/txs/`]: (url) => {
      const [, hash, sub] = /\/txs\/([0-9a-f]{64})(\/utxos)?$/.exec(url.pathname) ?? [];
      if (hash === INPUT_TX && sub !== undefined) {
        return json({
          hash: INPUT_TX,
          inputs: [],
          outputs: [
            {
              address: PAYER,
              amount: [{ unit: "lovelace", quantity: state.inputLovelace }],
              output_index: INPUT_INDEX,
              data_hash: null,
              inline_datum: null,
              reference_script_hash: null,
              collateral: false,
              consumed_by_tx: state.consumedBy,
            },
          ],
        });
      }
      if (hash !== undefined && sub === undefined && state.submitted.has(hash)) {
        return json({ hash, block_height: TIP.height, slot: TIP.slot + 30, valid_contract: true });
      }
      return json({ status_code: 404, error: "Not Found", message: "not found" }, 404);
    },
  };
}

/** The stock facilitator stack: Blockfrost signer + ExactCardanoScheme + x402Facilitator. */
function facilitatorStack() {
  const signer = toFacilitatorCardanoSigner({
    network: NETWORK,
    provider: { blockfrost: { baseUrl: FAC_BF, projectId: TEST_PROJECT_ID } },
    awaitConfirmation: false,
  });
  const scheme = new FacilitatorScheme(signer, {
    confirmationTimeoutMs: 2_000,
    confirmationPollMs: 10,
  });
  const facilitator = new x402Facilitator().register(NETWORK, scheme);
  return { scheme, facilitator };
}

/** HTTP face of the facilitator (/supported, /verify, /settle) for HTTPFacilitatorClient. */
function facilitatorHttp(facilitator: x402Facilitator): Record<string, Route> {
  const body = (init: RequestInit | undefined) =>
    jsonBody(init) as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  return {
    [`${FACILITATOR}/supported`]: () => json(facilitator.getSupported()),
    [`${FACILITATOR}/verify`]: async (_url, init) => {
      const b = body(init);
      return json(await facilitator.verify(b.paymentPayload, b.paymentRequirements));
    },
    [`${FACILITATOR}/settle`]: async (_url, init) => {
      const b = body(init);
      return json(await facilitator.settle(b.paymentPayload, b.paymentRequirements));
    },
  };
}

// --- ZyroPay's side, as apps/api does it --------------------------------------------------

async function sellerPaymentRequired(): Promise<JsonObject> {
  const app = createApp(ENV, { now: () => NOW });
  const res = await app.request(RESOURCE, { headers: { accept: "application/json" } });
  expect(res.status).toBe(402);
  return decodeHeader(res.headers.get("PAYMENT-REQUIRED")) as JsonObject;
}

async function zyropayPayload(paymentRequired: JsonObject): Promise<CanonicalTransactionPayload> {
  const adapter = createX402Adapter({
    caps: { "cardano-preprod:native": "5000000" },
    now: () => NOW,
  });
  const quote = await adapter.quote({
    action: "pay",
    network: "cardano-preprod",
    params: {
      paymentRequired,
      resourceUrl: RESOURCE,
      maxAmount: "3000000",
      assetId: "cardano-preprod:native",
      payer: PAYER,
    },
  });
  return createCanonicalPayload({
    version: 1,
    network: "cardano-preprod",
    from: PAYER,
    to: TEST_PAY_TO,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: quote.inputAmount,
    feeCap: "2000000",
    plugin: "x402",
    tool: "pay_x402",
    pluginData: quote.pluginData,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    idempotencyKey: "x402-cardano-compat-001",
  });
}

async function buildUnsigned(payload: CanonicalTransactionPayload, maxValiditySeconds = 600) {
  const builder = createCardanoTransactionBuilder({
    blockfrostProjectId: "preprodTESTKEY0000000000000000000000",
    network: "cardano-preprod",
    blockfrostBaseUrl: "https://bf.test/api/v0",
    fetch: fixtureFetch({
      rest: blockfrostRest({
        networkMagic: 1,
        tip: TIP,
        utxos: [
          {
            address: PAYER,
            tx_hash: INPUT_TX,
            tx_index: INPUT_INDEX,
            output_index: INPUT_INDEX,
            amount: [{ unit: "lovelace", quantity: INPUT_LOVELACE }],
            block: "b".repeat(64),
            data_hash: null,
            inline_datum: null,
            reference_script_hash: null,
          },
        ],
      }),
    }),
    sleep: noSleep,
    now: () => NOW,
  });
  return builder.buildTransfer(payload, { maxValiditySeconds });
}

function sign(unsigned: { serialized: string; bodyHash: string }) {
  const signature = hex(testEd25519Sign(PAYER_SECRET, unhex(unsigned.bodyHash)));
  const signed = attachCardanoWitness({
    unsignedHex: unsigned.serialized,
    publicKey: PAYER_PK,
    signature,
    expectedKeyHash: cardanoKeyHash(PAYER_PK),
  });
  return { ...signed, signature };
}

/** The whole buyer side: 402 -> quote -> payload -> build -> sign -> PAYMENT-SIGNATURE. */
async function zyropayPayment(maxValiditySeconds = 600) {
  const paymentRequired = await sellerPaymentRequired();
  const payload = await zyropayPayload(paymentRequired);
  const unsigned = await buildUnsigned(payload, maxValiditySeconds);
  const signed = sign(unsigned);
  const inner = cardanoPaymentPayload(signed.signedTransaction);
  const header = x402PaymentHeader(payload, inner);
  const requirements = (paymentRequired.accepts as unknown as PaymentRequirements[])[0]!;
  return {
    paymentRequired,
    payload,
    unsigned,
    signed,
    inner,
    header,
    paymentPayload: decodeHeader(header.value) as PaymentPayload,
    requirements,
  };
}

// ------------------------------------------------------------------------------------------

beforeEach(() => {
  // Only Date is faked (getCurrentSlot reads Date.now()); timers stay real for Effect.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ZyroPay Cardano x402 payment vs the official @x402/cardano facilitator", () => {
  it("the seller advertises the requirement ZyroPay pays (exact, preprod, lovelace)", async () => {
    const state = chainState();
    stubFetch({
      ...facilitatorHttp(facilitatorStack().facilitator),
      ...facilitatorBlockfrost(state),
    });
    const { requirements, paymentPayload, header } = await zyropayPayment();
    expect(requirements).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      amount: "2000000",
      asset: "lovelace",
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { confirmationPolicy: { l1Confirmations: 0 }, areFeesSponsored: false },
    });
    expect(paymentPayload.resource?.url).toBe(RESOURCE);
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    // ZyroPay echoes the accepted requirement verbatim.
    expect(paymentPayload.accepted).toEqual(requirements);
    expect(paymentPayload.x402Version).toBe(2);
  });

  it("verify(): isValid, and the facilitator decodes the same tx id and body as ZyroPay", async () => {
    const state = chainState();
    const { scheme, facilitator } = facilitatorStack();
    const calls = stubFetch({ ...facilitatorHttp(facilitator), ...facilitatorBlockfrost(state) });
    const p = await zyropayPayment();
    calls.length = 0;

    const result = await scheme.verify(p.paymentPayload, p.requirements);
    expect(result).toEqual({ isValid: true, payer: PAYER });
    // Every chain-backed check ran against the (fake) facilitator Blockfrost.
    expect(calls.map((c) => `${c.method} ${c.url.replace(FAC_BF, "")}`).sort()).toEqual(
      [
        `GET /txs/${p.unsigned.bodyHash}`, // ledger evidence (unknown -> pre-broadcast checks)
        `GET /txs/${INPUT_TX}/utxos`, // input value + owner (Evolution getUtxosByOutRef)
        `GET /txs/${INPUT_TX}/utxos`, // input unspent (consumed_by_tx)
        "GET /epochs/latest/parameters", // fee floor + min-UTxO
        "POST /utils/txs/evaluate/utxos", // evaluateTransaction
      ].sort(),
    );

    // Evolution's view of ZyroPay's bytes.
    const decoded = decodeCardanoTransaction(p.inner.transaction);
    expect(decoded.txHash).toBe(p.unsigned.bodyHash);
    expect(decoded.txHash).toBe(p.signed.txHash);
    expect(decoded.signaturesValid).toBe(true);
    expect(decoded.vkeyWitnessCount).toBe(1);
    expect(decoded.inputs).toEqual([`${INPUT_TX}#${INPUT_INDEX}`]);
    expect(decoded.networkId).toBeUndefined();
    expect(decoded.ttlSlot).toBe(BigInt(p.unsigned.ttlSlot));
    expect(decoded.validityStartSlot).toBeUndefined();
    expect(decoded.balanceChangingOperations).toEqual([]);
    expect(decoded.outputs[0]).toMatchObject({ address: TEST_PAY_TO, coin: 2_000_000n });
    expect(decoded.outputs[1]?.address).toBe(PAYER);
    // Value is conserved and the fee covers the SIGNED size at preprod parameters.
    const coinOut = decoded.outputs.reduce((s, o) => s + o.coin, decoded.fee);
    expect(coinOut).toBe(BigInt(INPUT_LOVELACE));
    expect(decoded.fee).toBeGreaterThanOrEqual(
      BigInt(CARDANO_TEST_PARAMS.min_fee_b + CARDANO_TEST_PARAMS.min_fee_a * decoded.sizeBytes),
    );

    // Re-encoding through Evolution: body (tag-258 input set included) and the whole tx
    // are byte-identical, so the hash is stable and the evaluate call sees our exact bytes.
    const txBytes = unhex(p.signed.signedTransaction);
    const tx = Transaction.fromCBORBytes(txBytes);
    const originalBody = Transaction.extractBodyBytes(txBytes);
    const reencodedBody = TransactionBody.toCBORBytes(tx.body);
    expect(hex(reencodedBody)).toBe(hex(originalBody));
    expect(TransactionHash.toHex(TransactionBody.toHashFromBytes(reencodedBody))).toBe(
      p.unsigned.bodyHash,
    );
    expect(Transaction.toCBORHex(tx)).toBe(p.signed.signedTransaction);
    expect(state.evaluated).toEqual([p.signed.signedTransaction]);
  });

  it("end to end through the seller app: 200, settled, the node got ZyroPay's exact bytes", async () => {
    const state = chainState();
    const { facilitator } = facilitatorStack();
    const calls = stubFetch({
      ...blockfrostRoutes(),
      ...facilitatorHttp(facilitator),
      ...facilitatorBlockfrost(state),
    });
    const p = await zyropayPayment();
    const app = createApp(ENV, { now: () => NOW });
    const res = await app.request(RESOURCE, {
      headers: { accept: "application/json", [p.header.name]: p.header.value },
    });
    expect(res.status).toBe(200);
    const settlement = decodeHeader(res.headers.get("PAYMENT-RESPONSE"));
    expect(settlement).toMatchObject({
      success: true,
      transaction: p.unsigned.bodyHash,
      network: NETWORK,
      payer: PAYER,
    });
    expect(hex(state.submitted.get(p.unsigned.bodyHash)!)).toBe(p.signed.signedTransaction);
    expect(calls.filter((c) => c.url === `${FACILITATOR}/verify`)).toHaveLength(1);
    expect(calls.filter((c) => c.url === `${FACILITATOR}/settle`)).toHaveLength(1);
  });

  it("embedded mode (the deployed default): the seller verifies and submits itself, no HTTP facilitator", async () => {
    const state = chainState();
    // The embedded facilitator reads the chain through the seller's own Blockfrost base URL.
    const facilitatorChain = Object.fromEntries(
      Object.entries(facilitatorBlockfrost(state)).map(([url, route]) => [
        url.replace(FAC_BF, BLOCKFROST_PREPROD_BASE_URL),
        route,
      ]),
    );
    const calls = stubFetch({
      ...blockfrostRoutes(),
      ...facilitatorHttp(facilitatorStack().facilitator), // only for zyropayPayment()'s 402
      ...facilitatorChain,
    });
    const p = await zyropayPayment();
    const before = calls.length;
    const { FACILITATOR_MODE: _hosted, FACILITATOR_URL: _url, ...embedded } = ENV;
    const app = createApp(embedded, { now: () => NOW });
    const res = await app.request(RESOURCE, {
      headers: { accept: "application/json", [p.header.name]: p.header.value },
    });
    expect(res.status).toBe(200);
    expect(decodeHeader(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({
      success: true,
      transaction: p.unsigned.bodyHash,
    });
    expect(hex(state.submitted.get(p.unsigned.bodyHash)!)).toBe(p.signed.signedTransaction);
    expect(calls.slice(before).some((c) => c.url.startsWith(FACILITATOR))).toBe(false);
  });

  describe("negative controls (the positive case is not vacuous)", () => {
    async function verdict(
      mutate: (p: Awaited<ReturnType<typeof zyropayPayment>>) => {
        paymentPayload?: PaymentPayload;
        requirements?: PaymentRequirements;
      } = () => ({}),
      opts: { state?: Partial<ChainState>; maxValiditySeconds?: number; at?: Date } = {},
    ) {
      const state = chainState(opts.state);
      stubFetch({
        ...facilitatorHttp(facilitatorStack().facilitator),
        ...facilitatorBlockfrost(state),
      });
      const p = await zyropayPayment(opts.maxValiditySeconds);
      const m = mutate(p);
      if (opts.at !== undefined) vi.setSystemTime(opts.at);
      return facilitatorStack().scheme.verify(
        m.paymentPayload ?? p.paymentPayload,
        m.requirements ?? p.requirements,
      );
    }

    it("wrong payTo -> recipient mismatch", async () => {
      // (Not PAYER: the change output to the payer would itself satisfy 2 ADA.)
      const other = makeAddress(6, 0, 0x55);
      const r = await verdict((p) => ({ requirements: { ...p.requirements, payTo: other } }));
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_RECIPIENT_MISMATCH });
    });

    it("higher amount -> amount insufficient", async () => {
      const r = await verdict((p) => ({ requirements: { ...p.requirements, amount: "2000001" } }));
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_AMOUNT_INSUFFICIENT });
    });

    it("TTL beyond now + maxTimeoutSeconds -> ttl too far", async () => {
      const r = await verdict(undefined, { maxValiditySeconds: 1200 });
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_TTL_TOO_FAR });
    });

    it("verified after the TTL slot -> ttl expired", async () => {
      const r = await verdict(undefined, { at: new Date(NOW.getTime() + 600_000) });
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_TTL_EXPIRED });
    });

    it("unsigned transaction -> unsigned", async () => {
      const r = await verdict((p) => ({
        paymentPayload: {
          ...p.paymentPayload,
          payload: {
            transaction: Buffer.from(unhex(p.unsigned.serialized)).toString("base64"),
            nonce: p.inner.nonce,
          },
        },
      }));
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_TRANSACTION_UNSIGNED });
    });

    it("tampered signature -> invalid signature", async () => {
      const r = await verdict((p) => {
        const flipped = p.signed.signature.replace(/^../, (b) =>
          (Number.parseInt(b, 16) ^ 1).toString(16).padStart(2, "0"),
        );
        const tampered = p.signed.signedTransaction.replace(p.signed.signature, flipped);
        expect(tampered).not.toBe(p.signed.signedTransaction);
        return {
          paymentPayload: {
            ...p.paymentPayload,
            payload: {
              transaction: Buffer.from(unhex(tampered)).toString("base64"),
              nonce: p.inner.nonce,
            },
          },
        };
      });
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_INVALID_SIGNATURE });
    });

    it("input already spent -> nonce not on chain", async () => {
      const r = await verdict(undefined, { state: { consumedBy: "cd".repeat(32) } });
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_NONCE_NOT_ON_CHAIN });
    });

    it("input value differs from what the builder saw -> value not conserved", async () => {
      const r = await verdict(undefined, { state: { inputLovelace: "10000001" } });
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_VALUE_NOT_CONSERVED });
    });

    it("a higher fee floor than ZyroPay's parameters -> fee below minimum", async () => {
      const r = await verdict(undefined, {
        state: { params: protocolParameters({ min_fee_b: 300_000 }) },
      });
      expect(r).toMatchObject({ isValid: false, invalidReason: ERR_FEE_BELOW_MINIMUM });
    });
  });
});
