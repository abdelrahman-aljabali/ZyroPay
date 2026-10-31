/*
 * Seller escrow spends, built offline with the Evolution SDK against fixture Blockfrost
 * (protocol parameters, UTxOs and script evaluation are stubbed; nothing is submitted) and
 * verified INDEPENDENTLY with @zyropay/blockchain's own CBOR decoder: redeemer, required
 * signer, validity bounds, script_data_hash, inline script, continuing datum, vkey witness.
 * The script itself is not executed here (that needs a live evaluator).
 */
import { Address, Client, preprod, PrivateKey, TransactionHash } from "@evolution-sdk/evolution";
import {
  masumiEscrowScriptHash,
  MASUMI_DEFAULT_DEPLOYMENT,
  parseMasumiLockDatum,
} from "@x402/cardano";
import {
  cardanoPosixMsToSlot,
  cardanoScriptDataHash,
  decodeCardanoTx,
  MASUMI_SCRIPT_BYTES,
  plutusV3LanguageViews,
  verifyVkeyWitness,
} from "@zyropay/blockchain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEscrowUtxo, walletUtxos } from "../src/escrow/chain";
import { ESCROW_STATE } from "../src/escrow/datum";
import { VESTED_PAY_V2_APPLIED_HEX } from "../src/escrow/script";
import type { SellerAction } from "../src/escrow/datum";
import {
  buildSellerSpend,
  ceilToSlotMs,
  COOLDOWN_MS,
  escrowScriptHash,
  slotStartMs,
} from "../src/escrow/spend";
import {
  chainRoutes,
  ESCROW_ADDRESS,
  EX_UNITS,
  issueQuote,
  lockDatumHex,
  PLUTUS_V3_COSTS,
  SELLER,
  SELLER_KEY,
  WALLET_UTXOS,
} from "./escrow-fixtures";
import { BLOCKFROST, stubFetch, TEST_PROJECT_ID } from "./helpers";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const URL_OK = "https://seller.example/v1/address-report/escrow?address=addr_test1xyz";
const LOCK_TX = "a".repeat(64);
const RESULT_HASH = "ab".repeat(32);

const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  return Client.make(preprod)
    .withBlockfrost({ baseUrl: BLOCKFROST, projectId: TEST_PROJECT_ID })
    .withPrivateKey({
      paymentKey: PrivateKey.toBech32(SELLER_KEY.privateKey),
      addressType: "Enterprise",
    });
}

async function setup() {
  const quote = await issueQuote(NOW, URL_OK);
  const { datum, lockedLovelace } = lockDatumHex(quote);
  return { quote, datum, lockedLovelace };
}

async function build(action: SellerAction, tipMs: number, datum: string, lovelace: bigint) {
  stubFetch(
    chainRoutes({
      tipMs,
      txs: {
        [LOCK_TX]: [
          { txHash: LOCK_TX, index: 0, address: ESCROW_ADDRESS, lovelace, inlineDatum: datum },
        ],
      },
    }),
  );
  const c = client();
  const escrow = await loadEscrowUtxo(c, LOCK_TX, 0);
  const view = parseMasumiLockDatum(datum)!;
  const wallet = await walletUtxos(c, SELLER.address);
  return buildSellerSpend({
    client: c,
    seller: SELLER,
    action,
    escrow,
    view,
    walletUtxos: wallet,
    tipMs: BigInt(tipMs),
    ...(action === "SubmitResult" ? { resultHash: RESULT_HASH } : {}),
  });
}

describe("the escrow script", () => {
  it("is the canonical applied vested_pay v2 (hash = @x402/cardano escrow credential)", () => {
    expect(VESTED_PAY_V2_APPLIED_HEX).toBe(bytesToHex(MASUMI_SCRIPT_BYTES));
    expect(escrowScriptHash()).toBe(masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT));
  });
});

describe("SubmitResult", () => {
  it("builds a script spend the validator's rules accept, signed by the seller", async () => {
    const { datum, lockedLovelace } = await setup();
    const tip = NOW + 120_000;
    const spend = await build("SubmitResult", tip, datum, lockedLovelace);
    const tx = decodeCardanoTx(Uint8Array.from(Buffer.from(spend.cbor, "hex")));
    const view = parseMasumiLockDatum(datum)!;

    expect(tx.bodyHash).toBe(spend.txHash);
    // Inputs: the escrow + a wallet input; redeemer SubmitResult (Constr 5) on the escrow.
    expect(tx.inputs.some((i) => i.txHash === LOCK_TX && i.index === 0)).toBe(true);
    expect(tx.redeemers).toHaveLength(1);
    const redeemer = tx.redeemers[0]!;
    expect(redeemer.tag).toBe(0);
    const sorted = [...tx.inputs].sort((a, b) =>
      a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1,
    );
    expect(sorted[redeemer.index]).toEqual({ txHash: LOCK_TX, index: 0 });
    expect(bytesToHex(redeemer.dataBytes)).toBe("d87e80");
    expect(redeemer.mem).toBe(BigInt(EX_UNITS.memory));
    // Required signer = the seller's payment key hash; its vkey witness verifies.
    expect(tx.requiredSigners).toEqual([SELLER_KEY.keyHash]);
    expect(tx.vkeyWitnesses).toHaveLength(1);
    expect(tx.vkeyWitnesses[0]!.vkey).toBe(SELLER_KEY.publicKey);
    expect(verifyVkeyWitness(tx.bodyHash, tx.vkeyWitnesses[0]!)).toBe(true);
    // The applied script inline, no reference inputs.
    expect(tx.plutusV3Scripts.map((s) => bytesToHex(s))).toEqual([VESTED_PAY_V2_APPLIED_HEX]);
    // script_data_hash = blake2b-256(redeemers || language views {2: PlutusV3 costs}).
    const expected = cardanoScriptDataHash({
      redeemers: tx.witnessEntries.get(5)!,
      languageViews: plutusV3LanguageViews(PLUTUS_V3_COSTS.map(BigInt)),
    });
    expect(tx.scriptDataHash).toBe(bytesToHex(expected));
    // Validity: finite bounds; upper before submit_result_time; collateral present.
    expect(tx.validityStart).not.toBeNull();
    expect(tx.ttl).not.toBeNull();
    const upperMs = slotStartMs(BigInt(tip) + 300_000n);
    expect(tx.ttl).toBe(cardanoPosixMsToSlot("cardano-preprod", upperMs, "floor"));
    expect(upperMs < view.submitResultTime).toBe(true);
    expect(tx.collateral).toHaveLength(1);
    expect(tx.totalCollateral).not.toBeNull();
    // Continuing output: escrow address, same value, datum with the result and new state.
    const continuing = tx.outputs.filter((o) => o.address === ESCROW_ADDRESS);
    expect(continuing).toHaveLength(1);
    expect(continuing[0]!.value.coin).toBe(lockedLovelace);
    expect(continuing[0]!.hasScriptRef).toBe(false);
    const next = parseMasumiLockDatum(bytesToHex(continuing[0]!.inlineDatum!))!;
    expect(next.state).toBe(ESCROW_STATE.ResultSubmitted);
    expect(next.resultHash).toBe(RESULT_HASH);
    expect(next.buyerCooldownTime).toBe(0n);
    expect(next.sellerCooldownTime).toBe(upperMs + COOLDOWN_MS);
    expect(spend.sellerCooldownTime).toBe(next.sellerCooldownTime);
    // Every other field is unchanged.
    expect({ ...next, state: 0n, resultHash: "", sellerCooldownTime: 0n }).toEqual(view);
    // Change goes back to the seller.
    expect(tx.outputs.filter((o) => o.address === SELLER.address).length).toBeGreaterThan(0);
    // Chaining: the consumed wallet input is no longer available.
    const spentWallet = tx.inputs.filter((i) => i.txHash !== LOCK_TX);
    for (const i of spentWallet) {
      expect(
        spend.available.some(
          (u) => u.index === BigInt(i.index) && TransactionHash.toHex(u.transactionId) === i.txHash,
        ),
      ).toBe(false);
    }
    expect(WALLET_UTXOS.length).toBeGreaterThan(0);
  });

  it("refuses once the submit window has closed", async () => {
    const { datum, lockedLovelace } = await setup();
    const view = parseMasumiLockDatum(datum)!;
    await expect(
      build("SubmitResult", Number(view.submitResultTime) - 60_000, datum, lockedLovelace),
    ).rejects.toThrow(/window/);
  });
});

describe("Withdraw and AuthorizeRefund", () => {
  it("Withdraw: no continuing output, lower bound at unlock_time", async () => {
    const { datum, lockedLovelace } = await setup();
    // Make it a ResultSubmitted escrow (as SubmitResult leaves it).
    const { submitResultDatum } = await import("../src/escrow/datum");
    const { Data } = await import("@evolution-sdk/evolution");
    const view = parseMasumiLockDatum(datum)!;
    const submitted = Data.toCBORHex(
      submitResultDatum(Data.fromCBORHex(datum), view, RESULT_HASH, view.payByTime),
    );
    const tip = Number(view.unlockTime) + 30_000;
    const spend = await build("Withdraw", tip, submitted, lockedLovelace);
    const tx = decodeCardanoTx(Uint8Array.from(Buffer.from(spend.cbor, "hex")));
    expect(bytesToHex(tx.redeemers[0]!.dataBytes)).toBe("d87980");
    expect(tx.outputs.some((o) => o.address === ESCROW_ADDRESS)).toBe(false);
    expect(tx.requiredSigners).toEqual([SELLER_KEY.keyHash]);
    expect(tx.validityStart).toBe(
      cardanoPosixMsToSlot("cardano-preprod", ceilToSlotMs(view.unlockTime), "floor"),
    );
    // Collateral 0 at this price: nothing goes back to the buyer.
    expect(view.collateralReturnLovelace).toBe(0n);
    expect(tx.outputs.every((o) => o.address === SELLER.address)).toBe(true);
  });

  it("Withdraw before unlock_time is refused without building", async () => {
    const { datum, lockedLovelace } = await setup();
    const view = parseMasumiLockDatum(datum)!;
    await expect(
      build("Withdraw", Number(view.unlockTime) - 60_000, datum, lockedLovelace),
    ).rejects.toThrow(/too early/);
  });

  it("AuthorizeRefund: continuing datum RefundAuthorized with an empty result hash", async () => {
    const { datum, lockedLovelace } = await setup();
    const tip = NOW + 200_000;
    const spend = await build("AuthorizeRefund", tip, datum, lockedLovelace);
    const tx = decodeCardanoTx(Uint8Array.from(Buffer.from(spend.cbor, "hex")));
    expect(bytesToHex(tx.redeemers[0]!.dataBytes)).toBe("d87f80");
    const continuing = tx.outputs.find((o) => o.address === ESCROW_ADDRESS)!;
    const next = parseMasumiLockDatum(bytesToHex(continuing.inlineDatum!))!;
    expect(next.state).toBe(ESCROW_STATE.RefundAuthorized);
    expect(next.resultHash).toBe("");
    expect(next.buyerCooldownTime).toBe(0n);
    expect(next.sellerCooldownTime).toBe(slotStartMs(BigInt(tip) + 300_000n) + COOLDOWN_MS);
    expect(continuing.value.coin).toBe(lockedLovelace);
    expect(Address.fromBech32(SELLER.address)).toBeTruthy();
  });
});
