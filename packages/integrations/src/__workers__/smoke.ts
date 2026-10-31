/**
 * Cloudflare Workers smoke test (no nodejs_compat flag). `pnpm --filter @zyropay/integrations
 * check:workers` bundles this with wrangler; `wrangler dev` + GET / runs every scenario inside
 * workerd with recorded fixtures (no network) and returns a JSON report.
 */
import {
  assertSignedMatchesUnsigned,
  attachCardanoWitness,
  createCardanoBroadcaster,
  createCardanoTransactionBuilder,
  createEvmTransactionBuilder,
  createSolanaTransactionBuilder,
  decodeSolanaTransaction,
  MockPriceProvider,
  txHashOfSigned,
} from "@zyropay/blockchain";
import {
  blockfrostRest,
  fixtureFetch,
  SOLANA_DEVNET_GENESIS,
  testEd25519PublicKey,
  testEd25519Sign,
} from "@zyropay/blockchain/testing";
import {
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  createCanonicalPayload,
  payloadHash,
} from "@zyropay/shared";
import {
  createTransakOnrampProvider,
  createX402Adapter,
  verifyHs256Jwt,
  verifyJupiterSwap,
} from "../index";
import SWAP from "../__tests__/fixtures/jupiter-swap-sol-usdc.json";

const SOL_FROM = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_TO = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

async function run(): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  const solPayload = createCanonicalPayload({
    version: 1,
    network: "solana-devnet",
    from: SOL_FROM,
    to: SOL_TO,
    asset: { id: "solana-devnet:native", kind: "native", decimals: 9 },
    amount: "1000000",
    feeCap: "100000",
    plugin: null,
    tool: "app_send",
    pluginData: null,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "smoke-key-001",
  });
  const solana = createSolanaTransactionBuilder({
    rpcUrl: "https://fixture",
    network: "solana-devnet",
    sleep: () => Promise.resolve(),
    fetch: fixtureFetch({
      rpc: {
        getGenesisHash: SOLANA_DEVNET_GENESIS,
        getLatestBlockhash: {
          context: { slot: 1 },
          value: {
            blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
            lastValidBlockHeight: 2000,
          },
        },
        getBlockHeight: 1900,
        getRecentPrioritizationFees: () => [{ slot: 1, prioritizationFee: 1000 }],
        simulateTransaction: {
          context: { slot: 1 },
          value: { err: null, logs: [], unitsConsumed: 450 },
        },
      },
    }),
  });
  const solTx = await solana.buildTransfer(solPayload);
  report.solanaBuild = {
    ok: (await solana.verifyMatchesPayload(solTx.serialized, "base64", solPayload)).ok,
    feePayer: decodeSolanaTransaction(solTx.serialized).feePayer,
    fee: solTx.estimatedFee,
  };

  const evmPayload = createCanonicalPayload({
    ...solPayload,
    network: "base-sepolia",
    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    asset: { id: "base-sepolia:native", kind: "native", decimals: 18 },
    feeCap: "1000000000000000",
  });
  const evm = createEvmTransactionBuilder({
    rpcUrl: "https://fixture",
    network: "base-sepolia",
    sleep: () => Promise.resolve(),
    fetch: fixtureFetch({
      rpc: {
        eth_chainId: "0x14a34",
        eth_call: `0x${1000n.toString(16).padStart(64, "0")}`,
        eth_estimateGas: "0x5208",
        eth_getTransactionCount: "0x0",
        eth_feeHistory: { baseFeePerGas: ["0x989680", "0x989680"], reward: [["0xf4240"]] },
      },
    }),
  });
  const evmTx = await evm.buildTransfer(evmPayload);
  report.evmBuild = {
    ok: (await evm.verifyMatchesPayload(evmTx.serialized, "hex", evmPayload)).ok,
    l1DataFee: evmTx.l1DataFee,
  };

  report.jupiterVerify = await verifyJupiterSwap(
    SWAP.swapTransaction,
    createCanonicalPayload({
      ...solPayload,
      network: "solana-mainnet",
      to: SOL_FROM,
      asset: { id: "solana-mainnet:native", kind: "native", decimals: 9 },
      amount: "10000000",
      feeCap: "200000",
      plugin: "jupiter",
      tool: "swap",
      pluginData: {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "10000000",
        minOutAmount: "1053102",
        slippageBps: 50,
        riskCategory: "medium",
      },
    }),
  );

  const x402 = createX402Adapter({
    caps: { "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e": "50000" },
  });
  const quote = await x402.quote({
    action: "pay",
    network: "base-sepolia",
    params: {
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://api.example.com/r" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            amount: "10000",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            maxTimeoutSeconds: 60,
            extra: { name: "USDC", version: "2" },
          },
        ],
      },
      resourceUrl: "https://api.example.com/r",
      maxAmount: "20000",
      assetId: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    },
  });
  const auth = await x402.buildPaymentAuthorization({
    quote,
    payload: createCanonicalPayload({
      ...evmPayload,
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      asset: {
        id: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        kind: "erc20",
        decimals: 6,
      },
      amount: "10000",
      feeCap: "0",
      plugin: "x402",
      tool: "pay_x402",
      pluginData: quote.pluginData,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  report.x402Digest = auth.digest;

  const transak = createTransakOnrampProvider({
    apiKey: "pk",
    apiSecret: "sk",
    environment: "STAGING",
    referrerDomain: "zyropay.app",
  });
  report.transakWebhookRejectsGarbage =
    (await transak.verifyWebhook("{}", { get: () => null })) === null;
  report.jwtRejectsGarbage = (await verifyHs256Jwt("x.y.z", ["k"])) === null;
  report.mockPrice = (
    await new MockPriceProvider().getPrices({ assetIds: ["solana-devnet:native"], currency: "USD" })
  ).prices["solana-devnet:native"]?.price.value;
  report.payloadHash = payloadHash(solPayload);
  report.cardano = await cardanoScenario();
  return report;
}

/**
 * Cardano in workerd: build (own CBOR codec + Blockfrost fixtures), independent verify,
 * Ed25519 sign (noble), attach the witness, C7 check, derive the tx id, and broadcast
 * through the Blockfrost adapter against a fixture `tx/submit`.
 */
async function cardanoScenario(): Promise<Record<string, unknown>> {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
  const pk = Array.from(testEd25519PublicKey(secret), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const from = cardanoEnterpriseAddress(pk, "cardano-preprod");
  const to = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
  const tip = { slot: 105_000_000, height: 4_200_000, time: Math.floor(Date.now() / 1000) };
  const utxos = [
    {
      tx_hash: "1".repeat(64),
      output_index: 0,
      amount: [{ unit: "lovelace", quantity: "9000000" }],
      data_hash: null,
      inline_datum: null,
      reference_script_hash: null,
    },
  ];
  const payload = createCanonicalPayload({
    version: 1,
    network: "cardano-preprod",
    from,
    to,
    asset: { id: "cardano-preprod:native", kind: "native", decimals: 6 },
    amount: "2000000",
    feeCap: "1000000",
    plugin: null,
    tool: "app_send",
    pluginData: null,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: "smoke-cardano-01",
  });
  let submittedHash = "";
  const fetch = fixtureFetch({
    rest: blockfrostRest({
      networkMagic: 1,
      utxos,
      tip,
      extra: { "/tx/submit": () => submittedHash },
    }),
  });
  const common = {
    blockfrostProjectId: "preprodSMOKE00000000000000000000000",
    network: "cardano-preprod" as const,
    blockfrostBaseUrl: "https://fixture/api/v0",
    fetch,
    sleep: () => Promise.resolve(),
  };
  const builder = createCardanoTransactionBuilder(common);
  const unsigned = await builder.buildTransfer(payload);
  const verified = (await builder.verifyMatchesPayload(unsigned.serialized, "hex", payload)).ok;
  const bodyHash = Uint8Array.from(unsigned.bodyHash.match(/../g) ?? [], (h) => parseInt(h, 16));
  const signature = Array.from(testEd25519Sign(secret, bodyHash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const { signedTransaction, txHash } = attachCardanoWitness({
    unsignedHex: unsigned.serialized,
    publicKey: pk,
    signature,
    expectedKeyHash: cardanoKeyHash(pk),
  });
  await assertSignedMatchesUnsigned({
    network: "cardano-preprod",
    encoding: "hex",
    signed: signedTransaction,
    unsigned: unsigned.serialized,
    expectedSigner: from,
  });
  submittedHash = txHash;
  const broadcast = await createCardanoBroadcaster(common).broadcast({
    network: "cardano-preprod",
    signedTransaction,
    encoding: "hex",
  });
  return {
    buildVerified: verified,
    fee: unsigned.estimatedFee,
    ttlSlot: unsigned.ttlSlot,
    txHash,
    derivedHashMatches:
      txHashOfSigned({ network: "cardano-preprod", signedTransaction, encoding: "hex" }) === txHash,
    broadcastHash: broadcast.txHash,
  };
}

export default {
  async fetch(): Promise<Response> {
    try {
      return Response.json({ ok: true, report: await run() });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        { status: 500 },
      );
    }
  },
};
