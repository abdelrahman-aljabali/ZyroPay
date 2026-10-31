import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  allowanceScriptAddress,
  cardanoAddressBytes,
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  checkCardanoAllowanceCreateTx,
  checkCardanoAllowanceOwnerSpendTx,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import type { ScriptProtocolParams } from "../cardano/blockfrost";
import { minAdaFor, planCardanoPayment, verifyCardanoTransfer } from "../cardano/builder";
import {
  cardanoSlotToPosixMs,
  masumiEscrowAddress,
  planCardanoEscrowLock,
  planCardanoEscrowSpend,
} from "../cardano/escrow";
import type { AllowanceDatum } from "../cardano/allowance";
import { planAllowanceCreate, planAllowanceOwnerSpend } from "../cardano/allowance";
import type { CardanoTxBody } from "../cardano/tx";
import { assembleTx, decodeCardanoTx, emptyValue, encodeBody } from "../cardano/tx";
import { cardanoPayload, FROM, SENDER_PK, TO, UNIT, utxo } from "./cardano-fixtures";
import COST_MODEL from "./fixtures/cardano/plutus-v3-cost-model.json";

/*
 * Real unsigned transactions built by the Cardano builders, committed as JSON vectors for
 * the on-device decoder (@zyropay/shared decodeCardanoUnsignedTx / checkCardano*Tx) and the
 * app's review integrity tests, plus tampered variants a compromised API could send. The
 * committed files must equal what the builders produce today; regenerate with
 * `UPDATE_CARDANO_VECTORS=1 pnpm --filter @zyropay/blockchain test cardano-review-vectors`.
 */

const TARGETS = [
  "../../../shared/src/__fixtures__/cardano-review-vectors.json",
  "../../../../apps/mobile/src/lib/__fixtures__/cardano-review-vectors.json",
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

const NETWORK = "cardano-preprod" as const;
/** 2030-01-01T00:00:00Z on preprod: far enough ahead that the vectors stay "not expired". */
const TTL_SLOT = 237_772_800n;
const VALID_FROM_SLOT = TTL_SLOT - 600n;
const GOLDEN_DATUM =
  "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff";
const REFUND_DATUM = GOLDEN_DATUM.replace(/0000d87980ff$/, "001b0000019fc76087a0d87b80ff");
const COLLATERAL = 1_435_230n;
const LOCKED = 4_000_000n;
const ESCROW = masumiEscrowAddress(NETWORK);
const ESCROW_TX = "2".repeat(64);
/** A key address the API might try to divert funds to. */
const MALLORY = cardanoEnterpriseAddress("ee".repeat(32), NETWORK);

const PARAMS: ScriptProtocolParams = {
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
  plutusV3CostModel: COST_MODEL.PlutusV3.map((c) => BigInt(c)),
};
/** Auto-pay allowance (docs/AUTOPAY.md): FROM is the owner, AGENT the server-held agent key. */
const AGENT_PK = "ab".repeat(32);
const AGENT = cardanoEnterpriseAddress(AGENT_PK, NETWORK);
const OWNER_KH = cardanoPaymentKeyHash(FROM) ?? "";
const ALLOWANCE_ADDRESS = allowanceScriptAddress(NETWORK, OWNER_KH);
const ALLOWANCE_TX = "6".repeat(64);
const ALLOWANCE_LOVELACE = 20_000_000n;
const TOP_UP_LOVELACE = 30_000_000n;
const FLOAT_LOVELACE = 5_000_000n;
const ALLOWANCE_DATUM: AllowanceDatum = {
  agentKeyHash: cardanoKeyHash(AGENT_PK),
  perPaymentMax: 3_000_000n,
  periodMs: 86_400_000n,
  periodCap: 5_000_000n,
  periodStart: cardanoSlotToPosixMs(NETWORK, VALID_FROM_SLOT) - 3_600_000n,
  spentInPeriod: 0n,
  allowedPayees: [{ kind: "key", hash: cardanoPaymentKeyHash(TO) ?? "" }],
  expiresAt: cardanoSlotToPosixMs(NETWORK, TTL_SLOT) + 7n * 86_400_000n,
};
const datumView = (d: AllowanceDatum) => ({
  agentKeyHash: d.agentKeyHash,
  perPaymentMax: d.perPaymentMax.toString(),
  periodMs: d.periodMs.toString(),
  periodCap: d.periodCap.toString(),
  periodStart: d.periodStart.toString(),
  spentInPeriod: d.spentInPeriod.toString(),
  allowedPayees: d.allowedPayees.map((p) => ({ ...p })),
  expiresAt: d.expiresAt.toString(),
});

const WALLET = [utxo("1", 0, "5000000"), utxo("3", 0, "1500000"), utxo("4", 2, "9000000")];

/** Re-encode an unsigned transaction with a patched body (script witnesses kept). */
function patched(serialized: string, patch: (b: CardanoTxBody) => Partial<CardanoTxBody>) {
  const tx = decodeCardanoTx(hexToBytes(serialized));
  const body: CardanoTxBody = {
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

function transfer(amount: bigint, unit: string | null) {
  const value =
    unit === null ? emptyValue(amount) : { coin: 0n, assets: new Map([[unit, amount]]) };
  const recipient = { address: TO, value };
  if (unit !== null)
    recipient.value = { ...value, coin: minAdaFor(recipient, PARAMS.coinsPerUtxoByte) };
  const utxos = unit === null ? WALLET : [...WALLET, utxo("5", 1, "3000000", { [unit]: "1000" })];
  const plan = planCardanoPayment({
    recipient,
    unit,
    utxos,
    params: PARAMS,
    ttl: TTL_SLOT,
    from: FROM,
    maxInputs: 20,
  });
  return bytesToHex(assembleTx(plan.bodyBytes, []));
}

function spend(action: "SetRefundRequested" | "WithdrawRefund") {
  return planCardanoEscrowSpend({
    network: NETWORK,
    action,
    from: FROM,
    escrow: {
      txHash: ESCROW_TX,
      index: 0,
      address: ESCROW,
      value: emptyValue(LOCKED),
      inlineDatum: GOLDEN_DATUM,
    },
    ...(action === "SetRefundRequested" ? { continuingDatumCbor: REFUND_DATUM } : {}),
    utxos: WALLET,
    params: PARAMS,
    validityStartSlot: VALID_FROM_SLOT,
    ttlSlot: TTL_SLOT,
    exUnits: { mem: 1_500_000n, steps: 500_000_000n },
  }).serialized;
}

function ownerSpend(continuing: boolean) {
  return planAllowanceOwnerSpend({
    network: NETWORK,
    owner: FROM,
    allowance: { txHash: ALLOWANCE_TX, index: 0, value: emptyValue(ALLOWANCE_LOVELACE) },
    ...(continuing ? { continuing: { lovelace: TOP_UP_LOVELACE, datum: ALLOWANCE_DATUM } } : {}),
    utxos: [...WALLET, utxo("7", 0, "15000000")],
    params: PARAMS,
    validityStartSlot: VALID_FROM_SLOT,
    ttlSlot: TTL_SLOT,
    exUnits: { mem: 300_000n, steps: 120_000_000n },
  }).serialized;
}

function vectors() {
  const transferAda = transfer(2_000_000n, null);
  const transferToken = transfer(100n, UNIT);
  const escrowLock = planCardanoEscrowLock({
    network: NETWORK,
    from: FROM,
    escrowAddress: ESCROW,
    lovelace: LOCKED,
    datumCbor: GOLDEN_DATUM,
    ttlSlot: TTL_SLOT,
    utxos: WALLET,
    params: PARAMS,
  }).serialized;
  const allowanceCreate = planAllowanceCreate({
    network: NETWORK,
    from: FROM,
    lovelace: ALLOWANCE_LOVELACE,
    datum: ALLOWANCE_DATUM,
    float: { address: AGENT, lovelace: FLOAT_LOVELACE },
    utxos: [...WALLET, utxo("7", 0, "15000000")],
    params: PARAMS,
    ttlSlot: TTL_SLOT,
  }).serialized;
  const allowanceTopUp = ownerSpend(true);
  const allowanceRevoke = ownerSpend(false);
  const refundRequest = spend("SetRefundRequested");
  const withdrawRefund = spend("WithdrawRefund");
  const toMallory = <T extends { address: string | null }>(o: T): T => ({ ...o, address: MALLORY });
  const plus = <T extends { value: { coin: bigint } }>(o: T, d: bigint): T => ({
    ...o,
    value: { ...o.value, coin: o.value.coin + d },
  });
  const first = <T>(xs: readonly T[], f: (x: T) => T): T[] =>
    xs.map((x, i) => (i === 0 ? f(x) : x));
  const last = <T>(xs: readonly T[], f: (x: T) => T): T[] =>
    xs.map((x, i) => (i === xs.length - 1 ? f(x) : x));
  const stolen = { address: MALLORY, value: emptyValue(1_000_000n) };
  return {
    network: NETWORK,
    senderPublicKey: SENDER_PK,
    from: FROM,
    to: TO,
    mallory: MALLORY,
    tokenUnit: UNIT,
    escrow: {
      address: ESCROW,
      utxo: `${ESCROW_TX}#0`,
      datumCbor: GOLDEN_DATUM,
      lockedLovelace: LOCKED.toString(),
      collateralLovelace: COLLATERAL.toString(),
      price: (LOCKED - COLLATERAL).toString(),
      payByTime: cardanoSlotToPosixMs(NETWORK, TTL_SLOT + 60n).toString(),
    },
    validFrom: new Date(Number(cardanoSlotToPosixMs(NETWORK, VALID_FROM_SLOT))).toISOString(),
    validUntil: new Date(Number(cardanoSlotToPosixMs(NETWORK, TTL_SLOT))).toISOString(),
    allowance: {
      ownerKeyHash: OWNER_KH,
      address: ALLOWANCE_ADDRESS,
      agentAddress: AGENT,
      utxo: `${ALLOWANCE_TX}#0`,
      datum: datumView(ALLOWANCE_DATUM),
      allowanceLovelace: ALLOWANCE_LOVELACE.toString(),
      floatLovelace: FLOAT_LOVELACE.toString(),
      topUpLovelace: TOP_UP_LOVELACE.toString(),
    },
    allowanceCreate: { hex: allowanceCreate },
    allowanceTopUp: { hex: allowanceTopUp },
    allowanceRevoke: { hex: allowanceRevoke },
    transferAda: { hex: transferAda, amount: "2000000" },
    transferToken: { hex: transferToken, amount: "100" },
    escrowLock: { hex: escrowLock },
    refundRequest: { hex: refundRequest },
    withdrawRefund: { hex: withdrawRefund },
    tampered: {
      transferOtherRecipient: patched(transferAda, (b) => ({
        outputs: first(b.outputs, toMallory),
      })),
      transferOtherAmount: patched(transferAda, (b) => ({
        outputs: last(
          first(b.outputs, (o) => plus(o, 1_000_000n)),
          (o) => plus(o, -1_000_000n),
        ),
      })),
      transferExtraOutput: patched(transferAda, (b) => ({
        outputs: [...last(b.outputs, (o) => plus(o, -1_000_000n)), stolen],
      })),
      transferChangeElsewhere: patched(transferAda, (b) => ({
        outputs: last(b.outputs, toMallory),
      })),
      transferFeeTooHigh: patched(transferAda, (b) => ({
        fee: b.fee + 2_000_000n,
        outputs: last(b.outputs, (o) => plus(o, -2_000_000n)),
      })),
      transferExpired: patched(transferAda, () => ({ ttl: 50_000_000n })),
      lockOtherAddress: patched(escrowLock, (b) => ({ outputs: first(b.outputs, toMallory) })),
      lockOtherDatum: patched(escrowLock, (b) => ({
        outputs: first(b.outputs, (o) => ({ ...o, inlineDatum: hexToBytes(REFUND_DATUM) })),
      })),
      lockExtraOutput: patched(escrowLock, (b) => ({
        outputs: [...last(b.outputs, (o) => plus(o, -1_000_000n)), stolen],
      })),
      refundRequestChangeElsewhere: patched(refundRequest, (b) => ({
        outputs: last(b.outputs, toMallory),
      })),
      refundRequestDrainsEscrow: patched(refundRequest, (b) => ({
        outputs: [...first(b.outputs, (o) => plus(o, -1_000_000n)), stolen],
      })),
      allowanceCreateOtherScript: patched(allowanceCreate, (b) => ({
        outputs: first(b.outputs, toMallory),
      })),
      allowanceCreateOtherDatum: patched(allowanceCreate, (b) => ({
        outputs: first(b.outputs, (o) => ({
          ...o,
          inlineDatum: hexToBytes(
            bytesToHex(o.inlineDatum ?? new Uint8Array()).replace("1a002dc6c0", "1a05f5e100"),
          ),
        })),
      })),
      allowanceCreateFloatElsewhere: patched(allowanceCreate, (b) => ({
        outputs: b.outputs.map((o, i) => (i === 1 ? toMallory(o) : o)),
      })),
      allowanceCreateExtraOutput: patched(allowanceCreate, (b) => ({
        outputs: [...last(b.outputs, (o) => plus(o, -1_000_000n)), stolen],
      })),
      allowanceTopUpDrains: patched(allowanceTopUp, (b) => ({
        outputs: [...first(b.outputs, (o) => plus(o, -1_000_000n)), stolen],
      })),
      allowanceRevokeToOther: patched(allowanceRevoke, (b) => ({
        outputs: first(b.outputs, toMallory),
      })),
      withdrawToOther: patched(withdrawRefund, (b) => ({ outputs: first(b.outputs, toMallory) })),
      withdrawCollateralElsewhere: patched(withdrawRefund, (b) => ({
        ...(b.collateralReturn ? { collateralReturn: toMallory(b.collateralReturn) } : {}),
      })),
    },
  };
}

describe("Cardano review vectors (on-device decoder fixtures)", () => {
  const data = vectors();

  it("the honest vectors pass the API's own verifiers", () => {
    const payload = cardanoPayload({ amount: "2000000", feeCap: "1000000" });
    expect(verifyCardanoTransfer(data.transferAda.hex, "hex", payload, NETWORK)).toEqual({
      ok: true,
    });
    expect(
      verifyCardanoTransfer(data.tampered.transferOtherRecipient, "hex", payload, NETWORK).ok,
    ).toBe(false);
    // Addresses round-trip (the mallory address is a valid preprod key address).
    expect(cardanoAddressBytes(MALLORY)[0]).toBe(0x60);
  });

  it("the allowance vectors pass the on-device checks, and every tampered one fails", () => {
    const now = new Date(Number(cardanoSlotToPosixMs(NETWORK, VALID_FROM_SLOT)));
    const a = data.allowance;
    const create = (hex: string) =>
      checkCardanoAllowanceCreateTx(hex, {
        network: NETWORK,
        owner: FROM,
        agentAddress: a.agentAddress,
        allowanceLovelace: BigInt(a.allowanceLovelace),
        floatLovelace: BigInt(a.floatLovelace),
        datum: a.datum,
        maxFee: 1_000_000n,
        now,
      });
    const owner = (hex: string, action: "top_up" | "revoke") =>
      checkCardanoAllowanceOwnerSpendTx(hex, {
        network: NETWORK,
        action,
        owner: FROM,
        utxo: a.utxo,
        ...(action === "top_up" ? { newLovelace: BigInt(a.topUpLovelace), datum: a.datum } : {}),
        maxFee: 1_000_000n,
        validFrom: data.validFrom,
        validUntil: data.validUntil,
        now,
      });
    expect(create(data.allowanceCreate.hex)).toMatchObject({ ok: true });
    expect(owner(data.allowanceTopUp.hex, "top_up")).toMatchObject({ ok: true });
    expect(owner(data.allowanceRevoke.hex, "revoke")).toMatchObject({ ok: true });
    const t = data.tampered;
    for (const hex of [
      t.allowanceCreateOtherScript,
      t.allowanceCreateOtherDatum,
      t.allowanceCreateFloatElsewhere,
      t.allowanceCreateExtraOutput,
    ])
      expect(create(hex).ok).toBe(false);
    expect(create(data.allowanceCreate.hex.replace(a.datum.agentKeyHash, "ee".repeat(28))).ok).toBe(
      false,
    );
    expect(owner(t.allowanceTopUpDrains, "top_up").ok).toBe(false);
    expect(owner(t.allowanceRevokeToOther, "revoke").ok).toBe(false);
    expect(owner(data.allowanceRevoke.hex, "top_up").ok).toBe(false);
    expect(owner(data.allowanceTopUp.hex, "revoke").ok).toBe(false);
  });

  it("the committed fixtures equal what the builders produce", () => {
    const json = `${JSON.stringify(data, null, 2)}\n`;
    for (const target of TARGETS) {
      if (process.env.UPDATE_CARDANO_VECTORS === "1") writeFileSync(target, json);
      expect(readFileSync(target, "utf8")).toBe(json);
    }
  });
});
