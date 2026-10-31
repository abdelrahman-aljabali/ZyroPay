/*
 * Sweeper decisions (pure, time-based) and one full offline sweep and status lookup through
 * the app, against fixture Blockfrost. TEST KEYS ONLY; nothing is submitted for real.
 */
import { Data } from "@evolution-sdk/evolution";
import type { MasumiDatumView } from "@x402/cardano";
import { parseMasumiLockDatum } from "@x402/cardano";
import { decodeCardanoTx } from "@zyropay/blockchain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Env } from "../src/config";
import {
  authorizeRefundDatum,
  datumMentionsKeyHash,
  ESCROW_STATE,
  submitResultDatum,
} from "../src/escrow/datum";
import { escrowRuntime } from "../src/escrow/runtime";
import type { EscrowRecord } from "../src/escrow/store";
import type { DecideContext, EscrowCandidate } from "../src/escrow/sweeper";
import { decide, sweep } from "../src/escrow/sweeper";
import type { FixtureUtxo } from "./escrow-fixtures";
import {
  bfTxUtxos,
  chainRoutes,
  ESCROW_ADDRESS,
  issueQuote,
  lockDatumHex,
  memoryKv,
  SELLER_ADDRESS,
  SELLER_KEY,
  SELLER_SEED,
} from "./escrow-fixtures";
import { BLOCKFROST, json, stubFetch, TEST_PROJECT_ID } from "./helpers";
import type { Route } from "./helpers";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const URL_OK = "https://seller.example/v1/address-report/escrow?address=addr_test1xyz";
const LOCK = "a".repeat(64);
const HASH = "ab".repeat(32);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Datum hex for each state, derived from one real lock datum. */
async function datums() {
  const quote = await issueQuote(NOW, URL_OK);
  const { datum, lockedLovelace } = lockDatumHex(quote);
  const lock = Data.fromCBORHex(datum);
  const view = parseMasumiLockDatum(datum)!;
  const withState = (state: bigint, buyerCooldown: bigint) => {
    if (!Data.isConstr(lock)) throw new Error("datum");
    const f = [...lock.fields];
    f[17] = Data.int(buyerCooldown);
    f[18] = Data.constr(state, []);
    return Data.toCBORHex(Data.constr(0n, f));
  };
  return {
    quote,
    view,
    lockedLovelace,
    locked: datum,
    submitted: Data.toCBORHex(submitResultDatum(lock, view, HASH, BigInt(NOW + 420_000))),
    refundRequested: withState(ESCROW_STATE.RefundRequested, BigInt(NOW + 420_000)),
    refundAuthorized: Data.toCBORHex(authorizeRefundDatum(lock, BigInt(NOW + 420_000))),
  };
}

function ctx(over: Partial<DecideContext> = {}): DecideContext {
  return {
    sellerKeyHash: SELLER_KEY.keyHash,
    sellerPublicKey: SELLER_KEY.publicKey,
    tipMs: BigInt(NOW),
    autoAuthorizeRefunds: true,
    record: null,
    ...over,
  };
}

const record = (over: Partial<EscrowRecord> = {}): EscrowRecord => ({
  lockTx: LOCK,
  sellerNonce: "",
  blockchainIdentifier: "",
  resultHash: HASH,
  resourceUrl: URL_OK,
  createdAt: new Date(NOW).toISOString(),
  ...over,
});

const candidate = (
  view: MasumiDatumView,
  over: Partial<EscrowCandidate> = {},
): EscrowCandidate => ({
  txHash: LOCK,
  index: 0,
  lovelace: 5_000_000n,
  hasReferenceScript: false,
  view,
  ...over,
});

describe("decide", () => {
  it("FundsLocked: SubmitResult only for our delivered lock, only before the submit deadline", async () => {
    const d = await datums();
    const v = d.view;
    const mine = record({ sellerNonce: v.sellerNonce });
    expect(decide(candidate(v), ctx({ record: mine }))).toEqual({
      action: "SubmitResult",
      resultHash: HASH,
    });
    expect(decide(candidate(v), ctx())).toMatchObject({
      action: null,
      reason: /no delivered result/,
    });
    // A different UTxO carrying a copy of the datum is not the lock we were paid with.
    expect(decide(candidate(v, { txHash: "e".repeat(64) }), ctx({ record: mine }))).toMatchObject({
      action: null,
    });
    // Already submitted (record carries the tx): nothing more to do.
    expect(
      decide(candidate(v), ctx({ record: { ...mine, resultTx: "f".repeat(64) } })),
    ).toMatchObject({
      action: null,
    });
    // Too close to submit_result_time.
    const late = ctx({ record: mine, tipMs: v.submitResultTime - 60_000n });
    expect(decide(candidate(v), late)).toMatchObject({ action: null, reason: /window/ });
  });

  it("RefundRequested: authorize (auto) or, with auto off, submit our result", async () => {
    const d = await datums();
    const v = parseMasumiLockDatum(d.refundRequested)!;
    expect(decide(candidate(v), ctx())).toEqual({ action: "AuthorizeRefund" });
    const mine = record({ sellerNonce: v.sellerNonce });
    expect(decide(candidate(v), ctx({ autoAuthorizeRefunds: false, record: mine }))).toEqual({
      action: "SubmitResult",
      resultHash: HASH,
    });
    expect(decide(candidate(v), ctx({ autoAuthorizeRefunds: false }))).toMatchObject({
      action: null,
      reason: /auto-authorize is off/,
    });
  });

  it("Disputed: AuthorizeRefund waits for the seller cooldown after SubmitResult", async () => {
    const d = await datums();
    const base = parseMasumiLockDatum(d.submitted)!;
    const v: MasumiDatumView = { ...base, state: ESCROW_STATE.Disputed };
    expect(decide(candidate(v), ctx({ tipMs: base.sellerCooldownTime - 1_000n }))).toMatchObject({
      action: null,
      reason: /too early/,
    });
    expect(decide(candidate(v), ctx({ tipMs: base.sellerCooldownTime + 1_000n }))).toEqual({
      action: "AuthorizeRefund",
    });
    expect(
      decide(
        candidate(v),
        ctx({ autoAuthorizeRefunds: false, tipMs: base.sellerCooldownTime + 1_000n }),
      ),
    ).toMatchObject({ action: null, reason: /admins/ });
  });

  it("ResultSubmitted: Withdraw only after unlock_time", async () => {
    const d = await datums();
    const v = parseMasumiLockDatum(d.submitted)!;
    expect(decide(candidate(v), ctx({ tipMs: v.unlockTime - 1_000n }))).toMatchObject({
      action: null,
      reason: /too early/,
    });
    expect(decide(candidate(v), ctx({ tipMs: v.unlockTime + 1_000n }))).toEqual({
      action: "Withdraw",
    });
  });

  it("RefundAuthorized: nothing (the buyer withdraws)", async () => {
    const d = await datums();
    const v = parseMasumiLockDatum(d.refundAuthorized)!;
    expect(decide(candidate(v), ctx())).toMatchObject({ action: null, reason: /buyer withdraws/ });
  });

  it("refuses escrows that are not provably ours or not worth a fee", async () => {
    const d = await datums();
    const v = parseMasumiLockDatum(d.refundRequested)!;
    expect(decide(candidate(v), ctx({ sellerKeyHash: "00".repeat(28) }))).toMatchObject({
      reason: "not our escrow",
    });
    expect(decide(candidate(v), ctx({ sellerPublicKey: "11".repeat(32) }))).toMatchObject({
      reason: "reference key is not ours",
    });
    expect(decide(candidate(v, { lovelace: 1_000_000n }), ctx())).toMatchObject({
      reason: /minimum price/,
    });
    expect(decide(candidate(v, { hasReferenceScript: true }), ctx())).toMatchObject({
      reason: /reference script/,
    });
  });
});

function env(kv = memoryKv()): Env {
  return {
    SELLER_ADDRESS,
    BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
    SELLER_SIGNING_KEY: SELLER_SEED,
    ESCROW_KV: kv,
  };
}

describe("datumMentionsKeyHash", () => {
  it("is true for our lock datum and false for another seller's or a missing datum", async () => {
    const { datum } = lockDatumHex(await issueQuote(NOW, URL_OK));
    expect(datumMentionsKeyHash(datum, SELLER_KEY.keyHash)).toBe(true);
    expect(datumMentionsKeyHash(datum.toUpperCase(), SELLER_KEY.keyHash)).toBe(true);
    expect(datumMentionsKeyHash(datum, "0".repeat(56))).toBe(false);
    expect(datumMentionsKeyHash(null, SELLER_KEY.keyHash)).toBe(false);
  });
});

describe("sweep (offline, fixture chain)", () => {
  it("authorizes a refund request, leaves others alone, and submits through Blockfrost", async () => {
    const d = await datums();
    const submitted: Uint8Array[] = [];
    const requestTx = "b".repeat(64);
    const escrowUtxos: FixtureUtxo[] = [
      {
        txHash: requestTx,
        index: 0,
        address: ESCROW_ADDRESS,
        lovelace: d.lockedLovelace,
        inlineDatum: d.refundRequested,
      },
      // Someone else's escrow and a junk output at the same address.
      {
        txHash: "9".repeat(64),
        index: 0,
        address: ESCROW_ADDRESS,
        lovelace: 9_000_000n,
        inlineDatum: null,
      },
    ];
    stubFetch(
      chainRoutes({
        tipMs: NOW,
        txs: { [requestTx]: [escrowUtxos[0]!] },
        escrowUtxos,
        onSubmit: (body) => {
          submitted.push(body);
          return json(decodeCardanoTx(body).bodyHash);
        },
      }),
    );
    const e = env();
    const config = loadConfig(e);
    if (!config.ok) throw new Error(config.problems.join());
    const rt = escrowRuntime(e, config.config);
    if (!rt.enabled) throw new Error(rt.problems.join());
    const entries = await sweep(rt.sweepDeps());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      escrow: `${requestTx}#0`,
      state: "refund_requested",
      action: "AuthorizeRefund",
    });
    expect(submitted).toHaveLength(1);
    const tx = decodeCardanoTx(submitted[0]!);
    expect(entries[0]!.txHash).toBe(tx.bodyHash);
    expect(Buffer.from(tx.redeemers[0]!.dataBytes).toString("hex")).toBe("d87f80");
    const out = tx.outputs.find((o) => o.address === ESCROW_ADDRESS)!;
    expect(parseMasumiLockDatum(Buffer.from(out.inlineDatum!).toString("hex"))!.state).toBe(
      ESCROW_STATE.RefundAuthorized,
    );
  });

  it("submits a pending KV result for a lock beyond the scanned pages", async () => {
    const d = await datums();
    const submitted: Uint8Array[] = [];
    const kv = memoryKv();
    const v = d.view;
    await kv.put(`escrow:${v.sellerNonce}`, JSON.stringify(record({ sellerNonce: v.sellerNonce })));
    stubFetch(
      chainRoutes({
        tipMs: NOW + 400_000,
        txs: {
          [LOCK]: [
            {
              txHash: LOCK,
              index: 0,
              address: ESCROW_ADDRESS,
              lovelace: d.lockedLovelace,
              inlineDatum: d.locked,
            },
          ],
        },
        escrowUtxos: [],
        onSubmit: (body) => {
          submitted.push(body);
          return json(decodeCardanoTx(body).bodyHash);
        },
      }),
    );
    const e = env(kv);
    const config = loadConfig(e);
    if (!config.ok) throw new Error(config.problems.join());
    const rt = escrowRuntime(e, config.config);
    if (!rt.enabled) throw new Error("disabled");
    const entries = await sweep(rt.sweepDeps());
    expect(entries[0]).toMatchObject({ action: "SubmitResult", state: "locked" });
    const tx = decodeCardanoTx(submitted[0]!);
    expect(Buffer.from(tx.redeemers[0]!.dataBytes).toString("hex")).toBe("d87e80");
    const saved = JSON.parse(kv.data.get(`escrow:${v.sellerNonce}`)!);
    expect(saved.resultTx).toBe(tx.bodyHash);
    // The next run finds nothing pending.
    expect(await rt.store.pending()).toEqual([]);
  });
});

describe("GET /v1/escrow/:id", () => {
  function chainOf(chain: Record<string, FixtureUtxo[]>) {
    const routes: Record<string, Route> = {
      ...chainRoutes({ tipMs: NOW, txs: {} }),
      [`${BLOCKFROST}/txs/`]: (url) => {
        const [, hash] = /\/txs\/([0-9a-f]{64})\/utxos$/.exec(url.pathname) ?? [];
        const outputs = hash === undefined ? undefined : chain[hash];
        return outputs === undefined
          ? json({ status_code: 404, error: "Not Found", message: "not found" }, 404)
          : json(bfTxUtxos(hash!, outputs));
      },
    };
    stubFetch(routes);
    return createApp(env(), { now: () => new Date(NOW) });
  }
  const esc = (
    txHash: string,
    inlineDatum: string,
    consumedBy: string | null = null,
  ): FixtureUtxo => ({
    txHash,
    index: 0,
    address: ESCROW_ADDRESS,
    lovelace: 5_000_000n,
    inlineDatum,
    consumedBy,
  });
  const change = (txHash: string): FixtureUtxo => ({
    txHash,
    index: 0,
    address: SELLER_ADDRESS,
    lovelace: 4_000_000n,
  });

  it("follows the lock through SubmitResult to Withdraw", async () => {
    const d = await datums();
    const [t1, t2, t3] = ["1a".repeat(32), "2b".repeat(32), "3c".repeat(32)];
    const app = chainOf({
      [t1]: [esc(t1, d.locked, t2)],
      [t2]: [esc(t2, d.submitted, t3), change(t2)],
      [t3]: [change(t3)],
    });
    const res = await app.request(`https://seller.example/v1/escrow/${t1}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      status: "withdrawn",
      lockTx: t1,
      utxo: null,
      closedBy: t3,
      resultHash: HASH,
      lockedLovelace: "5000000",
      blockchainIdentifier: d.quote.extra.blockchainIdentifier,
    });
    expect(body.history.map((h: { status: string }) => h.status)).toEqual([
      "locked",
      "result_submitted",
      "withdrawn",
    ]);
  });

  it("locked / refund requested -> refund authorized -> refunded / pending", async () => {
    const d = await datums();
    const [t1, t2, t3, t4] = ["1a".repeat(32), "2b".repeat(32), "3c".repeat(32), "4d".repeat(32)];
    let app = chainOf({ [t1]: [esc(t1, d.locked)] });
    let body = (await (await app.request(`https://seller.example/v1/escrow/${t1}`)).json()) as any;
    expect(body).toMatchObject({ status: "locked", utxo: { txHash: t1, index: 0 } });
    expect(body.deadlines.submitResult).toBe(
      new Date(Number(d.view.submitResultTime)).toISOString(),
    );

    app = chainOf({
      [t1]: [esc(t1, d.locked, t2)],
      [t2]: [esc(t2, d.refundRequested, t3)],
      [t3]: [esc(t3, d.refundAuthorized, t4)],
      [t4]: [change(t4)],
    });
    body = (await (await app.request(`https://seller.example/v1/escrow/${t1}`)).json()) as any;
    expect(body.status).toBe("refunded");
    expect(body.history.map((h: { status: string }) => h.status)).toEqual([
      "locked",
      "refund_requested",
      "refund_authorized",
      "refunded",
    ]);

    app = chainOf({});
    body = (await (await app.request(`https://seller.example/v1/escrow/${t1}`)).json()) as any;
    expect(body.status).toBe("pending");
  });

  it("finds a live escrow by blockchainIdentifier; rejects junk ids", async () => {
    const d = await datums();
    const t1 = "1a".repeat(32);
    stubFetch(chainRoutes({ tipMs: NOW, txs: {}, escrowUtxos: [esc(t1, d.refundRequested)] }));
    const app = createApp(env(), { now: () => new Date(NOW) });
    const id = String(d.quote.extra.blockchainIdentifier);
    const res = await app.request(`https://seller.example/v1/escrow/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "refund_requested", utxo: { txHash: t1 } });
    expect((await app.request("https://seller.example/v1/escrow/zz-not-an-id")).status).toBe(400);
  });
});
