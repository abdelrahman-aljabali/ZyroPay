import { ChainError } from "@zyropay/blockchain";
import {
  fixtureFetch,
  noSleep,
  RpcErrorReply,
  SOLANA_MAINNET_GENESIS,
} from "@zyropay/blockchain/testing";
import type { CanonicalTransactionPayload, PluginQuote } from "@zyropay/shared";
import { createCanonicalPayload } from "@zyropay/shared";
import type { Hex } from "viem";
import {
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  parseTransaction,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import { createAaveAdapter, poolAbi, verifyAaveTransaction } from "../aave";
import { createHyperliquidAdapter } from "../hyperliquid";
import { createKaminoAdapter, verifyKaminoTransaction } from "../kamino";
import { MockPluginAdapter, MockX402Adapter } from "../mocks";
import { createPluginRegistry } from "../registry";
import { createJupiterAdapter } from "../jupiter";
import HL_SPOT from "./fixtures/hyperliquid-spot.json";
import K_DEPOSIT from "./fixtures/kamino-deposit-usdc.json";
import K_MARKETS from "./fixtures/kamino-markets.json";
import K_RESERVES from "./fixtures/kamino-reserves.json";

const NOW = () => new Date("2026-10-30T12:00:00.000Z");
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const RESERVE = "5xXxt9uVHrcT5b1KveAT5ZWgk2f74aDjnLEDDEeAxgpN";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

function payloadFor(
  quote: PluginQuote,
  base: Omit<
    CanonicalTransactionPayload,
    | "pluginData"
    | "amount"
    | "plugin"
    | "version"
    | "nonce"
    | "idempotencyKey"
    | "tool"
    | "expiresAt"
  > &
    Partial<CanonicalTransactionPayload>,
): CanonicalTransactionPayload {
  return createCanonicalPayload({
    version: 1,
    amount: quote.inputAmount,
    plugin: quote.pluginId,
    pluginData: quote.pluginData,
    tool: "app_send",
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: "2026-10-30T12:10:00.000Z",
    idempotencyKey: "plugin-key-0001",
    ...base,
  });
}

describe("Kamino adapter (recorded KTX fixtures)", () => {
  const rpc = {
    getGenesisHash: SOLANA_MAINNET_GENESIS,
    getAccountInfo: {
      context: { slot: 1 },
      value: {
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        lamports: 1,
        data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6 } } },
      },
    },
    simulateTransaction: {
      context: { slot: 1 },
      value: { err: null, logs: [], unitsConsumed: 300000 },
    },
  };
  const adapter = () =>
    createKaminoAdapter({
      rpcUrl: "https://mainnet.example",
      now: NOW,
      sleep: noSleep,
      fetch: fixtureFetch({
        rpc,
        rest: {
          "/v2/kamino-market": () => K_MARKETS,
          "/reserves/metrics": () => K_RESERVES,
          "/ktx/klend/deposit": K_DEPOSIT,
        },
      }),
    });

  it("discovers markets and reserves read-only", async () => {
    const a = adapter();
    expect((await a.listMarkets())[0]?.lendingMarket).toBe(MARKET);
    expect((await a.listReserves(MARKET)).some((r) => r.reserve === RESERVE)).toBe(true);
  });

  it("quotes and builds a deposit whose KLend amount matches the approval", async () => {
    const a = adapter();
    const q = await a.quote({
      action: "deposit",
      network: "solana-mainnet",
      params: { market: MARKET, reserve: RESERVE, amount: "1500000", wallet: USER },
    });
    expect(q.pluginData).toMatchObject({
      action: "deposit",
      mint: USDC,
      decimals: 6,
      riskCategory: "high",
    });
    const p = payloadFor(q, {
      network: "solana-mainnet",
      from: USER,
      to: RESERVE,
      asset: { id: `solana-mainnet:${USDC}`, kind: "spl", decimals: 6 },
      feeCap: "100000",
    });
    const tx = await a.buildTransaction({ payload: p, quote: q });
    expect(tx.serialized).toBe(K_DEPOSIT.transaction);
    expect(verifyKaminoTransaction(K_DEPOSIT.transaction, p)).toEqual({ ok: true });
    await expect(a.verifyTransaction(K_DEPOSIT.transaction, "base64", p)).resolves.toEqual({
      ok: true,
    });
    expect((await a.verifyTransaction(K_DEPOSIT.transaction, "hex", p)).ok).toBe(false);
    const other = payloadFor(q, {
      network: "solana-mainnet",
      from: USER,
      to: RESERVE,
      asset: { id: `solana-mainnet:${USDC}`, kind: "spl", decimals: 6 },
      feeCap: "100000",
      amount: "1500001",
    });
    expect((await a.verifyTransaction(K_DEPOSIT.transaction, "base64", other)).ok).toBe(false);
  });

  it("verify rejects a different amount, a different user and withdraw-vs-deposit confusion", async () => {
    const a = adapter();
    const q = await a.quote({
      action: "deposit",
      network: "solana-mainnet",
      params: { market: MARKET, reserve: RESERVE, amount: "1500001", wallet: USER },
    });
    const p = payloadFor(q, {
      network: "solana-mainnet",
      from: USER,
      to: RESERVE,
      asset: { id: `solana-mainnet:${USDC}`, kind: "spl", decimals: 6 },
      feeCap: "100000",
    });
    expect(verifyKaminoTransaction(K_DEPOSIT.transaction, p).ok).toBe(false);
    await expectCode(a.buildTransaction({ payload: p, quote: q }), "VALIDATION_FAILED");
    const other = payloadFor(q, {
      network: "solana-mainnet",
      from: RESERVE,
      to: RESERVE,
      asset: { id: `solana-mainnet:${USDC}`, kind: "spl", decimals: 6 },
      feeCap: "100000",
      amount: "1500000",
    });
    expect(verifyKaminoTransaction(K_DEPOSIT.transaction, other).ok).toBe(false);
    const withdraw = payloadFor(
      { ...q, pluginData: { ...q.pluginData, action: "withdraw" }, inputAmount: "1500000" },
      {
        network: "solana-mainnet",
        from: USER,
        to: USER,
        asset: { id: `solana-mainnet:${USDC}`, kind: "spl", decimals: 6 },
        feeCap: "100000",
      },
    );
    expect(verifyKaminoTransaction(K_DEPOSIT.transaction, withdraw).ok).toBe(false);
  });

  it("refuses unknown reserves, devnet and free-text params", async () => {
    const a = adapter();
    await expectCode(
      a.quote({
        action: "deposit",
        network: "solana-mainnet",
        params: { market: MARKET, reserve: USER, amount: "1", wallet: USER },
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      a.quote({
        action: "deposit",
        network: "solana-devnet",
        params: { market: MARKET, reserve: RESERVE, amount: "1", wallet: USER },
      }),
      "NETWORK_NOT_SUPPORTED",
    );
    await expectCode(
      a.quote({
        action: "deposit",
        network: "solana-mainnet",
        params: {
          market: MARKET,
          reserve: RESERVE,
          amount: "1",
          wallet: USER,
          memo: "do something else",
        },
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("Aave v3 adapter", () => {
  const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const ASSET = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"; // Aave faucet USDC, Base Sepolia
  const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
  const sel = (sig: string) => toFunctionSelector(sig);
  function rpc(allowance: bigint) {
    return {
      eth_chainId: "0x14a34",
      eth_getCode: "0x6080",
      eth_estimateGas: "0x30d40",
      eth_getTransactionCount: "0x3",
      eth_feeHistory: { baseFeePerGas: ["0x989680", "0x989680"], reward: [["0xf4240"]] },
      eth_call: (params: unknown) => {
        const data = (params as [{ data: string }])[0].data;
        if (data.startsWith(sel("getAllReservesTokens()")))
          return encodeAbiParameters(
            [
              {
                type: "tuple[]",
                components: [
                  { name: "symbol", type: "string" },
                  { name: "tokenAddress", type: "address" },
                ],
              },
            ],
            [[{ symbol: "USDC", tokenAddress: ASSET }]],
          );
        if (data.startsWith(sel("getReserveConfigurationData(address)")))
          return encodeAbiParameters(
            Array.from({ length: 10 }, (_, i) => ({ type: i >= 5 ? "bool" : "uint256" })),
            [6n, 7500n, 8000n, 10500n, 1000n, true, true, false, true, false],
          );
        if (data.startsWith(sel("getReserveData(address)")))
          return encodeAbiParameters(
            Array.from({ length: 12 }, (_, i) => ({ type: i === 11 ? "uint40" : "uint256" })),
            [
              0n,
              0n,
              5_000_000_000n,
              0n,
              0n,
              31_000_000_000_000_000_000_000_000n,
              0n,
              0n,
              0n,
              10n ** 27n,
              10n ** 27n,
              1_700_000_000,
            ],
          );
        if (data.startsWith(sel("allowance(address,address)")))
          return encodeAbiParameters([{ type: "uint256" }], [allowance]);
        if (data.startsWith("0x49948e0e"))
          return encodeAbiParameters([{ type: "uint256" }], [1000n]); // L1 fee
        return "0x";
      },
    };
  }
  const adapter = (allowance = 10n ** 12n) =>
    createAaveAdapter({
      rpcUrls: { "base-sepolia": "https://base-sepolia.example" },
      now: NOW,
      sleep: noSleep,
      fetch: fixtureFetch({ rpc: rpc(allowance) }),
    });

  it("reads reserves with supply rate as a ray integer", async () => {
    const reserves = await adapter().listReserves("base-sepolia");
    expect(reserves).toEqual([
      {
        symbol: "USDC",
        asset: ASSET,
        decimals: 6,
        isActive: true,
        isFrozen: false,
        liquidityRateRay: "31000000000000000000000000",
        totalSupplied: "5000000000",
      },
    ]);
  });

  it("builds an exact supply call and verifies calldata", async () => {
    const a = adapter();
    const q = await a.quote({
      action: "supply",
      network: "base-sepolia",
      params: { asset: ASSET, amount: "2500000", wallet: WALLET },
    });
    const p = payloadFor(q, {
      network: "base-sepolia",
      from: WALLET,
      to: POOL,
      asset: { id: `base-sepolia:${ASSET}`, kind: "erc20", decimals: 6 },
      feeCap: "100000000000000",
    });
    const tx = await a.buildTransaction({ payload: p, quote: q });
    const parsed = parseTransaction(tx.serialized as Hex);
    expect(parsed.to?.toLowerCase()).toBe(POOL.toLowerCase());
    const call = decodeFunctionData({ abi: poolAbi, data: parsed.data ?? "0x" });
    expect(call.functionName).toBe("supply");
    expect(call.args).toEqual([ASSET, 2500000n, WALLET, 0]);
    expect(verifyAaveTransaction(tx.serialized, p)).toEqual({ ok: true });
    const wrongRecipient = payloadFor(q, {
      network: "base-sepolia",
      from: WALLET,
      to: WALLET,
      asset: { id: `base-sepolia:${ASSET}`, kind: "erc20", decimals: 6 },
      feeCap: "100000000000000",
    });
    expect(verifyAaveTransaction(tx.serialized, wrongRecipient).ok).toBe(false);
    await expect(a.verifyTransaction(tx.serialized, "hex", p)).resolves.toEqual({ ok: true });
    expect((await a.verifyTransaction(tx.serialized, "base64", p)).ok).toBe(false);
    expect((await a.verifyTransaction(tx.serialized, "hex", wrongRecipient)).ok).toBe(false);
    expect((await a.verifyTransaction("0xdeadbeef", "hex", p)).ok).toBe(false);
  });

  it("requires an exact approval first and builds it", async () => {
    await expectCode(
      adapter(0n).quote({
        action: "supply",
        network: "base-sepolia",
        params: { asset: ASSET, amount: "2500000", wallet: WALLET },
      }),
      "VALIDATION_FAILED",
    );
    const a = adapter(0n);
    const q = await a.quote({
      action: "approve",
      network: "base-sepolia",
      params: { asset: ASSET, amount: "2500000", wallet: WALLET },
    });
    const p = payloadFor(q, {
      network: "base-sepolia",
      from: WALLET,
      to: POOL,
      asset: { id: `base-sepolia:${ASSET}`, kind: "erc20", decimals: 6 },
      feeCap: "100000000000000",
    });
    const tx = await a.buildTransaction({ payload: p, quote: q });
    const call = decodeFunctionData({
      abi: erc20Abi,
      data: parseTransaction(tx.serialized as Hex).data ?? "0x",
    });
    expect(call).toMatchObject({ functionName: "approve", args: [POOL, 2500000n] });
  });

  it("refuses unconfigured networks, unknown reserves and simulation reverts", async () => {
    await expectCode(
      adapter().quote({
        action: "supply",
        network: "ethereum-mainnet",
        params: { asset: ASSET, amount: "1", wallet: WALLET },
      }),
      "NETWORK_NOT_SUPPORTED",
    );
    await expectCode(
      adapter().quote({
        action: "supply",
        network: "base-sepolia",
        params: { asset: WALLET, amount: "1", wallet: WALLET },
      }),
      "VALIDATION_FAILED",
    );
    const reverting = createAaveAdapter({
      rpcUrls: { "base-sepolia": "x" },
      now: NOW,
      sleep: noSleep,
      fetch: fixtureFetch({
        rpc: {
          ...rpc(10n ** 12n),
          eth_call: (params: unknown) => {
            const call = (params as [{ data: string; from?: string }])[0];
            return call.from !== undefined
              ? new RpcErrorReply(3, "execution reverted: 51")
              : rpc(10n ** 12n).eth_call(params);
          },
        },
      }),
    });
    const q = await reverting.quote({
      action: "withdraw",
      network: "base-sepolia",
      params: { asset: ASSET, amount: "1", wallet: WALLET },
    });
    const p = payloadFor(q, {
      network: "base-sepolia",
      from: WALLET,
      to: WALLET,
      asset: { id: `base-sepolia:${ASSET}`, kind: "erc20", decimals: 6 },
      feeCap: "100000000000000",
    });
    await expectCode(reverting.buildTransaction({ payload: p, quote: q }), "VALIDATION_FAILED");
  });
});

describe("Hyperliquid (read-only)", () => {
  it("reads spot markets with contexts matched by coin, refuses trading", async () => {
    const a = createHyperliquidAdapter({
      environment: "mainnet",
      sleep: noSleep,
      fetch: fixtureFetch({ rest: { "/info": () => HL_SPOT } }),
    });
    const markets = await a.getSpotMarkets();
    expect(markets[0]).toMatchObject({ name: "PURR/USDC", base: "PURR", quote: "USDC" });
    expect(markets[0]?.midPx).toMatch(/^\d+\.\d+$/);
    await expectCode(
      a.quote({ action: "open_position", network: "base-mainnet", params: {} }),
      "PLUGIN_DISABLED",
    );
    await expect(a.verifyTransaction()).resolves.toEqual({ ok: false, reason: "read-only" });
  });
});

describe("Plugin registry", () => {
  const jupiter = createJupiterAdapter({ apiKey: "k", rpcUrl: "https://x" });

  it("routes only available plugins on mode-allowed manifest networks", () => {
    const prod = createPluginRegistry([jupiter], { mode: "production" });
    expect(prod.require("jupiter", { network: "solana-mainnet", action: "swap" })).toBe(jupiter);
    expect(() => prod.require("jupiter", { network: "solana-devnet", action: "swap" })).toThrow(
      ChainError,
    );
    expect(() =>
      prod.require("jupiter", { network: "solana-mainnet", action: "withdraw_all" }),
    ).toThrow(ChainError);
    expect(() => prod.require("x402", { network: "base-mainnet", action: "pay" })).toThrow(
      ChainError,
    );
  });

  it("refuses mocks in production and coming-soon plugins unless enabled", () => {
    expect(() => createPluginRegistry([new MockX402Adapter()], { mode: "production" })).toThrow();
    const dev = createPluginRegistry([new MockX402Adapter(), new MockPluginAdapter("aave")], {
      mode: "development",
    });
    expect(dev.require("x402", { network: "base-sepolia", action: "pay" }).manifest.id).toBe(
      "x402",
    );
    expect(() =>
      createPluginRegistry([createAaveAdapter({ rpcUrls: {} })], { mode: "development" }).require(
        "aave",
        { network: "base-sepolia", action: "supply" },
      ),
    ).toThrow(ChainError);
    expect(
      createPluginRegistry([createAaveAdapter({ rpcUrls: {} })], {
        mode: "development",
        enableComingSoon: true,
      }).require("aave", { network: "base-sepolia", action: "supply" }).manifest.id,
    ).toBe("aave");
  });

  it("there is no mock swap: Jupiter has no development networks", async () => {
    await expectCode(
      new MockPluginAdapter("jupiter", NOW).quote({
        action: "swap",
        network: "solana-devnet",
        params: { amount: "1000", slippageBps: 100 },
      }),
      "NETWORK_NOT_SUPPORTED",
    );
  });

  it("mock verifyTransaction accepts exactly what the mock built", async () => {
    const a = new MockPluginAdapter("aave", NOW);
    const q = await a.quote({
      action: "supply",
      network: "base-sepolia",
      params: { amount: "1000" },
    });
    expect(q.simulated).toBe(true);
    const p = payloadFor(q, {
      network: "base-sepolia",
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      asset: { id: "base-sepolia:native", kind: "native", decimals: 18 },
      feeCap: "10000",
    });
    const tx = await a.buildTransaction({ payload: p, quote: q });
    expect(tx.simulated).toBe(true);
    await expect(a.verifyTransaction(tx.serialized, tx.encoding, p)).resolves.toEqual({
      ok: true,
    });
    expect((await a.verifyTransaction(tx.serialized, "base64", p)).ok).toBe(false);
    expect((await a.verifyTransaction(tx.serialized, "hex", { ...p, amount: "999" })).ok).toBe(
      false,
    );
  });

  it("mock x402 builds and verifies a deterministic simulated EIP-712 authorization", async () => {
    const a = new MockX402Adapter(NOW);
    const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const PAYTO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const q = await a.quote({
      action: "pay",
      network: "base-sepolia",
      params: { amount: "10000" },
    });
    const p = payloadFor(q, {
      network: "base-sepolia",
      from: WALLET,
      to: PAYTO,
      asset: { id: `base-sepolia:${TOKEN}`, kind: "erc20", decimals: 6 },
      feeCap: "0",
    });
    const td = await a.buildTypedData({ payload: p, quote: q });
    expect(td).toMatchObject({ kind: "eip712", network: "base-sepolia", simulated: true });
    expect(td.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await a.buildTypedData({ payload: p, quote: q })).toEqual(td);
    await expect(a.verifyTypedData(td, p)).resolves.toEqual({ ok: true });
    expect((await a.verifyTypedData({ ...td, digest: `0x${"0".repeat(64)}` }, p)).ok).toBe(false);
    expect((await a.verifyTypedData({ ...td, simulated: false }, p)).ok).toBe(false);
    expect((await a.verifyTypedData(td, { ...p, amount: "10001" })).ok).toBe(false);
  });
});
