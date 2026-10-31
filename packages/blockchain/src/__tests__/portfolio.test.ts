import type { WatchedAddress } from "@zyropay/shared";
import { PortfolioSnapshotSchema, TransactionSchema } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ChainError } from "../errors";
import { MockPortfolioProvider, MockPriceProvider } from "../mocks";
import { createCompositePortfolioProvider } from "../portfolio/common";
import { createEvmPortfolioProvider, receiptFee } from "../portfolio/evm";
import { createSolanaPortfolioProvider } from "../portfolio/solana";
import { fixtureFetch, HttpReply, noSleep, RpcErrorReply } from "../testing";
import { DEVNET_USDC, EVM_FROM, EVM_TO, SEPOLIA_USDC, SOL_FROM, SOL_TO } from "./fixtures";

const WALLET = "0199e7a0-0000-7000-8000-000000000001";
const NOW = () => new Date("2026-10-30T12:00:00.000Z");
const solAddr: WatchedAddress = { walletId: WALLET, network: "solana-devnet", address: SOL_FROM };
const evmAddr: WatchedAddress = {
  walletId: WALLET,
  network: "ethereum-sepolia",
  address: EVM_FROM,
};

/** Recorded-shape fixture of Helius DAS getAssetsByOwner (fungible + native balance). */
const DAS_RESPONSE = {
  total: 3,
  limit: 1000,
  page: 1,
  items: [
    {
      interface: "FungibleToken",
      id: DEVNET_USDC,
      content: {
        metadata: { name: "USD Coin", symbol: "USDC" },
        links: { image: "https://example.com/usdc.png" },
      },
      token_info: {
        symbol: "USDC",
        balance: 12_500_000,
        supply: 1e15,
        decimals: 6,
        token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
    },
    {
      interface: "FungibleToken",
      id: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
      content: {
        metadata: { name: "Spam\u0000Token", symbol: "FREE" },
        links: { image: "javascript:alert(1)" },
      },
      token_info: { balance: 99, supply: 1000, decimals: 2 },
    },
    {
      interface: "V1_NFT",
      id: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
      content: { metadata: { name: "NFT" } },
      token_info: { balance: 1, supply: 1, decimals: 0 },
    },
  ],
  nativeBalance: { lamports: 1_000_000_000, price_per_sol: 150, total_price: 150 },
};

/** Recorded-shape getTransactionsForAddress (full, jsonParsed): one SOL out, one USDC in. */
const GTFA_RESPONSE = {
  data: [
    {
      slot: 400000001,
      blockTime: 1793328400,
      transaction: {
        signatures: [
          "3N6b1Gq6ZMbYqaU5rZ9TRv3sA8i6hkMXmVYBkUQf8ojJyKxQ2u4X9pFqzQeGgkqTPaxXnwwB3rGq3EW4xPpBqRq5",
        ],
        message: {
          accountKeys: [
            { pubkey: SOL_FROM, signer: true, writable: true },
            { pubkey: SOL_TO, signer: false, writable: true },
            { pubkey: "11111111111111111111111111111111", signer: false, writable: false },
          ],
          instructions: [
            {
              program: "system",
              programId: "11111111111111111111111111111111",
              parsed: {
                type: "transfer",
                info: { source: SOL_FROM, destination: SOL_TO, lamports: 250000000 },
              },
            },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        innerInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    },
    {
      slot: 400000000,
      blockTime: 1793318400,
      transaction: {
        signatures: [
          "4xH6s6q1Zt3oXkDfJ5f4u8jM4n2Q8VZ7kVv5mXyY2bA7dK3pR9wLs1uTqE6cNn8gFhJ2kYxPz5rW3vB7tQ9mUeS",
        ],
        message: {
          accountKeys: [
            { pubkey: SOL_TO, signer: true, writable: true },
            {
              pubkey: "AtaSrc1111111111111111111111111111111111111",
              signer: false,
              writable: true,
            },
            {
              pubkey: "AtaDst1111111111111111111111111111111111111",
              signer: false,
              writable: true,
            },
          ],
          instructions: [
            {
              program: "spl-token",
              programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              parsed: {
                type: "transferChecked",
                info: {
                  source: "AtaSrc1111111111111111111111111111111111111",
                  destination: "AtaDst1111111111111111111111111111111111111",
                  authority: SOL_TO,
                  mint: DEVNET_USDC,
                  tokenAmount: { amount: "7000000", decimals: 6, uiAmount: 7, uiAmountString: "7" },
                },
              },
            },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        innerInstructions: [],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: DEVNET_USDC,
            owner: SOL_TO,
            uiTokenAmount: { amount: "9000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: DEVNET_USDC,
            owner: SOL_FROM,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [],
      },
    },
  ],
  paginationToken: "400000000:0",
};

describe("Solana portfolio (Helius)", () => {
  const provider = (rpc: Record<string, unknown>) =>
    createSolanaPortfolioProvider({
      heliusApiKey: "k",
      network: "solana-devnet",
      rpcUrl: "https://devnet.example/?api-key=k",
      fetch: fixtureFetch({ rpc }),
      sleep: noSleep,
      now: NOW,
      priceProvider: new MockPriceProvider(NOW),
    });

  it("normalizes native + fungible balances to base-unit strings, drops NFTs, sanitizes metadata", async () => {
    // Raw JSON text: the lamports literal is above 2^53 and must not pass through a double.
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { ...DAS_RESPONSE, nativeBalance: { lamports: "__BIG__" } },
    }).replace('"__BIG__"', "9007199254740993");
    const snapshot = await provider({ getAssetsByOwner: new HttpReply(200, raw) }).getSnapshot({
      addresses: [solAddr],
      currency: "USD",
    });
    expect(PortfolioSnapshotSchema.parse(snapshot)).toBeTruthy();
    expect(snapshot.stale).toBe(false);
    expect(snapshot.balances.map((b) => [b.asset.symbol, b.amount])).toEqual([
      ["SOL", "9007199254740993"],
      ["USDC", "12500000"],
      ["FREE", "99"],
    ]);
    const usdc = snapshot.balances[1]!;
    expect(usdc.asset.verified).toBe(true);
    const spam = snapshot.balances[2]!;
    expect(spam.asset.verified).toBe(false);
    expect(spam.asset.name).toBe("SpamToken");
    expect(spam.asset.logoUrl).toBeNull();
  });

  it("falls back to the last good data with stale=true when Helius fails", async () => {
    let fail = false;
    const p = provider({
      getAssetsByOwner: () => (fail ? new HttpReply(503, "down") : DAS_RESPONSE),
    });
    const first = await p.getSnapshot({ addresses: [solAddr], currency: "USD" });
    fail = true;
    const second = await p.getSnapshot({ addresses: [solAddr], currency: "USD" });
    expect(second.stale).toBe(true);
    expect(second.balances).toEqual(first.balances);
    // No cache at all: stale and empty, never invented.
    const cold = await provider({ getAssetsByOwner: new HttpReply(503, "down") }).getSnapshot({
      addresses: [solAddr],
      currency: "USD",
    });
    expect(cold).toMatchObject({ stale: true, balances: [], totalValue: { value: "0.00" } });
  });

  it("refuses addresses on another network or with an invalid format", async () => {
    const p = provider({ getAssetsByOwner: DAS_RESPONSE });
    await expect(
      p.getSnapshot({ addresses: [{ ...solAddr, network: "solana-mainnet" }], currency: "USD" }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.code === "NETWORK_MODE_MISMATCH",
    );
    await expect(
      p.getSnapshot({ addresses: [{ ...solAddr, address: EVM_FROM }], currency: "USD" }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.code === "INVALID_ADDRESS");
  });

  it("parses history with exact amounts, direction, fee and cursor", async () => {
    const fetch = fixtureFetch({ rpc: { getTransactionsForAddress: GTFA_RESPONSE } });
    const p = createSolanaPortfolioProvider({
      heliusApiKey: "k",
      network: "solana-devnet",
      rpcUrl: "https://x",
      fetch,
      sleep: noSleep,
    });
    const page = await p.getTransactions({ address: solAddr, limit: 2 });
    expect(page.nextCursor).toBe("400000000:0");
    expect(page.transactions).toHaveLength(2);
    for (const t of page.transactions) TransactionSchema.parse(t);
    const [out, inc] = page.transactions;
    expect(out).toMatchObject({
      direction: "out",
      amount: "250000000",
      fee: "5000",
      to: SOL_TO,
      status: "confirmed",
      blockNumber: "400000001",
    });
    expect(out?.asset.kind).toBe("native");
    expect(inc).toMatchObject({
      direction: "in",
      amount: "7000000",
      fee: null,
      from: SOL_TO,
      to: SOL_FROM,
    });
    expect(inc?.asset.symbol).toBe("USDC");
    // deterministic ids
    const again = await p.getTransactions({ address: solAddr, limit: 2, cursor: "abc" });
    expect(again.transactions[0]?.id).toBe(out?.id);
    const sent = fetch.calls.at(-1)?.body as { params: [string, { paginationToken: string }] };
    expect(sent.params[1].paginationToken).toBe("abc");
  });
});

describe("EVM portfolio (Alchemy)", () => {
  const rpc = {
    eth_chainId: "0xaa36a7",
    eth_getBalance: "0xde0b6b3a7640000",
    alchemy_getTokenBalances: {
      address: EVM_FROM,
      tokenBalances: [
        {
          contractAddress: SEPOLIA_USDC.toLowerCase(),
          tokenBalance: "0x00000000000000000000000000000000000000000000000000000000004c4b40",
          error: null,
        },
        {
          contractAddress: "0x1111111111111111111111111111111111111111",
          tokenBalance: "0x0",
          error: null,
        },
        {
          contractAddress: "0x2222222222222222222222222222222222222222",
          tokenBalance: null,
          error: "bad",
        },
        {
          contractAddress: "0x3333333333333333333333333333333333333333",
          tokenBalance: "0x10",
          error: null,
        },
      ],
    },
    alchemy_getTokenMetadata: (params: unknown) => {
      const [address] = params as [string];
      return address.startsWith("0x3333")
        ? { decimals: null, symbol: "X", name: "X", logo: null }
        : {
            decimals: 6,
            symbol: "USDC",
            name: "USDC",
            logo: "https://static.alchemyapi.io/images/assets/3408.png",
          };
    },
    alchemy_getAssetTransfers: (params: unknown) => {
      const [q] = params as [{ fromAddress?: string; category: string[] }];
      expect(q.category).not.toContain("internal"); // not supported on Sepolia
      return q.fromAddress !== undefined
        ? {
            transfers: [
              {
                blockNum: "0x10",
                uniqueId: "0xaa:external",
                hash: "0xaa",
                from: EVM_FROM.toLowerCase(),
                to: EVM_TO.toLowerCase(),
                value: 0.5,
                asset: "ETH",
                category: "external",
                rawContract: { value: "0x6f05b59d3b20000", address: null, decimal: "0x12" },
                metadata: { blockTimestamp: "2026-10-30T00:00:00.000Z" },
              },
            ],
          }
        : {
            transfers: [
              {
                blockNum: "0x12",
                uniqueId: "0xbb:log:3",
                hash: "0xbb",
                from: EVM_TO.toLowerCase(),
                to: EVM_FROM.toLowerCase(),
                value: 5,
                asset: "USDC",
                category: "erc20",
                rawContract: {
                  value: "0x4c4b40",
                  address: SEPOLIA_USDC.toLowerCase(),
                  decimal: "0x6",
                },
                metadata: { blockTimestamp: "2026-10-30T06:00:00.000Z" },
              },
            ],
          };
    },
  };

  it("normalizes native + ERC-20 balances, skipping zero, errored and decimals-less tokens", async () => {
    const p = createEvmPortfolioProvider({
      alchemyApiKey: "k",
      network: "ethereum-sepolia",
      rpcUrl: "https://x",
      fetch: fixtureFetch({ rpc }),
      sleep: noSleep,
      now: NOW,
    });
    const s = await p.getSnapshot({ addresses: [evmAddr], currency: "USD" });
    PortfolioSnapshotSchema.parse(s);
    expect(s.balances.map((b) => [b.asset.id, b.amount])).toEqual([
      ["ethereum-sepolia:native", "1000000000000000000"],
      [`ethereum-sepolia:${SEPOLIA_USDC}`, "5000000"],
    ]);
    // No price provider: everything unpriced, total 0, never guessed.
    expect(s.unpricedAssetCount).toBe(2);
    expect(s.balances.every((b) => b.value === null)).toBe(true);
  });

  it("refuses an endpoint serving another chain", async () => {
    const p = createEvmPortfolioProvider({
      alchemyApiKey: "k",
      network: "ethereum-sepolia",
      rpcUrl: "https://x",
      fetch: fixtureFetch({ rpc: { ...rpc, eth_chainId: "0x1" } }),
      sleep: noSleep,
    });
    await expect(p.getSnapshot({ addresses: [evmAddr], currency: "USD" })).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.code === "NETWORK_MODE_MISMATCH",
    );
  });

  it("merges in/out transfers newest first with exact raw amounts and a resumable cursor", async () => {
    const p = createEvmPortfolioProvider({
      alchemyApiKey: "k",
      network: "ethereum-sepolia",
      rpcUrl: "https://x",
      fetch: fixtureFetch({ rpc }),
      sleep: noSleep,
    });
    const page = await p.getTransactions({ address: evmAddr, limit: 1 });
    expect(page.transactions).toHaveLength(1);
    TransactionSchema.parse(page.transactions[0]);
    expect(page.transactions[0]).toMatchObject({
      direction: "in",
      amount: "5000000",
      txHash: "0xbb",
    });
    expect(page.nextCursor).not.toBeNull();
    const next = await p.getTransactions({
      address: evmAddr,
      limit: 1,
      cursor: page.nextCursor ?? "",
    });
    expect(next.transactions[0]).toMatchObject({
      direction: "out",
      amount: "500000000000000000",
      to: EVM_TO,
    });
    await expect(
      p.getTransactions({ address: evmAddr, limit: 1, cursor: "garbage" }),
    ).rejects.toThrow(ChainError);
  });
  // Regression: a real Sepolia send showed fee null in history although
  // the schema keeps null for incoming transfers only (getAssetTransfers carries no fee).
  it("fills the fee of sent transactions from their receipt, never of received ones", async () => {
    const receipts: unknown[] = [];
    const p = createEvmPortfolioProvider({
      alchemyApiKey: "k",
      network: "ethereum-sepolia",
      rpcUrl: "https://x",
      fetch: fixtureFetch({
        rpc: {
          ...rpc,
          eth_getTransactionReceipt: (params: unknown) => {
            receipts.push(params);
            return {
              transactionHash: "0xaa",
              from: EVM_FROM.toLowerCase(),
              status: "0x1",
              gasUsed: "0x31f38", // 204600
              effectiveGasPrice: "0x3b9aca00", // 1 gwei
            };
          },
        },
      }),
      sleep: noSleep,
    });
    const page = await p.getTransactions({ address: evmAddr, limit: 10 });
    for (const t of page.transactions) TransactionSchema.parse(t);
    expect(page.transactions.map((t) => [t.direction, t.fee])).toEqual([
      ["in", null],
      ["out", "204600000000000"],
    ]);
    expect(receipts).toEqual([["0xaa"]]); // only the sent transaction is looked up
  });

  it("leaves the fee unknown when the receipt cannot be read", async () => {
    const p = createEvmPortfolioProvider({
      alchemyApiKey: "k",
      network: "ethereum-sepolia",
      rpcUrl: "https://x",
      fetch: fixtureFetch({
        rpc: { ...rpc, eth_getTransactionReceipt: new RpcErrorReply(-32000, "unavailable") },
      }),
      sleep: noSleep,
    });
    const page = await p.getTransactions({ address: evmAddr, limit: 10 });
    expect(page.transactions.map((t) => t.fee)).toEqual([null, null]);
  });

  it("receiptFee charges only the payer and adds the OP-stack l1Fee", () => {
    const r = { from: EVM_FROM, gasUsed: "0x5208", effectiveGasPrice: "0x2" };
    expect(receiptFee(EVM_FROM, r)).toBe("42000");
    expect(receiptFee(EVM_FROM.toLowerCase(), { ...r, l1Fee: "0x10" })).toBe("42016");
    expect(receiptFee(EVM_TO, r)).toBeNull();
    expect(receiptFee(EVM_FROM, null)).toBeNull();
    expect(receiptFee(EVM_FROM, { from: EVM_FROM, gasUsed: "0x5208" })).toBeNull();
  });
});

describe("composite + mock providers", () => {
  it("routes by chain family and values with bigint math", async () => {
    const solana = createSolanaPortfolioProvider({
      heliusApiKey: "k",
      network: "solana-devnet",
      rpcUrl: "https://x",
      fetch: fixtureFetch({
        rpc: {
          getAssetsByOwner: {
            ...DAS_RESPONSE,
            items: [DAS_RESPONSE.items[0]],
            nativeBalance: { lamports: 1_500_000_000 },
          },
        },
      }),
      sleep: noSleep,
      now: NOW,
    });
    const composite = createCompositePortfolioProvider({
      byNetwork: { "solana-devnet": solana },
      priceProvider: new MockPriceProvider(NOW),
      now: NOW,
    });
    const s = await composite.getSnapshot({ addresses: [solAddr], currency: "USD" });
    // 1.5 SOL * 150 = 225.00 ; 12.5 USDC * 1 = 12.50
    expect(s.totalValue).toEqual({ value: "237.50", currency: "USD" });
    expect(s.unpricedAssetCount).toBe(0);
    await expect(composite.getSnapshot({ addresses: [evmAddr], currency: "USD" })).rejects.toThrow(
      ChainError,
    );
  });

  it("labels testnet balances valued through the mainnet-price proxy", async () => {
    const solana = createSolanaPortfolioProvider({
      heliusApiKey: "k",
      network: "solana-devnet",
      rpcUrl: "https://x",
      fetch: fixtureFetch({
        rpc: {
          getAssetsByOwner: {
            ...DAS_RESPONSE,
            items: [],
            nativeBalance: { lamports: 2_000_000_000 },
          },
        },
      }),
      sleep: noSleep,
      now: NOW,
    });
    const composite = createCompositePortfolioProvider({
      byNetwork: { "solana-devnet": solana },
      priceProvider: {
        getPrices: ({ assetIds }) =>
          Promise.resolve({
            simulated: false,
            prices: Object.fromEntries(
              assetIds.map((id) => [
                id,
                {
                  assetId: id,
                  price: { value: "150", currency: "USD" },
                  asOf: NOW().toISOString(),
                  source: "jupiter-price-v3+testnet-proxy",
                  simulated: false,
                },
              ]),
            ),
          }),
      },
      now: NOW,
    });
    const s = await composite.getSnapshot({ addresses: [solAddr], currency: "USD" });
    expect(PortfolioSnapshotSchema.parse(s).balances[0]?.priceBasis).toBe("mainnet_proxy");
    expect(s.totalValue.value).toBe("300.00");
  });

  it("mock portfolio is labelled simulated", async () => {
    const s = await new MockPortfolioProvider(new MockPriceProvider(NOW), NOW).getSnapshot({
      addresses: [solAddr, evmAddr],
      currency: "USD",
    });
    expect(s.simulated).toBe(true);
    expect(s.totalValue.value).toBe("4725.00");
  });
});
