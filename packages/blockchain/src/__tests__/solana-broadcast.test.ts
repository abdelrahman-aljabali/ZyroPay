import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  assertSignedMatchesUnsigned,
  createSolanaBroadcaster,
  normalizeSignedTransaction,
  solanaSignatureOf,
  txHashOfSigned,
} from "../broadcast";
import { createConfirmationTracker } from "../confirmation";
import { ChainError } from "../errors";
import { createSolanaTransactionBuilder } from "../solana/builder";
import { fixtureFetch, noSleep, RpcErrorReply } from "../testing";
import { payload, solanaRpcFixtures } from "./fixtures";

async function signedTransfer() {
  const signer = await generateKeyPairSigner();
  const from = signer.address;
  const b = createSolanaTransactionBuilder({
    rpcUrl: "x",
    network: "solana-devnet",
    fetch: fixtureFetch({ rpc: solanaRpcFixtures() }),
    sleep: noSleep,
  });
  const unsigned = await b.buildTransfer(payload({ network: "solana-devnet", from }));
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(unsigned.serialized));
  const [signatures] = await signer.signTransactions([
    tx as Parameters<typeof signer.signTransactions>[0][number],
  ]);
  const signed = getBase64EncodedWireTransaction({
    ...tx,
    signatures: { ...tx.signatures, ...signatures },
  });
  return { from: String(from), unsigned: unsigned.serialized, signed };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

describe("Solana broadcaster", () => {
  it("refuses unsigned transactions and derives the signature locally", async () => {
    const { unsigned, signed } = await signedTransfer();
    expect(() => solanaSignatureOf(unsigned)).toThrow(ChainError);
    expect(solanaSignatureOf(signed)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });

  it("checks the signed bytes are the reviewed message", async () => {
    const { from, unsigned, signed } = await signedTransfer();
    await expect(
      assertSignedMatchesUnsigned({ encoding: "base64", signed, unsigned, expectedSigner: from }),
    ).resolves.toBeUndefined();
    const other = await signedTransfer();
    await expect(
      assertSignedMatchesUnsigned({ encoding: "base64", signed, unsigned: other.unsigned }),
    ).rejects.toThrow(ChainError);
  });

  it("accepts Turnkey's hex-encoded signed transaction and derives the same signature", async () => {
    const { signed } = await signedTransfer();
    const hex = Buffer.from(signed, "base64").toString("hex");
    const network = "solana-devnet" as const;
    expect(
      normalizeSignedTransaction({ network, signedTransaction: hex, encoding: "hex" }),
    ).toEqual({ signedTransaction: signed, encoding: "base64" });
    expect(txHashOfSigned({ network, signedTransaction: hex, encoding: "hex" })).toBe(
      solanaSignatureOf(signed),
    );
    expect(() =>
      normalizeSignedTransaction({ network, signedTransaction: "zz", encoding: "hex" }),
    ).toThrow(ChainError);
    const sig = solanaSignatureOf(signed);
    const sent: unknown[] = [];
    const broadcaster = createSolanaBroadcaster({
      rpcUrl: "x",
      network,
      fetch: fixtureFetch({
        rpc: {
          getGenesisHash: solanaRpcFixtures().getGenesisHash,
          sendTransaction: (params: unknown) => {
            sent.push(params);
            return sig;
          },
        },
      }),
      sleep: noSleep,
    });
    await expect(
      broadcaster.broadcast({ network, signedTransaction: `0x${hex}`, encoding: "hex" }),
    ).resolves.toEqual({ txHash: sig, simulated: false });
    // The RPC receives base64, never the hex Turnkey returned.
    expect(JSON.stringify(sent)).toContain(signed);
    expect(JSON.stringify(sent)).not.toContain(hex);
  });

  it("broadcasts idempotently and maps errors", async () => {
    const { signed } = await signedTransfer();
    const sig = solanaSignatureOf(signed);
    const make = (send: unknown) =>
      createSolanaBroadcaster({
        rpcUrl: "x",
        network: "solana-devnet",
        fetch: fixtureFetch({
          rpc: { getGenesisHash: solanaRpcFixtures().getGenesisHash, sendTransaction: send },
        }),
        sleep: noSleep,
      });
    const input = {
      network: "solana-devnet" as const,
      signedTransaction: signed,
      encoding: "base64" as const,
    };
    await expect(make(sig).broadcast(input)).resolves.toEqual({ txHash: sig, simulated: false });
    await expect(
      make(
        new RpcErrorReply(
          -32002,
          "Transaction simulation failed: This transaction has already been processed",
        ),
      ).broadcast(input),
    ).resolves.toEqual({ txHash: sig, simulated: false });
    await expectCode(
      make(
        new RpcErrorReply(-32002, "Transaction simulation failed: Blockhash not found"),
      ).broadcast(input),
      "BROADCAST_FAILED",
    );
    await expectCode(
      make(
        new RpcErrorReply(
          -32002,
          "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
          { err: "AccountNotFound" },
        ),
      ).broadcast(input),
      "INSUFFICIENT_FUNDS",
    );
    await expectCode(
      make(new RpcErrorReply(-32002, "insufficient lamports 10, need 5000")).broadcast(input),
      "INSUFFICIENT_FUNDS",
    );
    await expectCode(
      make(sig).broadcast({ ...input, network: "solana-mainnet" }),
      "NETWORK_MODE_MISMATCH",
    );
  });

  it("tracks commitment and expires transactions past lastValidBlockHeight", async () => {
    const tracker = (statuses: unknown[], height = 100) =>
      createConfirmationTracker({
        networks: { "solana-devnet": { rpcUrl: "x", commitment: "confirmed" } },
        fetch: fixtureFetch({
          rpc: {
            getGenesisHash: solanaRpcFixtures().getGenesisHash,
            getSignatureStatuses: () => ({ context: { slot: 1 }, value: statuses }),
            getBlockHeight: height,
          },
        }),
        sleep: noSleep,
      });
    const txHash = "5".repeat(64);
    expect(
      (
        await tracker([
          { slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" },
        ]).track({ network: "solana-devnet", txHash })
      ).status,
    ).toBe("pending");
    expect(
      (
        await tracker([
          { slot: 1, confirmations: 5, err: null, confirmationStatus: "confirmed" },
        ]).track({ network: "solana-devnet", txHash })
      ).status,
    ).toBe("confirmed");
    expect(
      (
        await tracker([
          { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" },
        ]).track({ network: "solana-devnet", txHash })
      ).confirmations,
    ).toBe(32);
    expect(
      (
        await tracker([
          {
            slot: 1,
            confirmations: 3,
            err: { InstructionError: [0, "Custom"] },
            confirmationStatus: "confirmed",
          },
        ]).track({ network: "solana-devnet", txHash })
      ).status,
    ).toBe("failed");
    expect(
      (
        await tracker([null], 100).track({
          network: "solana-devnet",
          txHash,
          lastValidBlockHeight: "150",
        })
      ).status,
    ).toBe("pending");
    expect(
      (
        await tracker([null], 151).track({
          network: "solana-devnet",
          txHash,
          lastValidBlockHeight: "150",
        })
      ).status,
    ).toBe("expired");
    await expect(tracker([null]).track({ network: "ethereum-sepolia", txHash })).rejects.toThrow(
      ChainError,
    );
  });
});
