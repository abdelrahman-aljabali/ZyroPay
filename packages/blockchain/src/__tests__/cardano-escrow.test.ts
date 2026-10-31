import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardanoKeyHash, cardanoPaymentKeyHash } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { BlockfrostClient, parseEvaluation, parseRational } from "../cardano/blockfrost";
import type { ScriptProtocolParams } from "../cardano/blockfrost";
import { assertCardanoSignedMatchesUnsigned } from "../cardano/broadcast";
import { verifyCardanoTransfer } from "../cardano/builder";
import { array, bytes, decodeCbor, encodeCbor, map, tag, uint } from "../cardano/cbor";
import type { CardanoEscrowLockExpectation, EscrowUtxo } from "../cardano/escrow";
import {
  cardanoPosixMsToSlot,
  cardanoScriptAddress,
  cardanoSlotToPosixMs,
  createCardanoEscrowBuilder,
  MASUMI_SCRIPT_BYTES,
  MASUMI_SCRIPT_HASH,
  masumiEscrowAddress,
  masumiRedeemer,
  planCardanoEscrowLock,
  planCardanoEscrowSpend,
  requiredCollateral,
  scriptExecutionFee,
  verifyCardanoEscrowLock,
  verifyCardanoEscrowSpend,
} from "../cardano/escrow";
import {
  assembleTx,
  decodeCardanoTx,
  encodeBody,
  encodeRedeemers,
  plutusV3LanguageViews,
  scriptDataHash,
} from "../cardano/tx";
import { attachCardanoWitness } from "../cardano/witness";
import { ChainError } from "../errors";
import { fixtureFetch, noSleep } from "../testing";
import {
  blockfrostPreprod,
  cardanoPayload,
  FROM,
  NOW,
  PARAMS,
  SENDER_PK,
  SENDER_SECRET,
  TIP,
  TO,
  utxo,
} from "./cardano-fixtures";
import COST_MODEL from "./fixtures/cardano/plutus-v3-cost-model.json";

/** Spec §2.1: x402 masumiDatum.test.ts golden datum (enterprise buyer 11*28, seller 22*28). */
const GOLDEN_DATUM =
  "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff";
/** SetRefundRequested continuation: buyer_cooldown = 1785756420000, state = RefundRequested. */
const REFUND_DATUM = GOLDEN_DATUM.replace(/0000d87980ff$/, "001b0000019fc76087a0d87b80ff");

const KEY = "preprodTESTKEY0000000000000000000000";
const ESCROW = masumiEscrowAddress("cardano-preprod");
const BUYER_KH = cardanoPaymentKeyHash(FROM) ?? "";
const COSTS = COST_MODEL.PlutusV3.map((c) => BigInt(c));
const BF_SCRIPT_PARAMS = { ...PARAMS, cost_models_raw: { PlutusV3: COST_MODEL.PlutusV3 } };
const SCRIPT_PARAMS: ScriptProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155381n,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384,
  maxValSize: 5000,
  priceMem: { num: 577n, den: 10000n },
  priceStep: { num: 721n, den: 10000000n },
  collateralPercent: 150n,
  maxCollateralInputs: 3,
  maxTxExMem: 16_500_000n,
  maxTxExSteps: 10_000_000_000n,
  plutusV3CostModel: COSTS,
};
const WALLET = [utxo("1", 0, "5000000"), utxo("3", 0, "1500000"), utxo("4", 2, "9000000")];
const EXUNITS = { mem: 1_500_000n, steps: 500_000_000n };
const ESCROW_UTXO: EscrowUtxo = {
  txHash: "2".repeat(64),
  index: 0,
  address: ESCROW,
  value: { coin: 4_000_000n, assets: new Map() },
  inlineDatum: GOLDEN_DATUM,
};
const PAY_BY = NOW.getTime() + 5 * 60_000;

function cslCostmdls(): CSL.Costmdls {
  const cm = CSL.CostModel.new();
  COST_MODEL.PlutusV3.forEach((c, i) => cm.set(i, CSL.Int.new_i32(c)));
  const all = CSL.Costmdls.new();
  all.insert(CSL.Language.new_plutus_v3(), cm);
  return all;
}

function lockPlan(overrides: Partial<Parameters<typeof planCardanoEscrowLock>[0]> = {}) {
  return planCardanoEscrowLock({
    network: "cardano-preprod",
    from: FROM,
    escrowAddress: ESCROW,
    lovelace: 4_000_000n,
    datumCbor: GOLDEN_DATUM,
    ttlSlot: cardanoPosixMsToSlot("cardano-preprod", PAY_BY, "floor"),
    utxos: WALLET,
    params: SCRIPT_PARAMS,
    ...overrides,
  });
}

function spendPlan(overrides: Partial<Parameters<typeof planCardanoEscrowSpend>[0]> = {}) {
  return planCardanoEscrowSpend({
    network: "cardano-preprod",
    action: "SetRefundRequested",
    from: FROM,
    escrow: ESCROW_UTXO,
    continuingDatumCbor: REFUND_DATUM,
    utxos: WALLET,
    params: SCRIPT_PARAMS,
    validityStartSlot: BigInt(TIP.slot - 60),
    ttlSlot: BigInt(TIP.slot + 300),
    exUnits: EXUNITS,
    ...overrides,
  });
}

const spendExpectation = {
  network: "cardano-preprod" as const,
  action: "SetRefundRequested" as const,
  from: FROM,
  escrow: ESCROW_UTXO,
  continuingDatumCbor: REFUND_DATUM,
  plutusV3CostModel: COSTS,
  collateralPercent: 150n,
};

function signHex(unsignedHex: string): string {
  const tx = decodeCardanoTx(hexToBytes(unsignedHex));
  return attachCardanoWitness({
    unsignedHex,
    publicKey: SENDER_PK,
    signature: bytesToHex(ed25519.sign(hexToBytes(tx.bodyHash), SENDER_SECRET)),
    expectedKeyHash: cardanoKeyHash(SENDER_PK),
  }).signedTransaction;
}

/** Re-assemble an unsigned spend with a modified body (witnesses kept byte-exact). */
function withBody(serialized: string, patch: (b: Parameters<typeof encodeBody>[0]) => object) {
  const tx = decodeCardanoTx(hexToBytes(serialized));
  const body = {
    inputs: tx.inputs,
    outputs: tx.outputs,
    fee: tx.fee ?? 0n,
    ttl: tx.ttl ?? 0n,
    ...(tx.validityStart !== null ? { validityStart: tx.validityStart } : {}),
    ...(tx.scriptDataHash !== null ? { scriptDataHash: hexToBytes(tx.scriptDataHash) } : {}),
    ...(tx.collateral.length > 0 ? { collateral: tx.collateral } : {}),
    ...(tx.requiredSigners.length > 0 ? { requiredSigners: tx.requiredSigners } : {}),
    ...(tx.collateralReturn !== null ? { collateralReturn: tx.collateralReturn } : {}),
    ...(tx.totalCollateral !== null ? { totalCollateral: tx.totalCollateral } : {}),
  };
  const redeemers = tx.witnessEntries.get(5);
  return bytesToHex(
    assembleTx(
      encodeBody({ ...body, ...patch(body) }),
      [],
      redeemers === undefined ? {} : { redeemers, plutusV3Scripts: tx.plutusV3Scripts },
    ),
  );
}

describe("Masumi script and time", () => {
  it("the pinned script hashes to the canonical escrow address (CSL oracle)", () => {
    expect(MASUMI_SCRIPT_BYTES.length).toBe(10003);
    expect(MASUMI_SCRIPT_HASH).toBe("a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad");
    expect(CSL.PlutusScript.new_v3(MASUMI_SCRIPT_BYTES).hash().to_hex()).toBe(MASUMI_SCRIPT_HASH);
    expect(ESCROW).toBe("addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g");
    expect(masumiEscrowAddress("cardano-mainnet")).toBe(
      "addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d",
    );
  });

  it("script_data_hash matches a vector agreed by CSL and evolution-sdk", () => {
    // SetRefundRequested at spend index 0, ex-units (1.5M, 500M), preprod PlutusV3 costs.
    // ddcc2dc5... computed independently by CSL hash_script_data and by evolution-sdk 0.5.19
    // Redeemers.toScriptDataHash (CostModel.languageViewsEncoding) over the same inputs.
    const redeemers = encodeRedeemers([
      { tag: 0, index: 0, data: masumiRedeemer("SetRefundRequested"), ...EXUNITS },
    ]);
    expect(bytesToHex(redeemers)).toBe("a182000082d87a80821a0016e3601a1dcd6500");
    const views = plutusV3LanguageViews(COSTS);
    expect(bytesToHex(views).slice(0, 40)).toBe("a1029901291a000189b41901a401011903e818ad");
    expect(views.length).toBe(812);
    const hash = bytesToHex(scriptDataHash({ redeemers, languageViews: views }));
    expect(hash).toBe("ddcc2dc5fc0683a38a286fec2836353cf20258fcd44ae2ec1cbf89b542e2935f");
    expect(CSL.hash_script_data(CSL.Redeemers.from_bytes(redeemers), cslCostmdls()).to_hex()).toBe(
      hash,
    );
  });

  it("converts POSIX ms and slots like the ledger (slot start)", () => {
    expect(cardanoSlotToPosixMs("cardano-preprod", 86400n)).toBe(1655769600000n);
    expect(cardanoPosixMsToSlot("cardano-preprod", 1655769601999, "floor")).toBe(86401n);
    expect(cardanoPosixMsToSlot("cardano-preprod", 1655769601999, "ceil")).toBe(86402n);
    expect(cardanoPosixMsToSlot("cardano-preprod", 1655769602000, "ceil")).toBe(86402n);
    expect(cardanoSlotToPosixMs("cardano-mainnet", 4492800n)).toBe(1596059091000n);
  });

  it("parses Blockfrost prices exactly and computes the script fee and collateral", () => {
    expect(parseRational(0.0577, "p")).toEqual({ num: 577n, den: 10000n });
    expect(parseRational(7.21e-5, "p")).toEqual({ num: 721n, den: 10000000n });
    expect(parseRational("721/10000000", "p")).toEqual({ num: 721n, den: 10000000n });
    // ceil(0.0577 * 1.5e6 + 0.0000721 * 5e8) = ceil(86550 + 36050) = 122600
    expect(scriptExecutionFee(SCRIPT_PARAMS, EXUNITS)).toBe(122600n);
    expect(scriptExecutionFee(SCRIPT_PARAMS, { mem: 1n, steps: 1n })).toBe(1n);
    expect(requiredCollateral(200_001n, 150n)).toBe(300_002n);
  });
});

describe("escrow lock", () => {
  it("embeds the golden datum byte for byte in a map-format output (CSL oracle)", () => {
    const plan = lockPlan({ requiredInput: { txHash: "3".repeat(64), index: 0 } });
    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect(tx.bodyKeys).toEqual([0, 1, 2, 3]);
    expect(tx.outputs[0]?.format).toBe("map");
    expect(bytesToHex(tx.outputs[0]?.inlineDatum ?? new Uint8Array())).toBe(GOLDEN_DATUM);
    expect(tx.inputs.some((i) => i.txHash === "3".repeat(64))).toBe(true); // nonce forced

    const csl = CSL.Transaction.from_hex(plan.serialized);
    const out = csl.body().outputs().get(0);
    expect(out.address().to_bech32()).toBe(ESCROW);
    expect(out.amount().coin().to_str()).toBe("4000000");
    expect(out.has_plutus_data()).toBe(true);
    expect(out.has_data_hash()).toBe(false);
    expect(out.has_script_ref()).toBe(false);
    expect(out.plutus_data()?.to_hex()).toBe(GOLDEN_DATUM); // golden vector round trip
    expect(csl.body().outputs().get(1).address().to_bech32()).toBe(FROM);
    expect(csl.body().script_data_hash()).toBeUndefined();
    expect(csl.body().ttl_bignum()?.to_str()).toBe(plan.ttlSlot.toString());
    expect(CSL.FixedTransaction.from_hex(plan.serialized).transaction_hash().to_hex()).toBe(
      plan.bodyHash,
    );
    // Value is preserved and the fee meets the size rule once signed.
    const signed = CSL.Transaction.from_hex(signHex(plan.serialized));
    const minFee = CSL.min_fee(
      signed,
      CSL.LinearFee.new(CSL.BigNum.from_str("44"), CSL.BigNum.from_str("155381")),
    );
    expect(BigInt(minFee.to_str())).toBeLessThanOrEqual(plan.fee);
    const inTotal = tx.inputs.reduce(
      (n, i) => n + BigInt(WALLET.find((u) => u.tx_hash === i.txHash)?.amount[0]?.quantity ?? 0),
      0n,
    );
    expect(inTotal).toBe(tx.outputs.reduce((n, o) => n + o.value.coin, 0n) + plan.fee);
  });

  it("never tops the escrow output up: refuses lovelace below min-UTxO with the datum", () => {
    // (160 + output size incl. the ~200-byte datum) * 4310 is about 1.67 ADA.
    expect(() => lockPlan({ lovelace: 1_200_000n })).toThrow(/needs at least/);
    expect(() => lockPlan({ datumCbor: "zz" })).toThrow(/hex/);
    expect(() => lockPlan({ datumCbor: "d87980ff" })).toThrow(/single CBOR item/);
    expect(() => lockPlan({ escrowAddress: TO })).toThrow(/script address/);
    expect(() => lockPlan({ requiredInput: { txHash: "9".repeat(64), index: 0 } })).toThrow(
      /required input/,
    );
  });

  it("plain-transfer verification still refuses escrow locks", () => {
    const plan = lockPlan();
    // (A payload `to` a script address is already refused by the payload schema.)
    expect(() => cardanoPayload({ to: ESCROW })).toThrow();
    const r = verifyCardanoTransfer(plan.serialized, "hex", cardanoPayload(), "cardano-preprod");
    expect(r).toEqual({ ok: false, reason: "outputs must be plain Shelley outputs" });
    const keysOnly = verifyCardanoTransfer(
      withBody(plan.serialized, (b) => ({
        outputs: [{ ...b.outputs[0], address: TO }, b.outputs[1]],
      })),
      "hex",
      cardanoPayload({ amount: "4000000" }),
      "cardano-preprod",
    );
    expect(keysOnly).toEqual({ ok: false, reason: "outputs must be plain Shelley outputs" });
  });

  it("the verifier accepts the built lock and refuses every deviation", () => {
    const plan = lockPlan();
    const expected: CardanoEscrowLockExpectation = {
      network: "cardano-preprod" as const,
      from: FROM,
      escrowAddress: ESCROW,
      lovelace: 4_000_000n,
      datumCbor: GOLDEN_DATUM,
      ttlSlot: plan.ttlSlot,
      feeCap: 1_000_000n,
    };
    expect(verifyCardanoEscrowLock(plan.serialized, expected)).toEqual({ ok: true });
    const reason = (hex: string, exp: Partial<typeof expected> = {}) => {
      const r = verifyCardanoEscrowLock(hex, { ...expected, ...exp });
      return r.ok ? "ok" : r.reason;
    };
    expect(reason(plan.serialized, { lovelace: 3_999_999n })).toMatch(/value differs/);
    expect(reason(plan.serialized, { datumCbor: REFUND_DATUM })).toMatch(/datum differs/);
    expect(
      reason(plan.serialized, { escrowAddress: masumiEscrowAddress("cardano-mainnet") }),
    ).toMatch(/escrow address/);
    expect(reason(plan.serialized, { ttlSlot: plan.ttlSlot - 1n })).toMatch(/ttl/);
    expect(reason(plan.serialized, { maxTtlSlot: plan.ttlSlot - 1n })).toMatch(/pay-by/);
    expect(reason(plan.serialized, { feeCap: 1000n })).toMatch(/fee cap/);
    expect(
      reason(plan.serialized, { requiredInput: { txHash: "9".repeat(64), index: 0 } }),
    ).toMatch(/nonce/);

    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    const rebuild = (patch: object) =>
      bytesToHex(
        assembleTx(
          encodeBody({
            inputs: tx.inputs,
            outputs: tx.outputs,
            fee: tx.fee ?? 0n,
            ttl: tx.ttl ?? 0n,
            ...patch,
          }),
          [],
        ),
      );
    const [escrowOut, change] = tx.outputs;
    if (escrowOut === undefined || change === undefined) throw new Error("fixture");
    // Change redirected to someone else.
    expect(reason(rebuild({ outputs: [escrowOut, { ...change, address: TO }] }))).toMatch(/change/);
    // A second output to the escrow address (dust at the script aborts every spend).
    expect(
      reason(rebuild({ outputs: [escrowOut, { address: ESCROW, value: change.value }] })),
    ).toMatch(/change/);
    // Escrow output without the datum (legacy format).
    expect(
      reason(rebuild({ outputs: [{ address: ESCROW, value: escrowOut.value }, change] })),
    ).toMatch(/map-format|inline datum/);
    // An extra body key (validity start).
    expect(reason(rebuild({ validityStart: 1n }))).toMatch(/unexpected body fields: 0,1,2,3,8/);
    // Signed already.
    expect(reason(signHex(plan.serialized))).toMatch(/no witnesses/);
    // Datum hash instead of an inline datum (hand-built map output).
    const body = decodeCbor(tx.bodyBytes).value;
    if (body.t !== "map") throw new Error("fixture");
    const datumHashOut = map([
      [uint(0), bytes(escrowOut.addressBytes)],
      [uint(1), uint(escrowOut.value.coin)],
      [uint(2), array([uint(0), bytes(new Uint8Array(32))])],
    ]);
    const forged = map(
      body.v.map(([k, v]) =>
        k.t === "uint" && k.v === 1n && v.t === "array"
          ? [k, array([datumHashOut, ...v.v.slice(1)])]
          : [k, v],
      ),
    );
    expect(reason(bytesToHex(assembleTx(encodeCbor(forged), [])))).toMatch(
      /canonical form|inline datum/,
    );
    // Inline datum wrapped in the wrong tag.
    const wrongTag = map([
      [uint(0), bytes(escrowOut.addressBytes)],
      [uint(1), uint(escrowOut.value.coin)],
      [uint(2), array([uint(1), tag(25, bytes(hexToBytes(GOLDEN_DATUM)))])],
    ]);
    const forged2 = map(
      body.v.map(([k, v]) =>
        k.t === "uint" && k.v === 1n && v.t === "array"
          ? [k, array([wrongTag, ...v.v.slice(1)])]
          : [k, v],
      ),
    );
    expect(reason(bytesToHex(assembleTx(encodeCbor(forged2), [])))).toMatch(/decode failed/);
  });

  it("builds a lock from Blockfrost (TTL = floor slot of payByTime)", async () => {
    const fetch = fixtureFetch({ rest: blockfrostPreprod({ utxos: WALLET }) });
    const b = createCardanoEscrowBuilder({
      blockfrostProjectId: KEY,
      network: "cardano-preprod",
      blockfrostBaseUrl: "https://bf.test/api/v0",
      fetch,
      sleep: noSleep,
      now: () => NOW,
    });
    expect(b.escrowAddress).toBe(ESCROW);
    const plan = await b.buildLock({
      from: FROM,
      lovelace: 4_000_000n,
      datumCbor: GOLDEN_DATUM,
      payByTimeMs: PAY_BY + 999,
      maxValiditySeconds: 600,
    });
    expect(plan.ttlSlot).toBe(cardanoPosixMsToSlot("cardano-preprod", PAY_BY, "floor"));
    expect(cardanoSlotToPosixMs("cardano-preprod", plan.ttlSlot)).toBeLessThanOrEqual(PAY_BY + 999);
    await expect(
      b.buildLock({
        from: FROM,
        lovelace: 4_000_000n,
        datumCbor: GOLDEN_DATUM,
        payByTimeMs: NOW.getTime() - 1,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.code === "REQUEST_EXPIRED");
    await expect(
      b.buildLock({
        from: FROM,
        lovelace: 4_000_000n,
        datumCbor: GOLDEN_DATUM,
        payByTimeMs: PAY_BY,
        maxValiditySeconds: 60,
      }),
    ).rejects.toThrow(/validity window/);
  });
});

describe("escrow buyer spends", () => {
  it("SetRefundRequested: CSL decodes it and agrees on script_data_hash, fee and witnesses", () => {
    const plan = spendPlan();
    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect([...tx.bodyKeys].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 8, 11, 13, 14, 16, 17]);
    expect(tx.witnessKeys).toEqual([5, 7]);

    // Full-transaction round trip and tx id (CSL oracle).
    const fixed = CSL.FixedTransaction.from_hex(plan.serialized);
    // CSL keeps the body bytes (tx id) as given. It re-emits the witness map in its own
    // key order (7 before 5), which is fine: only the redeemer bytes are hashed.
    expect(bytesToHex(fixed.raw_body())).toBe(bytesToHex(tx.bodyBytes));

    const csl = CSL.Transaction.from_hex(plan.serialized);
    const body = csl.body();
    const ws = csl.witness_set();
    const redeemers = ws.redeemers();
    if (redeemers === undefined) throw new Error("no redeemers");
    // script_data_hash: CSL's hash_script_data over the same redeemers + PlutusV3 cost model.
    const cslHash = CSL.hash_script_data(redeemers, cslCostmdls()).to_hex();
    expect(body.script_data_hash()?.to_hex()).toBe(cslHash);
    expect(plan.scriptDataHash).toBe(cslHash);

    // The redeemer bytes CSL re-serializes equal ours (map format preserved).
    expect(redeemers.to_hex()).toBe(bytesToHex(tx.witnessEntries.get(5) ?? new Uint8Array()));
    const r = redeemers.get(0);
    expect(redeemers.len()).toBe(1);
    expect(r.tag().kind()).toBe(CSL.RedeemerTagKind.Spend);
    expect(r.index().to_str()).toBe(String(plan.redeemerIndex));
    expect(r.data().to_hex()).toBe("d87a80");
    expect(r.ex_units().mem().to_str()).toBe("1500000");
    expect(r.ex_units().steps().to_str()).toBe("500000000");
    const sortedIds = [...tx.inputs]
      .sort((a, b) => (a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1))
      .map((i) => i.txHash);
    expect(sortedIds[plan.redeemerIndex]).toBe(ESCROW_UTXO.txHash);
    expect(ws.plutus_scripts()?.get(0).hash().to_hex()).toBe(MASUMI_SCRIPT_HASH);

    expect(body.required_signers()?.len()).toBe(1);
    expect(body.required_signers()?.get(0).to_hex()).toBe(BUYER_KH);
    expect(body.validity_start_interval_bignum()?.to_str()).toBe(String(TIP.slot - 60));
    expect(body.ttl_bignum()?.to_str()).toBe(String(TIP.slot + 300));

    // Collateral: one pure-ADA buyer UTxO, return to the buyer, total >= 150 % of the fee.
    const collateral = body.collateral();
    expect(collateral?.len()).toBe(1);
    const colIn = WALLET.find((u) => u.tx_hash === collateral?.get(0).transaction_id().to_hex());
    expect(colIn).toBeDefined();
    const total = BigInt(body.total_collateral()?.to_str() ?? "0");
    expect(total).toBe(requiredCollateral(plan.fee, 150n));
    expect(total * 100n).toBeGreaterThanOrEqual(plan.fee * 150n);
    expect(body.collateral_return()?.address().to_bech32()).toBe(FROM);
    expect(BigInt(body.collateral_return()?.amount().coin().to_str() ?? "0") + total).toBe(
      BigInt(colIn?.amount[0]?.quantity ?? "0"),
    );

    // Continuing output: escrow address, exact value, inline datum.
    const cont = body.outputs().get(0);
    expect(cont.address().to_bech32()).toBe(ESCROW);
    expect(cont.amount().coin().to_str()).toBe("4000000");
    expect(cont.plutus_data()?.to_hex()).toBe(REFUND_DATUM);
    expect(body.outputs().get(1).address().to_bech32()).toBe(FROM);

    // Fee >= CSL's size fee of the SIGNED tx + script fee (and not wildly above).
    const signed = CSL.Transaction.from_hex(signHex(plan.serialized));
    const sizeFee = BigInt(
      CSL.min_fee(
        signed,
        CSL.LinearFee.new(CSL.BigNum.from_str("44"), CSL.BigNum.from_str("155381")),
      ).to_str(),
    );
    const scriptFee = BigInt(
      CSL.min_script_fee(
        signed,
        CSL.ExUnitPrices.new(
          CSL.UnitInterval.new(CSL.BigNum.from_str("577"), CSL.BigNum.from_str("10000")),
          CSL.UnitInterval.new(CSL.BigNum.from_str("721"), CSL.BigNum.from_str("10000000")),
        ),
      ).to_str(),
    );
    expect(scriptFee).toBe(122600n);
    expect(plan.fee).toBeGreaterThanOrEqual(sizeFee + scriptFee);
    expect(plan.fee - (sizeFee + scriptFee)).toBeLessThan(44n * 16n);
    expect(signed.to_bytes().length).toBeLessThanOrEqual(16384);
  });

  it("signing keeps redeemers/scripts byte-exact; the signed check accepts only that", () => {
    const plan = spendPlan();
    const signed = signHex(plan.serialized);
    const tx = decodeCardanoTx(hexToBytes(signed));
    expect([...tx.witnessKeys]).toEqual([0, 5, 7]);
    expect(tx.vkeyWitnesses).toHaveLength(1);
    expect(tx.bodyHash).toBe(plan.bodyHash);
    expect(CSL.Transaction.from_hex(signed).witness_set().vkeys()?.len()).toBe(1);
    expect(() =>
      assertCardanoSignedMatchesUnsigned({
        signed,
        unsigned: plan.serialized,
        expectedSigner: FROM,
      }),
    ).not.toThrow();
    // Swap the redeemer bytes in the signed tx: body still signed, script witnesses differ.
    const other = spendPlan({ exUnits: { mem: 1_500_001n, steps: 500_000_000n } });
    const otherTx = decodeCardanoTx(hexToBytes(other.serialized));
    const tampered = bytesToHex(
      assembleTx(tx.bodyBytes, tx.vkeyWitnesses, {
        redeemers: otherTx.witnessEntries.get(5) ?? new Uint8Array(),
        plutusV3Scripts: tx.plutusV3Scripts,
      }),
    );
    expect(() =>
      assertCardanoSignedMatchesUnsigned({ signed: tampered, unsigned: plan.serialized }),
    ).toThrow(/script witnesses differ/);
    // Signing twice is refused.
    expect(() => signHex(signed)).toThrow(/already has witnesses/);
  });

  it("WithdrawRefund: pays the escrow out to the buyer, fee from the escrow itself", () => {
    const plan = spendPlan({ action: "WithdrawRefund", continuingDatumCbor: undefined });
    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect(tx.inputs).toHaveLength(1); // only the escrow: no wallet input needed
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0]?.address).toBe(FROM);
    expect(tx.outputs[0]?.value.coin).toBe(4_000_000n - plan.fee);
    const csl = CSL.Transaction.from_hex(plan.serialized);
    expect(csl.witness_set().redeemers()?.get(0).data().to_hex()).toBe("d87c80");
    expect(csl.witness_set().redeemers()?.get(0).index().to_str()).toBe("0");
    expect(csl.body().script_data_hash()?.to_hex()).toBe(
      CSL.hash_script_data(csl.witness_set().redeemers() as CSL.Redeemers, cslCostmdls()).to_hex(),
    );
    expect(
      verifyCardanoEscrowSpend(plan.serialized, {
        ...spendExpectation,
        action: "WithdrawRefund",
        continuingDatumCbor: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses bad spend inputs", () => {
    expect(() => spendPlan({ continuingDatumCbor: undefined })).toThrow(/hex|CBOR/);
    expect(() => spendPlan({ action: "WithdrawRefund" })).toThrow(/no continuing output/);
    expect(() => spendPlan({ escrow: { ...ESCROW_UTXO, address: TO } })).toThrow(/script address/);
    expect(() =>
      spendPlan({
        escrow: {
          ...ESCROW_UTXO,
          address: cardanoScriptAddress("cardano-preprod", "ab".repeat(28)),
        },
      }),
    ).toThrow(/not locked/);
    expect(() => spendPlan({ validityStartSlot: BigInt(TIP.slot + 301) })).toThrow(/validity/);
    expect(() => spendPlan({ exUnits: { mem: 16_500_001n, steps: 1n } })).toThrow(/limit/);
    expect(() =>
      spendPlan({ utxos: [utxo("1", 0, "1000000", { [`${"a".repeat(56)}01`]: "1" })] }),
    ).toThrow(/pure-ADA/);
    expect(() => spendPlan({ utxos: [utxo("1", 0, "1200000")] })).toThrow(ChainError);
  });

  it("the spend verifier refuses every deviation", () => {
    const plan = spendPlan();
    expect(verifyCardanoEscrowSpend(plan.serialized, spendExpectation)).toEqual({ ok: true });
    const reason = (hex: string, exp: object = {}) => {
      const r = verifyCardanoEscrowSpend(hex, { ...spendExpectation, ...exp });
      return r.ok ? "ok" : r.reason;
    };
    expect(reason(plan.serialized, { action: "WithdrawRefund" })).toMatch(/action/);
    expect(reason(plan.serialized, { plutusV3CostModel: [...COSTS.slice(0, -1), 1n] })).toMatch(
      /script_data_hash/,
    );
    expect(reason(plan.serialized, { continuingDatumCbor: GOLDEN_DATUM })).toMatch(/datum differs/);
    expect(reason(plan.serialized, { escrow: { ...ESCROW_UTXO, index: 1 } })).toMatch(/not spent/);
    expect(
      reason(plan.serialized, {
        escrow: { ...ESCROW_UTXO, value: { coin: 3_000_000n, assets: new Map() } },
      }),
    ).toMatch(/value differs/);
    expect(reason(plan.serialized, { feeCap: 1000n })).toMatch(/fee cap/);
    expect(reason(plan.serialized, { ttlSlot: 1n })).toMatch(/ttl/);
    expect(reason(plan.serialized, { collateralInputValue: 1n })).toMatch(/collateral/);
    expect(reason(plan.serialized, { script: MASUMI_SCRIPT_BYTES.slice(0, -1) })).toMatch(/script/);
    expect(reason(signHex(plan.serialized))).toMatch(/witness fields: 0,5,7/);

    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect(
      reason(withBody(plan.serialized, () => ({ requiredSigners: ["ab".repeat(28)] }))),
    ).toMatch(/script_data_hash|required signers/);
    // Same script_data_hash but another signer: caught by the signer check.
    expect(
      reason(withBody(plan.serialized, () => ({ requiredSigners: [BUYER_KH, "ab".repeat(28)] }))),
    ).toMatch(/required signers/);
    expect(
      reason(
        withBody(plan.serialized, () => ({ totalCollateral: (tx.totalCollateral ?? 0n) - 1000n })),
      ),
    ).toMatch(/collateral/);
    expect(
      reason(
        withBody(plan.serialized, () => ({
          collateralReturn: { ...tx.collateralReturn, address: TO },
        })),
      ),
    ).toMatch(/collateral must return/);
    expect(
      reason(
        withBody(plan.serialized, (b) => ({
          outputs: [b.outputs[0], { ...b.outputs[1], address: TO }],
        })),
      ),
    ).toMatch(/change to the buyer/);
    expect(
      reason(
        withBody(plan.serialized, (b) => ({
          outputs: [
            ...b.outputs,
            { address: ESCROW, value: { coin: 2_000_000n, assets: new Map() } },
          ],
        })),
      ),
    ).toMatch(/at most one change/);
    expect(
      reason(withBody(plan.serialized, () => ({ scriptDataHash: new Uint8Array(32) }))),
    ).toMatch(/script_data_hash/);
    // WithdrawRefund that leaves something at the escrow address.
    const w = spendPlan({ action: "WithdrawRefund", continuingDatumCbor: undefined });
    expect(
      reason(
        withBody(w.serialized, (b) => ({
          outputs: [{ ...b.outputs[0], address: ESCROW }],
        })),
        { action: "WithdrawRefund", continuingDatumCbor: undefined },
      ),
    ).toMatch(/plain change to the buyer/);
    // A spend must not pass as a plain transfer or a lock.
    expect(
      verifyCardanoTransfer(plan.serialized, "hex", cardanoPayload(), "cardano-preprod").ok,
    ).toBe(false);
    expect(
      verifyCardanoEscrowLock(plan.serialized, {
        network: "cardano-preprod",
        from: FROM,
        escrowAddress: ESCROW,
        lovelace: 4_000_000n,
        datumCbor: REFUND_DATUM,
      }).ok,
    ).toBe(false);
  });
});

describe("escrow builder over Blockfrost (fixtures)", () => {
  function setup(evaluate: (body: { cbor: string }) => unknown) {
    const seen: string[] = [];
    const rest = {
      ...blockfrostPreprod({ utxos: WALLET }),
      "/epochs/latest/parameters": BF_SCRIPT_PARAMS,
      [`/txs/${ESCROW_UTXO.txHash}/utxos`]: {
        hash: ESCROW_UTXO.txHash,
        inputs: [],
        outputs: [
          {
            address: ESCROW,
            amount: [{ unit: "lovelace", quantity: "4000000" }],
            output_index: 0,
            data_hash: "d".repeat(64),
            inline_datum: GOLDEN_DATUM,
            reference_script_hash: null,
            collateral: false,
            consumed_by_tx: null,
          },
        ],
      },
      "/utils/txs/evaluate/utxos": ({ body }: { body: { cbor: string } }) => {
        seen.push(body.cbor);
        return evaluate(body);
      },
    };
    const fetch = fixtureFetch({ rest });
    const b = createCardanoEscrowBuilder({
      blockfrostProjectId: KEY,
      network: "cardano-preprod",
      blockfrostBaseUrl: "https://bf.test/api/v0",
      fetch,
      sleep: noSleep,
      now: () => NOW,
    });
    return { b, fetch, seen };
  }

  it("reads the escrow UTxO, evaluates, and rebuilds with measured units + 20 %", async () => {
    const { b, fetch, seen } = setup((body) => {
      const tx = decodeCardanoTx(hexToBytes(body.cbor));
      const idx = tx.redeemers[0]?.index ?? -1;
      return {
        type: "jsonwsp/response",
        version: "1.0",
        servicename: "ogmios",
        methodname: "EvaluateTx",
        result: {
          EvaluationResult: { [`spend:${idx}`]: { memory: 1_000_000, steps: 400_000_000 } },
        },
      };
    });
    const escrow = await b.readEscrowUtxo(ESCROW_UTXO.txHash, 0);
    expect(escrow).toEqual(ESCROW_UTXO);
    expect(await b.readEscrowUtxo(ESCROW_UTXO.txHash, 5)).toBeNull();
    if (escrow === null) throw new Error("fixture");
    const plan = await b.buildSpend({
      action: "SetRefundRequested",
      from: FROM,
      escrow,
      continuingDatumCbor: REFUND_DATUM,
      validityStartSlot: BigInt(TIP.slot - 60),
      ttlSlot: BigInt(TIP.slot + 300),
    });
    expect(seen).toHaveLength(1);
    expect(plan.exUnits).toEqual({ mem: 1_200_000n, steps: 480_000_000n });
    const call = fetch.calls.find((c) => c.url.includes("/utils/txs/evaluate/utxos"));
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual({ cbor: seen[0], additionalUtxoSet: [] });
    expect(verifyCardanoEscrowSpend(plan.serialized, spendExpectation)).toEqual({ ok: true });
    // CSL agrees on the final script_data_hash with the measured units.
    const csl = CSL.Transaction.from_hex(plan.serialized);
    expect(csl.body().script_data_hash()?.to_hex()).toBe(
      CSL.hash_script_data(csl.witness_set().redeemers() as CSL.Redeemers, cslCostmdls()).to_hex(),
    );
    // With explicit units no evaluation happens.
    await b.buildSpend({
      action: "WithdrawRefund",
      from: FROM,
      escrow,
      validityStartSlot: BigInt(TIP.slot - 60),
      ttlSlot: BigInt(TIP.slot + 300),
      exUnits: EXUNITS,
    });
    expect(seen).toHaveLength(1);
  });

  it("a script failure during evaluation is a VALIDATION_FAILED, never a plan", async () => {
    const { b } = setup(() => ({
      type: "jsonwsp/response",
      result: { EvaluationFailure: { ScriptFailures: { "spend:1": [{ validatorFailed: {} }] } } },
    }));
    await expect(
      b.buildSpend({
        action: "WithdrawRefund",
        from: FROM,
        escrow: ESCROW_UTXO,
        validityStartSlot: BigInt(TIP.slot - 60),
        ttlSlot: BigInt(TIP.slot + 300),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ChainError &&
        e.code === "VALIDATION_FAILED" &&
        /evaluation failed/.test(e.message),
    );
  });

  it("parses Ogmios v5 evaluation replies and their failures", () => {
    expect(
      parseEvaluation({
        result: {
          EvaluationResult: {
            "spend:1": { memory: 5, steps: 7 },
            "withdrawal:0": { memory: 1, steps: 2 },
          },
        },
      }),
    ).toEqual([
      { tag: "spend", index: 1, mem: 5n, steps: 7n },
      { tag: "reward", index: 0, mem: 1n, steps: 2n },
    ]);
    expect(() => parseEvaluation({ type: "jsonwsp/fault", fault: { string: "boom" } })).toThrow(
      /boom/,
    );
    expect(() => parseEvaluation({ result: { EvaluationResult: { bogus: {} } } })).toThrow(
      /malformed/,
    );
    expect(() => parseEvaluation([])).toThrow(/malformed/);
  });

  it("reads PlutusV3 cost model and prices from protocol parameters", async () => {
    const client = new BlockfrostClient({
      projectId: KEY,
      network: "cardano-preprod",
      baseUrl: "https://bf.test/api/v0",
      fetch: fixtureFetch({
        rest: { ...blockfrostPreprod(), "/epochs/latest/parameters": BF_SCRIPT_PARAMS },
      }),
      sleep: noSleep,
    });
    const p = await client.scriptProtocolParams();
    expect(p).toEqual(SCRIPT_PARAMS);
    const noCosts = new BlockfrostClient({
      projectId: KEY,
      network: "cardano-preprod",
      baseUrl: "https://bf.test/api/v0",
      fetch: fixtureFetch({ rest: blockfrostPreprod() }),
      sleep: noSleep,
    });
    await expect(noCosts.scriptProtocolParams()).rejects.toThrow(/PlutusV3/);
  });
});
