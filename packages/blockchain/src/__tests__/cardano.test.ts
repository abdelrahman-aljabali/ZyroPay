import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardanoKeyHash, cardanoPaymentKeyHash } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import {
  assertSignedMatchesUnsigned,
  normalizeSignedTransaction,
  txHashOfSigned,
} from "../broadcast";
import { BlockfrostClient } from "../cardano/blockfrost";
import { createCardanoBroadcaster } from "../cardano/broadcast";
import {
  createCardanoTransactionBuilder,
  minAdaFor,
  verifyCardanoTransfer,
} from "../cardano/builder";
import { decodeCbor, encodeCbor, map, uint } from "../cardano/cbor";
import { assembleTx, decodeCardanoTx, encodeBody } from "../cardano/tx";
import { attachCardanoWitness } from "../cardano/witness";
import { createConfirmationTracker } from "../confirmation";
import { ChainError } from "../errors";
import { createCardanoPortfolioProvider, parseCardanoTransaction } from "../portfolio/cardano";
import { createPriceProvider } from "../prices";
import { fixtureFetch, HttpReply, noSleep } from "../testing";
import {
  blockfrostPreprod,
  cardanoPayload,
  FROM,
  NOW,
  OTHER_PK,
  OTHER_SECRET,
  PARAMS,
  RECORDED,
  SENDER_PK,
  SENDER_SECRET,
  TIP,
  TO,
  UNIT,
  utxo,
} from "./cardano-fixtures";

const KEY = "preprodTESTKEY0000000000000000000000";

function builder(rest = blockfrostPreprod()) {
  const fetch = fixtureFetch({ rest });
  return {
    fetch,
    b: createCardanoTransactionBuilder({
      blockfrostProjectId: KEY,
      network: "cardano-preprod",
      blockfrostBaseUrl: "https://bf.test/api/v0",
      fetch,
      sleep: noSleep,
      now: () => NOW,
    }),
  };
}

function sign(unsignedHex: string, secret = SENDER_SECRET): { signed: string; txHash: string } {
  const tx = decodeCardanoTx(hexToBytes(unsignedHex));
  const signature = bytesToHex(ed25519.sign(hexToBytes(tx.bodyHash), secret));
  const publicKey = bytesToHex(ed25519.getPublicKey(secret));
  const { signedTransaction, txHash } = attachCardanoWitness({
    unsignedHex,
    publicKey,
    signature,
    expectedKeyHash: cardanoKeyHash(publicKey),
  });
  return { signed: signedTransaction, txHash };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

describe("CBOR codec", () => {
  it("encodes canonically and refuses non-canonical input in strict mode", () => {
    const bytes = encodeCbor(
      map([
        [uint(1), uint(500)],
        [uint(0), uint(23)],
      ]),
    );
    expect(bytesToHex(bytes)).toBe("a20017011901f4");
    expect(() => decodeCbor(hexToBytes("1817"))).toThrow(/non-shortest/); // 23 in two bytes
    expect(() => decodeCbor(hexToBytes("9f01ff"))).toThrow(/indefinite/);
    expect(decodeCbor(hexToBytes("9f01ff"), { strict: false }).value).toEqual({
      t: "array",
      v: [{ t: "uint", v: 1n }],
    });
    expect(() => decodeCbor(hexToBytes("a201010102"))).toThrow(/duplicate/);
    expect(() => decodeCbor(hexToBytes("0101"))).toThrow(/trailing/);
  });

  it("hashes the original body bytes of real mainnet transactions (recorded)", () => {
    for (const [hash, entry] of Object.entries(RECORDED.txs)) {
      const tx = decodeCardanoTx(hexToBytes(entry.cbor.cbor), { strict: false });
      expect(tx.bodyHash).toBe(hash);
      expect(tx.fee?.toString()).toBe(entry.tx.fees);
      // Independent check with the reference implementation (EMURGO CSL).
      expect(CSL.FixedTransaction.from_hex(entry.cbor.cbor).transaction_hash().to_hex()).toBe(hash);
    }
  });
});

describe("Cardano transaction builder", () => {
  it("caps the validity window at maxValiditySeconds (x402 maxTimeoutSeconds)", async () => {
    const { b } = builder();
    const unsigned = await b.buildTransfer(cardanoPayload(), { maxValiditySeconds: 300 });
    expect(unsigned.ttlSlot).toBe(String(TIP.slot + 300));
    expect(unsigned.validUntil).toBe(new Date(NOW.getTime() + 300_000).toISOString());
    await expect(b.buildTransfer(cardanoPayload(), { maxValiditySeconds: 10 })).rejects.toThrow(
      /at least 60/,
    );
  });

  it("builds an ADA transfer the reference implementation accepts", async () => {
    const { b } = builder();
    const payload = cardanoPayload();
    const unsigned = await b.buildTransfer(payload);
    expect(unsigned).toMatchObject({ family: "cardano", encoding: "hex", minAdaDeposit: "0" });
    expect((await b.verifyMatchesPayload(unsigned.serialized, "hex", payload)).ok).toBe(true);

    const tx = decodeCardanoTx(hexToBytes(unsigned.serialized));
    expect(tx.bodyHash).toBe(unsigned.bodyHash);
    expect(tx.outputs[0]).toMatchObject({ address: TO });
    expect(tx.outputs[0]?.value.coin).toBe(2_000_000n);
    expect(tx.outputs[1]?.address).toBe(FROM);
    // TTL: tip slot + 10 min until expiry + 10 min margin.
    expect(unsigned.ttlSlot).toBe(String(TIP.slot + 1200));
    expect(unsigned.validUntil).toBe(new Date(NOW.getTime() + 1_200_000).toISOString());
    // Value is conserved: inputs = outputs + fee.
    const inputsTotal = tx.inputs.length === 1 ? 5_000_000n : 0n;
    expect(inputsTotal).toBe(5_000_000n); // largest pure-ADA UTxO first, one input suffices
    expect(
      (tx.outputs[0]?.value.coin ?? 0n) + (tx.outputs[1]?.value.coin ?? 0n) + (tx.fee ?? 0n),
    ).toBe(5_000_000n);

    const { signed, txHash } = sign(unsigned.serialized);
    expect(txHash).toBe(unsigned.bodyHash);
    const csl = CSL.Transaction.from_hex(signed);
    const fee = CSL.min_fee(
      csl,
      CSL.LinearFee.new(CSL.BigNum.from_str("44"), CSL.BigNum.from_str("155381")),
    );
    expect(fee.to_str()).toBe(unsigned.estimatedFee);
    expect(csl.body().fee().to_str()).toBe(unsigned.estimatedFee);
    expect(csl.body().ttl_bignum()?.to_str()).toBe(unsigned.ttlSlot);
    expect(CSL.FixedTransaction.from_hex(signed).transaction_hash().to_hex()).toBe(txHash);
    // Every output meets the ledger's min-UTxO (CSL's own computation).
    const cost = CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(PARAMS.coins_per_utxo_size));
    const outs = csl.body().outputs();
    for (let i = 0; i < outs.len(); i++) {
      const out = outs.get(i);
      const min = BigInt(CSL.min_ada_for_output(out, cost).to_str());
      expect(BigInt(out.amount().coin().to_str()) >= min).toBe(true);
    }
    // The witness CSL computes for the same key is byte-identical (Ed25519 is deterministic).
    const sk = CSL.PrivateKey.from_normal_bytes(SENDER_SECRET);
    expect(sk.to_public().to_hex()).toBe(SENDER_PK);
    const cslWitness = CSL.make_vkey_witness(CSL.TransactionHash.from_hex(txHash), sk);
    expect(decodeCardanoTx(hexToBytes(signed)).vkeyWitnesses[0]?.signature).toBe(
      cslWitness.signature().to_hex(),
    );
  });

  it("sends a native token with its min-ADA deposit bounded by the fee cap", async () => {
    const { b } = builder();
    const payload = cardanoPayload({
      asset: { id: `cardano-preprod:${UNIT}`, kind: "cardano_token", decimals: 2 },
      amount: "250",
      feeCap: "2000000",
    });
    const unsigned = await b.buildTransfer(payload);
    const tx = decodeCardanoTx(hexToBytes(unsigned.serialized));
    const pay = tx.outputs[0];
    expect(pay?.value.assets.get(UNIT)).toBe(250n);
    expect(pay?.value.coin.toString()).toBe(unsigned.minAdaDeposit);
    expect(BigInt(unsigned.minAdaDeposit)).toBe(
      minAdaFor({ address: TO, value: { coin: 0n, assets: new Map([[UNIT, 250n]]) } }, 4310n),
    );
    expect(tx.outputs[1]?.value.assets.get(UNIT)).toBe(750n); // token change back to sender
    expect((await b.verifyMatchesPayload(unsigned.serialized, "hex", payload)).ok).toBe(true);
    const csl = CSL.Transaction.from_hex(sign(unsigned.serialized).signed);
    const cost = CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str("4310"));
    expect(CSL.min_ada_for_output(csl.body().outputs().get(0), cost).to_str()).toBe(
      unsigned.minAdaDeposit,
    );

    await expectCode(b.buildTransfer({ ...payload, feeCap: "200000" }), "VALIDATION_FAILED");
    await expectCode(
      b.buildTransfer(
        cardanoPayload({
          asset: { id: `cardano-preprod:${UNIT}`, kind: "cardano_token", decimals: 6 },
          amount: "1",
        }),
      ),
      "DECIMALS_MISMATCH",
    );
  });

  it("estimates the fee cap (fee x2 + deposit) before the payload is hashed", async () => {
    const { b } = builder();
    const est = await b.estimateTransferFee(cardanoPayload());
    // Headroom is the fee itself, but at least 0.2 ADA.
    const fee = BigInt(est.estimatedFee);
    expect(BigInt(est.recommendedFeeCap)).toBe(fee + (fee > 200_000n ? fee : 200_000n));
    expect(est.minAdaDeposit).toBe("0");
  });

  it("fails closed on balance, dust outputs, wrong network and expiry", async () => {
    const { b } = builder();
    await expectCode(b.buildTransfer(cardanoPayload({ amount: "50000000" })), "INSUFFICIENT_FUNDS");
    await expectCode(b.buildTransfer(cardanoPayload({ amount: "100000" })), "VALIDATION_FAILED");
    await expectCode(
      b.buildTransfer({
        ...cardanoPayload(),
        expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      }),
      "REQUEST_EXPIRED",
    );
    const { b: empty } = builder(blockfrostPreprod({ utxos: [] }));
    await expectCode(empty.buildTransfer(cardanoPayload()), "INSUFFICIENT_FUNDS");
    // Change below min-UTxO with no other input left: refuse rather than burn it as fee.
    const { b: tight } = builder(blockfrostPreprod({ utxos: [utxo("4", 0, "2500000")] }));
    await expectCode(tight.buildTransfer(cardanoPayload()), "INSUFFICIENT_FUNDS");
    // UTxOs carrying reference scripts are never spent.
    const ref = { ...utxo("5", 0, "90000000"), reference_script_hash: "c".repeat(56) };
    const { b: refOnly } = builder(blockfrostPreprod({ utxos: [ref] }));
    await expectCode(refOnly.buildTransfer(cardanoPayload()), "INSUFFICIENT_FUNDS");
  });

  it("is bound to its network and Blockfrost project", async () => {
    expect(() =>
      createCardanoTransactionBuilder({
        blockfrostProjectId: "mainnetXYZ",
        network: "cardano-preprod",
      }),
    ).toThrow(/not a preprod project/);
    const { b } = builder({
      ...blockfrostPreprod(),
      "/genesis": { ...RECORDED.genesis }, // mainnet magic behind a preprod URL
    });
    await expectCode(b.buildTransfer(cardanoPayload()), "NETWORK_MODE_MISMATCH");
  });
});

describe("verifyCardanoTransfer (independent decode)", () => {
  async function built() {
    const { b } = builder();
    const payload = cardanoPayload();
    return { payload, unsigned: await b.buildTransfer(payload) };
  }

  it("rejects anything that differs from the payload", async () => {
    const { payload, unsigned } = await built();
    const verify = (hex: string, p = payload) =>
      verifyCardanoTransfer(hex, "hex", p, "cardano-preprod");
    expect(verify(unsigned.serialized).ok).toBe(true);
    expect(verify(unsigned.serialized, { ...payload, amount: "2000001" }).ok).toBe(false);
    expect(verify(unsigned.serialized, { ...payload, to: FROM }).ok).toBe(false);
    expect(verify(unsigned.serialized, { ...payload, feeCap: "100" }).ok).toBe(false);
    expect(
      verifyCardanoTransfer(unsigned.serialized, "base64", payload, "cardano-preprod").ok,
    ).toBe(false);
    expect(verifyCardanoTransfer(unsigned.serialized, "hex", payload, "cardano-mainnet").ok).toBe(
      false,
    );

    const tx = decodeCardanoTx(hexToBytes(unsigned.serialized));
    const reencode = (outputs: Parameters<typeof encodeBody>[0]["outputs"], extra?: Uint8Array) =>
      bytesToHex(
        assembleTx(
          extra ?? encodeBody({ inputs: tx.inputs, outputs, fee: tx.fee ?? 0n, ttl: tx.ttl ?? 0n }),
          [],
        ),
      );
    const [pay, change] = tx.outputs;
    if (pay === undefined || change === undefined) throw new Error("fixture");
    // A third output skimming value to someone else.
    expect(
      verify(
        reencode([
          pay,
          { ...change, value: { coin: change.value.coin - 1_000_000n, assets: new Map() } },
          { address: TO, value: { coin: 1_000_000n, assets: new Map() } },
        ]),
      ).ok,
    ).toBe(false);
    // Change redirected to another address.
    expect(verify(reencode([pay, { ...change, address: TO }])).ok).toBe(false);
    // An already-signed transaction is not what the passkey reviews.
    expect(verify(sign(unsigned.serialized).signed).ok).toBe(false);
    // An extra body field (here: validity start, key 8) is refused.
    const body = decodeCbor(tx.bodyBytes);
    if (body.value.t !== "map") throw new Error("fixture");
    const withKey8 = encodeCbor(map([...body.value.v, [uint(8), uint(1)]]));
    expect(verify(reencode([], withKey8)).ok).toBe(false);
    // Garbage.
    expect(verify("00").ok).toBe(false);
  });
});

describe("Cardano signed transactions (C7)", () => {
  it("accepts only the reviewed body with the sender's verifying witness", async () => {
    const { b } = builder();
    const unsigned = await b.buildTransfer(cardanoPayload());
    const { signed, txHash } = sign(unsigned.serialized);
    await expect(
      assertSignedMatchesUnsigned({
        network: "cardano-preprod",
        encoding: "hex",
        signed,
        unsigned: unsigned.serialized,
        expectedSigner: FROM,
      }),
    ).resolves.toBeUndefined();
    expect(
      txHashOfSigned({
        network: "cardano-preprod",
        signedTransaction: `0x${signed.toUpperCase()}`,
        encoding: "hex",
      }),
    ).toBe(txHash);
    expect(
      normalizeSignedTransaction({
        network: "cardano-preprod",
        signedTransaction: signed,
        encoding: "hex",
      }).encoding,
    ).toBe("hex");
    expect(() =>
      txHashOfSigned({
        network: "cardano-preprod",
        signedTransaction: unsigned.serialized,
        encoding: "hex",
      }),
    ).toThrow(ChainError);

    // Signed by a different key: refused against the sender address.
    const other = sign(unsigned.serialized, OTHER_SECRET).signed;
    await expect(
      assertSignedMatchesUnsigned({
        network: "cardano-preprod",
        encoding: "hex",
        signed: other,
        unsigned: unsigned.serialized,
        expectedSigner: FROM,
      }),
    ).rejects.toThrow(/another key/);
    // A forged signature never verifies.
    const tx = decodeCardanoTx(hexToBytes(signed));
    const forged = bytesToHex(
      assembleTx(tx.bodyBytes, [{ vkey: SENDER_PK, signature: "00".repeat(64) }]),
    );
    await expect(
      assertSignedMatchesUnsigned({
        network: "cardano-preprod",
        encoding: "hex",
        signed: forged,
        unsigned: unsigned.serialized,
      }),
    ).rejects.toThrow(/does not verify/);
    // A different body (another build) under a valid signature is refused.
    const { b: b2 } = builder();
    const second = await b2.buildTransfer(cardanoPayload({ amount: "2100000" }));
    await expect(
      assertSignedMatchesUnsigned({
        network: "cardano-preprod",
        encoding: "hex",
        signed: sign(second.serialized).signed,
        unsigned: unsigned.serialized,
      }),
    ).rejects.toThrow(/differs/);
  });

  it("attaches a witness only for the address's own key and a valid signature", async () => {
    const { b } = builder();
    const unsigned = await b.buildTransfer(cardanoPayload());
    const tx = decodeCardanoTx(hexToBytes(unsigned.serialized));
    const sig = bytesToHex(ed25519.sign(hexToBytes(tx.bodyHash), OTHER_SECRET));
    expect(() =>
      attachCardanoWitness({
        unsignedHex: unsigned.serialized,
        publicKey: OTHER_PK,
        signature: sig,
        expectedKeyHash: cardanoPaymentKeyHash(FROM) ?? "",
      }),
    ).toThrow(/does not own/);
    expect(() =>
      attachCardanoWitness({
        unsignedHex: unsigned.serialized,
        publicKey: SENDER_PK,
        signature: sig,
        expectedKeyHash: cardanoKeyHash(SENDER_PK),
      }),
    ).toThrow(/does not verify/);
  });
});

describe("Cardano broadcaster and tracker", () => {
  async function signedTx() {
    const { b } = builder();
    const unsigned = await b.buildTransfer(cardanoPayload());
    return { ...sign(unsigned.serialized), ttlSlot: unsigned.ttlSlot };
  }
  const broadcaster = (rest: Record<string, unknown>) =>
    createCardanoBroadcaster({
      blockfrostProjectId: KEY,
      network: "cardano-preprod",
      blockfrostBaseUrl: "https://bf.test/api/v0",
      fetch: fixtureFetch({ rest: { ...rest, ...blockfrostPreprod() } }),
      sleep: noSleep,
    });

  it("submits CBOR and returns the locally derived id", async () => {
    const { signed, txHash } = await signedTx();
    const fetch = fixtureFetch({ rest: { "/tx/submit": txHash, ...blockfrostPreprod() } });
    const bc = createCardanoBroadcaster({
      blockfrostProjectId: KEY,
      network: "cardano-preprod",
      blockfrostBaseUrl: "https://bf.test/api/v0",
      fetch,
      sleep: noSleep,
    });
    await expect(
      bc.broadcast({ network: "cardano-preprod", signedTransaction: signed, encoding: "hex" }),
    ).resolves.toEqual({ txHash, simulated: false });
    const submit = fetch.calls.find((c) => c.url.endsWith("/tx/submit"));
    expect(submit?.method).toBe("POST");
    expect(submit?.headers["content-type"]).toBe("application/cbor");
    expect(submit?.headers.project_id).toBe(KEY);
    await expectCode(
      bc.broadcast({ network: "cardano-mainnet", signedTransaction: signed, encoding: "hex" }),
      "NETWORK_MODE_MISMATCH",
    );
  });

  it("maps ledger rejections; BadInputs for our own landed tx is success", async () => {
    const { signed, txHash } = await signedTx();
    const reject = (msg: string) =>
      new HttpReply(400, { status_code: 400, error: "Bad Request", message: msg });
    const landed = broadcaster({
      "/tx/submit": reject("ApplyTxError (ConwayUtxowFailure (UtxoFailure (BadInputsUTxO ...)))"),
      [`/txs/${txHash}`]: { hash: txHash, block_height: TIP.height - 1, valid_contract: true },
    });
    await expect(
      landed.broadcast({ network: "cardano-preprod", signedTransaction: signed, encoding: "hex" }),
    ).resolves.toEqual({ txHash, simulated: false });
    const spent = broadcaster({
      "/tx/submit": reject("ApplyTxError (ConwayUtxowFailure (UtxoFailure (BadInputsUTxO ...)))"),
      "/txs/": new HttpReply(404, { status_code: 404 }),
      "/mempool/": new HttpReply(404, { status_code: 404 }),
    });
    await expect(
      spent.broadcast({ network: "cardano-preprod", signedTransaction: signed, encoding: "hex" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ChainError &&
        e.code === "BROADCAST_FAILED" &&
        e.details?.reason === "inputs_spent",
    );
    const late = broadcaster({
      "/tx/submit": reject("ApplyTxError (OutsideValidityIntervalUTxO ...)"),
    });
    await expect(
      late.broadcast({ network: "cardano-preprod", signedTransaction: signed, encoding: "hex" }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.details?.reason === "ttl_expired",
    );
  });

  it("tracks confirmations, expiry past the TTL and rebroadcast hints", async () => {
    const { txHash, ttlSlot } = await signedTx();
    const tracker = (rest: Record<string, unknown>) =>
      createConfirmationTracker({
        fetch: fixtureFetch({ rest: { ...rest, ...blockfrostPreprod() } }),
        sleep: noSleep,
        networks: {
          "cardano-preprod": {
            blockfrostProjectId: KEY,
            blockfrostBaseUrl: "https://bf.test/api/v0",
            confirmations: 3,
          },
        },
      });
    const inBlock = (h: number) => ({
      [`/txs/${txHash}`]: { hash: txHash, block_height: h, valid_contract: true },
    });
    expect(
      (await tracker(inBlock(TIP.height)).track({ network: "cardano-preprod", txHash })).status,
    ).toBe("pending");
    expect(
      await tracker(inBlock(TIP.height - 2)).track({ network: "cardano-preprod", txHash }),
    ).toMatchObject({ status: "confirmed", confirmations: 3 });
    const unknown = { "/txs/": new HttpReply(404, {}), "/mempool/": new HttpReply(404, {}) };
    expect(
      await tracker(unknown).track({ network: "cardano-preprod", txHash, validUntilSlot: ttlSlot }),
    ).toMatchObject({ status: "pending", rebroadcastSuggested: true });
    expect(
      await tracker(unknown).track({
        network: "cardano-preprod",
        txHash,
        validUntilSlot: String(TIP.slot - 1),
      }),
    ).toMatchObject({ status: "expired" });
    expect(
      await tracker({
        "/txs/": new HttpReply(404, {}),
        [`/mempool/${txHash}`]: { tx: { hash: txHash } },
      }).track({ network: "cardano-preprod", txHash }),
    ).toMatchObject({ status: "pending", rebroadcastSuggested: false });
  });
});

describe("Cardano portfolio (recorded mainnet data)", () => {
  const ADDRESS = RECORDED.address.address;
  const watched = {
    walletId: "00000000-0000-4000-8000-000000000001",
    network: "cardano-mainnet" as const,
    address: ADDRESS,
  };
  const rest = () => {
    const out: Record<string, unknown> = {
      "/genesis": RECORDED.genesis,
      "/transactions?order=desc": () => RECORDED.addressTransactions.slice(0, 2),
    };
    for (const [hash, entry] of Object.entries(RECORDED.txs)) {
      out[`/txs/${hash}/utxos`] = entry.utxos;
      out[`/txs/${hash}`] = entry.tx;
    }
    for (const [unit, asset] of Object.entries(RECORDED.assets)) out[`/assets/${unit}`] = asset;
    out[`/addresses/${ADDRESS}`] = RECORDED.address;
    return out;
  };
  const provider = (r = rest()) =>
    createCardanoPortfolioProvider({
      blockfrostProjectId: "mainnetTESTKEY000000000000000000000",
      network: "cardano-mainnet",
      blockfrostBaseUrl: "https://bf.test/api/v0",
      fetch: fixtureFetch({ rest: r }),
      sleep: noSleep,
      now: () => NOW,
    });

  it("reads ADA and native tokens with registry decimals", async () => {
    const snapshot = await provider().getSnapshot({ addresses: [watched], currency: "USD" });
    expect(snapshot.stale).toBe(false);
    const ada = snapshot.balances.find((x) => x.asset.kind === "native");
    expect(ada).toMatchObject({ amount: "9959330", asset: { symbol: "ADA", decimals: 6 } });
    const night = snapshot.balances.find((x) => x.asset.kind === "cardano_token");
    expect(night).toMatchObject({
      amount: "112454621",
      asset: {
        symbol: "NIGHT",
        decimals: 6,
        verified: false,
        address: "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa4e49474854",
      },
    });
  });

  it("treats an unused address as empty and an outage as stale", async () => {
    const empty = await provider({
      "/genesis": RECORDED.genesis,
      "/addresses/": new HttpReply(404, {}),
    }).getSnapshot({ addresses: [watched], currency: "USD" });
    expect(empty.balances.map((b) => b.amount)).toEqual(["0"]);
    const down = await provider({
      "/genesis": RECORDED.genesis,
      "/addresses/": new HttpReply(503, {}),
    }).getSnapshot({ addresses: [watched], currency: "USD" });
    expect(down.stale).toBe(true);
  });

  it("normalizes history to exact per-asset movements", async () => {
    const page = await provider().getTransactions({ address: watched, limit: 20 });
    expect(page.nextCursor).toBeNull();
    const incoming = page.transactions.filter((t) => t.txHash.startsWith("745ed6e9"));
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({
      direction: "in",
      amount: "10285581",
      fee: null,
      to: ADDRESS,
      blockNumber: "14081264",
    });
    expect(incoming[0]?.from).toMatch(/^addr1qx3fal54/);
    const outgoing = page.transactions.filter((t) => t.txHash.startsWith("8f868908"));
    expect(outgoing.length).toBeGreaterThan(0);
    for (const t of page.transactions) {
      expect(t.explorerUrl).toBe(`https://cardanoscan.io/transaction/${t.txHash}`);
    }
    // Deterministic ids across polls.
    const again = await provider().getTransactions({ address: watched, limit: 20 });
    expect(again.transactions.map((t) => t.id)).toEqual(page.transactions.map((t) => t.id));
  });

  it("parses a pure-fee self transaction", () => {
    const tx = {
      hash: "d".repeat(64),
      fees: "170000",
      block_time: 1,
      block_height: 2,
      valid_contract: true,
    };
    const utxos = {
      inputs: [{ address: ADDRESS, amount: [{ unit: "lovelace", quantity: "5000000" }] }],
      outputs: [{ address: ADDRESS, amount: [{ unit: "lovelace", quantity: "4830000" }] }],
    };
    expect(parseCardanoTransaction(watched, tx, utxos, new Map())).toMatchObject([
      { direction: "self", amount: "0", fee: "170000" },
    ]);
  });
});

describe("Blockfrost client and ADA prices", () => {
  it("refuses a project id of the other network", () => {
    expect(
      () => new BlockfrostClient({ projectId: "preprodX", network: "cardano-mainnet" }),
    ).toThrow(ChainError);
    expect(() => new BlockfrostClient({ projectId: "", network: "cardano-mainnet" })).toThrow(
      ChainError,
    );
  });

  it("prices ADA through CoinGecko `cardano`; preprod only via the dev proxy", async () => {
    const fetch = fixtureFetch({
      rest: {
        "/simple/price?ids=cardano": {
          cardano: { usd: 0.61, last_updated_at: NOW.getTime() / 1000 },
        },
      },
    });
    const prices = createPriceProvider({ fetch, now: () => NOW, sleep: noSleep });
    const result = await prices.getPrices({
      assetIds: ["cardano-mainnet:native", "cardano-preprod:native", `cardano-mainnet:${UNIT}`],
      currency: "USD",
    });
    expect(result.prices["cardano-mainnet:native"]?.price.value).toBe("0.61");
    expect(result.prices["cardano-preprod:native"]).toBeUndefined();
    expect(result.prices[`cardano-mainnet:${UNIT}`]).toBeUndefined();
    const proxied = createPriceProvider({
      fetch,
      now: () => NOW,
      sleep: noSleep,
      valueTestnetsAtMainnetPrices: true,
    });
    const p = await proxied.getPrices({ assetIds: ["cardano-preprod:native"], currency: "USD" });
    expect(p.prices["cardano-preprod:native"]?.source).toBe("coingecko+testnet-proxy");
  });
});
