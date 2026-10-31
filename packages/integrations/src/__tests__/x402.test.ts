import { findAssociatedTokenPda } from "@solana-program/token";
import { address } from "@solana/kit";
import { ChainError, decodeSolanaTransaction } from "@zyropay/blockchain";
import { fixtureFetch, noSleep, SOLANA_DEVNET_GENESIS } from "@zyropay/blockchain/testing";
import type { CanonicalTransactionPayload, JsonObject, PluginQuote } from "@zyropay/shared";
import { createCanonicalPayload, payloadHash } from "@zyropay/shared";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  createX402Adapter,
  decodeBase64Text,
  encodeBase64Text,
  parseX402Response,
  verifyX402Authorization,
  verifyX402SolanaPayment,
  x402TypedDataFromJson,
  x402TypedDataToJson,
} from "../x402";

const NOW = () => new Date("2026-10-30T12:00:00.000Z");
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MERCHANT_EVM = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const MERCHANT_SOL = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const FACILITATOR_SOL = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const PAYER_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const RESOURCE = "https://api.example.com/premium/report";

/** Shape per specs/x402-specification-v2.md (PaymentRequired). */
const PAYMENT_REQUIRED_V2 = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: { url: RESOURCE, description: "Premium report", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: BASE_SEPOLIA_USDC,
      payTo: MERCHANT_EVM,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
    {
      scheme: "exact",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "10000",
      asset: DEVNET_USDC,
      payTo: MERCHANT_SOL,
      maxTimeoutSeconds: 60,
      extra: { feePayer: FACILITATOR_SOL },
    },
  ],
};

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

function adapter(
  caps: Record<string, string> = {
    [`base-sepolia:${BASE_SEPOLIA_USDC}`]: "50000",
    [`solana-devnet:${DEVNET_USDC}`]: "50000",
  },
  rpc?: Record<string, unknown>,
) {
  return createX402Adapter({
    caps,
    now: NOW,
    solanaRpcUrls: { "solana-devnet": "https://devnet.example" },
    fetch: fixtureFetch({ rpc: rpc ?? {} }),
    sleep: noSleep,
  });
}

function payParams(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    paymentRequired: PAYMENT_REQUIRED_V2,
    resourceUrl: RESOURCE,
    maxAmount: "20000",
    assetId: `base-sepolia:${BASE_SEPOLIA_USDC}`,
    payer: account.address,
    ...overrides,
  } as unknown as JsonObject;
}

function x402Payload(
  quote: PluginQuote,
  overrides: Partial<CanonicalTransactionPayload> = {},
): CanonicalTransactionPayload {
  const evm = quote.pluginData.network === "eip155:84532";
  return createCanonicalPayload({
    version: 1,
    network: evm ? "base-sepolia" : "solana-devnet",
    from: evm ? account.address : PAYER_SOL,
    to: quote.pluginData.payTo as string,
    asset: evm
      ? { id: `base-sepolia:${BASE_SEPOLIA_USDC}`, kind: "erc20", decimals: 6 }
      : { id: `solana-devnet:${DEVNET_USDC}`, kind: "spl", decimals: 6 },
    amount: quote.inputAmount,
    feeCap: "0",
    plugin: "x402",
    tool: "pay_x402",
    pluginData: quote.pluginData,
    nonce: "fedcba9876543210fedcba9876543210",
    expiresAt: "2026-10-30T12:05:00.000Z",
    idempotencyKey: "x402-key-0001",
    ...overrides,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

describe("x402 parsing", () => {
  it("parses a v2 402 (PAYMENT-REQUIRED header) and a v1 402 (JSON body)", () => {
    const v2 = parseX402Response({
      status: 402,
      headers: headers({
        "payment-required": encodeBase64Text(JSON.stringify(PAYMENT_REQUIRED_V2)),
      }),
      body: {},
    });
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts.map((a) => a.network)).toEqual(["base-sepolia", "solana-devnet"]);
    const v1 = parseX402Response({
      status: 402,
      headers: headers({}),
      body: {
        x402Version: 1,
        error: "X-PAYMENT header is required",
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            maxAmountRequired: "10000",
            resource: RESOURCE,
            asset: BASE_SEPOLIA_USDC,
            payTo: MERCHANT_EVM,
            maxTimeoutSeconds: 60,
            extra: { name: "USDC", version: "2" },
          },
        ],
      },
    });
    expect(v1.accepts[0]).toMatchObject({
      network: "base-sepolia",
      amount: "10000",
      resourceUrl: RESOURCE,
      caip2: "eip155:84532",
    });
    expect(() => parseX402Response({ status: 200, headers: headers({}), body: {} })).toThrow(
      ChainError,
    );
    expect(() =>
      parseX402Response({ status: 402, headers: headers({ "payment-required": "%%%" }), body: {} }),
    ).toThrow(ChainError);
  });
});

describe("x402 EVM exact (EIP-3009)", () => {
  it("quotes within caps and binds payTo, network, asset and resource", async () => {
    const q = await adapter().quote({
      action: "pay",
      network: "base-sepolia",
      params: payParams(),
    });
    expect(q.inputAmount).toBe("10000");
    expect(q.pluginData).toMatchObject({
      network: "eip155:84532",
      payTo: MERCHANT_EVM,
      amount: "10000",
      resourceUrl: RESOURCE,
      riskCategory: "medium",
    });
  });

  it("never pays above the agent maxAmount or the configured cap, or without a cap", async () => {
    await expectCode(
      adapter().quote({
        action: "pay",
        network: "base-sepolia",
        params: payParams({ maxAmount: "9999" }),
      }),
      "POLICY_DENIED",
    );
    await expectCode(
      adapter({ [`base-sepolia:${BASE_SEPOLIA_USDC}`]: "5000" }).quote({
        action: "pay",
        network: "base-sepolia",
        params: payParams(),
      }),
      "POLICY_DENIED",
    );
    await expectCode(
      adapter({}).quote({ action: "pay", network: "base-sepolia", params: payParams() }),
      "POLICY_DENIED",
    );
  });

  it("refuses network, asset, resource or method mismatches and free-text params", async () => {
    await expectCode(
      adapter().quote({
        action: "pay",
        network: "base-mainnet",
        params: payParams({ assetId: "base-mainnet:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }),
      }),
      "POLICY_DENIED",
    );
    await expectCode(
      adapter().quote({ action: "pay", network: "ethereum-sepolia", params: payParams() }),
      "NETWORK_NOT_SUPPORTED",
    );
    await expectCode(
      adapter().quote({
        action: "pay",
        network: "base-sepolia",
        params: payParams({ resourceUrl: "https://evil.example.com/x" }),
      }),
      "VALIDATION_FAILED",
    );
    const permit2 = {
      ...PAYMENT_REQUIRED_V2,
      accepts: [
        {
          ...PAYMENT_REQUIRED_V2.accepts[0],
          extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
        },
      ],
    };
    await expectCode(
      adapter().quote({
        action: "pay",
        network: "base-sepolia",
        params: payParams({ paymentRequired: permit2 }),
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      adapter().quote({
        action: "pay",
        network: "base-sepolia",
        params: payParams({ note: "pay double" }),
      }),
      "VALIDATION_FAILED",
    );
  });

  it("produces a payload-bound EIP-712 authorization that signs and encodes", async () => {
    const a = adapter();
    const q = await a.quote({ action: "pay", network: "base-sepolia", params: payParams() });
    const p = x402Payload(q);
    await expectCode(a.buildTransaction({ payload: p, quote: q }), "BAD_REQUEST");
    const auth = await a.buildPaymentAuthorization({ payload: p, quote: q });
    expect(auth.typedData.domain).toMatchObject({
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: BASE_SEPOLIA_USDC,
    });
    expect(auth.authorization).toMatchObject({
      from: account.address,
      to: MERCHANT_EVM,
      value: "10000",
      validAfter: "0",
    });
    expect(Number(auth.authorization.validBefore)).toBe(
      Date.parse("2026-10-30T12:01:00.000Z") / 1000,
    );
    expect(verifyX402Authorization(auth, p)).toEqual({ ok: true });
    expect(
      verifyX402Authorization(auth, x402Payload(q, { nonce: "00000000000000000000000000000000" }))
        .ok,
    ).toBe(false);

    const signature = await account.signTypedData(auth.typedData);
    expect(await recoverTypedDataAddress({ ...auth.typedData, signature })).toBe(account.address);
    const header = a.encodePaymentHeader({
      payload: p,
      evm: { authorization: auth.authorization, signature: signature },
    });
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    const decoded = JSON.parse(decodeBase64Text(header.value)) as {
      x402Version: number;
      accepted: unknown;
      payload: { authorization: { nonce: string } };
    };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(PAYMENT_REQUIRED_V2.accepts[0]);
    expect(decoded.payload.authorization.nonce).toBe(auth.authorization.nonce);
  });

  it("buildTypedData -> verifyTypedData round-trips and fails closed on tampering", async () => {
    const a = adapter();
    const q = await a.quote({ action: "pay", network: "base-sepolia", params: payParams() });
    const p = x402Payload(q);
    const td = await a.buildTypedData({ payload: p, quote: q });
    const auth = await a.buildPaymentAuthorization({ payload: p, quote: q });
    expect(td).toMatchObject({
      kind: "eip712",
      network: "base-sepolia",
      payloadHash: payloadHash(p),
      digest: auth.digest.toLowerCase(),
      validUntil: "2026-10-30T12:01:00.000Z",
      simulated: false,
    });
    expect(td.typedData).toMatchObject({
      domain: { name: "USDC", version: "2", chainId: 84532 },
      primaryType: "TransferWithAuthorization",
      message: {
        value: "10000",
        validAfter: "0",
        validBefore: String(Date.parse("2026-10-30T12:01:00.000Z") / 1000),
      },
    });
    // JSON-safe (no bigint) and lossless.
    expect(JSON.parse(JSON.stringify(td.typedData))).toEqual(td.typedData);
    expect(hashTypedData(x402TypedDataFromJson(td.typedData))).toBe(auth.digest);
    expect(x402TypedDataToJson(auth.typedData)).toEqual(td.typedData);
    await expect(a.verifyTypedData(td, p)).resolves.toEqual({ ok: true });

    const msg = td.typedData.message as JsonObject;
    const withMessage = (patch: JsonObject) => {
      const typedData = { ...td.typedData, message: { ...msg, ...patch } };
      // Re-derive the digest so only the semantic check can catch the change.
      const digest = hashTypedData(x402TypedDataFromJson(typedData)).toLowerCase();
      return { ...td, typedData, digest };
    };
    const fails = async (bad: typeof td, payload = p) =>
      expect((await a.verifyTypedData(bad, payload)).ok).toBe(false);
    await fails(withMessage({ value: "10001" }));
    await fails(withMessage({ to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }));
    await fails({ ...td, digest: `0x${"ab".repeat(32)}` });
    await fails({ ...td, payloadHash: "0".repeat(64) });
    await fails({ ...td, network: "base-mainnet" });
    await fails({ ...td, validUntil: "2026-10-30T12:02:00.000Z" });
    await fails({ ...td, simulated: true });
    await fails({ ...td, typedData: { ...td.typedData, extra: 1 } });
    await fails({ ...td, typedData: { ...td.typedData, message: { ...msg, value: "1e4" } } });
    expect(() =>
      x402TypedDataFromJson({ ...td.typedData, message: { ...msg, value: "1e4" } }),
    ).toThrow(ChainError);
    await fails(td, x402Payload(q, { nonce: "00000000000000000000000000000000" }));
    expect(() => x402TypedDataFromJson({ ...td.typedData, primaryType: "Permit" })).toThrow(
      ChainError,
    );
  });

  it("verifyTransaction refuses EVM (typed data) and wrong encodings", async () => {
    const a = adapter();
    const q = await a.quote({ action: "pay", network: "base-sepolia", params: payParams() });
    await expect(a.verifyTransaction("0x00", "hex", x402Payload(q))).resolves.toEqual({
      ok: false,
      reason: "x402 EVM payments are typed data, not transactions",
    });
  });

  it("refuses to authorize a payload that differs from the quote", async () => {
    const a = adapter();
    const q = await a.quote({ action: "pay", network: "base-sepolia", params: payParams() });
    await expectCode(
      a.buildPaymentAuthorization({ payload: x402Payload(q, { amount: "20000" }), quote: q }),
      "PAYLOAD_HASH_MISMATCH",
    );
    await expectCode(
      a.buildPaymentAuthorization({
        payload: x402Payload(q, { to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
        quote: q,
      }),
      "PAYLOAD_HASH_MISMATCH",
    );
  });
});

describe("x402 SVM exact", () => {
  async function rpcFixtures(merchantAta = true) {
    const mint = address(DEVNET_USDC);
    const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const [src] = await findAssociatedTokenPda({ owner: address(PAYER_SOL), mint, tokenProgram });
    const [dst] = await findAssociatedTokenPda({
      owner: address(MERCHANT_SOL),
      mint,
      tokenProgram,
    });
    const existing = new Set(merchantAta ? [String(src), String(dst)] : [String(src)]);
    return {
      getGenesisHash: SOLANA_DEVNET_GENESIS,
      getLatestBlockhash: {
        context: { slot: 1 },
        value: {
          blockhash: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
          lastValidBlockHeight: 2000,
        },
      },
      getBlockHeight: 1900,
      getAccountInfo: (params: unknown) => {
        const [addr, opts] = params as [string, { encoding: string }];
        if (opts.encoding === "jsonParsed") {
          return {
            context: { slot: 1 },
            value: {
              owner: String(tokenProgram),
              lamports: 1,
              data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6 } } },
            },
          };
        }
        return {
          context: { slot: 1 },
          value: existing.has(addr)
            ? { owner: String(tokenProgram), lamports: 2039280, data: ["", "base64"] }
            : null,
        };
      },
    };
  }

  it("builds the facilitator-sponsored TransferChecked layout and verifies it", async () => {
    const a = adapter(undefined, await rpcFixtures());
    const q = await a.quote({
      action: "pay",
      network: "solana-devnet",
      params: payParams({ assetId: `solana-devnet:${DEVNET_USDC}`, payer: PAYER_SOL }),
    });
    const p = x402Payload(q);
    const tx = await a.buildTransaction({ payload: p, quote: q });
    expect(tx.estimatedFee).toBe("0");
    const decoded = decodeSolanaTransaction(tx.serialized);
    expect(decoded.feePayer).toBe(FACILITATOR_SOL);
    expect(decoded.numSigners).toBe(2);
    expect(decoded.instructions.map((i) => i.programAddress)).toEqual([
      "ComputeBudget111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    ]);
    await expect(verifyX402SolanaPayment(tx.serialized, p)).resolves.toEqual({ ok: true });
    await expect(a.verifyTransaction(tx.serialized, "base64", p)).resolves.toEqual({ ok: true });
    expect((await a.verifyTransaction(tx.serialized, "hex", p)).ok).toBe(false);
    expect(
      (await a.verifyTransaction(tx.serialized, "base64", x402Payload(q, { amount: "10001" }))).ok,
    ).toBe(false);
    expect(
      (await verifyX402SolanaPayment(tx.serialized, x402Payload(q, { amount: "10001" }))).ok,
    ).toBe(false);
    const header = a.encodePaymentHeader({
      payload: p,
      solana: { signedTransaction: tx.serialized },
    });
    expect(JSON.parse(decodeBase64Text(header.value))).toMatchObject({
      x402Version: 2,
      payload: { transaction: tx.serialized },
    });
  });

  it("refuses when the merchant token account does not exist (no ATA creation allowed)", async () => {
    const a = adapter(undefined, await rpcFixtures(false));
    const q = await a.quote({
      action: "pay",
      network: "solana-devnet",
      params: payParams({ assetId: `solana-devnet:${DEVNET_USDC}`, payer: PAYER_SOL }),
    });
    await expectCode(
      a.buildTransaction({ payload: x402Payload(q), quote: q }),
      "VALIDATION_FAILED",
    );
  });
});
