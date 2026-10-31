import { describe, expect, it } from "vitest";
import V from "./__fixtures__/cardano-review-vectors.json";
import { cardanoUnsignedBodyHash, MASUMI_ESCROW_ADDRESSES } from "./cardano";
import {
  checkCardanoEscrowLockTx,
  checkCardanoEscrowSpendTx,
  checkCardanoTransferTx,
  type CardanoEscrowLockExpectation,
  type CardanoEscrowSpendExpectation,
  type CardanoTransferExpectation,
} from "./cardano-tx-check";
import { cardanoSlotToMs, CardanoTxDecodeError, decodeCardanoUnsignedTx } from "./cardano-tx";

// Vectors: real unsigned transactions from @zyropay/blockchain's builders
// (packages/blockchain/src/__tests__/cardano-review-vectors.test.ts keeps them in sync).
const NET = "cardano-preprod" as const;
const NOW = new Date("2026-10-30T12:00:00.000Z");

const transfer: CardanoTransferExpectation = {
  network: NET,
  from: V.from,
  to: V.to,
  amount: 2_000_000n,
  unit: null,
  maxFee: 1_000_000n,
  now: NOW,
};
const lock: CardanoEscrowLockExpectation = {
  network: NET,
  from: V.from,
  amount: BigInt(V.escrow.price),
  unit: null,
  lockedLovelace: BigInt(V.escrow.lockedLovelace),
  collateralLovelace: BigInt(V.escrow.collateralLovelace),
  datumCbor: V.escrow.datumCbor,
  payByMs: Number(V.escrow.payByTime),
  maxFee: 1_000_000n,
  now: NOW,
};
const refund: CardanoEscrowSpendExpectation = {
  network: NET,
  from: V.from,
  action: "request_refund",
  escrowUtxo: V.escrow.utxo,
  lockedLovelace: BigInt(V.escrow.lockedLovelace),
  unit: null,
  amount: BigInt(V.escrow.price),
  validFrom: V.validFrom,
  validUntil: V.validUntil,
  maxFee: 2_000_000n,
  now: NOW,
};
const withdraw: CardanoEscrowSpendExpectation = { ...refund, action: "withdraw_refund" };

const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : (r.reason ?? ""));

describe("decodeCardanoUnsignedTx", () => {
  it("decodes a plain ADA transfer", () => {
    const tx = decodeCardanoUnsignedTx(V.transferAda.hex, NET);
    expect(tx.bodyKeys).toEqual([0, 1, 2, 3]);
    expect(tx.witnessKeys).toEqual([]);
    expect(tx.bodyHash).toBe(cardanoUnsignedBodyHash(V.transferAda.hex));
    expect(tx.outputs[0]).toMatchObject({ address: V.to, lovelace: 2_000_000n, format: "array" });
    expect(tx.outputs[1]?.address).toBe(V.from);
    expect(tx.inputs.length).toBeGreaterThan(0);
    expect(cardanoSlotToMs(NET, tx.ttl ?? 0n)).toBe(Date.parse("2030-01-01T00:00:00Z"));
  });

  it("decodes a token transfer, an escrow lock and both escrow spends", () => {
    const token = decodeCardanoUnsignedTx(V.transferToken.hex, NET);
    expect(token.outputs[0]?.assets.get(V.tokenUnit)).toBe(100n);
    const l = decodeCardanoUnsignedTx(V.escrowLock.hex, NET);
    expect(l.outputs[0]).toMatchObject({
      address: MASUMI_ESCROW_ADDRESSES[NET],
      lovelace: 4_000_000n,
      format: "map",
      inlineDatumHex: V.escrow.datumCbor,
    });
    const s = decodeCardanoUnsignedTx(V.refundRequest.hex, NET);
    expect(s.bodyKeys).toEqual([0, 1, 2, 3, 8, 11, 13, 14, 16, 17]);
    expect(s.witnessKeys).toEqual([5, 7]);
    expect(s.redeemers).toHaveLength(1);
    expect(s.redeemers[0]?.dataHex).toBe("d87a80");
    expect(s.plutusV3ScriptHashes).toEqual([
      "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    ]);
    expect(s.bodyHash).toBe(cardanoUnsignedBodyHash(V.refundRequest.hex));
    expect(decodeCardanoUnsignedTx(V.withdrawRefund.hex, NET).redeemers[0]?.dataHex).toBe("d87c80");
  });

  it("refuses other networks, signatures, non-canonical CBOR and unknown fields", () => {
    expect(() => decodeCardanoUnsignedTx(V.transferAda.hex, "cardano-mainnet")).toThrow(
      /another network/,
    );
    expect(() => decodeCardanoUnsignedTx(V.transferAda.hex, "solana-mainnet")).toThrow(
      CardanoTxDecodeError,
    );
    // A vkey witness set {0: [...]} in place of the empty one.
    const signed = V.transferAda.hex.replace(/a0f5f6$/, "a10080f5f6");
    expect(() => decodeCardanoUnsignedTx(signed, NET)).toThrow(/signature/);
    // Body map(4) -> map(5) with an extra key 7 (auxiliary data hash) = 32 zero bytes.
    const body = V.transferAda.hex.slice(2, -6);
    const extra = `84a5${body.slice(2)}075820${"00".repeat(32)}a0f5f6`;
    expect(() => decodeCardanoUnsignedTx(extra, NET)).toThrow(/unexpected body field 7/);
    // Non-shortest head for the fee (key 2).
    expect(() => decodeCardanoUnsignedTx(V.transferAda.hex.replace(/^84a4/, "849f"), NET)).toThrow(
      CardanoTxDecodeError,
    );
    expect(() => decodeCardanoUnsignedTx(`${V.transferAda.hex}00`, NET)).toThrow(/trailing/);
    expect(() => decodeCardanoUnsignedTx("zz", NET)).toThrow(/hex/);
    expect(() => decodeCardanoUnsignedTx(V.transferAda.hex.slice(0, -2), NET)).toThrow();
  });
});

describe("checkCardanoTransferTx", () => {
  it("passes the honest transfers", () => {
    expect(reason(checkCardanoTransferTx(V.transferAda.hex, transfer))).toBe("ok");
    expect(
      reason(
        checkCardanoTransferTx(V.transferToken.hex, {
          ...transfer,
          amount: 100n,
          unit: V.tokenUnit,
          maxFee: 3_000_000n,
        }),
      ),
    ).toBe("ok");
  });

  it("refuses every tampered variant with a specific reason", () => {
    const t = V.tampered;
    expect(reason(checkCardanoTransferTx(t.transferOtherRecipient, transfer))).toMatch(
      /different address/,
    );
    expect(reason(checkCardanoTransferTx(t.transferOtherAmount, transfer))).toMatch(
      /different amount/,
    );
    expect(reason(checkCardanoTransferTx(t.transferExtraOutput, transfer))).toMatch(/more outputs/);
    expect(reason(checkCardanoTransferTx(t.transferChangeElsewhere, transfer))).toMatch(
      /change to another address/,
    );
    expect(reason(checkCardanoTransferTx(t.transferFeeTooHigh, transfer))).toMatch(/fee cap/);
    expect(reason(checkCardanoTransferTx(t.transferExpired, transfer))).toMatch(/already ended/);
  });

  it("refuses a transfer reviewed with other terms", () => {
    const hex = V.transferAda.hex;
    expect(checkCardanoTransferTx(hex, { ...transfer, to: V.mallory }).ok).toBe(false);
    expect(checkCardanoTransferTx(hex, { ...transfer, amount: 1n }).ok).toBe(false);
    expect(checkCardanoTransferTx(hex, { ...transfer, from: V.mallory }).ok).toBe(false);
    expect(checkCardanoTransferTx(hex, { ...transfer, maxFee: 1000n }).ok).toBe(false);
    expect(checkCardanoTransferTx(hex, { ...transfer, unit: V.tokenUnit }).ok).toBe(false);
    expect(checkCardanoTransferTx(hex, { ...transfer, now: new Date("2031-01-01") }).ok).toBe(
      false,
    );
    // An escrow lock or a script spend is never a transfer.
    expect(checkCardanoTransferTx(V.escrowLock.hex, transfer).ok).toBe(false);
    expect(reason(checkCardanoTransferTx(V.refundRequest.hex, transfer))).toMatch(/fields/);
    // A token transfer that sends too much ADA as "deposit" or a low fee cap.
    expect(
      checkCardanoTransferTx(V.transferToken.hex, { ...transfer, amount: 100n, unit: V.tokenUnit })
        .ok,
    ).toBe(false);
  });
});

describe("checkCardanoEscrowLockTx", () => {
  it("passes the honest lock and refuses tampered ones", () => {
    expect(reason(checkCardanoEscrowLockTx(V.escrowLock.hex, lock))).toBe("ok");
    const t = V.tampered;
    expect(reason(checkCardanoEscrowLockTx(t.lockOtherAddress, lock))).toMatch(/Masumi escrow/);
    expect(reason(checkCardanoEscrowLockTx(t.lockOtherDatum, lock))).toMatch(/datum/);
    expect(reason(checkCardanoEscrowLockTx(t.lockExtraOutput, lock))).toMatch(/more outputs/);
    expect(reason(checkCardanoEscrowLockTx(V.escrowLock.hex, { ...lock, maxFee: 1000n }))).toMatch(
      /fee cap/,
    );
    expect(
      reason(
        checkCardanoEscrowLockTx(V.escrowLock.hex, { ...lock, payByMs: lock.payByMs - 120_000 }),
      ),
    ).toMatch(/pay-by/);
    expect(
      reason(checkCardanoEscrowLockTx(V.escrowLock.hex, { ...lock, amount: lock.amount + 1n })),
    ).toMatch(/add up/);
    expect(
      reason(
        checkCardanoEscrowLockTx(V.escrowLock.hex, {
          ...lock,
          amount: lock.amount - 1n,
          lockedLovelace: lock.lockedLovelace - 1n,
        }),
      ),
    ).toMatch(/different amount/);
    expect(checkCardanoEscrowLockTx(V.transferAda.hex, lock).ok).toBe(false);
  });
});

describe("checkCardanoEscrowSpendTx", () => {
  it("passes the honest refund request and withdrawal", () => {
    expect(reason(checkCardanoEscrowSpendTx(V.refundRequest.hex, refund))).toBe("ok");
    expect(reason(checkCardanoEscrowSpendTx(V.withdrawRefund.hex, withdraw))).toBe("ok");
  });

  it("refuses tampered spends and other actions", () => {
    const t = V.tampered;
    expect(reason(checkCardanoEscrowSpendTx(t.refundRequestChangeElsewhere, refund))).toMatch(
      /change to another address/,
    );
    expect(reason(checkCardanoEscrowSpendTx(t.refundRequestDrainsEscrow, refund))).toMatch(
      /amount held in escrow/,
    );
    expect(reason(checkCardanoEscrowSpendTx(t.withdrawToOther, withdraw))).toMatch(
      /refund to another address/,
    );
    expect(reason(checkCardanoEscrowSpendTx(t.withdrawCollateralElsewhere, withdraw))).toMatch(
      /collateral/,
    );
    expect(reason(checkCardanoEscrowSpendTx(V.refundRequest.hex, withdraw))).toMatch(
      /another action/,
    );
    expect(
      reason(
        checkCardanoEscrowSpendTx(V.refundRequest.hex, {
          ...refund,
          escrowUtxo: `${"3".repeat(64)}#0`,
        }),
      ),
    ).toMatch(/escrow shown/);
    expect(
      reason(
        checkCardanoEscrowSpendTx(V.refundRequest.hex, { ...refund, validUntil: V.validFrom }),
      ),
    ).toMatch(/validity window/);
    expect(
      reason(checkCardanoEscrowSpendTx(V.refundRequest.hex, { ...refund, maxFee: 1n })),
    ).toMatch(/fee/);
    expect(checkCardanoEscrowSpendTx(V.escrowLock.hex, refund).ok).toBe(false);
  });
});
