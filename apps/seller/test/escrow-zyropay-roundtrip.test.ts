/*
 * Cross-implementation round trip of the Masumi escrow (x402 `assetTransferMethod: "masumi"`),
 * offline: the SELLER (this app: escrow route, @x402/cardano quote issuance, embedded
 * facilitator, receipts, Evolution-built SubmitResult / AuthorizeRefund, the sweeper)
 * against the BUYER side of ZyroPay (@zyropay/integrations x402 adapter + masumi
 * validation, @zyropay/blockchain codec, the API's real EscrowChain from
 * apps/api/src/escrow-chain.ts, the API's receipt check and escrow state rules).
 *
 * One stateful fake chain answers every Blockfrost call from both sides. Each submitted
 * transaction is decoded and checked before it is applied, so every step spends the
 * previous step's REAL outputs:
 *   - ledger rules: inputs (and collateral) exist and are unspent, the validity interval
 *     contains the tip, every vkey witness verifies, every key input and required signer is
 *     witnessed, value is conserved, script_data_hash = blake2b-256(redeemers || language
 *     views), the redeemer points at the escrow input, the script is the escrow's;
 *   - the vested_pay v2 rules of each action (spend spec, vested_pay.ak), re-implemented
 *     here because no UPLC evaluator runs offline: state transitions, the fields each
 *     action may change, cooldowns >= upper bound + cooldown_period, the time gates, who
 *     signs, the continuing output's value.
 * The same rules answer /utils/txs/evaluate/utxos, so a builder whose draft would fail the
 * script sees an EvaluationFailure exactly as with Blockfrost.
 *
 * TEST KEYS ONLY; nothing touches a network or funds.
 */
import { createHash } from "node:crypto";
import { Data } from "@evolution-sdk/evolution";
import type { CardanoExtraMasumi } from "@x402/cardano";
import { MASUMI_DEFAULT_DEPLOYMENT, parseMasumiLockDatum } from "@x402/cardano";
import type { DecodedCardanoTx } from "@zyropay/blockchain";
import {
  attachCardanoWitness,
  cardanoPosixMsToSlot,
  cardanoScriptDataHash,
  cardanoSlotToPosixMs,
  decodeCardanoTx,
  MASUMI_SCRIPT_BYTES,
  MASUMI_SCRIPT_HASH,
  plutusV3LanguageViews,
  verifyVkeyWitness,
} from "@zyropay/blockchain";
import { noSleep, testEd25519PublicKey, testEd25519Sign } from "@zyropay/blockchain/testing";
import type { MasumiEscrowTerms } from "@zyropay/integrations";
import {
  createX402Adapter,
  masumiEscrowTermsOf,
  masumiEscrowView,
  masumiRefundRequestDatum,
} from "@zyropay/integrations";
import type { Broadcaster } from "@zyropay/shared";
import {
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  createCanonicalPayload,
  decodeX402Receipt,
  verifyX402Receipt,
} from "@zyropay/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EscrowChain, EscrowOnChain } from "../../api/src/chain";
import { createRealEscrowChain } from "../../api/src/escrow-chain";
import { createApp, ESCROW_REPORT_PATH } from "../src/app";
import type { Env } from "../src/config";
import { loadConfig } from "../src/config";
import { escrowRuntime } from "../src/escrow/runtime";
import type { KvLike } from "../src/escrow/store";
import { sweep } from "../src/escrow/sweeper";
import {
  ESCROW_ADDRESS,
  memoryKv,
  SELLER_ADDRESS,
  SELLER_KEY,
  SELLER_SEED,
} from "./escrow-fixtures";
import { blockfrostRoutes, FIXTURE_NOW } from "./fixtures";
import { BLOCKFROST, decodeHeader, json, TEST_BASE_ADDRESS, TEST_PROJECT_ID } from "./helpers";

const NETWORK = "cardano-preprod" as const;
const NOW = FIXTURE_NOW.getTime();
const COOLDOWN = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
const URL_OK = `https://seller.example${ESCROW_REPORT_PATH}?address=${TEST_BASE_ADDRESS}`;
/** TEST ONLY: the ZyroPay wallet's key (an enterprise address, as ZyroPay's wallets are). */
const PAYER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
const PAYER_PK = Buffer.from(testEd25519PublicKey(PAYER_SECRET)).toString("hex");
const PAYER = cardanoEnterpriseAddress(PAYER_PK, NETWORK);
const PAYER_KEY_HASH = cardanoKeyHash(PAYER_PK);
const BUYER_FUNDING_TX = "cd".repeat(32);
const SELLER_FUNDING_TX = "ef".repeat(32);
const EX_UNITS = { memory: 1_400_000, steps: 450_000_000 };

/** Synthetic PlutusV3 cost model (297 entries): only its bytes matter offline. */
const PLUTUS_V3_COSTS = Array.from({ length: 297 }, (_, i) => 1000 + i);
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

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const posix = (slot: bigint) => cardanoSlotToPosixMs(NETWORK, slot);
const slotOf = (ms: number | bigint) => cardanoPosixMsToSlot(NETWORK, BigInt(ms), "floor");

// --- the fake chain -----------------------------------------------------------------------

interface ChainOutput {
  readonly address: string;
  readonly lovelace: bigint;
  readonly assets: ReadonlyMap<string, bigint>;
  readonly inlineDatum: string | null;
  consumedBy: string | null;
}

type Action =
  | "Withdraw"
  | "SetRefundRequested"
  | "AuthorizeWithdrawal"
  | "WithdrawRefund"
  | "WithdrawDisputed"
  | "SubmitResult"
  | "AuthorizeRefund";
const ACTIONS: readonly Action[] = [
  "Withdraw",
  "SetRefundRequested",
  "AuthorizeWithdrawal",
  "WithdrawRefund",
  "WithdrawDisputed",
  "SubmitResult",
  "AuthorizeRefund",
];

interface Applied {
  readonly txHash: string;
  readonly tx: DecodedCardanoTx;
  readonly action: Action | null;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const ref = (txHash: string, index: number) => `${txHash}#${index}`;
const sortInputs = <T extends { txHash: string; index: number }>(inputs: readonly T[]) =>
  [...inputs].sort((a, b) =>
    a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1,
  );

/** Datum fields as canonical CBOR hex (structural equality per field). */
function datumFields(datumHex: string): string[] {
  const d = Data.fromCBORHex(datumHex);
  if (!(d instanceof Data.Constr) || d.index !== 0n || d.fields.length !== 19)
    throw new Error("not a vested_pay datum");
  return d.fields.map((f) => Data.toCBORHex(f));
}

class FakeChain {
  readonly txs = new Map<string, ChainOutput[]>();
  readonly applied: Applied[] = [];
  readonly rejected: { reason: string; signers: readonly string[] }[] = [];
  /** Signed size of each submitted transaction (for the minimum fee). */
  private readonly sizeOf = new Map<string, number>();
  /** Test hook: refuse transactions signed by this key hash (a seller outage). */
  refuseSignedBy: string | null = null;

  seed(txHash: string, outputs: Omit<ChainOutput, "consumedBy" | "assets" | "inlineDatum">[]) {
    this.txs.set(
      txHash,
      outputs.map((o) => ({ ...o, assets: new Map(), inlineDatum: null, consumedBy: null })),
    );
  }

  tipMs = () => Date.now();
  tipSlot = () => slotOf(this.tipMs());

  output(txHash: string, index: number): ChainOutput | undefined {
    return this.txs.get(txHash)?.[index];
  }

  utxosAt(address: string) {
    const rows = [];
    for (const [txHash, outputs] of this.txs)
      for (const [index, o] of outputs.entries())
        if (o.address === address && o.consumedBy === null) rows.push(this.row(txHash, index, o));
    return rows;
  }

  balance(address: string): bigint {
    return this.utxosAt(address).reduce(
      (n, r) => n + BigInt(r.amount.find((a) => a.unit === "lovelace")!.quantity),
      0n,
    );
  }

  private amount(o: ChainOutput) {
    return [
      { unit: "lovelace", quantity: o.lovelace.toString() },
      ...[...o.assets].map(([unit, q]) => ({ unit, quantity: q.toString() })),
    ];
  }

  private row(txHash: string, index: number, o: ChainOutput) {
    return {
      address: o.address,
      tx_hash: txHash,
      tx_index: index,
      output_index: index,
      amount: this.amount(o),
      block: "b".repeat(64),
      data_hash: null,
      inline_datum: o.inlineDatum,
      reference_script_hash: null,
    };
  }

  txUtxos(txHash: string) {
    const outputs = this.txs.get(txHash);
    if (outputs === undefined) return null;
    return {
      hash: txHash,
      inputs: [],
      outputs: outputs.map((o, index) => ({
        address: o.address,
        amount: this.amount(o),
        output_index: index,
        data_hash: null,
        inline_datum: o.inlineDatum,
        reference_script_hash: null,
        collateral: false,
        consumed_by_tx: o.consumedBy,
      })),
    };
  }

  /**
   * Why `tx` would be refused (ledger + vested_pay rules), or null. `signed: false` is the
   * evaluation endpoint: witnesses and fee balance are not checked yet.
   */
  check(tx: DecodedCardanoTx, signed: boolean): { reason: string | null; action: Action | null } {
    const no = (reason: string) => ({ reason, action: null });
    const tip = this.tipSlot();
    if (tx.ttl === null || tip >= tx.ttl) return no("outside the validity interval (ttl)");
    if (tx.validityStart !== null && tip < tx.validityStart)
      return no("outside the validity interval (start)");
    const resolved: { input: { txHash: string; index: number }; out: ChainOutput }[] = [];
    for (const input of [...tx.inputs, ...tx.collateral]) {
      const out = this.output(input.txHash, input.index);
      if (out === undefined) return no(`unknown input ${ref(input.txHash, input.index)}`);
      if (out.consumedBy !== null) return no(`input ${ref(input.txHash, input.index)} is spent`);
      resolved.push({ input, out });
    }
    const witnessed = new Set(tx.vkeyWitnesses.map((w) => cardanoKeyHash(w.vkey)));
    if (signed) {
      for (const w of tx.vkeyWitnesses)
        if (!verifyVkeyWitness(tx.bodyHash, w)) return no("a vkey witness does not verify");
      for (const { out } of resolved) {
        const kh = cardanoPaymentKeyHash(out.address);
        if (kh !== null && !witnessed.has(kh)) return no("a key input is not witnessed");
      }
      for (const s of tx.requiredSigners)
        if (!witnessed.has(s)) return no("a required signer did not sign");
      const spent = tx.inputs.reduce((n, i) => n + this.output(i.txHash, i.index)!.lovelace, 0n);
      const made = tx.outputs.reduce((n, o) => n + o.value.coin, 0n);
      if (spent !== made + (tx.fee ?? 0n)) return no("value is not conserved");
      // Ledger minimum fee: size + execution units (no reference scripts are used).
      const size = BigInt(this.sizeOf.get(tx.bodyHash) ?? 0);
      if (size > BigInt(PROTOCOL_PARAMS.max_tx_size)) return no("transaction too large");
      const exec = tx.redeemers.reduce(
        (n, r) => n + ceilDiv(r.mem * 577n, 10_000n) + ceilDiv(r.steps * 721n, 10_000_000n),
        0n,
      );
      const minFee = 44n * size + 155_381n + exec;
      if ((tx.fee ?? 0n) < minFee) return no(`fee below the minimum (${minFee})`);
      if (tx.redeemers.length > 0) {
        // Plutus collateral: >= 150 % of the fee, return + total = collateral inputs.
        const posted = tx.collateral.reduce(
          (n, c) => n + this.output(c.txHash, c.index)!.lovelace,
          0n,
        );
        const total = tx.totalCollateral ?? posted;
        if (total * 100n < (tx.fee ?? 0n) * 150n) return no("insufficient collateral");
        if ((tx.collateralReturn?.value.coin ?? 0n) + total !== posted)
          return no("collateral return does not balance");
      }
    }
    const scriptInputs = sortInputs(tx.inputs).flatMap((input, index) => {
      const out = this.output(input.txHash, input.index)!;
      return out.address === ESCROW_ADDRESS ? [{ input, index, out }] : [];
    });
    if (scriptInputs.length === 0) return { reason: null, action: null };
    if (scriptInputs.length > 1) return no("this harness handles one escrow input per tx");
    const [{ input, index, out }] = scriptInputs as [(typeof scriptInputs)[number]];
    if (tx.plutusV3Scripts.length !== 1 || hex(tx.plutusV3Scripts[0]!) !== hex(MASUMI_SCRIPT_BYTES))
      return no("the escrow script is not attached");
    if (MASUMI_SCRIPT_HASH !== "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad")
      return no("unexpected script hash");
    const redeemerBytes = tx.witnessEntries.get(5);
    if (redeemerBytes === undefined || tx.scriptDataHash === null)
      return no("no redeemers / script_data_hash");
    const sdh = hex(
      cardanoScriptDataHash({
        redeemers: redeemerBytes,
        languageViews: plutusV3LanguageViews(PLUTUS_V3_COSTS.map(BigInt)),
      }),
    );
    if (sdh !== tx.scriptDataHash) return no("script_data_hash mismatch (PPViewHashesDontMatch)");
    if (tx.collateral.length === 0) return no("no collateral");
    const redeemer = tx.redeemers.find((r) => r.tag === 0 && r.index === index);
    if (redeemer === undefined || tx.redeemers.length !== 1)
      return no("the redeemer does not point at the escrow input");
    const r = Data.fromCBORHex(hex(redeemer.dataBytes));
    if (!(r instanceof Data.Constr)) return no("redeemer is not a constructor");
    const action = ACTIONS[Number(r.index)] ?? null;
    if (action === null) return no("unknown action");
    const reason = this.vestedPay(tx, action, input, out);
    return { reason, action: reason === null ? action : null };
  }

  /** vested_pay v2 per-action rules (spec §3, vested_pay.ak). */
  private vestedPay(
    tx: DecodedCardanoTx,
    action: Action,
    input: { txHash: string; index: number },
    out: ChainOutput,
  ): string | null {
    if (out.inlineDatum === null) return "escrow input has no inline datum";
    const v = parseMasumiLockDatum(out.inlineDatum);
    if (v === null) return "escrow datum does not decode";
    const before = datumFields(out.inlineDatum);
    if (tx.ttl === null) return "upper bound must be finite";
    const upper = posix(tx.ttl);
    const lower = tx.validityStart === null ? null : posix(tx.validityStart);
    const startsAfter = (t: bigint) => lower !== null && t <= lower;
    const cooldown = upper + COOLDOWN;
    const signedBy = (h: string) => tx.requiredSigners.includes(h);
    const buyer = v.buyer.payment.hash;
    const seller = v.seller.payment.hash;
    const continuing = tx.outputs.filter(
      (o) =>
        o.address === ESCROW_ADDRESS &&
        o.inlineDatum !== undefined &&
        parseMasumiLockDatum(hex(o.inlineDatum))?.referenceSignature === v.referenceSignature,
    );
    if (tx.outputs.some((o) => o.address === ESCROW_ADDRESS && o.hasScriptRef))
      return "script output with a reference script";
    const next = () => {
      if (continuing.length !== 1) return null;
      const o = continuing[0]!;
      if (o.value.coin < out.lovelace) return null;
      return {
        fields: datumFields(hex(o.inlineDatum!)),
        view: parseMasumiLockDatum(hex(o.inlineDatum!))!,
      };
    };
    /** Every field except `allowed` unchanged. */
    const onlyChanged = (after: string[], allowed: number[]) =>
      after.every((f, i) => allowed.includes(i) || f === before[i]);
    const state = Number(v.state);
    switch (action) {
      case "SetRefundRequested": {
        if (!signedBy(buyer)) return "SetRefundRequested: not signed by the buyer";
        if (![0, 1, 3].includes(state)) return "SetRefundRequested: wrong state";
        if (!(upper < v.unlockTime)) return "SetRefundRequested: upper >= unlock_time";
        if (!startsAfter(v.buyerCooldownTime)) return "SetRefundRequested: buyer cooldown";
        const n = next();
        if (n === null) return "SetRefundRequested: no continuing output";
        if (!onlyChanged(n.fields, [16, 17, 18])) return "SetRefundRequested: other fields changed";
        if (n.view.sellerCooldownTime !== 0n) return "SetRefundRequested: seller cooldown != 0";
        if (n.view.buyerCooldownTime < cooldown) return "SetRefundRequested: buyer cooldown short";
        if (Number(n.view.state) !== (v.resultHash === "" ? 2 : 3))
          return "SetRefundRequested: wrong new state";
        return null;
      }
      case "WithdrawRefund": {
        if (!signedBy(buyer)) return "WithdrawRefund: not signed by the buyer";
        if (![0, 2, 5].includes(state)) return "WithdrawRefund: wrong state";
        if (v.resultHash !== "") return "WithdrawRefund: result_hash is set";
        if (state !== 5 && !startsAfter(v.submitResultTime))
          return "WithdrawRefund: before submit_result_time";
        if (continuing.length !== 0) return "WithdrawRefund: continuing output";
        if (v.buyerReturnAddress !== null) return "WithdrawRefund: harness expects no return addr";
        return null;
      }
      case "SubmitResult": {
        if (!signedBy(seller)) return "SubmitResult: not signed by the seller";
        if (![0, 1, 2, 3].includes(state)) return "SubmitResult: wrong state";
        if (out.lovelace < v.collateralReturnLovelace) return "SubmitResult: collateral";
        if (!startsAfter(v.sellerCooldownTime)) return "SubmitResult: seller cooldown";
        if (!(
          upper < v.submitResultTime ||
          (upper < v.externalDisputeUnlockTime && v.resultHash !== "")
        ))
          return "SubmitResult: too late";
        const n = next();
        if (n === null) return "SubmitResult: no continuing output";
        if (!onlyChanged(n.fields, [11, 16, 17, 18])) return "SubmitResult: other fields changed";
        if (n.view.resultHash === "") return "SubmitResult: empty result hash";
        if (n.view.sellerCooldownTime < cooldown) return "SubmitResult: seller cooldown short";
        if (n.view.buyerCooldownTime !== 0n) return "SubmitResult: buyer cooldown != 0";
        if (Number(n.view.state) !== (state <= 1 ? 1 : 3)) return "SubmitResult: wrong new state";
        return null;
      }
      case "AuthorizeRefund": {
        if (!signedBy(seller)) return "AuthorizeRefund: not signed by the seller";
        if (![0, 1, 2, 3].includes(state)) return "AuthorizeRefund: wrong state";
        if (!startsAfter(v.sellerCooldownTime)) return "AuthorizeRefund: seller cooldown";
        const n = next();
        if (n === null) return "AuthorizeRefund: no continuing output";
        if (!onlyChanged(n.fields, [11, 16, 17, 18]))
          return "AuthorizeRefund: other fields changed";
        if (n.view.resultHash !== "") return "AuthorizeRefund: result hash not cleared";
        if (n.view.sellerCooldownTime < cooldown) return "AuthorizeRefund: seller cooldown short";
        if (n.view.buyerCooldownTime !== 0n) return "AuthorizeRefund: buyer cooldown != 0";
        if (Number(n.view.state) !== 5) return "AuthorizeRefund: wrong new state";
        return null;
      }
      case "Withdraw":
      case "AuthorizeWithdrawal":
      case "WithdrawDisputed":
        return `${action}: not exercised by this harness (input ${ref(input.txHash, input.index)})`;
    }
  }

  submit(bytes: Uint8Array): { ok: true; txHash: string } | { ok: false; reason: string } {
    const tx = decodeCardanoTx(bytes);
    const signers = tx.vkeyWitnesses.map((w) => cardanoKeyHash(w.vkey));
    if (this.refuseSignedBy !== null && signers.includes(this.refuseSignedBy)) {
      this.rejected.push({ reason: "refused by test hook", signers });
      return { ok: false, reason: "refused by test hook" };
    }
    this.sizeOf.set(tx.bodyHash, bytes.length);
    const { reason, action } = this.check(tx, true);
    if (reason !== null) {
      this.rejected.push({ reason, signers });
      return { ok: false, reason };
    }
    for (const i of tx.inputs) this.output(i.txHash, i.index)!.consumedBy = tx.bodyHash;
    this.txs.set(
      tx.bodyHash,
      tx.outputs.map((o) => {
        if (o.address === null) throw new Error("Byron output");
        return {
          address: o.address,
          lovelace: o.value.coin,
          assets: o.value.assets,
          inlineDatum: o.inlineDatum === undefined ? null : hex(o.inlineDatum),
          consumedBy: null,
        };
      }),
    );
    this.applied.push({ txHash: tx.bodyHash, tx, action });
    return { ok: true, txHash: tx.bodyHash };
  }

  /** Blockfrost REST, as both sides call it. */
  async handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const path = url.pathname.replace(/^\/api\/v0/, "");
    const method = init?.method ?? "GET";
    const notFound = () => json({ status_code: 404, error: "Not Found", message: "nf" }, 404);
    if (path === "/genesis") return json({ network_magic: 1, system_start: 1654041600 });
    if (path === "/epochs/latest/parameters") return json(PROTOCOL_PARAMS);
    if (path === "/blocks/latest")
      return json({
        time: Math.floor(this.tipMs() / 1000),
        slot: Number(this.tipSlot()),
        height: 4_300_000,
        hash: "c".repeat(64),
      });
    let m = /^\/addresses\/([^/]+)\/utxos$/.exec(path);
    if (m) {
      const page = url.searchParams.get("page") ?? "1";
      return json(page === "1" ? this.utxosAt(decodeURIComponent(m[1]!)) : []);
    }
    m = /^\/txs\/([0-9a-f]{64})\/utxos$/.exec(path);
    if (m) {
      const body = this.txUtxos(m[1]!);
      return body === null ? notFound() : json(body);
    }
    m = /^\/txs\/([0-9a-f]{64})$/.exec(path);
    const known = m?.[1];
    if (known !== undefined)
      return this.applied.some((a) => a.txHash === known)
        ? json({ hash: known, block_height: 4_300_000, slot: 1, valid_contract: true })
        : notFound();
    if (path === "/utils/txs/evaluate/utxos" && method === "POST") {
      const { cbor } = JSON.parse(init?.body as string) as { cbor: string };
      const tx = decodeCardanoTx(unhex(cbor));
      const { reason } = this.check(tx, false);
      if (reason !== null)
        return json({
          type: "jsonwsp/response",
          version: "1.0",
          servicename: "ogmios",
          methodname: "EvaluateTx",
          result: { EvaluationFailure: { ScriptFailures: { "spend:0": [{ reason }] } } },
        });
      const result = Object.fromEntries(tx.redeemers.map((r) => [`spend:${r.index}`, EX_UNITS]));
      return json({
        type: "jsonwsp/response",
        version: "1.0",
        servicename: "ogmios",
        methodname: "EvaluateTx",
        result: { EvaluationResult: result },
      });
    }
    if (path === "/tx/submit" && method === "POST") {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const r = this.submit(body);
      return r.ok
        ? json(r.txHash)
        : json({ status_code: 400, error: "Bad Request", message: r.reason }, 400);
    }
    throw new Error(`unexpected Blockfrost call in test: ${method} ${url.href}`);
  }
}

/** Global fetch -> the seller's report fixtures for the queried address, else the chain. */
function install(chain: FakeChain) {
  const report = blockfrostRoutes();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!url.href.startsWith(BLOCKFROST)) throw new Error(`unexpected fetch: ${url.href}`);
    const key = Object.keys(report)
      .filter((k) => url.href.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key !== undefined) return report[key]!(url, init);
    return chain.handle(url, init);
  });
}

// --- ZyroPay API mirrors (not exported by apps/api: kept line-for-line) -------------------

/** apps/api/src/services/escrow-view.ts availableActions (3-minute refund margin). */
function availableActions(
  state: string,
  terms: MasumiEscrowTerms,
  snapshot: { resultHash: string | null; buyerCooldownTime: string },
  now: Date,
) {
  const t = now.getTime();
  const out: string[] = [];
  const cooldown = Number(snapshot.buyerCooldownTime);
  if (
    (state === "funds_locked" || state === "result_submitted" || state === "disputed") &&
    t < Number(terms.unlockTime) - 3 * 60_000 &&
    t >= cooldown
  )
    out.push("request_refund");
  if (
    state === "refund_authorized" ||
    ((state === "funds_locked" || state === "refund_requested") &&
      snapshot.resultHash == null &&
      t >= Number(terms.submitResultTime))
  )
    out.push("withdraw_refund");
  return out;
}

/** apps/api/src/services/escrow.ts boundsFor (600-slot validity, 60-slot lower slack). */
function boundsFor(
  chain: EscrowChain,
  action: "request_refund" | "withdraw_refund",
  state: string,
  terms: MasumiEscrowTerms,
  buyerCooldownMs: bigint,
  nowMs: bigint,
) {
  const nowSlot = chain.slotOf(nowMs, "floor");
  const upper = nowSlot + 600n;
  const base = nowSlot - 60n;
  const atLeast = (ms: bigint): bigint =>
    ms <= chain.posixOf(base)
      ? base
      : [base, chain.slotOf(ms, "ceil")].sort((a, b) => (a > b ? -1 : 1))[0]!;
  if (action === "request_refund") {
    const lower = atLeast(buyerCooldownMs);
    if (lower > nowSlot) throw new Error("a refund was requested recently");
    const unlockSlot = chain.slotOf(BigInt(terms.unlockTime) - 1n, "floor");
    const ttl = upper < unlockSlot ? upper : unlockSlot;
    if (ttl < nowSlot + 120n) throw new Error("too late to request a refund");
    return { lower, ttl };
  }
  if (state === "refund_authorized") return { lower: base, ttl: upper };
  const lower = atLeast(BigInt(terms.submitResultTime));
  if (lower > nowSlot) throw new Error("the refund can be withdrawn after the result deadline");
  return { lower, ttl: upper };
}

// --- the round trip ------------------------------------------------------------------------

function env(kv: KvLike | undefined, extra: Partial<Env> = {}): Env {
  return {
    SELLER_ADDRESS,
    BLOCKFROST_PROJECT_ID: TEST_PROJECT_ID,
    SELLER_SIGNING_KEY: SELLER_SEED,
    ...(kv ? { ESCROW_KV: kv } : {}),
    ...extra,
  };
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Everything from the 402 to the paid 200, the ZyroPay way. */
async function payIntoEscrow(chain: FakeChain, appEnv: Env, tasks: Promise<unknown>[]) {
  chain.seed(BUYER_FUNDING_TX, [
    { address: PAYER, lovelace: 20_000_000n },
    { address: PAYER, lovelace: 8_000_000n },
  ]);
  chain.seed(SELLER_FUNDING_TX, [
    { address: SELLER_ADDRESS, lovelace: 20_000_000n },
    { address: SELLER_ADDRESS, lovelace: 9_000_000n },
  ]);
  const now = () => new Date(Date.now());
  const app = createApp(appEnv, { now, background: (t) => tasks.push(t) });

  // 1. The seller's 402 (escrow route).
  const first = await app.request(URL_OK, { headers: { accept: "application/json" } });
  expect(first.status).toBe(402);
  const required = decodeHeader(first.headers.get("PAYMENT-REQUIRED"));
  const accepted = required.accepts[0];
  const extra = accepted.extra as CardanoExtraMasumi;
  // (b) the seller is unregistered: no agentIdentifier (ZyroPay refuses a non-empty one).
  expect(extra.terms.agentIdentifier ?? null).toBeNull();
  // (a) the payment window ZyroPay requires: > 60 s left, within maxTimeoutSeconds (<= 600).
  expect(accepted.maxTimeoutSeconds).toBeLessThanOrEqual(600);
  expect(Number(extra.terms.payByTime) - Date.now()).toBeGreaterThan(60_000);

  // 2. ZyroPay's adapter quote (real masumi validation; coinsPerUtxoByte from the chain).
  const broadcaster: Broadcaster = {
    broadcast: () => Promise.reject(new Error("the API broadcaster is not used here")),
    getStatus: () => Promise.reject(new Error("unused")),
  };
  const escrowChain = createRealEscrowChain({
    network: NETWORK,
    blockfrostProjectId: TEST_PROJECT_ID,
    broadcaster,
    http: { sleep: noSleep },
    now,
  });
  const adapter = createX402Adapter({
    caps: { "cardano-preprod:native": "10000000" },
    now,
    cardanoCoinsPerUtxoByte: () => escrowChain.coinsPerUtxoByte(),
  });
  const quote = await adapter.quote({
    action: "pay",
    network: NETWORK,
    params: {
      paymentRequired: required,
      resourceUrl: URL_OK,
      maxAmount: "6000000",
      assetId: "cardano-preprod:native",
      payer: PAYER,
      transferMethod: "masumi",
    },
  });
  const payload = createCanonicalPayload({
    version: 1,
    network: NETWORK,
    from: PAYER,
    to: ESCROW_ADDRESS,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: quote.inputAmount,
    feeCap: "3000000",
    plugin: "x402",
    tool: "pay_x402",
    pluginData: quote.pluginData,
    nonce: "00112233445566778899aabbccddeeff",
    expiresAt: quote.expiresAt,
    idempotencyKey: "roundtrip-0001",
  });
  const terms = masumiEscrowTermsOf(payload.pluginData)!;
  expect(terms.sellerAddress).toBe(SELLER_ADDRESS);
  expect(terms.lockedLovelace).toBe(accepted.amount); // >= 4 tADA: collateral-free

  // 3. The lock, built by the API's real EscrowChain, verified by the adapter, signed.
  const unsigned = await escrowChain.buildLock(payload, {
    maxValiditySeconds: accepted.maxTimeoutSeconds,
  });
  expect(await adapter.verifyTransaction(unsigned.serialized, "hex", payload)).toEqual({
    ok: true,
  });
  const lockUnsigned = decodeCardanoTx(unhex(unsigned.serialized));
  const signature = hex(testEd25519Sign(PAYER_SECRET, unhex(lockUnsigned.bodyHash)));
  const { signedTransaction, txHash: lockTx } = attachCardanoWitness({
    unsignedHex: unsigned.serialized,
    publicKey: PAYER_PK,
    signature,
    expectedKeyHash: PAYER_KEY_HASH,
  });
  const header = adapter.encodePaymentHeader({ payload, cardano: { signedTransaction } });
  expect(header.name).toBe("PAYMENT-SIGNATURE");

  // 4. The paid retry: the seller's embedded facilitator verifies + settles the lock.
  const paid = await app.request(URL_OK, {
    headers: { accept: "application/json", [header.name]: header.value },
  });
  expect(paid.status).toBe(200);
  expect(decodeHeader(paid.headers.get("PAYMENT-RESPONSE"))).toMatchObject({
    success: true,
    transaction: lockTx,
  });
  expect(chain.applied[0]?.txHash).toBe(lockTx);
  const body = new Uint8Array(await paid.arrayBuffer());
  const contentSha256 = createHash("sha256").update(body).digest("hex");
  // (f) the result hash the seller commits to is sha256(body).
  expect(paid.headers.get("X-Escrow-Result-Hash")).toBe(contentSha256);

  // 5. (c) The delivery receipt, checked as the API checks it (services/x402.ts checkReceipt):
  // against terms.sellerAddress (the escrow script cannot sign), paymentTx = the lock.
  const receipt = decodeX402Receipt(paid.headers.get("X-Delivery-Receipt")!);
  expect(receipt).not.toBeNull();
  const sameUrl = (a: string, b: string) => new URL(a).href === new URL(b).href;
  const expectation = {
    payTo: terms.sellerAddress,
    sameResource: (url: string) => sameUrl(url, payload.pluginData!.resourceUrl as string),
    contentSha256,
    paymentTx: lockTx,
  };
  expect(verifyX402Receipt(receipt!, expectation)).toEqual({ ok: true });
  expect(verifyX402Receipt(receipt!, { ...expectation, payTo: payload.to })).toEqual({
    ok: false,
    reason: "wrong_signer",
  });

  const lockView = masumiEscrowView(terms.datumCbor)!;
  const hint = {
    referenceSignature: lockView.referenceSignature,
    lockDatumCbor: terms.datumCbor,
    lockLovelace: terms.lockedLovelace,
  };
  return { app, escrowChain, terms, lockTx, contentSha256, hint };
}

/** The API's view of the escrow right now (EscrowChain.read + masumiEscrowView). */
async function apiRead(
  escrowChain: EscrowChain,
  lockTx: string,
  hint: Parameters<EscrowChain["read"]>[1],
) {
  const read = await escrowChain.read({ txHash: lockTx, index: 0 }, hint);
  if (read.status !== "unspent") return { read, view: null, utxo: null };
  const view = masumiEscrowView(read.utxo.inlineDatum)!;
  // escrow-view.ts sameEscrow: same escrow (reference_signature) and buyer, at the escrow.
  expect(read.utxo.address).toBe(ESCROW_ADDRESS);
  expect(view.referenceSignature).toBe(hint.referenceSignature);
  expect(view.buyerKeyHash).toBe(PAYER_KEY_HASH);
  return { read, view, utxo: read.utxo };
}

/** A ZyroPay buyer spend: bounds, datum, build (evaluated), verify, passkey-sign, submit. */
async function buyerSpend(
  chain: FakeChain,
  escrowChain: EscrowChain,
  terms: MasumiEscrowTerms,
  utxo: EscrowOnChain,
  action: "request_refund" | "withdraw_refund",
) {
  const view = masumiEscrowView(utxo.inlineDatum)!;
  const { lower, ttl } = boundsFor(
    escrowChain,
    action,
    view.state,
    terms,
    view.buyerCooldownTime,
    BigInt(Date.now()),
  );
  const continuingDatumCbor =
    action === "request_refund"
      ? masumiRefundRequestDatum(
          utxo.inlineDatum,
          escrowChain.posixOf(ttl),
          BigInt(terms.cooldownPeriodMs),
        )
      : undefined;
  const input = {
    action:
      action === "request_refund" ? ("SetRefundRequested" as const) : ("WithdrawRefund" as const),
    from: PAYER,
    utxo,
    ...(continuingDatumCbor !== undefined ? { continuingDatumCbor } : {}),
    validityStartSlot: lower,
    ttlSlot: ttl,
    feeCap: 3_000_000n,
  };
  const built = await escrowChain.buildSpend(input);
  expect(await escrowChain.verifySpend(built.serialized, input)).toEqual({ ok: true });
  const sig = hex(testEd25519Sign(PAYER_SECRET, unhex(built.bodyHash)));
  const { signedTransaction, txHash } = attachCardanoWitness({
    unsignedHex: built.serialized,
    publicKey: PAYER_PK,
    signature: sig,
    expectedKeyHash: PAYER_KEY_HASH,
  });
  const result = chain.submit(unhex(signedTransaction));
  expect(result).toEqual({ ok: true, txHash });
  const tx = decodeCardanoTx(unhex(signedTransaction));
  expect(tx.requiredSigners).toEqual([PAYER_KEY_HASH]);
  expect(tx.validityStart).toBe(lower);
  expect(tx.ttl).toBe(ttl);
  return { txHash, tx, continuingDatumCbor, lower, ttl };
}

function sellerSweepDeps(appEnv: Env) {
  const config = loadConfig(appEnv);
  if (!config.ok) throw new Error(config.problems.join("; "));
  const rt = escrowRuntime(appEnv, config.config);
  if (!rt.enabled) throw new Error(rt.problems.join("; "));
  return rt.sweepDeps();
}

describe("Masumi escrow: seller (apps/seller) x buyer (ZyroPay) round trip", () => {
  it("deliver -> SubmitResult -> refund request (Disputed) -> AuthorizeRefund after the seller cooldown -> WithdrawRefund", async () => {
    const chain = new FakeChain();
    install(chain);
    const kv = memoryKv();
    const appEnv = env(kv);
    const tasks: Promise<unknown>[] = [];
    const { escrowChain, terms, lockTx, contentSha256, hint } = await payIntoEscrow(
      chain,
      appEnv,
      tasks,
    );

    // 6. The seller's background SubmitResult (Evolution), checked by the fake ledger.
    await Promise.all(tasks);
    expect(chain.rejected).toEqual([]);
    const submit = chain.applied[1]!;
    expect(submit.action).toBe("SubmitResult");
    expect(submit.tx.inputs.some((i) => i.txHash === lockTx && i.index === 0)).toBe(true);
    expect(submit.tx.requiredSigners).toEqual([SELLER_KEY.keyHash]);
    const submitted = parseMasumiLockDatum(
      hex(submit.tx.outputs.find((o) => o.address === ESCROW_ADDRESS)!.inlineDatum!),
    )!;
    expect(submitted.resultHash).toBe(contentSha256);
    expect(submitted.sellerCooldownTime).toBe(posix(submit.tx.ttl!) + COOLDOWN);

    // 7. ZyroPay follows the escrow to the seller's continuing output: result_submitted.
    let seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.read.status).toBe("unspent");
    expect(seen.utxo!.txHash).toBe(submit.txHash);
    expect(seen.view).toMatchObject({ state: "result_submitted", resultHash: contentSha256 });
    expect(
      availableActions(
        seen.view!.state,
        terms,
        { resultHash: seen.view!.resultHash, buyerCooldownTime: "0" },
        new Date(),
      ),
    ).toEqual(["request_refund"]);

    // 8. ZyroPay SetRefundRequested against the seller's output: the escrow becomes Disputed.
    advance(60_000);
    const request = await buyerSpend(chain, escrowChain, terms, seen.utxo!, "request_refund");
    expect(chain.applied.at(-1)?.action).toBe("SetRefundRequested");
    seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.utxo!.txHash).toBe(request.txHash);
    expect(seen.view).toMatchObject({ state: "disputed", resultHash: contentSha256 });
    expect(seen.view!.buyerCooldownTime).toBe(posix(request.ttl) + COOLDOWN);
    // With a result on chain the buyer cannot withdraw alone.
    expect(
      availableActions(
        "disputed",
        terms,
        { resultHash: contentSha256, buyerCooldownTime: seen.view!.buyerCooldownTime.toString() },
        new Date(),
      ),
    ).toEqual([]);

    // SetRefundRequested resets seller_cooldown_time to 0 (vested_pay.ak), so the seller
    // may AuthorizeRefund at once although its SubmitResult cooldown has not elapsed.
    expect(seen.view!.sellerCooldownTime).toBe(0n);
    expect(BigInt(Date.now())).toBeLessThan(submitted.sellerCooldownTime);

    // 9. The seller's sweeper recognises the Disputed escrow and authorizes the refund.
    const late = await sweep(sellerSweepDeps(appEnv));
    expect(chain.rejected).toEqual([]);
    expect(late).toEqual([
      expect.objectContaining({
        state: "disputed",
        action: "AuthorizeRefund",
        txHash: expect.any(String),
      }),
    ]);
    const authorize = chain.applied.at(-1)!;
    expect(authorize.action).toBe("AuthorizeRefund");
    expect(authorize.tx.requiredSigners).toEqual([SELLER_KEY.keyHash]);

    // 10. ZyroPay sees refund_authorized and withdraws at once.
    seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.utxo!.txHash).toBe(late[0]!.txHash);
    expect(seen.view).toMatchObject({ state: "refund_authorized", resultHash: null });
    expect(
      availableActions(
        "refund_authorized",
        terms,
        { resultHash: null, buyerCooldownTime: "0" },
        new Date(),
      ),
    ).toContain("withdraw_refund");
    const before = chain.balance(PAYER);
    const withdraw = await buyerSpend(chain, escrowChain, terms, seen.utxo!, "withdraw_refund");
    expect(chain.applied.at(-1)?.action).toBe("WithdrawRefund");
    expect(await escrowChain.read({ txHash: lockTx, index: 0 }, hint)).toEqual({
      status: "spent",
      spentBy: withdraw.txHash,
    });
    expect(chain.balance(PAYER) - before).toBe(BigInt(terms.lockedLovelace) - withdraw.tx.fee!);
    expect(chain.utxosAt(ESCROW_ADDRESS)).toEqual([]);
  });

  it("no SubmitResult (seller outage) -> refund request from funds_locked -> sweeper AuthorizeRefund at once -> WithdrawRefund", async () => {
    const chain = new FakeChain();
    install(chain);
    const kv = memoryKv();
    const appEnv = env(kv);
    const tasks: Promise<unknown>[] = [];
    chain.refuseSignedBy = SELLER_KEY.keyHash;
    const { escrowChain, terms, lockTx, hint } = await payIntoEscrow(chain, appEnv, tasks);
    await Promise.all(tasks);
    chain.refuseSignedBy = null;
    chain.rejected.length = 0;
    expect(chain.applied).toHaveLength(1); // the lock only

    let seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.view).toMatchObject({ state: "funds_locked", resultHash: null });
    advance(30_000);
    const request = await buyerSpend(chain, escrowChain, terms, seen.utxo!, "request_refund");
    seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.utxo!.txHash).toBe(request.txHash);
    expect(seen.view).toMatchObject({ state: "refund_requested", resultHash: null });

    // The sweeper recognises ZyroPay's RefundRequested datum and authorizes immediately
    // (SetRefundRequested reset seller_cooldown_time to 0).
    const entries = await sweep(sellerSweepDeps(appEnv));
    expect(chain.rejected).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        state: "refund_requested",
        action: "AuthorizeRefund",
        txHash: expect.any(String),
      }),
    ]);
    seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.view).toMatchObject({ state: "refund_authorized", resultHash: null });
    const withdraw = await buyerSpend(chain, escrowChain, terms, seen.utxo!, "withdraw_refund");
    expect(await escrowChain.read({ txHash: lockTx, index: 0 }, hint)).toEqual({
      status: "spent",
      spentBy: withdraw.txHash,
    });
  });

  it("seller silent: ZyroPay withdraws straight from funds_locked once submit_result_time passed (slot rounding)", async () => {
    // Deadlines 400 ms into a slot: TTLs must floor, lower bounds must ceil.
    vi.setSystemTime(NOW + 400);
    const chain = new FakeChain();
    install(chain);
    const appEnv = env(undefined, { AUTO_AUTHORIZE_REFUNDS: "false" });
    const tasks: Promise<unknown>[] = [];
    chain.refuseSignedBy = SELLER_KEY.keyHash;
    const { escrowChain, terms, lockTx, hint } = await payIntoEscrow(chain, appEnv, tasks);
    await Promise.all(tasks);
    chain.refuseSignedBy = null;
    chain.rejected.length = 0;

    let seen = await apiRead(escrowChain, lockTx, hint);
    expect(seen.view?.state).toBe("funds_locked");
    // Not before the deadline (the API refuses; the validator would too).
    expect(() =>
      boundsFor(escrowChain, "withdraw_refund", "funds_locked", terms, 0n, BigInt(Date.now())),
    ).toThrow(/after the result deadline/);
    // Just after the (non-slot-aligned) submit_result_time: lower = ceil slot >= the deadline.
    advance(Number(terms.submitResultTime) - Date.now() + 1_500);
    // The sweeper does nothing (no record, auto-authorize off).
    expect((await sweep(sellerSweepDeps(appEnv)))[0]).toMatchObject({ action: null });
    seen = await apiRead(escrowChain, lockTx, hint);
    const withdraw = await buyerSpend(chain, escrowChain, terms, seen.utxo!, "withdraw_refund");
    expect(Number(terms.submitResultTime) % 1000).toBe(400);
    expect(posix(withdraw.lower)).toBe(BigInt(terms.submitResultTime) + 600n);
    expect(chain.rejected).toEqual([]);
    expect(await escrowChain.read({ txHash: lockTx, index: 0 }, hint)).toEqual({
      status: "spent",
      spentBy: withdraw.txHash,
    });
  });
  it("negative controls: the fake ledger's vested_pay rules refuse off-by-one bounds and datums", async () => {
    const chain = new FakeChain();
    install(chain);
    const tasks: Promise<unknown>[] = [];
    chain.refuseSignedBy = SELLER_KEY.keyHash;
    const { escrowChain, terms, lockTx, hint } = await payIntoEscrow(chain, env(undefined), tasks);
    await Promise.all(tasks);
    chain.refuseSignedBy = null;
    const { utxo } = await apiRead(escrowChain, lockTx, hint);
    const nowSlot = slotOf(Date.now());
    const ttl = nowSlot + 600n;
    const base = {
      action: "SetRefundRequested" as const,
      from: PAYER,
      utxo: utxo!,
      validityStartSlot: nowSlot - 60n,
      ttlSlot: ttl,
      feeCap: 3_000_000n,
    };
    // buyer_cooldown_time one slot short of upper bound + cooldown: evaluation fails.
    const short = masumiRefundRequestDatum(utxo!.inlineDatum, posix(ttl) - 1000n, COOLDOWN);
    await expect(escrowChain.buildSpend({ ...base, continuingDatumCbor: short })).rejects.toThrow(
      /buyer cooldown short/,
    );
    // Upper bound at unlock_time: refused.
    const unlockSlot = slotOf(BigInt(terms.unlockTime));
    const late = masumiRefundRequestDatum(utxo!.inlineDatum, posix(unlockSlot), COOLDOWN);
    vi.setSystemTime(Number(terms.unlockTime) - 120_000);
    await expect(
      escrowChain.buildSpend({
        ...base,
        validityStartSlot: unlockSlot - 200n,
        ttlSlot: unlockSlot,
        continuingDatumCbor: late,
      }),
    ).rejects.toThrow(/upper >= unlock_time/);
    // WithdrawRefund one slot before submit_result_time: refused.
    vi.setSystemTime(Number(terms.submitResultTime) + 5_000);
    const srSlot = slotOf(BigInt(terms.submitResultTime));
    await expect(
      escrowChain.buildSpend({
        action: "WithdrawRefund",
        from: PAYER,
        utxo: utxo!,
        validityStartSlot: srSlot - 1n,
        ttlSlot: srSlot + 600n,
        feeCap: 3_000_000n,
      }),
    ).rejects.toThrow(/before submit_result_time/);
    expect(chain.applied).toHaveLength(1);
  });
});
