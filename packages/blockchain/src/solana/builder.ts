import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  identifySystemInstruction,
  parseTransferSolInstruction,
  SystemInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import {
  AssociatedTokenInstruction,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  identifyAssociatedTokenInstruction,
  identifyTokenInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
  TokenInstruction,
} from "@solana-program/token";
import type { Instruction } from "@solana/kit";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type {
  BaseUnitAmount,
  CanonicalTransactionPayload,
  NetworkId,
  TransactionBuilder,
  UnsignedTransaction,
} from "@zyropay/shared";
import {
  CanonicalTransactionPayloadSchema,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
} from "@zyropay/shared";
import { ChainError, isChainError } from "../errors";
import type { HttpOptions } from "../http";
import { assertAddress, assertFamily, assertSameNetwork } from "../networks";
import { maxNetworkFee, percentileFee, readComputeBudget } from "./compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  MAX_COMPUTE_UNIT_LIMIT,
  SYSTEM_PROGRAM,
  TOKEN_2022_ATA_SIZE,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM,
  token2022TransferBlocker,
} from "./constants";
import { decodeSolanaTransaction } from "./decode";
import { SolanaRpc } from "./rpc";

export interface SolanaTransactionBuilderConfig extends HttpOptions {
  readonly rpcUrl: string;
  readonly network: NetworkId;
  /** Ceiling for the compute-unit price, micro-lamports per CU. Default 2_000_000 (2 lamports). */
  readonly maxMicroLamportsPerCu?: bigint;
  /** Floor for the compute-unit price. Default 0. */
  readonly minMicroLamportsPerCu?: bigint;
  /** Percentile of recent prioritization fees to pay. Default 75. */
  readonly priorityFeePercentile?: number;
  /** Extra compute units over the simulated amount, basis points. Default 2000 (20%). */
  readonly computeUnitMarginBps?: number;
  /** Seconds per slot used to turn lastValidBlockHeight into a timestamp. Default 0.4. */
  readonly secondsPerBlock?: number;
  readonly now?: () => Date;
}

/** A Solana unsigned transaction plus the facts the review screen and rebuild logic need. */
export interface SolanaUnsignedTransaction extends UnsignedTransaction {
  readonly family: "solana";
  readonly encoding: "base64";
  readonly blockhash: string;
  readonly lastValidBlockHeight: string;
  readonly computeUnitLimit: number;
  readonly microLamportsPerCu: string;
  /**
   * Lamports locked as rent when the transaction creates the recipient's token account. Paid
   * by the sender in addition to `estimatedFee` and the amount; not part of the network fee.
   */
  readonly rentDeposit: BaseUnitAmount;
  readonly createsRecipientTokenAccount: boolean;
}

export interface TransferFeeEstimate {
  /** Network fee the built transaction is expected to pay, lamports. */
  readonly estimatedFee: BaseUnitAmount;
  /** Suggested `feeCap` for the payload: the estimate with headroom (2x, min +10k lamports). */
  readonly recommendedFeeCap: BaseUnitAmount;
  readonly rentDeposit: BaseUnitAmount;
}

export interface SolanaTransactionBuilder extends TransactionBuilder<"solana"> {
  readonly network: NetworkId;
  buildTransfer(payload: CanonicalTransactionPayload): Promise<SolanaUnsignedTransaction>;
  /** Fee estimate for a transfer before the payload (and its feeCap) is fixed. */
  estimateTransferFee(
    input: Omit<CanonicalTransactionPayload, "feeCap" | "nonce" | "idempotencyKey" | "expiresAt">,
  ): Promise<TransferFeeEstimate>;
  /**
   * ADR-001 D4: if the stored transaction's blockhash expires within `minRemainingBlocks`
   * (default 40, about 16 s), rebuild it from the same payload. The payloadHash never covers
   * the blockhash, so the rebuilt transaction carries the same hash; this is asserted.
   */
  rebuildIfExpiring(
    stored: SolanaUnsignedTransaction,
    payload: CanonicalTransactionPayload,
    options?: { minRemainingBlocks?: number },
  ): Promise<{ rebuilt: boolean; transaction: SolanaUnsignedTransaction }>;
  /** True while the blockhash in `lastValidBlockHeight` can still land. */
  isBlockhashValid(lastValidBlockHeight: string): Promise<boolean>;
}

interface ResolvedTransfer {
  readonly instructions: Instruction[];
  readonly writableAccounts: string[];
  readonly rentDeposit: bigint;
  readonly createsAta: boolean;
}

const DEFAULT_MAX_PRICE = 2_000_000n;

export function createSolanaTransactionBuilder(
  config: SolanaTransactionBuilderConfig,
): SolanaTransactionBuilder {
  assertFamily(config.network, "solana");
  const rpc = new SolanaRpc(config);
  const now = config.now ?? (() => new Date());
  const maxPrice = config.maxMicroLamportsPerCu ?? DEFAULT_MAX_PRICE;
  const minPrice = config.minMicroLamportsPerCu ?? 0n;
  const percentile = config.priorityFeePercentile ?? 75;
  const marginBps = BigInt(config.computeUnitMarginBps ?? 2000);
  const secondsPerBlock = config.secondsPerBlock ?? 0.4;

  type TransferInput = Pick<
    CanonicalTransactionPayload,
    "network" | "from" | "to" | "asset" | "amount"
  >;

  function validateTransferInput(input: TransferInput): void {
    assertSameNetwork(config.network, input.network);
    assertAddress(input.network, input.from, "from");
    assertAddress(input.network, input.to, "to");
    if (parseAssetId(input.asset.id).network !== input.network) {
      throw new ChainError("NETWORK_MODE_MISMATCH", "asset is on a different network");
    }
    if (parseBaseUnits(input.amount) === 0n) {
      throw new ChainError("VALIDATION_FAILED", "amount must be greater than zero");
    }
    if (input.asset.kind === "erc20") {
      throw new ChainError("VALIDATION_FAILED", "erc20 assets cannot be sent on Solana");
    }
  }

  async function resolveTransfer(input: TransferInput): Promise<ResolvedTransfer> {
    const from = address(input.from);
    const to = address(input.to);
    const amount = parseBaseUnits(input.amount);
    if (input.asset.kind === "native") {
      return {
        instructions: [
          getTransferSolInstruction({ source: createNoopSigner(from), destination: to, amount }),
        ],
        writableAccounts: [input.from, input.to],
        rentDeposit: 0n,
        createsAta: false,
      };
    }
    const mintAddress = parseAssetId(input.asset.id).tokenAddress;
    if (mintAddress === null) throw new ChainError("VALIDATION_FAILED", "spl asset needs a mint");
    const mintInfo = await rpc.getMint(mintAddress);
    if (mintInfo === null) {
      throw new ChainError("VALIDATION_FAILED", "asset address is not an SPL token mint");
    }
    if (mintInfo.programId !== TOKEN_PROGRAM && mintInfo.programId !== TOKEN_2022_PROGRAM) {
      throw new ChainError("VALIDATION_FAILED", "mint is owned by an unknown token program");
    }
    if (mintInfo.decimals !== input.asset.decimals) {
      throw new ChainError(
        "DECIMALS_MISMATCH",
        `mint has ${mintInfo.decimals} decimals, request says ${input.asset.decimals}`,
      );
    }
    const blocker = token2022TransferBlocker(mintInfo.extensions);
    if (blocker !== null)
      throw new ChainError("VALIDATION_FAILED", `unsupported token: ${blocker}`);

    // The recipient must be a wallet (owner), never a token account: sending to the ATA of a
    // token account would strand the funds.
    const recipient = await rpc.getAccountOwner(input.to);
    if (
      recipient !== null &&
      (recipient.owner === TOKEN_PROGRAM || recipient.owner === TOKEN_2022_PROGRAM)
    ) {
      throw new ChainError(
        "INVALID_ADDRESS",
        "recipient is a token account; send to the owner's wallet address",
      );
    }
    const tokenProgram = address(mintInfo.programId);
    const mint = address(mintAddress);
    const [sourceAta] = await findAssociatedTokenPda({ owner: from, mint, tokenProgram });
    const [destinationAta] = await findAssociatedTokenPda({ owner: to, mint, tokenProgram });
    const source = await rpc.getAccountOwner(sourceAta);
    if (source === null) {
      throw new ChainError("INSUFFICIENT_FUNDS", "sender has no token account for this mint");
    }
    const destination = await rpc.getAccountOwner(destinationAta);
    const instructions: Instruction[] = [];
    let rentDeposit = 0n;
    if (destination === null) {
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: createNoopSigner(from),
          ata: destinationAta,
          owner: to,
          mint,
          tokenProgram,
        }),
      );
      rentDeposit = await rpc.getMinimumBalanceForRentExemption(
        tokenProgram === TOKEN_PROGRAM ? TOKEN_ACCOUNT_SIZE : TOKEN_2022_ATA_SIZE,
      );
    }
    instructions.push(
      getTransferCheckedInstruction(
        {
          source: sourceAta,
          mint,
          destination: destinationAta,
          authority: createNoopSigner(from),
          amount,
          decimals: input.asset.decimals,
        },
        { programAddress: tokenProgram },
      ),
    );
    return {
      instructions,
      writableAccounts: [input.from, sourceAta, destinationAta],
      rentDeposit,
      createsAta: destination === null,
    };
  }

  function compile(
    from: string,
    blockhash: { blockhash: string; lastValidBlockHeight: bigint },
    unitLimit: number,
    price: bigint,
    instructions: readonly Instruction[],
  ): string {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(from), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash.blockhash as Parameters<
              typeof setTransactionMessageLifetimeUsingBlockhash
            >[0]["blockhash"],
            lastValidBlockHeight: blockhash.lastValidBlockHeight,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: unitLimit }),
            getSetComputeUnitPriceInstruction({ microLamports: price }),
            ...instructions,
          ],
          m,
        ),
    );
    return getBase64EncodedWireTransaction(compileTransaction(message));
  }

  async function priorityPrice(accounts: readonly string[]): Promise<bigint> {
    const fees = await rpc.getRecentPrioritizationFees(accounts);
    let price = percentileFee(fees, percentile);
    if (price < minPrice) price = minPrice;
    if (price > maxPrice) price = maxPrice;
    return price;
  }

  /** Simulate with the max limit to measure units; returns the limit to use. */
  async function measureUnits(
    from: string,
    blockhash: { blockhash: string; lastValidBlockHeight: bigint },
    price: bigint,
    instructions: readonly Instruction[],
  ): Promise<number> {
    const probe = compile(from, blockhash, MAX_COMPUTE_UNIT_LIMIT, price, instructions);
    const sim = await rpc.simulate(probe, { replaceRecentBlockhash: true });
    if (sim.err !== null) throw simulationError(sim.err, sim.logs);
    const consumed = sim.unitsConsumed ?? 200_000n;
    const withMargin = consumed + (consumed * marginBps + 9_999n) / 10_000n + 300n;
    return Number(
      withMargin > BigInt(MAX_COMPUTE_UNIT_LIMIT) ? BigInt(MAX_COMPUTE_UNIT_LIMIT) : withMargin,
    );
  }

  async function estimate(input: TransferInput): Promise<{
    resolved: ResolvedTransfer;
    blockhash: { blockhash: string; lastValidBlockHeight: bigint };
    unitLimit: number;
    price: bigint;
  }> {
    validateTransferInput(input);
    const resolved = await resolveTransfer(input);
    const blockhash = await rpc.getLatestBlockhash("confirmed");
    const price = await priorityPrice(resolved.writableAccounts);
    const unitLimit = await measureUnits(input.from, blockhash, price, resolved.instructions);
    return { resolved, blockhash, unitLimit, price };
  }

  function toIso(lastValid: bigint, current: bigint): string {
    const blocks = lastValid > current ? Number(lastValid - current) : 0;
    return new Date(now().getTime() + Math.floor(blocks * secondsPerBlock * 1000)).toISOString();
  }

  const builder: SolanaTransactionBuilder = {
    family: "solana",
    network: config.network,

    async estimateTransferFee(input) {
      const { unitLimit, price, resolved } = await estimate(input);
      const fee = maxNetworkFee(1, unitLimit, price);
      const headroom = fee > 10_000n ? fee : 10_000n;
      return {
        estimatedFee: fee.toString(),
        recommendedFeeCap: (fee + headroom).toString(),
        rentDeposit: resolved.rentDeposit.toString(),
      };
    },

    async buildTransfer(rawPayload) {
      const payload = CanonicalTransactionPayloadSchema.parse(rawPayload);
      assertFamily(payload.network, "solana");
      if (Date.parse(payload.expiresAt) <= now().getTime()) {
        throw new ChainError("REQUEST_EXPIRED", "payload has expired");
      }
      const feeCap = parseBaseUnits(payload.feeCap);
      const { resolved, blockhash, unitLimit, price: wantedPrice } = await estimate(payload);

      // Fit the priority fee under the payload's fee cap. The base signature fee is fixed.
      let price = wantedPrice;
      if (maxNetworkFee(1, unitLimit, price) > feeCap) {
        const base = maxNetworkFee(1, 0, 0n);
        if (feeCap < base) {
          throw new ChainError(
            "VALIDATION_FAILED",
            `fee cap ${payload.feeCap} is below the base fee`,
          );
        }
        price = ((feeCap - base) * 1_000_000n) / BigInt(unitLimit);
      }
      const serialized = compile(payload.from, blockhash, unitLimit, price, resolved.instructions);

      // Final simulation of the exact bytes that will be signed (no blockhash replacement).
      const sim = await rpc.simulate(serialized, { replaceRecentBlockhash: false });
      if (sim.err !== null) throw simulationError(sim.err, sim.logs);

      const height = await rpc.getBlockHeight("confirmed");
      const verified = await builder.verifyMatchesPayload(serialized, "base64", payload);
      if (!verified.ok) {
        throw new ChainError(
          "INTERNAL_ERROR",
          `built transaction failed self-check: ${verified.reason}`,
        );
      }
      return {
        family: "solana",
        network: payload.network,
        payloadHash: payloadHash(payload),
        encoding: "base64",
        serialized,
        estimatedFee: maxNetworkFee(1, unitLimit, price).toString(),
        validUntil: toIso(blockhash.lastValidBlockHeight, height),
        simulated: false,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
        computeUnitLimit: unitLimit,
        microLamportsPerCu: price.toString(),
        rentDeposit: resolved.rentDeposit.toString(),
        createsRecipientTokenAccount: resolved.createsAta,
      };
    },

    verifyMatchesPayload(serialized, encoding, payload) {
      return Promise.resolve(verifySolanaTransfer(serialized, encoding, payload, config.network));
    },

    async isBlockhashValid(lastValidBlockHeight) {
      const height = await rpc.getBlockHeight("confirmed");
      return height <= BigInt(lastValidBlockHeight);
    },

    async rebuildIfExpiring(stored, payload, options = {}) {
      const minRemaining = BigInt(options.minRemainingBlocks ?? 40);
      const height = await rpc.getBlockHeight("confirmed");
      if (BigInt(stored.lastValidBlockHeight) - height > minRemaining) {
        return { rebuilt: false, transaction: stored };
      }
      const transaction = await builder.buildTransfer(payload);
      if (transaction.payloadHash !== stored.payloadHash) {
        throw new ChainError(
          "PAYLOAD_HASH_MISMATCH",
          "rebuilt transaction has a different payload",
        );
      }
      return { rebuilt: true, transaction };
    },
  };
  return builder;
}

/**
 * Independent decode of a Solana transfer (ADR-001 D2 step 3). Pure: no RPC. Checks that the
 * transaction does exactly what the payload says and nothing else:
 *  - fee payer and only signer is `payload.from`; no address lookup tables;
 *  - only ComputeBudget (limit/price), then either one System transfer (native) or an optional
 *    idempotent ATA creation plus one TransferChecked (SPL) with the derived ATAs;
 *  - worst-case network fee (signatures + unit limit x price) <= payload.feeCap.
 */
export async function verifySolanaTransferAsync(
  serialized: string,
  encoding: "base64" | "hex",
  payload: CanonicalTransactionPayload,
  network: NetworkId,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (encoding !== "base64") return { ok: false, reason: "Solana transactions are base64" };
    const p = CanonicalTransactionPayloadSchema.parse(payload);
    if (p.network !== network) return { ok: false, reason: "payload is for another network" };
    const tx = decodeSolanaTransaction(serialized);
    if (tx.usesLookupTables) return { ok: false, reason: "address lookup tables are not allowed" };
    if (tx.feePayer !== p.from) return { ok: false, reason: "fee payer is not the sender" };
    if (tx.numSigners !== 1) return { ok: false, reason: "transaction requires extra signers" };
    const budget = readComputeBudget(tx.instructions);
    const fee = maxNetworkFee(tx.numSigners, budget.unitLimit, budget.microLamportsPerCu);
    if (fee > parseBaseUnits(p.feeCap)) {
      return { ok: false, reason: `max network fee ${fee} exceeds fee cap ${p.feeCap}` };
    }
    const amount = parseBaseUnits(p.amount);
    const ixs = budget.otherInstructions;

    if (p.asset.kind === "native") {
      const [ix] = ixs;
      if (ixs.length !== 1 || ix === undefined || ix.programAddress !== SYSTEM_PROGRAM) {
        return { ok: false, reason: "expected exactly one System transfer" };
      }
      if (identifySystemInstruction(ix) !== SystemInstruction.TransferSol) {
        return { ok: false, reason: "System instruction is not a transfer" };
      }
      const parsed = parseTransferSolInstruction(ix);
      if (parsed.accounts.source.address !== p.from) return { ok: false, reason: "wrong source" };
      if (parsed.accounts.destination.address !== p.to)
        return { ok: false, reason: "wrong recipient" };
      if (parsed.data.amount !== amount) return { ok: false, reason: "wrong amount" };
      return { ok: true };
    }
    if (p.asset.kind !== "spl") return { ok: false, reason: "unsupported asset kind" };

    const mint = parseAssetId(p.asset.id).tokenAddress;
    const transferIx = ixs[ixs.length - 1];
    if (mint === null || transferIx === undefined) return { ok: false, reason: "no transfer" };
    const tokenProgram = transferIx.programAddress;
    if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) {
      return { ok: false, reason: "last instruction is not an SPL token transfer" };
    }
    if (identifyTokenInstruction(transferIx) !== TokenInstruction.TransferChecked) {
      return { ok: false, reason: "token instruction is not TransferChecked" };
    }
    const t = parseTransferCheckedInstruction(transferIx);
    const [sourceAta] = await findAssociatedTokenPda({
      owner: address(p.from),
      mint: address(mint),
      tokenProgram: tokenProgram,
    });
    const [destinationAta] = await findAssociatedTokenPda({
      owner: address(p.to),
      mint: address(mint),
      tokenProgram: tokenProgram,
    });
    if (t.accounts.mint.address !== mint) return { ok: false, reason: "wrong mint" };
    if (t.accounts.source.address !== sourceAta)
      return { ok: false, reason: "wrong source account" };
    if (t.accounts.destination.address !== destinationAta) {
      return { ok: false, reason: "destination is not the recipient's associated token account" };
    }
    if (t.accounts.authority.address !== p.from) return { ok: false, reason: "wrong authority" };
    if (t.data.amount !== amount) return { ok: false, reason: "wrong amount" };
    if (t.data.decimals !== p.asset.decimals) return { ok: false, reason: "wrong decimals" };

    if (ixs.length === 2) {
      const create = ixs[0];
      if (create?.programAddress !== ASSOCIATED_TOKEN_PROGRAM) {
        return { ok: false, reason: "unexpected instruction before the transfer" };
      }
      if (
        identifyAssociatedTokenInstruction(create) !==
        AssociatedTokenInstruction.CreateAssociatedTokenIdempotent
      ) {
        return { ok: false, reason: "only idempotent ATA creation is allowed" };
      }
      const c = parseCreateAssociatedTokenIdempotentInstruction(create);
      if (
        c.accounts.payer.address !== p.from ||
        c.accounts.ata.address !== destinationAta ||
        c.accounts.owner.address !== p.to ||
        c.accounts.mint.address !== mint ||
        c.accounts.tokenProgram.address !== tokenProgram
      ) {
        return { ok: false, reason: "ATA creation does not match the transfer" };
      }
    } else if (ixs.length !== 1) {
      return { ok: false, reason: "unexpected extra instructions" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cannot decode transaction: ${errorMessage(error)}` };
  }
}

function verifySolanaTransfer(
  serialized: string,
  encoding: "base64" | "hex",
  payload: CanonicalTransactionPayload,
  network: NetworkId,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return verifySolanaTransferAsync(serialized, encoding, payload, network);
}

function errorMessage(error: unknown): string {
  if (isChainError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "unknown error";
}

const INSUFFICIENT_ERRORS = new Set([
  "InsufficientFundsForFee",
  "InsufficientFundsForRent",
  "AccountNotFound",
]);

/** Map a simulation `err` to a ChainError with a shared code. */
export function simulationError(err: unknown, logs: readonly string[]): ChainError {
  const text = JSON.stringify(err);
  const insufficient =
    (typeof err === "string" && INSUFFICIENT_ERRORS.has(err)) ||
    (typeof err === "object" && err !== null && "InsufficientFundsForRent" in err) ||
    // Token program error 1 = InsufficientFunds; System error 1 = ResultWithNegativeLamports.
    /"Custom":1\}/.test(text) ||
    logs.some((l) => /insufficient (funds|lamports)/i.test(l));
  return new ChainError(
    insufficient ? "INSUFFICIENT_FUNDS" : "VALIDATION_FAILED",
    insufficient ? "insufficient funds for amount plus fees" : `simulation failed: ${text}`,
    { details: { simulationError: err, logs: logs.slice(-10) } },
  );
}
