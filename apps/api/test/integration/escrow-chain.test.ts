/*
 * The real EscrowChain (src/escrow-chain.ts) offline: real CBOR, real @x402/cardano
 * validation, Blockfrost answered by fixtures (protocol parameters with the recorded PlutusV3
 * cost model, the wallet's UTxOs, escrow transactions, script evaluation). Covers the lock
 * (built, verified by the x402 adapter, body hash recomputable by the app), following the
 * escrow through a continuing output, and the two buyer spends (built after evaluation,
 * verified independently, body hash recomputable without a CBOR library, signable). Nothing
 * touches a network or funds.
 */
import { readFileSync } from "node:fs";
import * as x402c from "@x402/cardano";
import type { Broadcaster } from "@zyropay/shared";
import {
  attachCardanoWitness,
  assertCardanoSignedMatchesUnsigned,
  cardanoPosixMsToSlot,
  cardanoSlotToPosixMs,
  decodeCardanoTx,
} from "@zyropay/blockchain";
import {
  fixtureFetch,
  noSleep,
  testEd25519PublicKey,
  testEd25519Sign,
} from "@zyropay/blockchain/testing";
import {
  createX402Adapter,
  masumiEscrowTermsOf,
  masumiEscrowView,
  masumiRefundRequestDatum,
} from "@zyropay/integrations";
import {
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoUnsignedBodyHash,
  createCanonicalPayload,
} from "@zyropay/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EscrowOnChain } from "../../src/chain";
import { createRealEscrowChain } from "../../src/escrow-chain";

const fixtures = new URL(
  "../../../../packages/blockchain/src/__tests__/fixtures/cardano/",
  import.meta.url,
);
const RECORDED = JSON.parse(readFileSync(new URL("mainnet-recorded.json", fixtures), "utf8")) as {
  parameters: Record<string, unknown>;
  genesis: Record<string, unknown>;
};
const COSTS = JSON.parse(readFileSync(new URL("plutus-v3-cost-model.json", fixtures), "utf8")) as {
  PlutusV3: number[];
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NOW = new Date("2026-10-30T12:00:00.000Z");
const NETWORK = "cardano-preprod" as const;
const NOW_SLOT = Number(cardanoPosixMsToSlot(NETWORK, NOW.getTime(), "floor"));
/** TEST-ONLY payer key and seller phrase: never funded. */
const PAYER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 33 + i);
const PAYER_PK = hex(testEd25519PublicKey(PAYER_SECRET));
const PAYER = cardanoEnterpriseAddress(PAYER_PK, NETWORK);
const SELLER = x402c.toMasumiSellerSigner({
  mnemonic: "test walk nut penalty hip pave soap entry language right filter choice",
  network: "cardano:preprod",
});
const RESOURCE = "https://seller.example.com/v1/jobs/9";
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const PAY_BY = NOW.getTime() + 4 * 60_000;
const LOCK_TX = "1".repeat(64);
const MOVED_TX = "2".repeat(64);
const SPENT_TX = "3".repeat(64);

function walletUtxo(byte: string, index: number, lovelace: string) {
  return {
    address: PAYER,
    tx_hash: byte.repeat(64),
    tx_index: index,
    output_index: index,
    amount: [{ unit: "lovelace", quantity: lovelace }],
    block: "b".repeat(64),
    data_hash: null,
    inline_datum: null,
    reference_script_hash: null,
  };
}

function escrowOutput(index: number, datum: string, lovelace: string, consumedBy: string | null) {
  return {
    address: ESCROW,
    amount: [{ unit: "lovelace", quantity: lovelace }],
    output_index: index,
    data_hash: "d".repeat(64),
    inline_datum: datum,
    reference_script_hash: null,
    collateral: false,
    consumed_by_tx: consumedBy,
  };
}

describe("real EscrowChain over Blockfrost fixtures (real codec, real Masumi)", () => {
  let lockDatum: string;
  let payload: ReturnType<typeof createCanonicalPayload>;
  let evaluations: string[];
  let chain: ReturnType<typeof createRealEscrowChain>;
  const adapter = createX402Adapter({
    caps: { "cardano-preprod:native": "10000000" },
    now: () => NOW,
    cardanoCoinsPerUtxoByte: () => Promise.resolve(4310n),
  });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const requirement = await x402c.issueMasumiRequirements({
      network: "cardano:preprod",
      asset: "lovelace",
      amount: "4000000",
      maxTimeoutSeconds: 300,
      sellerAddress: SELLER.sellerAddress,
      signTerms: SELLER.signTerms,
      commitment: [
        {
          name: "resource",
          canonicalization: "jcs",
          mediaType: "application/json",
          content: { url: RESOURCE },
        },
      ],
      payByTime: String(PAY_BY),
      submitResultTime: String(PAY_BY + 15 * 60_000),
      unlockTime: String(PAY_BY + 35 * 60_000),
      externalDisputeUnlockTime: String(PAY_BY + 55 * 60_000),
    });
    const quote = await adapter.quote({
      action: "pay",
      network: NETWORK,
      params: {
        paymentRequired: JSON.parse(
          JSON.stringify({ x402Version: 2, resource: { url: RESOURCE }, accepts: [requirement] }),
        ),
        resourceUrl: RESOURCE,
        maxAmount: "5000000",
        assetId: "cardano-preprod:native",
        payer: PAYER,
        transferMethod: "masumi",
      },
    });
    payload = createCanonicalPayload({
      version: 1,
      network: NETWORK,
      from: PAYER,
      to: ESCROW,
      asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
      amount: quote.inputAmount,
      feeCap: "3000000",
      plugin: "x402",
      tool: "pay_x402",
      pluginData: quote.pluginData,
      nonce: "00112233445566778899aabbccddeeff",
      expiresAt: quote.expiresAt,
      idempotencyKey: "escrow-chain-0001",
    });
    lockDatum = masumiEscrowTermsOf(payload.pluginData)?.datumCbor ?? "";
    const requested = masumiRefundRequestDatum(lockDatum, BigInt(NOW.getTime()), 420_000n);

    evaluations = [];
    const fetch = fixtureFetch({
      rest: {
        "/genesis": { ...RECORDED.genesis, network_magic: 1 },
        "/epochs/latest/parameters": {
          ...RECORDED.parameters,
          cost_models_raw: { PlutusV3: COSTS.PlutusV3 },
        },
        "/blocks/latest": { slot: NOW_SLOT, height: 4_200_000, time: NOW.getTime() / 1000 },
        "/utxos?count=100&page=1": () => [
          walletUtxo("a", 0, "9000000"),
          walletUtxo("b", 1, "6000000"),
        ],
        [`/txs/${LOCK_TX}/utxos`]: {
          hash: LOCK_TX,
          inputs: [],
          outputs: [escrowOutput(0, lockDatum, "4000000", MOVED_TX)],
        },
        [`/txs/${MOVED_TX}/utxos`]: {
          hash: MOVED_TX,
          inputs: [],
          outputs: [escrowOutput(0, requested, "4000000", null)],
        },
        [`/txs/${SPENT_TX}/utxos`]: {
          hash: SPENT_TX,
          inputs: [],
          outputs: [escrowOutput(0, lockDatum, "4000000", "4".repeat(64))],
        },
        [`/txs/${"4".repeat(64)}/utxos`]: { hash: "4".repeat(64), inputs: [], outputs: [] },
        "/utils/txs/evaluate/utxos": ({ body }: { body: { cbor: string } }) => {
          evaluations.push(body.cbor);
          const idx = decodeCardanoTx(Buffer.from(body.cbor, "hex")).redeemers[0]?.index ?? -1;
          return {
            type: "jsonwsp/response",
            result: {
              EvaluationResult: {
                [`spend:${String(idx)}`]: { memory: 900_000, steps: 300_000_000 },
              },
            },
          };
        },
      },
    });
    const broadcaster: Broadcaster = {
      broadcast: () => Promise.reject(new Error("tests never submit")),
      getStatus: () => Promise.reject(new Error("unused")),
    };
    chain = createRealEscrowChain({
      network: NETWORK,
      blockfrostProjectId: "preprodTESTKEY0000000000000000000000",
      broadcaster,
      http: { fetch, sleep: noSleep },
      now: () => NOW,
    });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("builds the lock: TTL = payByTime's slot, verified by the adapter, body hash recomputable", async () => {
    const unsigned = await chain.buildLock(payload, { maxValiditySeconds: 300 });
    expect(unsigned.simulated).toBe(false);
    expect(await adapter.verifyTransaction(unsigned.serialized, "hex", payload)).toEqual({
      ok: true,
    });
    const tx = decodeCardanoTx(Buffer.from(unsigned.serialized, "hex"));
    expect(tx.ttl).toBe(cardanoPosixMsToSlot(NETWORK, PAY_BY, "floor"));
    expect(hex(tx.outputs[0]?.inlineDatum ?? new Uint8Array())).toBe(lockDatum);
    expect(cardanoUnsignedBodyHash(unsigned.serialized)).toBe(tx.bodyHash);
  });

  it("follows the escrow through a continuing output, and sees a spend without one", async () => {
    const lock = masumiEscrowView(lockDatum);
    if (lock === null) throw new Error("lock datum");
    const hint = {
      referenceSignature: lock.referenceSignature,
      lockDatumCbor: lockDatum,
      lockLovelace: "4000000",
    };
    const moved = await chain.read({ txHash: LOCK_TX, index: 0 }, hint);
    expect(moved.status).toBe("unspent");
    if (moved.status !== "unspent") throw new Error("unreachable");
    expect(moved.utxo).toMatchObject({ txHash: MOVED_TX, index: 0, lovelace: "4000000" });
    expect(masumiEscrowView(moved.utxo.inlineDatum)?.state).toBe("refund_requested");
    expect(await chain.read({ txHash: SPENT_TX, index: 0 }, hint)).toEqual({
      status: "spent",
      spentBy: "4".repeat(64),
    });
    expect(await chain.read({ txHash: LOCK_TX, index: 3 }, hint)).toEqual({ status: "missing" });
  });

  it("builds and verifies both buyer spends (evaluated), signable with the passkey's body hash", async () => {
    const utxo: EscrowOnChain = {
      txHash: LOCK_TX,
      index: 0,
      address: ESCROW,
      lovelace: "4000000",
      assets: {},
      inlineDatum: lockDatum,
    };
    const ttl = BigInt(NOW_SLOT + 600);
    const continuing = masumiRefundRequestDatum(
      lockDatum,
      cardanoSlotToPosixMs(NETWORK, ttl),
      420_000n,
    );
    const request = {
      action: "SetRefundRequested" as const,
      from: PAYER,
      utxo,
      continuingDatumCbor: continuing,
      validityStartSlot: BigInt(NOW_SLOT - 60),
      ttlSlot: ttl,
      feeCap: 3_000_000n,
    };
    const built = await chain.buildSpend(request);
    expect(evaluations).toHaveLength(1);
    expect(await chain.verifySpend(built.serialized, request)).toEqual({ ok: true });
    // The app's CBOR-free hash agrees on a script spend (witness keys 5 and 7).
    const tx = decodeCardanoTx(Buffer.from(built.serialized, "hex"));
    expect([...tx.witnessKeys].sort()).toEqual([5, 7]);
    expect(cardanoUnsignedBodyHash(built.serialized)).toBe(built.bodyHash);
    expect(tx.bodyHash).toBe(built.bodyHash);
    // Any other continuing datum or bound fails verification.
    const other = masumiRefundRequestDatum(
      lockDatum,
      cardanoSlotToPosixMs(NETWORK, ttl) + 1000n,
      420_000n,
    );
    expect(
      (await chain.verifySpend(built.serialized, { ...request, continuingDatumCbor: other })).ok,
    ).toBe(false);
    expect((await chain.verifySpend(built.serialized, { ...request, ttlSlot: ttl + 1n })).ok).toBe(
      false,
    );

    // Signed with the payer's (test) key over the body hash: the C7 check accepts it.
    const signature = hex(testEd25519Sign(PAYER_SECRET, Buffer.from(built.bodyHash, "hex")));
    const { signedTransaction } = attachCardanoWitness({
      unsignedHex: built.serialized,
      publicKey: PAYER_PK,
      signature,
      expectedKeyHash: cardanoKeyHash(PAYER_PK),
    });
    expect(() =>
      assertCardanoSignedMatchesUnsigned({
        signed: signedTransaction,
        unsigned: built.serialized,
        expectedSigner: PAYER,
      }),
    ).not.toThrow();
    expect(cardanoUnsignedBodyHash(signedTransaction)).toBeNull(); // signed: not signable again

    const withdraw = {
      action: "WithdrawRefund" as const,
      from: PAYER,
      utxo,
      validityStartSlot: BigInt(NOW_SLOT - 60),
      ttlSlot: ttl,
      feeCap: 3_000_000n,
    };
    const out = await chain.buildSpend(withdraw);
    expect(await chain.verifySpend(out.serialized, withdraw)).toEqual({ ok: true });
    expect(cardanoUnsignedBodyHash(out.serialized)).toBe(out.bodyHash);
    expect((await chain.verifySpend(out.serialized, request)).ok).toBe(false);
  });
});
