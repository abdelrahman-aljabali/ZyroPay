import { Data } from "@evolution-sdk/evolution";
import * as x402c from "@x402/cardano";
import {
  attachCardanoWitness,
  cardanoPosixMsToSlot,
  masumiEscrowAddress,
  planCardanoEscrowLock,
} from "@zyropay/blockchain";
import { testEd25519PublicKey, testEd25519Sign } from "@zyropay/blockchain/testing";
import type { CanonicalTransactionPayload, JsonObject, PluginQuote } from "@zyropay/shared";
import {
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoUnsignedBodyHash,
  createCanonicalPayload,
  MASUMI_ESCROW_ADDRESSES,
} from "@zyropay/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  masumiEscrowTermsOf,
  masumiEscrowView,
  masumiRefundRequestDatum,
  type MasumiEscrowTerms,
} from "../masumi";
import type { MasumiAgent, MasumiVerifyInput, MasumiVerifyResult } from "../masumi-registry";
import { createX402Adapter, decodeBase64Text } from "../x402";

/*
 * x402 Cardano `assetTransferMethod: "masumi"` (Masumi escrow), buyer side, offline. The 402
 * is issued with @x402/cardano's own issuer and a TEST-ONLY seller mnemonic; the built lock
 * is checked by ZyroPay's verifier AND by @x402/cardano's facilitator check (verifyMasumiLock).
 * Nothing touches a network or funds.
 */

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const NOW = new Date("2026-10-30T12:00:00.000Z");
const PAYER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const PAYER_PK = hex(testEd25519PublicKey(PAYER_SECRET));
const PAYER = cardanoEnterpriseAddress(PAYER_PK, "cardano-preprod");
/** TEST ONLY: a throwaway BIP-39 phrase, never funded. */
const SELLER_MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice";
const SELLER = x402c.toMasumiSellerSigner({
  mnemonic: SELLER_MNEMONIC,
  network: "cardano:preprod",
});
const RESOURCE = "https://seller.example.com/v1/jobs/42";
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const PAY_BY = NOW.getTime() + 4 * 60_000;
const PARAMS = {
  minFeeA: 44n,
  minFeeB: 155381n,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384,
  maxValSize: 5000,
};

async function issue(overrides: Record<string, unknown> = {}): Promise<JsonObject> {
  const req = await x402c.issueMasumiRequirements({
    network: "cardano:preprod",
    asset: "lovelace",
    amount: "2000000",
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
    ...overrides,
  });
  return JSON.parse(JSON.stringify(req)) as JsonObject;
}

function paymentRequired(accepts: JsonObject[]): JsonObject {
  return { x402Version: 2, resource: { url: RESOURCE }, accepts };
}

function adapter(coinsPerUtxoByte: bigint | null = 4310n) {
  return createX402Adapter({
    caps: { "cardano-preprod:native": "10000000" },
    now: () => NOW,
    ...(coinsPerUtxoByte !== null
      ? { cardanoCoinsPerUtxoByte: () => Promise.resolve(coinsPerUtxoByte) }
      : {}),
  });
}

function quoteInput(pr: JsonObject, transferMethod?: "default" | "masumi") {
  return {
    action: "pay",
    network: "cardano-preprod" as const,
    params: {
      paymentRequired: pr,
      resourceUrl: RESOURCE,
      maxAmount: "3000000",
      assetId: "cardano-preprod:native",
      payer: PAYER,
      ...(transferMethod !== undefined ? { transferMethod } : {}),
    },
  };
}

function payloadFor(quote: PluginQuote): CanonicalTransactionPayload {
  return createCanonicalPayload({
    version: 1,
    network: "cardano-preprod",
    from: PAYER,
    to: quote.pluginData.payTo as string,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: quote.inputAmount,
    feeCap: "3000000",
    plugin: "x402",
    tool: "pay_x402",
    pluginData: quote.pluginData,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: quote.expiresAt,
    idempotencyKey: "masumi-test-0001",
  });
}

function utxo(byte: string, index: number, lovelace: string) {
  return {
    tx_hash: byte.repeat(64),
    output_index: index,
    amount: [{ unit: "lovelace", quantity: lovelace }],
    data_hash: null,
    inline_datum: null,
    reference_script_hash: null,
  };
}

function planLock(escrow: MasumiEscrowTerms) {
  return planCardanoEscrowLock({
    network: "cardano-preprod",
    from: PAYER,
    escrowAddress: escrow.escrowAddress,
    lovelace: BigInt(escrow.lockedLovelace),
    datumCbor: escrow.datumCbor,
    ttlSlot: cardanoPosixMsToSlot("cardano-preprod", BigInt(escrow.payByTime), "floor"),
    utxos: [utxo("a", 0, "9000000"), utxo("b", 1, "3000000")],
    params: PARAMS,
  });
}

describe("x402 masumi escrow (buyer side)", () => {
  // @x402/cardano reads the clock itself (issuer and authorization checks).
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("the canonical escrow address agrees across shared, blockchain and @x402/cardano", () => {
    for (const [network, wire] of [
      ["cardano-preprod", "cardano:preprod"],
      ["cardano-mainnet", "cardano:mainnet"],
    ] as const) {
      expect(MASUMI_ESCROW_ADDRESSES[network]).toBe(masumiEscrowAddress(network));
      expect(MASUMI_ESCROW_ADDRESSES[network]).toBe(x402c.masumiEscrowAddress(wire));
    }
    expect(MASUMI_ESCROW_ADDRESSES["cardano-preprod"]).toBe(ESCROW);
  });

  it("quotes a masumi requirement only when asked, binding the seller-signed terms and datum", async () => {
    const req = await issue();
    const pr = paymentRequired([req]);
    // Never picked implicitly.
    await expect(adapter().quote(quoteInput(pr))).rejects.toThrow(/no exact-scheme requirement/);
    const quote = await adapter().quote(quoteInput(pr, "masumi"));
    expect(quote.inputAmount).toBe("2000000");
    expect(quote.expiresAt).toBe(new Date(PAY_BY).toISOString());
    expect(quote.pluginData).toMatchObject({ payTo: ESCROW, amount: "2000000" });
    const escrow = masumiEscrowTermsOf(quote.pluginData);
    if (escrow === null) throw new Error("no escrow terms");
    expect(escrow).toMatchObject({
      method: "masumi",
      escrowAddress: ESCROW,
      sellerAddress: SELLER.sellerAddress,
      payByTime: String(PAY_BY),
      lockedLovelace: String(2_000_000n + BigInt(escrow.collateralLovelace)),
      coinsPerUtxoByte: "4310",
      cooldownPeriodMs: "420000",
    });
    expect(BigInt(escrow.collateralLovelace)).toBeGreaterThanOrEqual(1_435_230n);
    // The datum round-trips through the reference parser as a fresh FundsLocked lock.
    const view = x402c.parseMasumiLockDatum(escrow.datumCbor);
    expect(view?.state).toBe(0n);
    expect(view?.buyer.payment.hash).toBe(cardanoKeyHash(PAYER_PK));
    expect(masumiEscrowView(escrow.datumCbor)).toMatchObject({
      state: "funds_locked",
      resultHash: null,
      buyerCooldownTime: 0n,
    });
    // The payload is valid with the escrow SCRIPT address as `to`.
    expect(payloadFor(quote).to).toBe(ESCROW);
  });

  it("refuses masumi requirements that are tampered, foreign or unsafe", async () => {
    const good = await issue();
    const extra = good.extra as JsonObject;
    const terms = extra.terms as JsonObject;
    const refuse = async (req: JsonObject, pattern: RegExp, a = adapter()) =>
      expect(a.quote(quoteInput(paymentRequired([req]), "masumi"))).rejects.toThrow(pattern);
    // The seller signed 2 ADA: asking for more breaks the signature.
    await refuse({ ...good, amount: "2500000" }, /seller authorization rejected/);
    // Another script address as payTo.
    await refuse(
      { ...good, payTo: "addr_test1wqsztux7j6c23ukjj3328vvxe3yqug43fs9vufysg6ddxpg8xqev4" },
      /canonical Masumi escrow/,
    );
    // A non-canonical deployment.
    await refuse(
      {
        ...good,
        extra: {
          ...extra,
          deployment: { requiredAdmins: "1", adminVkeys: ["11".repeat(28)], cooldownPeriod: "0" },
        },
      },
      /non-canonical|malformed|authorization/,
    );
    // Terms edited after signing (seller nonce).
    await refuse(
      { ...good, extra: { ...extra, terms: { ...terms, sellerNonce: "ab".repeat(32) } } },
      /seller authorization rejected|malformed/,
    );
    // Malformed extra.
    await refuse({ ...good, extra: { assetTransferMethod: "masumi" } }, /malformed extra/);
    // payByTime beyond maxTimeoutSeconds, or too close to approve.
    const early = (at: number) =>
      createX402Adapter({
        caps: { "cardano-preprod:native": "10000000" },
        now: () => new Date(at),
        cardanoCoinsPerUtxoByte: () => Promise.resolve(4310n),
      });
    await refuse(good, /beyond maxTimeoutSeconds/, early(NOW.getTime() - 2 * 60_000));
    vi.setSystemTime(PAY_BY - 30_000);
    await refuse(good, /too close/, early(PAY_BY - 30_000));
    vi.setSystemTime(NOW);
    // The commitment names another resource.
    const other = await issue({
      commitment: [
        {
          name: "resource",
          canonicalization: "jcs",
          mediaType: "application/json",
          content: { url: "https://seller.example.com/v1/jobs/43" },
        },
      ],
    });
    await refuse(other, /another resource/);
    // No live coinsPerUtxoByte: masumi is not configured.
    await refuse(good, /not configured/, adapter(null));
  });

  it("verifies the built lock (ZyroPay verifier + @x402/cardano facilitator check) and signs its body hash", async () => {
    const req = await issue();
    const a = adapter();
    const quote = await a.quote(quoteInput(paymentRequired([req]), "masumi"));
    const payload = payloadFor(quote);
    const escrow = masumiEscrowTermsOf(payload.pluginData);
    if (escrow === null) throw new Error("no escrow");
    const plan = planLock(escrow);
    expect(await a.verifyTransaction(plan.serialized, "hex", payload)).toEqual({ ok: true });
    // The app's CBOR-free body hash agrees with the builder.
    expect(cardanoUnsignedBodyHash(plan.serialized)).toBe(plan.bodyHash);

    // A lock built for different terms (another datum) is refused against this payload.
    const otherQuote = await adapter(5000n).quote(quoteInput(paymentRequired([req]), "masumi"));
    const otherEscrow = masumiEscrowTermsOf(otherQuote.pluginData);
    if (otherEscrow === null) throw new Error("no escrow");
    const foreign = planLock(otherEscrow);
    expect((await a.verifyTransaction(foreign.serialized, "hex", payload)).ok).toBe(false);
    // The plain-transfer path never accepts a lock.
    const asDefault = createCanonicalPayload({
      ...payload,
      pluginData: { ...payload.pluginData, escrow: null },
      to: SELLER.sellerAddress,
    });
    expect((await a.verifyTransaction(plan.serialized, "hex", asDefault)).ok).toBe(false);

    // Signed with the payer's (test) key, the header is what the facilitator verifies.
    const signature = hex(testEd25519Sign(PAYER_SECRET, Buffer.from(plan.bodyHash, "hex")));
    const { signedTransaction } = attachCardanoWitness({
      unsignedHex: plan.serialized,
      publicKey: PAYER_PK,
      signature,
      expectedKeyHash: cardanoKeyHash(PAYER_PK),
    });
    const header = a.encodePaymentHeader({ payload, cardano: { signedTransaction } });
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    const body = JSON.parse(decodeBase64Text(header.value)) as {
      accepted: JsonObject;
      payload: { transaction: string; nonce: string };
    };
    expect(body.accepted).toEqual(req);
    const decoded = x402c.decodeCardanoTransaction(body.payload.transaction);
    const check = await x402c.verifyMasumiLock(
      (req as { extra: unknown }).extra,
      req as unknown as Parameters<typeof x402c.verifyMasumiLock>[1],
      decoded,
      { payload: body.payload, payer: PAYER, coinsPerUtxoByte: 4310n },
    );
    expect(check).toEqual({ ok: true });
  });

  it("computes the SetRefundRequested continuing datum per vested_pay", async () => {
    const quote = await adapter().quote(quoteInput(paymentRequired([await issue()]), "masumi"));
    const escrow = masumiEscrowTermsOf(quote.pluginData);
    if (escrow === null) throw new Error("no escrow");
    const ttl = 1_793_000_000_000n;
    const next = masumiRefundRequestDatum(escrow.datumCbor, ttl, 420_000n);
    expect(masumiEscrowView(next)).toMatchObject({
      state: "refund_requested",
      buyerCooldownTime: ttl + 420_000n,
      sellerCooldownTime: 0n,
      resultHash: null,
    });
    // A refund cannot be requested twice from RefundRequested.
    expect(() => masumiRefundRequestDatum(next, ttl, 420_000n)).toThrow(/state refund_requested/);
    // After the seller submitted a result, a request moves the escrow to Disputed.
    const data = Data.fromCBORHex(escrow.datumCbor) as Data.Constr;
    const fields = [...data.fields];
    fields[11] = Data.bytearray("ab".repeat(32));
    fields[16] = 1_792_000_000_000n;
    fields[18] = Data.constr(1n, []);
    const submitted = Data.toCBORHex(Data.constr(0n, fields));
    expect(masumiEscrowView(submitted)).toMatchObject({
      state: "result_submitted",
      resultHash: "ab".repeat(32),
    });
    expect(masumiEscrowView(masumiRefundRequestDatum(submitted, ttl, 420_000n))).toMatchObject({
      state: "disputed",
      resultHash: "ab".repeat(32),
      sellerCooldownTime: 0n,
    });
    expect(masumiEscrowView("d87980")).toBeNull();
  });
});

describe("x402 masumi escrow: registered-agent claims (Masumi registry)", () => {
  const AGENT = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10${"5a".repeat(28)}000000`;
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  function registry(result: Partial<MasumiVerifyResult> & { ok: boolean }) {
    const verifySeller = vi.fn((_input: MasumiVerifyInput) =>
      Promise.resolve<MasumiVerifyResult>({
        reasons: [],
        details: [],
        agent: { name: "Summarizer" } as MasumiAgent,
        ...result,
      }),
    );
    return { verifySeller };
  }

  function withRegistry(r: ReturnType<typeof registry> | null) {
    return createX402Adapter({
      caps: { "cardano-preprod:native": "10000000" },
      now: () => NOW,
      cardanoCoinsPerUtxoByte: () => Promise.resolve(4310n),
      ...(r !== null ? { masumiRegistry: () => r } : {}),
    });
  }

  it("binds a verified claim (identifier, name, seller key) into the datum and the terms", async () => {
    const req = await issue({ agentIdentifier: AGENT });
    const r = registry({ ok: true });
    const a = withRegistry(r);
    const quote = await a.quote(quoteInput(paymentRequired([req]), "masumi"));
    expect(r.verifySeller).toHaveBeenCalledWith({
      agentIdentifier: AGENT,
      sellerAddress: SELLER.sellerAddress,
      resourceUrl: RESOURCE,
      asset: "lovelace",
      amount: "2000000",
      requireEscrow: true,
    });
    const escrow = masumiEscrowTermsOf(quote.pluginData);
    if (escrow === null) throw new Error("no escrow");
    expect(escrow).toMatchObject({
      agentIdentifier: AGENT,
      agentName: "Summarizer",
      sellerPaymentKeyHash: x402c.parseMasumiLockDatum(escrow.datumCbor)?.seller.payment.hash,
    });
    expect(x402c.parseMasumiLockDatum(escrow.datumCbor)?.agentIdentifier).toBe(AGENT);
    // The lock verifies here and at the facilitator (with the same registry check).
    const payload = payloadFor(quote);
    const plan = planLock(escrow);
    expect(await a.verifyTransaction(plan.serialized, "hex", payload)).toEqual({ ok: true });
    // Rebinding the terms as unregistered no longer matches the datum.
    const stripped = createCanonicalPayload({
      ...payload,
      pluginData: { ...payload.pluginData, escrow: { ...escrow, agentIdentifier: null } },
    });
    expect((await a.verifyTransaction(plan.serialized, "hex", stripped)).ok).toBe(false);
  });

  it("refuses a claim that does not verify, or when no registry is configured", async () => {
    const req = await issue({ agentIdentifier: AGENT });
    const pr = paymentRequired([req]);
    await expect(
      withRegistry(registry({ ok: false, reasons: ["seller_mismatch"] })).quote(
        quoteInput(pr, "masumi"),
      ),
    ).rejects.toThrow(/registry identity did not verify \(seller_mismatch\)/);
    // An unreadable registry is a retryable outage, not a verdict on the seller.
    await expect(
      withRegistry(registry({ ok: false, reasons: ["upstream_unavailable"] })).quote(
        quoteInput(pr, "masumi"),
      ),
    ).rejects.toThrow(/registry could not be read/);
    await expect(
      withRegistry(registry({ ok: false, reasons: ["upstream_unavailable"] })).quote(
        quoteInput(pr, "masumi"),
      ),
    ).rejects.toHaveProperty("code", "UPSTREAM_UNAVAILABLE");
    await expect(withRegistry(null).quote(quoteInput(pr, "masumi"))).rejects.toThrow(
      /registry check, which is not configured/,
    );
    // A registry outage fails closed.
    const down = { verifySeller: () => Promise.reject(new Error("down")) };
    await expect(
      createX402Adapter({
        caps: { "cardano-preprod:native": "10000000" },
        now: () => NOW,
        cardanoCoinsPerUtxoByte: () => Promise.resolve(4310n),
        masumiRegistry: () => down,
      }).quote(quoteInput(pr, "masumi")),
    ).rejects.toThrow(/seller authorization rejected/);
  });

  it("an unregistered seller needs no registry and is bound as such", async () => {
    const r = registry({ ok: true });
    const quote = await withRegistry(r).quote(
      quoteInput(paymentRequired([await issue()]), "masumi"),
    );
    expect(r.verifySeller).not.toHaveBeenCalled();
    expect(masumiEscrowTermsOf(quote.pluginData)).toMatchObject({
      agentIdentifier: null,
      agentName: null,
    });
  });
});
