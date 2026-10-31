import { findAssociatedTokenPda } from "@solana-program/token";
import { address } from "@solana/kit";
import { payloadHash } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ChainError } from "../errors";
import { createSolanaTransactionBuilder } from "../solana/builder";
import { decodeSolanaTransaction } from "../solana/decode";
import { readComputeBudget } from "../solana/compute-budget";
import { fixtureFetch, noSleep, SOLANA_MAINNET_GENESIS } from "../testing";
import {
  BLOCKHASH,
  BLOCKHASH_2,
  DEVNET_USDC,
  payload,
  SOL_FROM,
  SOL_TO,
  solanaRpcFixtures,
  splPayload,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./fixtures";

const NOW = () => new Date("2026-10-30T12:00:00.000Z");

function builder(rpc: Record<string, unknown>) {
  const fetch = fixtureFetch({ rpc });
  return {
    fetch,
    b: createSolanaTransactionBuilder({
      rpcUrl: "https://devnet.example/rpc",
      network: "solana-devnet",
      fetch,
      sleep: noSleep,
      now: NOW,
    }),
  };
}

async function atas(program = TOKEN_PROGRAM) {
  const tokenProgram = address(program);
  const mint = address(DEVNET_USDC);
  const [source] = await findAssociatedTokenPda({ owner: address(SOL_FROM), mint, tokenProgram });
  const [destination] = await findAssociatedTokenPda({
    owner: address(SOL_TO),
    mint,
    tokenProgram,
  });
  return { source: String(source), destination: String(destination) };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof ChainError && e.code === code,
  );
}

describe("Solana transaction builder", () => {
  it("builds a native SOL transfer with compute budget and verifies it", async () => {
    const { b } = builder(solanaRpcFixtures({ unitsConsumed: 450, fees: [0, 0, 1000, 3000] }));
    const p = payload({ network: "solana-devnet" });
    const tx = await b.buildTransfer(p);
    expect(tx.family).toBe("solana");
    expect(tx.encoding).toBe("base64");
    expect(tx.simulated).toBe(false);
    expect(tx.payloadHash).toBe(payloadHash(p));
    expect(tx.blockhash).toBe(BLOCKHASH);
    // 450 units + 20% + 300 = 840; price = 75th percentile of [0,0,1000,3000] = 3000
    expect(tx.computeUnitLimit).toBe(840);
    expect(tx.microLamportsPerCu).toBe("3000");
    expect(tx.estimatedFee).toBe((5000n + 3n).toString()); // ceil(840*3000/1e6)=3
    expect(tx.rentDeposit).toBe("0");
    expect(tx.validUntil).not.toBeNull();

    const decoded = decodeSolanaTransaction(tx.serialized);
    expect(decoded.feePayer).toBe(SOL_FROM);
    expect(decoded.lifetimeToken).toBe(BLOCKHASH);
    expect(decoded.usesLookupTables).toBe(false);
    expect(decoded.signatures.every((s) => s.signature === null)).toBe(true);
    const budget = readComputeBudget(decoded.instructions);
    expect(budget.otherInstructions).toHaveLength(1);

    await expect(b.verifyMatchesPayload(tx.serialized, "base64", p)).resolves.toEqual({ ok: true });
  });

  it("verifyMatchesPayload rejects any material difference", async () => {
    const { b } = builder(solanaRpcFixtures());
    const p = payload({ network: "solana-devnet" });
    const tx = await b.buildTransfer(p);
    for (const tampered of [
      payload({ network: "solana-devnet", amount: "1000001" }),
      payload({ network: "solana-devnet", to: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" }),
      payload({ network: "solana-devnet", from: SOL_TO, to: SOL_FROM }),
      payload({ network: "solana-devnet", feeCap: "5000" }),
    ]) {
      const result = await b.verifyMatchesPayload(tx.serialized, "base64", tampered);
      expect(result.ok).toBe(false);
    }
    expect((await b.verifyMatchesPayload(tx.serialized, "hex", p)).ok).toBe(false);
    expect((await b.verifyMatchesPayload("not-a-transaction", "base64", p)).ok).toBe(false);
  });

  it("builds an SPL TransferChecked and creates the recipient ATA when missing", async () => {
    const { source, destination } = await atas();
    const { b } = builder(
      solanaRpcFixtures({ existing: { [source]: TOKEN_PROGRAM }, unitsConsumed: 30000 }),
    );
    const p = splPayload();
    const tx = await b.buildTransfer(p);
    expect(tx.createsRecipientTokenAccount).toBe(true);
    expect(tx.rentDeposit).toBe("2039280");
    const decoded = decodeSolanaTransaction(tx.serialized);
    const others = readComputeBudget(decoded.instructions).otherInstructions;
    expect(others.map((i) => i.programAddress)).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      TOKEN_PROGRAM,
    ]);
    expect(others[1]?.accounts.map((a) => a.address)).toContain(destination);
    await expect(b.verifyMatchesPayload(tx.serialized, "base64", p)).resolves.toEqual({ ok: true });
    // Same bytes claimed as a different mint/decimals fail.
    const wrong = splPayload({
      asset: { id: `solana-devnet:${SOL_TO}`, kind: "spl", decimals: 6 },
    });
    expect((await b.verifyMatchesPayload(tx.serialized, "base64", wrong)).ok).toBe(false);
  });

  it("skips ATA creation when the recipient account exists; supports Token-2022", async () => {
    const { source, destination } = await atas(TOKEN_2022_PROGRAM);
    const { b } = builder(
      solanaRpcFixtures({
        existing: { [source]: TOKEN_2022_PROGRAM, [destination]: TOKEN_2022_PROGRAM },
        mint: {
          program: TOKEN_2022_PROGRAM,
          extensions: [
            {
              extension: "transferFeeConfig",
              state: {
                olderTransferFee: { transferFeeBasisPoints: 0 },
                newerTransferFee: { transferFeeBasisPoints: 0 },
              },
            },
          ],
        },
      }),
    );
    const tx = await b.buildTransfer(splPayload());
    expect(tx.createsRecipientTokenAccount).toBe(false);
    const others = readComputeBudget(
      decodeSolanaTransaction(tx.serialized).instructions,
    ).otherInstructions;
    expect(others.map((i) => i.programAddress)).toEqual([TOKEN_2022_PROGRAM]);
  });

  it("refuses Token-2022 mints with a transfer fee or hook", async () => {
    const { source } = await atas(TOKEN_2022_PROGRAM);
    for (const extensions of [
      [
        {
          extension: "transferFeeConfig",
          state: {
            olderTransferFee: { transferFeeBasisPoints: 0 },
            newerTransferFee: { transferFeeBasisPoints: 50 },
          },
        },
      ],
      [{ extension: "transferHook", state: { programId: SOL_TO, authority: null } }],
      [{ extension: "nonTransferable", state: {} }],
    ]) {
      const { b } = builder(
        solanaRpcFixtures({
          existing: { [source]: TOKEN_2022_PROGRAM },
          mint: { program: TOKEN_2022_PROGRAM, extensions },
        }),
      );
      await expectCode(b.buildTransfer(splPayload()), "VALIDATION_FAILED");
    }
  });

  it("rejects decimals mismatch, unknown mints and token-account recipients", async () => {
    const { source } = await atas();
    await expectCode(
      builder(solanaRpcFixtures({ mint: { decimals: 9 } })).b.buildTransfer(splPayload()),
      "DECIMALS_MISMATCH",
    );
    await expectCode(
      builder(solanaRpcFixtures({ mint: null })).b.buildTransfer(splPayload()),
      "VALIDATION_FAILED",
    );
    await expectCode(
      builder(
        solanaRpcFixtures({ existing: { [source]: TOKEN_PROGRAM, [SOL_TO]: TOKEN_PROGRAM } }),
      ).b.buildTransfer(splPayload()),
      "INVALID_ADDRESS",
    );
    await expectCode(
      builder(solanaRpcFixtures()).b.buildTransfer(splPayload()),
      "INSUFFICIENT_FUNDS",
    );
  });

  it("never switches networks: mainnet payload, EVM payload and wrong-cluster RPC are refused", async () => {
    await expectCode(
      builder(solanaRpcFixtures()).b.buildTransfer(payload({ network: "solana-mainnet" })),
      "NETWORK_MODE_MISMATCH",
    );
    await expect(
      builder(solanaRpcFixtures()).b.buildTransfer(payload({ network: "base-sepolia" })),
    ).rejects.toThrow();
    await expectCode(
      builder(solanaRpcFixtures({ genesis: SOLANA_MAINNET_GENESIS })).b.buildTransfer(
        payload({ network: "solana-devnet" }),
      ),
      "NETWORK_MODE_MISMATCH",
    );
    expect(() => createSolanaTransactionBuilder({ rpcUrl: "x", network: "base-mainnet" })).toThrow(
      ChainError,
    );
  });

  it("maps simulation failures to INSUFFICIENT_FUNDS", async () => {
    const { b } = builder(
      solanaRpcFixtures({ simulateErr: { InstructionError: [2, { Custom: 1 }] } }),
    );
    await expectCode(b.buildTransfer(payload({ network: "solana-devnet" })), "INSUFFICIENT_FUNDS");
    const { b: b2 } = builder(solanaRpcFixtures({ simulateErr: "AccountNotFound" }));
    await expectCode(b2.buildTransfer(payload({ network: "solana-devnet" })), "INSUFFICIENT_FUNDS");
  });

  it("fits the priority fee under the payload fee cap and refuses caps below the base fee", async () => {
    const { b } = builder(solanaRpcFixtures({ unitsConsumed: 100000, fees: [2_000_000] }));
    const tx = await b.buildTransfer(payload({ network: "solana-devnet", feeCap: "10000" }));
    expect(BigInt(tx.estimatedFee)).toBeLessThanOrEqual(10000n);
    await expectCode(
      builder(solanaRpcFixtures()).b.buildTransfer(
        payload({ network: "solana-devnet", feeCap: "4999" }),
      ),
      "VALIDATION_FAILED",
    );
  });

  it("refuses expired payloads", async () => {
    await expectCode(
      builder(solanaRpcFixtures()).b.buildTransfer(
        payload({ network: "solana-devnet", expiresAt: "2020-01-01T00:00:00.000Z" }),
      ),
      "REQUEST_EXPIRED",
    );
  });

  it("rebuilds near blockhash expiry with the same payloadHash (ADR-001 D4)", async () => {
    const { b } = builder(
      solanaRpcFixtures({
        blockhashes: [BLOCKHASH, BLOCKHASH_2],
        blockHeight: [1000, 1100, 1140, 1141],
      }),
    );
    const p = payload({ network: "solana-devnet" });
    const first = await b.buildTransfer(p);
    // height 1100, lastValid 1151: 51 blocks left -> no rebuild
    const keep = await b.rebuildIfExpiring(first, p);
    expect(keep.rebuilt).toBe(false);
    // height 1140: 11 left -> rebuild
    const again = await b.rebuildIfExpiring(first, p);
    expect(again.rebuilt).toBe(true);
    expect(again.transaction.blockhash).toBe(BLOCKHASH_2);
    expect(again.transaction.payloadHash).toBe(first.payloadHash);
    expect(again.transaction.serialized).not.toBe(first.serialized);
  });

  it("estimates fees before a payload exists", async () => {
    const { b } = builder(solanaRpcFixtures({ unitsConsumed: 450, fees: [10000] }));
    const p = payload({ network: "solana-devnet" });
    const est = await b.estimateTransferFee(p);
    expect(BigInt(est.recommendedFeeCap)).toBeGreaterThan(BigInt(est.estimatedFee));
  });
});
