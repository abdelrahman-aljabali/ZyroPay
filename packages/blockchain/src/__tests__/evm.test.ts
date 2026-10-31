import { tokenAssetId } from "@zyropay/shared";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import {
  decodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  serializeTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  assertSignedMatchesUnsigned,
  createEvmBroadcaster,
  normalizeSignedTransaction,
  txHashOfSigned,
} from "../broadcast";
import { createConfirmationTracker } from "../confirmation";
import { ChainError } from "../errors";
import { createEvmTransactionBuilder } from "../evm/builder";
import { fixtureFetch, HttpReply, noSleep, RpcErrorReply } from "../testing";
import { EVM_FROM, EVM_TO, payload, SEPOLIA_USDC, TEST_PRIVATE_KEY } from "./fixtures";

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function evmRpc(
  overrides: Record<string, unknown> = {},
  chainId = "0xaa36a7",
): Record<string, unknown> {
  return {
    eth_chainId: chainId,
    eth_getCode: "0x6080604052",
    eth_call: (params: unknown) => {
      const [call] = params as [{ data?: string; to: string }];
      const data = call.data ?? "0x";
      if (data.startsWith("0x313ce567")) return word(6n); // decimals()
      if (data.startsWith("0xa9059cbb")) return word(1n); // transfer() -> true
      if (data.startsWith("0x49948e0e")) return word(50_000_000_000n); // getL1Fee(bytes)
      return "0x";
    },
    eth_estimateGas: (params: unknown) => {
      const data = (params as [{ data?: string }])[0].data;
      return data !== undefined && data !== "0x" ? "0xfde8" : "0x5208";
    },
    eth_feeHistory: {
      oldestBlock: "0x10",
      baseFeePerGas: [
        "0x3b9aca00",
        "0x3b9aca00",
        "0x3b9aca00",
        "0x3b9aca00",
        "0x3b9aca00",
        "0x3b9aca00",
      ],
      gasUsedRatio: [0.5, 0.5, 0.5, 0.5, 0.5],
      reward: [["0x5f5e100"], ["0x5f5e100"], ["0x5f5e100"], ["0x5f5e100"], ["0x5f5e100"]],
    },
    eth_getTransactionCount: "0x7",
    ...overrides,
  };
}

function builder(
  rpc: Record<string, unknown>,
  network: "ethereum-sepolia" | "base-sepolia" = "ethereum-sepolia",
) {
  return createEvmTransactionBuilder({
    rpcUrl: "https://sepolia.example",
    network,
    fetch: fixtureFetch({ rpc }),
    sleep: noSleep,
  });
}

const erc20Payload = () =>
  payload({
    network: "ethereum-sepolia",
    asset: { id: tokenAssetId("ethereum-sepolia", SEPOLIA_USDC), kind: "erc20", decimals: 6 },
    amount: "1500000",
  });

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

describe("EVM transaction builder", () => {
  it("builds an unsigned EIP-1559 native transfer bound to the chain id", async () => {
    const p = payload({ network: "ethereum-sepolia" });
    const tx = await builder(evmRpc()).buildTransfer(p);
    const parsed = parseTransaction(tx.serialized as Hex);
    expect(parsed.type).toBe("eip1559");
    expect(parsed.chainId).toBe(11155111);
    expect(parsed.nonce).toBe(7);
    expect(parsed.to).toBe(EVM_TO.toLowerCase());
    expect(parsed.value).toBe(1000000n);
    // gas 21000 * 1.2 = 25200; maxFee = 2*1 gwei + 0.1 gwei
    expect(parsed.gas).toBe(25200n);
    expect(parsed.maxPriorityFeePerGas).toBe(100_000_000n);
    expect(parsed.maxFeePerGas).toBe(2_100_000_000n);
    expect(tx.estimatedFee).toBe((25200n * 2_100_000_000n).toString());
    expect(tx.l1DataFee).toBe("0");
    expect(tx.validUntil).toBeNull();
    expect(parsed.r).toBeUndefined();
  });

  it("builds an ERC-20 transfer and verify catches every substitution", async () => {
    const b = builder(evmRpc());
    const p = erc20Payload();
    const tx = await b.buildTransfer(p);
    const parsed = parseTransaction(tx.serialized as Hex) as TransactionSerializableEIP1559;
    expect(parsed.to).toBe(SEPOLIA_USDC.toLowerCase());
    expect(parsed.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: parsed.data ?? "0x" });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([EVM_TO, 1500000n]);
    await expect(b.verifyMatchesPayload(tx.serialized, "hex", p)).resolves.toEqual({ ok: true });

    const swappedRecipient = serializeTransaction({
      ...parsed,
      type: "eip1559",
      data: (parsed.data ?? "0x").replace(
        EVM_TO.slice(2).toLowerCase(),
        EVM_FROM.slice(2).toLowerCase(),
      ) as Hex,
    });
    expect((await b.verifyMatchesPayload(swappedRecipient, "hex", p)).ok).toBe(false);
    const otherChain = serializeTransaction({ ...parsed, type: "eip1559", chainId: 1 });
    expect((await b.verifyMatchesPayload(otherChain, "hex", p)).ok).toBe(false);
    const trailing = serializeTransaction({
      ...parsed,
      type: "eip1559",
      data: `${parsed.data ?? "0x"}00`,
    });
    expect((await b.verifyMatchesPayload(trailing, "hex", p)).ok).toBe(false);
    const expensive = serializeTransaction({
      ...parsed,
      type: "eip1559",
      maxFeePerGas: 10n ** 15n,
    });
    expect((await b.verifyMatchesPayload(expensive, "hex", p)).ok).toBe(false);
    expect(
      (await b.verifyMatchesPayload(tx.serialized, "hex", payload({ network: "ethereum-sepolia" })))
        .ok,
    ).toBe(false);
  });

  it("rejects decimals mismatch, wrong chain RPC and cross-network payloads", async () => {
    await expectCode(
      builder(evmRpc()).buildTransfer({
        ...erc20Payload(),
        asset: { ...erc20Payload().asset, decimals: 18 },
      }),
      "DECIMALS_MISMATCH",
    );
    await expectCode(
      builder(evmRpc({}, "0x1")).buildTransfer(payload({ network: "ethereum-sepolia" })),
      "NETWORK_MODE_MISMATCH",
    );
    await expectCode(
      builder(evmRpc()).buildTransfer(payload({ network: "base-sepolia" })),
      "NETWORK_MODE_MISMATCH",
    );
    await expect(
      builder(evmRpc()).buildTransfer(payload({ network: "solana-devnet" })),
    ).rejects.toThrow();
  });

  it("maps estimateGas insufficient funds and reverts", async () => {
    await expectCode(
      builder(
        evmRpc({ eth_estimateGas: new RpcErrorReply(-32000, "insufficient funds for transfer") }),
      ).buildTransfer(payload({ network: "ethereum-sepolia" })),
      "INSUFFICIENT_FUNDS",
    );
    await expectCode(
      builder(
        evmRpc({
          eth_call: (params: unknown) =>
            (params as [{ data: string }])[0].data.startsWith("0x313ce567")
              ? word(6n)
              : new RpcErrorReply(3, "execution reverted: ERC20: transfer amount exceeds balance"),
        }),
      ).buildTransfer(erc20Payload()),
      "INSUFFICIENT_FUNDS",
    );
  });

  it("fits maxFeePerGas under the fee cap, refuses caps below the network fee", async () => {
    const cap = (25200n * 1_500_000_000n).toString();
    const tx = await builder(evmRpc()).buildTransfer(
      payload({ network: "ethereum-sepolia", feeCap: cap }),
    );
    expect(BigInt(tx.estimatedFee)).toBeLessThanOrEqual(BigInt(cap));
    await expectCode(
      builder(evmRpc()).buildTransfer(payload({ network: "ethereum-sepolia", feeCap: "1000" })),
      "VALIDATION_FAILED",
    );
  });

  it("includes the OP-stack L1 data fee on Base", async () => {
    const p = payload({ network: "base-sepolia" });
    const tx = await builder(evmRpc({}, "0x14a34"), "base-sepolia").buildTransfer(p);
    expect(tx.l1DataFee).toBe(75_000_000_000n.toString()); // 50 gwei + 50% margin
    expect(BigInt(tx.estimatedFee)).toBe(25200n * 2_100_000_000n + 75_000_000_000n);
  });

  it("uses an explicit nonce and builds bumped replacements within the fee cap", async () => {
    const b = builder(evmRpc());
    const p = payload({ network: "ethereum-sepolia" });
    const tx = await b.buildTransfer(p, { nonce: 42 });
    expect(tx.nonce).toBe(42);
    const replacement = await b.buildReplacement(tx, p);
    const r = parseTransaction(replacement.serialized as Hex);
    expect(r.nonce).toBe(42);
    expect(r.maxFeePerGas).toBeGreaterThanOrEqual((2_100_000_000n * 11n) / 10n);
    await expectCode(
      b.buildReplacement(tx, payload({ network: "ethereum-sepolia", amount: "5" })),
      "PAYLOAD_HASH_MISMATCH",
    );
    const cancel = await b.buildCancellation({
      from: EVM_FROM,
      nonce: 42,
      minMaxFeePerGas: 3n * 10n ** 9n,
      minMaxPriorityFeePerGas: 10n ** 9n,
    });
    const c = parseTransaction(cancel.serialized);
    expect(c.to).toBe(EVM_FROM.toLowerCase());
    expect(c.value ?? 0n).toBe(0n);
  });
});

describe("EVM broadcaster and confirmations", () => {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);

  async function signedTx(chainId = 11155111) {
    const tx = await builder(evmRpc()).buildTransfer(payload({ network: "ethereum-sepolia" }));
    const parsed = parseTransaction(tx.serialized as Hex) as TransactionSerializableEIP1559;
    const signed = await account.signTransaction({ ...parsed, type: "eip1559", chainId });
    return { unsigned: tx.serialized, signed };
  }

  it("checks the signed tx equals the reviewed unsigned tx and the signer", async () => {
    const { unsigned, signed } = await signedTx();
    await expect(
      assertSignedMatchesUnsigned({ encoding: "hex", signed, unsigned, expectedSigner: EVM_FROM }),
    ).resolves.toBeUndefined();
    await expect(
      assertSignedMatchesUnsigned({ encoding: "hex", signed, unsigned, expectedSigner: EVM_TO }),
    ).rejects.toThrow(ChainError);
    const other = await builder(evmRpc()).buildTransfer(
      payload({ network: "ethereum-sepolia", amount: "2" }),
    );
    await expect(
      assertSignedMatchesUnsigned({ encoding: "hex", signed, unsigned: other.serialized }),
    ).rejects.toThrow(ChainError);
  });

  it("derives the tx hash from signed bytes and normalizes Turnkey's unprefixed hex", async () => {
    const { unsigned, signed } = await signedTx();
    const bare = signed.slice(2).toUpperCase();
    const network = "ethereum-sepolia" as const;
    expect(
      normalizeSignedTransaction({ network, signedTransaction: bare, encoding: "hex" }),
    ).toEqual({ signedTransaction: signed.toLowerCase(), encoding: "hex" });
    expect(txHashOfSigned({ network, signedTransaction: bare, encoding: "hex" })).toBe(
      keccak256(signed),
    );
    expect(() => txHashOfSigned({ network, signedTransaction: unsigned, encoding: "hex" })).toThrow(
      ChainError,
    );
    expect(() =>
      normalizeSignedTransaction({ network, signedTransaction: "AQID", encoding: "base64" }),
    ).toThrow(ChainError);
  });

  it("broadcasts, treats 'already known' as success and maps errors", async () => {
    const { signed } = await signedTx();
    const hash = keccak256(signed);
    const ok = createEvmBroadcaster({
      rpcUrl: "x",
      network: "ethereum-sepolia",
      fetch: fixtureFetch({ rpc: { eth_chainId: "0xaa36a7", eth_sendRawTransaction: hash } }),
      sleep: noSleep,
    });
    await expect(
      ok.broadcast({ network: "ethereum-sepolia", signedTransaction: signed, encoding: "hex" }),
    ).resolves.toEqual({ txHash: hash, simulated: false });
    const known = createEvmBroadcaster({
      rpcUrl: "x",
      network: "ethereum-sepolia",
      fetch: fixtureFetch({
        rpc: {
          eth_chainId: "0xaa36a7",
          eth_sendRawTransaction: new RpcErrorReply(-32000, "already known"),
        },
      }),
      sleep: noSleep,
    });
    await expect(
      known.broadcast({ network: "ethereum-sepolia", signedTransaction: signed, encoding: "hex" }),
    ).resolves.toEqual({ txHash: hash, simulated: false });
    const poor = createEvmBroadcaster({
      rpcUrl: "x",
      network: "ethereum-sepolia",
      fetch: fixtureFetch({
        rpc: {
          eth_chainId: "0xaa36a7",
          eth_sendRawTransaction: new RpcErrorReply(
            -32000,
            "insufficient funds for gas * price + value",
          ),
        },
      }),
      sleep: noSleep,
    });
    await expectCode(
      poor.broadcast({ network: "ethereum-sepolia", signedTransaction: signed, encoding: "hex" }),
      "INSUFFICIENT_FUNDS",
    );
    const nonce = createEvmBroadcaster({
      rpcUrl: "x",
      network: "ethereum-sepolia",
      fetch: fixtureFetch({
        rpc: {
          eth_chainId: "0xaa36a7",
          eth_sendRawTransaction: new RpcErrorReply(-32000, "nonce too low"),
          eth_getTransactionByHash: null,
        },
      }),
      sleep: noSleep,
    });
    await expectCode(
      nonce.broadcast({ network: "ethereum-sepolia", signedTransaction: signed, encoding: "hex" }),
      "BROADCAST_FAILED",
    );
    await expectCode(
      ok.broadcast({ network: "base-sepolia", signedTransaction: signed, encoding: "hex" }),
      "NETWORK_MODE_MISMATCH",
    );
    const { signed: mainnetSigned } = await signedTx(1);
    await expectCode(
      ok.broadcast({
        network: "ethereum-sepolia",
        signedTransaction: mainnetSigned,
        encoding: "hex",
      }),
      "NETWORK_MODE_MISMATCH",
    );
  });

  it("reports confirmations, reverts and replaced nonces", async () => {
    const receipt = {
      status: "0x1",
      blockNumber: "0x64",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3b9aca00",
    };
    const make = (rpc: Record<string, unknown>) =>
      createConfirmationTracker({
        networks: { "ethereum-sepolia": { rpcUrl: "x", confirmations: 3 } },
        fetch: fixtureFetch({ rpc: { eth_chainId: "0xaa36a7", ...rpc } }),
        sleep: noSleep,
      });
    const hash = `0x${"ab".repeat(32)}`;
    expect(
      (
        await make({ eth_getTransactionReceipt: receipt, eth_blockNumber: "0x65" }).track({
          network: "ethereum-sepolia",
          txHash: hash,
        })
      ).status,
    ).toBe("pending");
    const done = await make({ eth_getTransactionReceipt: receipt, eth_blockNumber: "0x66" }).track({
      network: "ethereum-sepolia",
      txHash: hash,
    });
    expect(done).toMatchObject({ status: "confirmed", confirmations: 3 });
    expect(
      (
        await make({
          eth_getTransactionReceipt: { ...receipt, status: "0x0" },
          eth_blockNumber: "0x70",
        }).track({ network: "ethereum-sepolia", txHash: hash })
      ).status,
    ).toBe("failed");
    const replaced = await make({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: null,
      eth_getTransactionCount: "0x9",
    }).track({ network: "ethereum-sepolia", txHash: hash, from: EVM_FROM, nonce: 7 });
    expect(replaced.status).toBe("replaced");
    const lost = await make({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: null,
      eth_getTransactionCount: "0x7",
    }).track({ network: "ethereum-sepolia", txHash: hash, from: EVM_FROM, nonce: 7 });
    expect(lost).toMatchObject({ status: "pending", rebroadcastSuggested: true });
  });

  it("retries 429 with backoff then surfaces RATE_LIMITED", async () => {
    const fetch = fixtureFetch({ rpc: { eth_chainId: new HttpReply(429, "slow down") } });
    const b = createEvmTransactionBuilder({
      rpcUrl: "x",
      network: "ethereum-sepolia",
      fetch,
      sleep: noSleep,
      maxRetries: 2,
    });
    await expectCode(b.getNonceState(EVM_FROM), "RATE_LIMITED");
    expect(fetch.calls).toHaveLength(3);
  });
});
