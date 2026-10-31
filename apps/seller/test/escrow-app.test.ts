/*
 * The escrow route end to end, offline: the real Hono app, @x402/hono, @x402/cardano's
 * resource-server scheme (Masumi quote issuance) and the EMBEDDED @x402/cardano facilitator
 * (masumi lock verify + settle), against fixture Blockfrost. The buyer's lock is built and
 * signed the way ZyroPay does it (@zyropay/blockchain planCardanoEscrowLock + a test key).
 * After the paid response the background SubmitResult is built, signed and "submitted" to
 * the fake node. TEST KEYS ONLY; nothing touches the network.
 */
import { SlotConfig } from "@evolution-sdk/evolution";
import type { CardanoExtraMasumi } from "@x402/cardano";
import {
  buildMasumiLock,
  decodeCardanoTransaction,
  MASUMI_MAX_DEADLINE_HORIZON_MS,
  parseMasumiLockDatum,
  validateMasumiExtra,
  verifyMasumiAuthorization,
} from "@x402/cardano";
import { Data } from "@evolution-sdk/evolution";
import {
  attachCardanoWitness,
  cardanoPosixMsToSlot,
  decodeCardanoTx,
  planCardanoEscrowLock,
} from "@zyropay/blockchain";
import { testEd25519PublicKey, testEd25519Sign } from "@zyropay/blockchain/testing";
import { cardanoEnterpriseAddress, cardanoKeyHash } from "@zyropay/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, ESCROW_REPORT_PATH, REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { ESCROW_STATE } from "../src/escrow/datum";
import { ownRegistryClaim } from "../src/escrow/terms";
import type { KvLike } from "../src/escrow/store";
import { blockfrostRoutes, FIXTURE_NOW } from "./fixtures";
import {
  bfTxUtxos,
  chainRoutes,
  ESCROW_ADDRESS,
  SELLER_ADDRESS,
  SELLER_KEY,
  memoryKv,
  SELLER_SEED,
} from "./escrow-fixtures";
import type { FixtureUtxo } from "./escrow-fixtures";
import {
  BLOCKFROST,
  decodeHeader,
  encodeHeader,
  json,
  stubFetch,
  TEST_BASE_ADDRESS,
  TEST_PROJECT_ID,
} from "./helpers";
import type { Route } from "./helpers";

const NOW = FIXTURE_NOW.getTime();
const PREPROD = SlotConfig.SLOT_CONFIG_NETWORK.Preprod;
const slotAt = (ms: number) =>
  Number(PREPROD.zeroSlot) + Math.floor((ms - Number(PREPROD.zeroTime)) / PREPROD.slotLength);
const URL_OK = `https://seller.example${ESCROW_REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;

const PAYER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const PAYER_PK = Buffer.from(testEd25519PublicKey(PAYER_SECRET)).toString("hex");
const PAYER = cardanoEnterpriseAddress(PAYER_PK, "cardano-preprod");
const INPUT_TX = "cd".repeat(32);

function env(kv?: KvLike): Env {
  return {
    SELLER_ADDRESS,
    BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
    SELLER_SIGNING_KEY: SELLER_SEED,
    ...(kv ? { ESCROW_KV: kv } : {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fixture node: everything the embedded facilitator, the report and the spend builder read. */
function node(state: { submitted: Uint8Array[]; lock?: { hash: string; outputs: FixtureUtxo[] } }) {
  const tipMs = NOW - 20_000;
  const base = chainRoutes({
    tipMs,
    txs: {},
    onSubmit: (body) => {
      state.submitted.push(body);
      return json(decodeCardanoTransaction(Buffer.from(body).toString("base64")).txHash);
    },
  });
  const routes: Record<string, Route> = {
    ...blockfrostRoutes(),
    ...base,
    [`${BLOCKFROST}/blocks/latest`]: () =>
      json({
        time: Math.floor(tipMs / 1000),
        slot: slotAt(tipMs),
        height: 4_300_000,
        hash: "c".repeat(64),
      }),
    [`${BLOCKFROST}/txs/`]: (url) => {
      const [, hash, sub] = /\/txs\/([0-9a-f]{64})(\/utxos)?$/.exec(url.pathname) ?? [];
      if (hash === INPUT_TX && sub !== undefined)
        return json(
          bfTxUtxos(INPUT_TX, [
            { txHash: INPUT_TX, index: 0, address: PAYER, lovelace: 20_000_000n },
          ]),
        );
      if (hash !== undefined && hash === state.lock?.hash && sub !== undefined)
        return json(bfTxUtxos(hash, state.lock.outputs));
      const known = state.submitted.some(
        (b) => decodeCardanoTransaction(Buffer.from(b).toString("base64")).txHash === hash,
      );
      if (hash !== undefined && sub === undefined && known)
        return json({ hash, block_height: 4_300_000, slot: slotAt(NOW), valid_contract: true });
      return json({ status_code: 404, error: "Not Found", message: "not found" }, 404);
    },
  };
  return routes;
}

async function get402(app: ReturnType<typeof createApp>) {
  const res = await app.request(URL_OK, { headers: { accept: "application/json" } });
  expect(res.status).toBe(402);
  return decodeHeader(res.headers.get("PAYMENT-REQUIRED"));
}

describe("the escrow 402", () => {
  it("is a seller-signed Masumi quote @x402/cardano's client checks accept", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp(env(), { now: () => new Date(NOW) });
    const required = await get402(app);
    expect(required.resource.url).toBe(URL_OK);
    expect(required.accepts).toHaveLength(1);
    const accepted = required.accepts[0];
    expect(accepted).toMatchObject({
      scheme: "exact",
      network: "cardano:preprod",
      asset: "lovelace",
      amount: "5000000",
      payTo: ESCROW_ADDRESS,
      maxTimeoutSeconds: 300,
    });
    expect(ESCROW_ADDRESS).toBe("addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g");
    const schema = validateMasumiExtra(accepted.extra, accepted.network);
    expect(schema.ok).toBe(true);
    const auth = await verifyMasumiAuthorization(accepted.extra, accepted, {
      requireAllPartContent: true,
      maxDeadlineHorizonMs: MASUMI_MAX_DEADLINE_HORIZON_MS,
    });
    expect(auth).toMatchObject({ ok: true, escrowAddress: ESCROW_ADDRESS });
    const extra = accepted.extra as CardanoExtraMasumi;
    expect(extra.assetTransferMethod).toBe("masumi");
    expect(extra.terms.sellerAddress).toBe(SELLER_ADDRESS);
    expect(extra.inputCommitment.parts[0]?.content).toEqual({ url: URL_OK });
    // Demo timeline: payBy +5, submit +15, unlock +30, dispute +45 minutes.
    const t = extra.terms;
    expect(Number(t.payByTime)).toBe(NOW + 300_000);
    expect(Number(t.submitResultTime) - NOW).toBe(15 * 60_000);
    expect(Number(t.unlockTime) - NOW).toBe(30 * 60_000);
    expect(Number(t.externalDisputeUnlockTime) - NOW).toBe(45 * 60_000);
    // At 5 tADA the buyer locks exactly the price: collateral_return_lovelace = 0.
    const lock = buildMasumiLock(extra, PAYER, "lovelace", 5_000_000n, 4310n);
    expect(lock.collateralLovelace).toBe(0n);
    expect(lock.lockedLovelace).toBe(5_000_000n);
    // A fresh quote per 402.
    const again = await get402(app);
    expect(again.accepts[0].extra.terms.sellerNonce).not.toBe(t.sellerNonce);
  });

  it("the default route is unchanged and the info route describes the escrow route", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp(env(), { now: () => new Date(NOW) });
    const res = await app.request(
      `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`,
    );
    expect(res.status).toBe(402);
    const accepted = decodeHeader(res.headers.get("PAYMENT-REQUIRED")).accepts[0];
    expect(accepted.payTo).toBe(SELLER_ADDRESS);
    expect(accepted.extra.assetTransferMethod).toBeUndefined();
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.escrowRoute).toMatchObject({
      enabled: true,
      payTo: ESCROW_ADDRESS,
      priceLovelace: "5000000",
    });
  });

  it("is 503 (never a 402) without the seller key", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp({ SELLER_ADDRESS, BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID });
    expect((await app.request(URL_OK)).status).toBe(503);
  });

  it("refuses a price below the collateral-free threshold", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp({ ...env(), ESCROW_PRICE_LOVELACE: "2000000" });
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.escrowRoute.enabled).toBe(false);
    expect(info.escrowRoute.problems.join(" ")).toContain("ESCROW_PRICE_LOVELACE");
  });
});

/** A registry V2 identifier (fixture; any asset name with a valid nonce byte). */
const AGENT_ID = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"10".padEnd(64, "e")}`;

describe("a registered seller (MASUMI_AGENT_IDENTIFIER)", () => {
  const registered = (kv?: KvLike): Env => ({ ...env(kv), MASUMI_AGENT_IDENTIFIER: AGENT_ID });

  it("every escrow 402 claims the identity; @x402/cardano honours it only with a validator", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp(registered(), { now: () => new Date(NOW) });
    const required = await get402(app);
    const accepted = required.accepts[0];
    expect(accepted.extra.terms.agentIdentifier).toBe(AGENT_ID);
    // Unvalidated, a claim is refused (the spec rule ZyroPay's registry check satisfies).
    expect(
      await verifyMasumiAuthorization(accepted.extra, accepted, { requireAllPartContent: true }),
    ).toMatchObject({ ok: false });
    const claim = {
      agentIdentifier: AGENT_ID,
      sellerAddress: SELLER_ADDRESS,
      network: "cardano:preprod",
      asset: "lovelace",
      amount: "5000000",
    };
    const auth = await verifyMasumiAuthorization(accepted.extra, accepted, {
      requireAllPartContent: true,
      resource: required.resource,
      validateRegistryClaim: ownRegistryClaim(claim),
    });
    expect(auth).toMatchObject({ ok: true, escrowAddress: ESCROW_ADDRESS });
    // The seller vouches for its own identity only.
    const other = { ...claim, agentIdentifier: `${AGENT_ID.slice(0, 119)}f` };
    const resource = required.resource;
    const own = ownRegistryClaim(claim);
    expect(await own({ ...other, resource })).toBe(false);
    expect(await own({ ...claim, sellerAddress: PAYER, resource })).toBe(false);
    expect(await own({ ...claim, amount: "4000000", resource })).toBe(false);
    // The info route names the claim; the default route makes none.
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.escrowRoute.masumiAgentIdentifier).toBe(AGENT_ID);
    const plain = await app.request(
      `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}`,
    );
    const direct = decodeHeader(plain.headers.get("PAYMENT-REQUIRED")).accepts[0];
    expect(direct.extra.terms).toBeUndefined();
  });

  it("the lock (datum agent_identifier) settles through the embedded facilitator", async () => {
    const state: { submitted: Uint8Array[]; lock?: { hash: string; outputs: FixtureUtxo[] } } = {
      submitted: [],
    };
    stubFetch(node(state));
    const tasks: Promise<unknown>[] = [];
    const deps = { now: () => new Date(NOW), background: (t: Promise<unknown>) => tasks.push(t) };
    const required = await get402(createApp(registered(memoryKv()), deps));
    const accepted = required.accepts[0];
    const lock = buyerLock(accepted);
    expect(parseMasumiLockDatum(lock.datumCbor)?.agentIdentifier).toBe(AGENT_ID);
    state.lock = {
      hash: lock.txHash,
      outputs: [
        {
          txHash: lock.txHash,
          index: 0,
          address: ESCROW_ADDRESS,
          lovelace: lock.lockedLovelace,
          inlineDatum: lock.datumCbor,
        },
      ],
    };
    const paid = await createApp(registered(memoryKv()), deps).request(URL_OK, {
      headers: {
        accept: "application/json",
        "PAYMENT-SIGNATURE": encodeHeader({
          x402Version: 2,
          resource: required.resource,
          accepted,
          payload: {
            transaction: Buffer.from(lock.signedTransaction, "hex").toString("base64"),
            nonce: `${INPUT_TX}#0`,
          },
        }),
      },
    });
    expect(paid.status).toBe(200);
    expect(decodeHeader(paid.headers.get("PAYMENT-RESPONSE"))).toMatchObject({
      success: true,
      transaction: lock.txHash,
    });
    await Promise.all(tasks);
  });

  it("is refused at startup with a hosted facilitator (it cannot verify the claim)", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp({ ...registered(), FACILITATOR_MODE: "hosted" });
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.escrowRoute.enabled).toBe(false);
    expect(info.escrowRoute.problems.join(" ")).toContain("MASUMI_AGENT_IDENTIFIER");
  });
});

/** The buyer's signed lock for `accepted`, built as ZyroPay builds it. */
function buyerLock(accepted: any) {
  const extra = accepted.extra as CardanoExtraMasumi;
  const lock = buildMasumiLock(extra, PAYER, "lovelace", BigInt(accepted.amount), 4310n);
  const datumCbor = Data.toCBORHex(lock.datum.data);
  const plan = planCardanoEscrowLock({
    network: "cardano-preprod",
    from: PAYER,
    escrowAddress: ESCROW_ADDRESS,
    lovelace: lock.lockedLovelace,
    datumCbor,
    ttlSlot: cardanoPosixMsToSlot("cardano-preprod", BigInt(extra.terms.payByTime), "floor"),
    requiredInput: { txHash: INPUT_TX, index: 0 },
    utxos: [
      {
        tx_hash: INPUT_TX,
        output_index: 0,
        amount: [{ unit: "lovelace", quantity: "20000000" }],
        data_hash: null,
        inline_datum: null,
        reference_script_hash: null,
      },
    ],
    params: {
      minFeeA: 44n,
      minFeeB: 155381n,
      coinsPerUtxoByte: 4310n,
      maxTxSize: 16384,
      maxValSize: 5000,
    },
  });
  const signature = Buffer.from(
    testEd25519Sign(PAYER_SECRET, Buffer.from(plan.bodyHash, "hex")),
  ).toString("hex");
  const signed = attachCardanoWitness({
    unsignedHex: plan.serialized,
    publicKey: PAYER_PK,
    signature,
    expectedKeyHash: cardanoKeyHash(PAYER_PK),
  });
  return { ...signed, datumCbor, lockedLovelace: lock.lockedLovelace };
}

describe("paying into escrow", () => {
  it("lock verified + settled by the embedded facilitator; result hash = receipt hash; SubmitResult follows", async () => {
    const state: { submitted: Uint8Array[]; lock?: { hash: string; outputs: FixtureUtxo[] } } = {
      submitted: [],
    };
    stubFetch(node(state));
    const kv = memoryKv();
    const tasks: Promise<unknown>[] = [];
    const app = createApp(env(kv), { now: () => new Date(NOW), background: (t) => tasks.push(t) });
    const required = await get402(app);
    const accepted = required.accepts[0];
    const lock = buyerLock(accepted);
    state.lock = {
      hash: lock.txHash,
      outputs: [
        {
          txHash: lock.txHash,
          index: 0,
          address: ESCROW_ADDRESS,
          lovelace: lock.lockedLovelace,
          inlineDatum: lock.datumCbor,
        },
      ],
    };

    // The paid retry lands on ANOTHER isolate (a fresh app): the quote is admitted because
    // it carries this seller's own COSE signature over the exact URL.
    const isolate = createApp(env(kv), {
      now: () => new Date(NOW),
      background: (t) => tasks.push(t),
    });
    const paid = await isolate.request(URL_OK, {
      headers: {
        accept: "application/json",
        "PAYMENT-SIGNATURE": encodeHeader({
          x402Version: 2,
          resource: required.resource,
          accepted,
          payload: {
            transaction: Buffer.from(lock.signedTransaction, "hex").toString("base64"),
            nonce: `${INPUT_TX}#0`,
          },
        }),
      },
    });
    expect(paid.status).toBe(200);
    const settlement = decodeHeader(paid.headers.get("PAYMENT-RESPONSE"));
    expect(settlement).toMatchObject({ success: true, transaction: lock.txHash });
    // The facilitator broadcast the lock.
    expect(state.submitted).toHaveLength(1);
    const body = new Uint8Array(await paid.arrayBuffer());
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(body).digest("hex");
    expect(paid.headers.get("X-Escrow-Result-Hash")).toBe(sha);
    expect(paid.headers.get("X-Escrow-Id")).toBe(accepted.extra.blockchainIdentifier);
    const receipt = JSON.parse(
      Buffer.from(paid.headers.get("X-Delivery-Receipt")!, "base64").toString(),
    );
    expect(receipt.contentSha256).toBe(sha);
    expect(receipt.paymentTx).toBe(lock.txHash);

    // After the response: the record is stored and the SubmitResult is submitted.
    await Promise.all(tasks);
    expect(state.submitted).toHaveLength(2);
    const submitTx = decodeCardanoTx(state.submitted[1]!);
    expect(Buffer.from(submitTx.redeemers[0]!.dataBytes).toString("hex")).toBe("d87e80");
    expect(submitTx.requiredSigners).toEqual([SELLER_KEY.keyHash]);
    expect(submitTx.inputs.some((i) => i.txHash === lock.txHash && i.index === 0)).toBe(true);
    const out = submitTx.outputs.find((o) => o.address === ESCROW_ADDRESS)!;
    const next = parseMasumiLockDatum(Buffer.from(out.inlineDatum!).toString("hex"))!;
    expect(next.state).toBe(ESCROW_STATE.ResultSubmitted);
    expect(next.resultHash).toBe(sha);
    const record = JSON.parse(kv.data.get(`escrow:${accepted.extra.terms.sellerNonce}`)!);
    expect(record).toMatchObject({
      lockTx: lock.txHash,
      resultHash: sha,
      resultTx: submitTx.bodyHash,
    });
  });

  it("a paid retry for another URL's quote is not served", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp(env(), { now: () => new Date(NOW) });
    const required = await get402(app);
    const other = `https://seller.example${ESCROW_REPORT_PATH}?address=${PAYER}`;
    const fresh = createApp(env(), { now: () => new Date(NOW) }); // another isolate
    const lock = buyerLock(required.accepts[0]);
    const res = await fresh.request(other, {
      headers: {
        "PAYMENT-SIGNATURE": encodeHeader({
          x402Version: 2,
          resource: { ...required.resource, url: other },
          accepted: required.accepts[0],
          payload: {
            transaction: Buffer.from(lock.signedTransaction, "hex").toString("base64"),
            nonce: `${INPUT_TX}#0`,
          },
        }),
      },
    });
    expect(res.status).toBe(402);
  });
});

describe("dishonest-seller demo switch (DEMO_DISHONEST_MODE)", () => {
  const demoUrl = (mode: string) => `${URL_OK}&demo=${mode}`;

  /** Pay the escrow route at `url` from a fresh isolate; returns the paid response + state. */
  async function payEscrow(url: string, extraEnv: Partial<Env>) {
    const state: { submitted: Uint8Array[]; lock?: { hash: string; outputs: FixtureUtxo[] } } = {
      submitted: [],
    };
    stubFetch(node(state));
    const kv = memoryKv();
    const tasks: Promise<unknown>[] = [];
    const mk = () =>
      createApp(
        { ...env(kv), ...extraEnv },
        {
          now: () => new Date(NOW),
          background: (t) => tasks.push(t),
        },
      );
    const first = await mk().request(url, { headers: { accept: "application/json" } });
    expect(first.status).toBe(402);
    const required = decodeHeader(first.headers.get("PAYMENT-REQUIRED"));
    const accepted = required.accepts[0];
    const lock = buyerLock(accepted);
    state.lock = {
      hash: lock.txHash,
      outputs: [
        {
          txHash: lock.txHash,
          index: 0,
          address: ESCROW_ADDRESS,
          lovelace: lock.lockedLovelace,
          inlineDatum: lock.datumCbor,
        },
      ],
    };
    const paid = await mk().request(url, {
      headers: {
        accept: "application/json",
        "PAYMENT-SIGNATURE": encodeHeader({
          x402Version: 2,
          resource: required.resource,
          accepted,
          payload: {
            transaction: Buffer.from(lock.signedTransaction, "hex").toString("base64"),
            nonce: `${INPUT_TX}#0`,
          },
        }),
      },
    });
    await Promise.all(tasks);
    return { first, paid, state, kv, accepted, lock };
  }

  it("is off by default: ?demo is a 400 before any 402, on both routes", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp(env());
    const res = await app.request(demoUrl("tamper"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("disabled");
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.demoDishonestMode).toEqual({ enabled: false });
    const on = createApp({ ...env(), DEMO_DISHONEST_MODE: "enabled" });
    const onDefault = await on.request(
      `https://seller.example${REPORT_PATH}?address=${TEST_BASE_ADDRESS}&demo=tamper`,
    );
    expect(onDefault.status).toBe(400);
    expect((await on.request(demoUrl("lie"))).status).toBe(400);
    expect((await on.request(`${demoUrl("tamper")}&demo=nodelivery`)).status).toBe(400);
    // Anything but the exact value keeps it off.
    const almost = createApp({ ...env(), DEMO_DISHONEST_MODE: "true" });
    expect((await almost.request(demoUrl("tamper"))).status).toBe(400);
  });

  it("labels the 402 and leaves honest requests unlabelled", async () => {
    stubFetch(node({ submitted: [] }));
    const app = createApp(
      { ...env(), DEMO_DISHONEST_MODE: "enabled" },
      { now: () => new Date(NOW) },
    );
    const demo = await app.request(demoUrl("tamper"));
    expect(demo.status).toBe(402);
    expect(demo.headers.get("X-Demo-Mode")).toBe("tamper");
    const honest = await app.request(URL_OK);
    expect(honest.status).toBe(402);
    expect(honest.headers.get("X-Demo-Mode")).toBeNull();
    const info = (await (await app.request("https://seller.example/")).json()) as any;
    expect(info.demoDishonestMode).toMatchObject({
      enabled: true,
      modes: ["tamper", "nodelivery"],
    });
  });

  it("tamper: the real report's hash goes on chain, different bytes are delivered", async () => {
    const { paid, state, kv, accepted, lock } = await payEscrow(demoUrl("tamper"), {
      DEMO_DISHONEST_MODE: "enabled",
    });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("X-Demo-Mode")).toBe("tamper");
    const body = new Uint8Array(await paid.arrayBuffer());
    const { createHash } = await import("node:crypto");
    const deliveredSha = createHash("sha256").update(body).digest("hex");
    const onChain = paid.headers.get("X-Escrow-Result-Hash")!;
    expect(onChain).not.toBe(deliveredSha);
    const delivered = JSON.parse(Buffer.from(body).toString());
    expect(delivered.demo.mode).toBe("tamper");
    expect(delivered.riskScore).toBe(0);
    // The receipt signs what was delivered: it disagrees with the on-chain result hash.
    const receipt = decodeHeader(paid.headers.get("X-Delivery-Receipt"));
    expect(receipt.contentSha256).toBe(deliveredSha);
    // SubmitResult carries the hash of the REAL report.
    expect(state.submitted).toHaveLength(2);
    const submitTx = decodeCardanoTx(state.submitted[1]!);
    const out = submitTx.outputs.find((o) => o.address === ESCROW_ADDRESS)!;
    const next = parseMasumiLockDatum(Buffer.from(out.inlineDatum!).toString("hex"))!;
    expect(next.resultHash).toBe(onChain);
    const record = JSON.parse(kv.data.get(`escrow:${accepted.extra.terms.sellerNonce}`)!);
    expect(record).toMatchObject({ lockTx: lock.txHash, resultHash: onChain });
  });

  it("nodelivery: the lock settles, nothing is delivered, recorded or submitted", async () => {
    const { paid, state, kv } = await payEscrow(demoUrl("nodelivery"), {
      DEMO_DISHONEST_MODE: "enabled",
    });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("X-Demo-Mode")).toBe("nodelivery");
    expect(paid.headers.get("X-Escrow-Result-Hash")).toBeNull();
    expect(paid.headers.get("X-Escrow-Id")).not.toBeNull();
    const body = (await paid.json()) as any;
    expect(body).toMatchObject({ delivered: false, demo: { mode: "nodelivery" } });
    expect(state.submitted).toHaveLength(1); // the lock only
    expect(kv.data.size).toBe(0);
  });
});
