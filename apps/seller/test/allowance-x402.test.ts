/*
 * Auto-pay feasibility, offline: an x402 `exact` Cardano payment that SPENDS ZyroPay's
 * allowance script (contracts/allowance, redeemer AgentPay) plus the agent key's own UTxO
 * (fee + collateral), built by @zyropay/blockchain's planner and signed by the agent key
 * only, must be accepted by the OFFICIAL @x402/cardano 2.29 facilitator (the code the seller
 * embeds) and settle end to end through the seller app.
 *
 * The facilitator does not require a key-hash payer, does not check input ownership beyond
 * resolving the nonce UTxO's address (`payer`), and does not refuse redeemers or inline
 * PlutusV3 scripts: it checks the signatures it finds, value conservation over every input,
 * the fee floor, TTL <= now + maxTimeoutSeconds, validity start <= now, and asks the chain
 * to evaluate the scripts. Nothing touches the network: fetch is stubbed.
 */
import { decodeCardanoTransaction, toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { AllowanceDatum, AllowanceUtxo, ScriptProtocolParams } from "@zyropay/blockchain";
import {
  allowanceScript,
  attachCardanoWitness,
  cardanoPosixMsToSlot,
  cardanoSlotToPosixMs,
  encodeAllowanceDatum,
  planAllowanceAgentPay,
} from "@zyropay/blockchain";
import {
  CARDANO_TEST_PARAMS,
  testEd25519PublicKey,
  testEd25519Sign,
} from "@zyropay/blockchain/testing";
import { cardanoPaymentPayload, x402PaymentHeader } from "@zyropay/integrations";
import type { JsonObject } from "@zyropay/shared";
import {
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  createCanonicalPayload,
} from "@zyropay/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import COST_MODEL from "../../../packages/blockchain/src/__tests__/fixtures/cardano/plutus-v3-cost-model.json";
import { createApp, REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { blockfrostRoutes, FIXTURE_NOW } from "./fixtures";
import type { Route } from "./helpers";
import {
  decodeHeader,
  FACILITATOR,
  json,
  stubFetch,
  TEST_BASE_ADDRESS,
  TEST_PAY_TO,
  TEST_PROJECT_ID,
} from "./helpers";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
function jsonBody(init: RequestInit | undefined): any {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(init.body);
}

const NOW = FIXTURE_NOW;
const NET = "cardano-preprod" as const;
const NETWORK = "cardano:preprod";
const FAC_BF = "https://facilitator-blockfrost.test/api/v0";
const ADA = 1_000_000n;
const DAY = 86_400_000n;

const AGENT_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const AGENT_PK = hex(testEd25519PublicKey(AGENT_SECRET));
const AGENT = cardanoEnterpriseAddress(AGENT_PK, NET);
const AGENT_KH = cardanoKeyHash(AGENT_PK);
const OWNER_KH = "7c".repeat(28);
const SCRIPT = allowanceScript(NET, OWNER_KH);

const ALLOWANCE_TX = "a1".repeat(32);
const AGENT_TX = "a2".repeat(32);

const NOW_SLOT = cardanoPosixMsToSlot(NET, BigInt(NOW.getTime()), "floor");
const PERIOD_START = cardanoSlotToPosixMs(NET, NOW_SLOT) - 3_600_000n;
const DATUM: AllowanceDatum = {
  agentKeyHash: AGENT_KH,
  perPaymentMax: 3n * ADA,
  periodMs: DAY,
  periodCap: 5n * ADA,
  periodStart: PERIOD_START,
  spentInPeriod: 0n,
  allowedPayees: [{ kind: "key", hash: cardanoPaymentKeyHash(TEST_PAY_TO) ?? "" }],
  expiresAt: PERIOD_START + 7n * DAY,
};
const ALLOWANCE: AllowanceUtxo = {
  txHash: ALLOWANCE_TX,
  index: 0,
  value: { coin: 20n * ADA, assets: new Map() },
  datum: DATUM,
};

const PARAMS: ScriptProtocolParams = {
  minFeeA: BigInt(CARDANO_TEST_PARAMS.min_fee_a),
  minFeeB: BigInt(CARDANO_TEST_PARAMS.min_fee_b),
  coinsPerUtxoByte: BigInt(CARDANO_TEST_PARAMS.coins_per_utxo_size),
  maxTxSize: CARDANO_TEST_PARAMS.max_tx_size,
  maxValSize: Number(CARDANO_TEST_PARAMS.max_val_size),
  priceMem: { num: 577n, den: 10000n },
  priceStep: { num: 721n, den: 10000000n },
  collateralPercent: 150n,
  maxCollateralInputs: 3,
  maxTxExMem: 14_000_000n,
  maxTxExSteps: 10_000_000_000n,
  plutusV3CostModel: COST_MODEL.PlutusV3.map((c: number) => BigInt(c)),
};
/** What Blockfrost measured for the live preprod agent payment (deployments/preprod.json). */
const MEASURED = { mem: 264_349n, steps: 106_417_209n };

const ENV: Env = {
  SELLER_ADDRESS: TEST_PAY_TO,
  BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
  FACILITATOR_MODE: "hosted",
  FACILITATOR_URL: FACILITATOR,
};
const RESOURCE = `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;

function protocolParameters() {
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
  };
}

interface ChainState {
  submitted: Map<string, Uint8Array>;
  evaluated: string[];
  /** The evaluator's verdict: the measured budget, or a script failure. */
  scriptOk: boolean;
}

/** Facilitator Blockfrost serving the allowance UTxO (script, inline datum) and the agent's. */
function facilitatorBlockfrost(state: ChainState): Record<string, Route> {
  const outputs: Record<string, object> = {
    [ALLOWANCE_TX]: {
      address: SCRIPT.address,
      amount: [{ unit: "lovelace", quantity: ALLOWANCE.value.coin.toString() }],
      output_index: 0,
      data_hash: null,
      inline_datum: hex(encodeAllowanceDatum(DATUM)),
      reference_script_hash: null,
      collateral: false,
      consumed_by_tx: null,
    },
    [AGENT_TX]: {
      address: AGENT,
      amount: [{ unit: "lovelace", quantity: "5000000" }],
      output_index: 0,
      data_hash: null,
      inline_datum: null,
      reference_script_hash: null,
      collateral: false,
      consumed_by_tx: null,
    },
  };
  return {
    [`${FAC_BF}/epochs/latest/parameters`]: () => json(protocolParameters()),
    [`${FAC_BF}/blocks/latest`]: () =>
      json({ slot: Number(NOW_SLOT), height: 4_300_000, time: NOW.getTime() / 1000 }),
    [`${FAC_BF}/utils/txs/evaluate/utxos`]: (_url, init) => {
      state.evaluated.push((jsonBody(init) as { cbor: string }).cbor);
      if (!state.scriptOk)
        return json({
          type: "jsonwsp/response",
          version: "1.0",
          servicename: "ogmios",
          methodname: "EvaluateTx",
          result: { EvaluationFailure: { ScriptFailures: { "spend:0": [] } } },
          reflection: { id: "test" },
        });
      return json({
        type: "jsonwsp/response",
        version: "1.0",
        servicename: "ogmios",
        methodname: "EvaluateTx",
        result: {
          EvaluationResult: {
            "spend:0": { memory: Number(MEASURED.mem), steps: Number(MEASURED.steps) },
          },
        },
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
      const out = hash === undefined ? undefined : outputs[hash];
      if (out !== undefined && sub !== undefined) return json({ hash, inputs: [], outputs: [out] });
      if (hash !== undefined && sub === undefined && state.submitted.has(hash))
        return json({
          hash,
          block_height: 4_300_000,
          slot: Number(NOW_SLOT) + 30,
          valid_contract: true,
        });
      return json({ status_code: 404, error: "Not Found", message: "not found" }, 404);
    },
  };
}

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
  return { scheme, facilitator: new x402Facilitator().register(NETWORK, scheme) };
}

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

async function sellerRequirements(): Promise<PaymentRequirements> {
  const app = createApp(ENV, { now: () => NOW });
  const res = await app.request(RESOURCE, { headers: { accept: "application/json" } });
  expect(res.status).toBe(402);
  const required = decodeHeader(res.headers.get("PAYMENT-REQUIRED")) as JsonObject;
  return (required.accepts as unknown as PaymentRequirements[])[0]!;
}

/** The auto-pay transaction: allowance input + agent UTxO, signed by the agent key only. */
function autoPay(requirements: PaymentRequirements, lovelace = BigInt(requirements.amount)) {
  const plan = planAllowanceAgentPay({
    network: NET,
    ownerKeyHash: OWNER_KH,
    allowance: ALLOWANCE,
    agent: AGENT,
    payee: requirements.payTo,
    lovelace,
    utxos: [
      {
        tx_hash: AGENT_TX,
        output_index: 0,
        amount: [{ unit: "lovelace", quantity: "5000000" }],
        data_hash: null,
        inline_datum: null,
        reference_script_hash: null,
      },
    ],
    params: PARAMS,
    validityStartSlot: NOW_SLOT - 20n,
    ttlSlot: NOW_SLOT + 300n,
    exUnits: MEASURED,
  });
  const signed = attachCardanoWitness({
    unsignedHex: plan.serialized,
    publicKey: AGENT_PK,
    signature: hex(testEd25519Sign(AGENT_SECRET, unhex(plan.bodyHash))),
    expectedKeyHash: AGENT_KH,
  });
  const inner = cardanoPaymentPayload(signed.signedTransaction);
  const payload = createCanonicalPayload({
    version: 1,
    network: NET,
    from: AGENT,
    to: requirements.payTo,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: requirements.amount,
    feeCap: "2000000",
    plugin: "x402",
    tool: "pay_x402",
    pluginData: {
      x402Version: 2,
      resourceUrl: RESOURCE,
      method: "GET",
      accepted: requirements as never,
      resource: { url: RESOURCE } as never,
    },
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    idempotencyKey: "allowance-x402-001",
  });
  const header = x402PaymentHeader(payload, inner);
  return {
    plan,
    signed,
    inner,
    header,
    paymentPayload: decodeHeader(header.value) as PaymentPayload,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auto-pay: an allowance spend as an x402 exact payment (official facilitator)", () => {
  it("verify(): isValid, payer = the resolved nonce owner, scripts evaluated", async () => {
    const state: ChainState = { submitted: new Map(), evaluated: [], scriptOk: true };
    const { scheme, facilitator } = facilitatorStack();
    stubFetch({ ...facilitatorHttp(facilitator), ...facilitatorBlockfrost(state) });
    const requirements = await sellerRequirements();
    const p = autoPay(requirements);

    const decoded = decodeCardanoTransaction(p.inner.transaction);
    expect(decoded.txHash).toBe(p.plan.bodyHash);
    expect(decoded.redeemerCount).toBe(1);
    expect(decoded.vkeyHashes).toEqual([AGENT_KH]);
    expect(decoded.inputs.sort()).toEqual([`${ALLOWANCE_TX}#0`, `${AGENT_TX}#0`].sort());
    expect(decoded.outputs[0]).toMatchObject({ address: SCRIPT.address });
    expect(decoded.outputs[1]).toMatchObject({ address: TEST_PAY_TO, coin: 2n * ADA });

    const result = await scheme.verify(p.paymentPayload, requirements);
    expect(result).toMatchObject({ isValid: true });
    // The nonce is the first (sorted) input; whichever it is, its address is the payer.
    const nonceTx = p.inner.nonce.split("#")[0];
    expect(result.payer).toBe(nonceTx === ALLOWANCE_TX ? SCRIPT.address : AGENT);
    expect(state.evaluated).toHaveLength(1);
  });

  it("a script the chain's evaluator refuses is refused by verify()", async () => {
    const state: ChainState = { submitted: new Map(), evaluated: [], scriptOk: false };
    const { scheme, facilitator } = facilitatorStack();
    stubFetch({ ...facilitatorHttp(facilitator), ...facilitatorBlockfrost(state) });
    const requirements = await sellerRequirements();
    const result = await scheme.verify(autoPay(requirements).paymentPayload, requirements);
    expect(result.isValid).toBe(false);
  });

  it("paying less than the requirement is refused (amount_insufficient)", async () => {
    const state: ChainState = { submitted: new Map(), evaluated: [], scriptOk: true };
    const { scheme, facilitator } = facilitatorStack();
    stubFetch({ ...facilitatorHttp(facilitator), ...facilitatorBlockfrost(state) });
    const requirements = await sellerRequirements();
    const p = autoPay(requirements, BigInt(requirements.amount) - 1n);
    const result = await scheme.verify(p.paymentPayload, requirements);
    expect(result).toMatchObject({ isValid: false });
  });

  it("end to end through the seller: 200, settled, the node got the allowance spend", async () => {
    const state: ChainState = { submitted: new Map(), evaluated: [], scriptOk: true };
    const { facilitator } = facilitatorStack();
    stubFetch({
      ...blockfrostRoutes(),
      ...facilitatorHttp(facilitator),
      ...facilitatorBlockfrost(state),
    });
    const requirements = await sellerRequirements();
    const p = autoPay(requirements);
    const app = createApp(ENV, { now: () => NOW });
    const res = await app.request(RESOURCE, {
      headers: { accept: "application/json", [p.header.name]: p.header.value },
    });
    expect(res.status).toBe(200);
    expect(decodeHeader(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({
      success: true,
      transaction: p.plan.bodyHash,
      network: NETWORK,
    });
    expect(hex(state.submitted.get(p.plan.bodyHash)!)).toBe(p.signed.signedTransaction);
  });
});
