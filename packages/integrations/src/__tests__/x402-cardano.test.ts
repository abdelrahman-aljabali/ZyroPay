import {
  attachCardanoWitness,
  ChainError,
  createCardanoTransactionBuilder,
  decodeCardanoTx,
} from "@zyropay/blockchain";
import {
  blockfrostRest,
  fixtureFetch,
  noSleep,
  testEd25519PublicKey,
  testEd25519Sign,
} from "@zyropay/blockchain/testing";
import type { CanonicalTransactionPayload, JsonObject, PluginQuote } from "@zyropay/shared";
import { cardanoEnterpriseAddress, cardanoKeyHash, createCanonicalPayload } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import {
  cardanoPaymentPayload,
  createX402Adapter,
  decodeBase64Text,
  normalizePaymentRequired,
  normalizeResourceUrl,
  x402AssetMatches,
} from "../x402";

/*
 * x402 exact scheme on Cardano (specs/schemes/exact/scheme_exact_cardano.md), offline: the
 * 402 shape below follows the spec and what @x402/cardano 2.29 servers emit; keys are
 * test-only fixtures, never funded.
 */

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

const NOW = new Date("2026-10-30T12:00:00.000Z");
const PAYER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SELLER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const PAYER_PK = bytesToHex(testEd25519PublicKey(PAYER_SECRET));
const PAYER = cardanoEnterpriseAddress(PAYER_PK, "cardano-preprod");
const SELLER = cardanoEnterpriseAddress(
  bytesToHex(testEd25519PublicKey(SELLER_SECRET)),
  "cardano-preprod",
);
const RESOURCE = "https://address-intel.zyropay.online/v1/address-report?address=addr_test1xyz";
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

function paymentRequired(overrides: Record<string, unknown> = {}, version = 2): JsonObject {
  return {
    x402Version: version,
    resource: { url: RESOURCE, description: "Cardano address intelligence report" },
    accepts: [
      {
        scheme: "exact",
        network: "cardano:preprod",
        amount: "2000000",
        asset: "lovelace",
        payTo: SELLER,
        maxTimeoutSeconds: 600,
        extra: { assetTransferMethod: "default", confirmationPolicy: { l1Confirmations: 0 } },
        ...overrides,
      },
    ],
  };
}

function adapter(caps: Record<string, string> = { "cardano-preprod:native": "5000000" }) {
  return createX402Adapter({ caps, now: () => NOW });
}

function quoteInput(paymentRequiredObj: JsonObject = paymentRequired(), maxAmount = "3000000") {
  return {
    action: "pay",
    network: "cardano-preprod" as const,
    params: {
      paymentRequired: paymentRequiredObj,
      resourceUrl: RESOURCE,
      maxAmount,
      assetId: "cardano-preprod:native",
      payer: PAYER,
    },
  };
}

function payloadFor(quote: PluginQuote): CanonicalTransactionPayload {
  return createCanonicalPayload({
    version: 1,
    network: "cardano-preprod",
    from: PAYER,
    to: SELLER,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: quote.inputAmount,
    feeCap: "2000000",
    plugin: "x402",
    tool: "pay_x402",
    pluginData: quote.pluginData,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    idempotencyKey: "x402-cardano-001",
  });
}

async function buildSigned(payload: CanonicalTransactionPayload) {
  const fetch = fixtureFetch({
    rest: blockfrostRest({
      networkMagic: 1,
      tip: { slot: 110_000_000, height: 4_300_000, time: NOW.getTime() / 1000 },
      utxos: [
        {
          address: PAYER,
          tx_hash: "ab".repeat(32),
          tx_index: 3,
          output_index: 3,
          amount: [{ unit: "lovelace", quantity: "10000000" }],
          block: "b".repeat(64),
          data_hash: null,
          inline_datum: null,
          reference_script_hash: null,
        },
      ],
    }),
  });
  const builder = createCardanoTransactionBuilder({
    blockfrostProjectId: "preprodTESTKEY0000000000000000000000",
    network: "cardano-preprod",
    blockfrostBaseUrl: "https://bf.test/api/v0",
    fetch,
    sleep: noSleep,
    now: () => NOW,
  });
  const unsigned = await builder.buildTransfer(payload, { maxValiditySeconds: 600 });
  const signature = bytesToHex(testEd25519Sign(PAYER_SECRET, hexToBytes(unsigned.bodyHash)));
  const signed = attachCardanoWitness({
    unsignedHex: unsigned.serialized,
    publicKey: PAYER_PK,
    signature,
    expectedKeyHash: cardanoKeyHash(PAYER_PK),
  });
  return { unsigned, signed };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

describe("x402 on Cardano", () => {
  it("maps the scheme's network names and assets onto ZyroPay's", () => {
    const parsed = normalizePaymentRequired(paymentRequired());
    expect(parsed.accepts[0]?.network).toBe("cardano-preprod");
    expect(
      normalizePaymentRequired(paymentRequired({ network: "cip34:0-1" })).accepts[0]?.network,
    ).toBe("cardano-preprod");
    expect(x402AssetMatches("cardano-preprod", "lovelace", "cardano-preprod:native")).toBe(true);
    const unit = TUSDM.replace(".", "");
    expect(x402AssetMatches("cardano-preprod", TUSDM, `cardano-preprod:${unit}`)).toBe(true);
    expect(x402AssetMatches("cardano-preprod", "lovelace", `cardano-preprod:${unit}`)).toBe(false);
    expect(x402AssetMatches("cardano-preprod", TUSDM, "cardano-preprod:native")).toBe(false);
  });

  it("quotes an ADA payment, binding the resource and method", async () => {
    const quote = await adapter().quote(quoteInput());
    expect(quote.inputAmount).toBe("2000000");
    expect(quote.pluginData).toMatchObject({
      network: "cip34:0-1",
      asset: "lovelace",
      payTo: SELLER,
      resourceUrl: RESOURCE,
      method: "GET",
      maxTimeoutSeconds: 600,
    });
    // The accepted requirement is echoed verbatim (network name included) in the payment.
    expect((quote.pluginData.accepted as JsonObject).network).toBe("cardano:preprod");
  });

  it("refuses requirements ZyroPay cannot build or must not pay", async () => {
    const a = adapter();
    // Escrow and script locks are not plain transfers.
    for (const method of ["masumi", "script"]) {
      await expectCode(
        a.quote(quoteInput(paymentRequired({ extra: { assetTransferMethod: method } }))),
        "VALIDATION_FAILED",
      );
    }
    await expectCode(
      a.quote(quoteInput(paymentRequired({ extra: { areFeesSponsored: true } }))),
      "VALIDATION_FAILED",
    );
    // Above the agent's maxAmount, and above the configured cap.
    await expectCode(a.quote(quoteInput(paymentRequired(), "1999999")), "POLICY_DENIED");
    await expectCode(
      a.quote(quoteInput(paymentRequired({ amount: "6000000" }), "9000000")),
      "POLICY_DENIED",
    );
    // No cap for the asset: never pays.
    await expectCode(adapter({}).quote(quoteInput()), "POLICY_DENIED");
    // A 402 for another resource.
    await expectCode(
      a.quote(quoteInput({ ...paymentRequired(), resource: { url: `${RESOURCE}&x=1` } })),
      "VALIDATION_FAILED",
    );
    // Mainnet requirement for a preprod payment.
    await expectCode(
      a.quote(quoteInput(paymentRequired({ network: "cardano:mainnet" }))),
      "VALIDATION_FAILED",
    );
  });

  it("does not build Cardano payments itself (the network builder does)", async () => {
    const a = adapter();
    const quote = await a.quote(quoteInput());
    await expectCode(a.buildTransaction({ payload: payloadFor(quote), quote }), "BAD_REQUEST");
  });

  it("verifies the built transaction against the x402 terms", async () => {
    const a = adapter();
    const quote = await a.quote(quoteInput());
    const payload = payloadFor(quote);
    const { unsigned } = await buildSigned(payload);
    expect(await a.verifyTransaction(unsigned.serialized, "hex", payload)).toEqual({ ok: true });
    // A payload whose recipient is not the x402 payTo is refused.
    const other = payloadFor(quote);
    const tampered = { ...other, to: PAYER };
    const verdict = await a.verifyTransaction(unsigned.serialized, "hex", tampered);
    expect(verdict.ok).toBe(false);
  });

  it("encodes the PAYMENT-SIGNATURE header: signed CBOR in base64 plus an input as nonce", async () => {
    const a = adapter();
    const quote = await a.quote(quoteInput());
    const payload = payloadFor(quote);
    const { signed } = await buildSigned(payload);
    const header = a.encodePaymentHeader({
      payload,
      cardano: { signedTransaction: signed.signedTransaction },
    });
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    const body = JSON.parse(decodeBase64Text(header.value)) as {
      x402Version: number;
      accepted: JsonObject;
      resource: JsonObject;
      payload: { transaction: string; nonce: string };
    };
    expect(body.x402Version).toBe(2);
    expect(body.accepted.network).toBe("cardano:preprod");
    expect(body.resource.url).toBe(RESOURCE);
    expect(body.payload.nonce).toBe(`${"ab".repeat(32)}#3`);
    const bytes = Uint8Array.from(atob(body.payload.transaction), (c) => c.charCodeAt(0));
    expect(bytesToHex(bytes)).toBe(signed.signedTransaction);
    const tx = decodeCardanoTx(bytes);
    expect(tx.bodyHash).toBe(signed.txHash);
    expect(tx.witnessKeys).toHaveLength(1);
  });

  it("refuses to put an unsigned transaction in a payment", async () => {
    const quote = await adapter().quote(quoteInput());
    const { unsigned } = await buildSigned(payloadFor(quote));
    expect(() => cardanoPaymentPayload(unsigned.serialized)).toThrow(/not signed/);
    expect(() => cardanoPaymentPayload("zz")).toThrow(/hex/);
  });
});

describe("x402 resource URL binding", () => {
  it("compares URLs in normalized form, as servers report resource.url", async () => {
    const mixed = RESOURCE.replace(
      "address-intel.zyropay.online",
      "Address-Intel.ZyroPay.ONLINE:443",
    );
    const quote = await adapter().quote({
      ...quoteInput(),
      params: { ...quoteInput().params, resourceUrl: mixed },
    });
    expect(quote.pluginData.resourceUrl).toBe(RESOURCE);
    expect(normalizeResourceUrl("https://A.example:443/x?y=1")).toBe("https://a.example/x?y=1");
  });
});
