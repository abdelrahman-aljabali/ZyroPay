import { findAssociatedTokenPda } from "@solana-program/token";
import {
  ChainError,
  decodeSolanaTransaction,
  isChainError,
  maxNetworkFee,
  readComputeBudget,
  requestJson,
  resolveHttpOptions,
  simulationError,
  SolanaRpc,
  solanaPrograms,
} from "@zyropay/blockchain";
import type { HttpOptions } from "@zyropay/blockchain";
import { address as toAddress } from "@solana/kit";
import type {
  CanonicalTransactionPayload,
  JsonObject,
  NetworkId,
  PluginAdapter,
  PluginQuote,
  UnsignedTransaction,
  VerificationResult,
} from "@zyropay/shared";
import {
  BaseUnitAmountSchema,
  CanonicalTransactionPayloadSchema,
  decimalToMinorUnits,
  isValidSolanaAddress,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
  SolanaAddressSchema,
} from "@zyropay/shared";
import { z } from "zod";
import {
  assertPayloadMatchesQuote,
  manifestFor,
  parseParams,
  runVerifier,
  toJsonObject,
} from "./common";

/** Jupiter v6 aggregator program. */
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** Anchor discriminators (sha256("global:<name>")[0..8]) of the ExactIn route instructions. */
const ROUTE_DISCRIMINATORS: ReadonlyMap<string, string> = new Map([
  ["e517cb977ae3ad2a", "route"],
  ["c1209b3341d69c81", "shared_accounts_route"],
]);
/** Absolute ceiling regardless of config (10%). The MCP schema already caps at 1000. */
export const JUPITER_MAX_SLIPPAGE_BPS = 1000;

export interface JupiterAdapter extends PluginAdapter {
  quote(input: { action: string; network: NetworkId; params: JsonObject }): Promise<JupiterQuote>;
  /** Independent decode of a swap this adapter built (base64 only). Never throws. */
  verifyTransaction(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
}

export interface JupiterAdapterConfig extends HttpOptions {
  /** JUPITER_API_KEY (x-api-key). Required: production traffic must not ride the keyless tier. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Solana mainnet RPC used to simulate the swap before handoff. */
  readonly rpcUrl: string;
  /** Slippage ceiling for requests. Default 100 (1%). */
  readonly maxSlippageBps?: number;
  /** Reject quotes whose price impact exceeds this. Default 100 (1%). */
  readonly maxPriceImpactBps?: number;
  /** Max priority fee Jupiter may add, lamports. Default 200_000. */
  readonly maxPriorityFeeLamports?: number;
  /** Quote validity window. Default 30 s. */
  readonly quoteTtlSeconds?: number;
  readonly now?: () => Date;
}

const SwapParamsSchema = z.strictObject({
  inputMint: SolanaAddressSchema,
  outputMint: SolanaAddressSchema,
  amount: BaseUnitAmountSchema,
  slippageBps: z.number().int().min(1).max(JUPITER_MAX_SLIPPAGE_BPS),
  userPublicKey: SolanaAddressSchema,
});

/** Material terms of a swap. This (and nothing route-specific) goes into the payload hash. */
export interface JupiterSwapTerms {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  /** The approval binds to this: the swap must never deliver less. */
  readonly minOutAmount: string;
  readonly slippageBps: number;
  readonly riskCategory: string;
}

export interface JupiterQuote extends PluginQuote {
  /** Raw Jupiter quoteResponse, needed by /swap. Not part of the payload hash. */
  readonly jupiterQuote: JsonObject;
  readonly priceImpactBps: number;
}

const QuoteResponseSchema = z.looseObject({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: BaseUnitAmountSchema,
  outAmount: BaseUnitAmountSchema,
  otherAmountThreshold: BaseUnitAmountSchema,
  swapMode: z.literal("ExactIn"),
  slippageBps: z.number().int(),
  priceImpactPct: z.string(),
  routePlan: z.array(z.unknown()).min(1),
});

const SwapResponseSchema = z.looseObject({
  swapTransaction: z.string().min(1),
  lastValidBlockHeight: z.number().int().positive(),
  simulationError: z.unknown().optional(),
});

/**
 * The minimum output the Jupiter program itself enforces: floor(quotedOut x (10000 - slippage)
 * / 10000). The API's otherAmountThreshold can be 1 unit higher (rounded up), so the approval
 * binds to this on-chain value, which verifyJupiterSwap recomputes from the instruction.
 */
function guaranteedMinOut(q: { outAmount: string; slippageBps: number }): bigint {
  return (parseBaseUnits(q.outAmount) * (10_000n - BigInt(q.slippageBps))) / 10_000n;
}

function priceImpactBps(pct: string): number {
  // priceImpactPct is a decimal FRACTION ("0.0012" = 0.12% = 12 bps).
  const abs = pct.startsWith("-") ? pct.slice(1) : pct;
  return Number(decimalToMinorUnits(abs, "ceil", 4));
}

/**
 * Jupiter swap adapter (Swap API v1 "Metis": GET /swap/v1/quote + POST /swap/v1/swap,
 * https://developers.jup.ag/docs/swap). v1 returns an unsigned transaction we simulate,
 * independently decode, have signed through Turnkey and broadcast ourselves. The v2
 * /order+/execute flow routes broadcast through Jupiter and RFQ makers, which does not fit
 * ADR-001's sign-only + own-broadcaster model; /swap/v2/build is the migration target.
 *
 * Mainnet only: Jupiter does not route on devnet. Development mode uses MockJupiterAdapter.
 * Swaps are never autonomous (ADR-001 D7): every swap needs a passkey approval.
 */
export function createJupiterAdapter(config: JupiterAdapterConfig): JupiterAdapter {
  const manifest = manifestFor("jupiter");
  const http = resolveHttpOptions(config);
  const baseUrl = config.baseUrl ?? "https://api.jup.ag";
  const maxSlippage = Math.min(config.maxSlippageBps ?? 100, JUPITER_MAX_SLIPPAGE_BPS);
  const maxImpact = config.maxPriceImpactBps ?? 100;
  const ttl = (config.quoteTtlSeconds ?? 30) * 1000;
  const now = config.now ?? (() => new Date());
  const rpc = new SolanaRpc({ ...config, rpcUrl: config.rpcUrl, network: "solana-mainnet" });
  // An empty key means the keyless tier (0.5 RPS): only for tests and local experiments.
  const headers: Record<string, string> =
    config.apiKey.length > 0 ? { "x-api-key": config.apiKey } : {};

  function assertNetwork(network: NetworkId): void {
    if (network !== "solana-mainnet") {
      throw new ChainError(
        "NETWORK_NOT_SUPPORTED",
        "Jupiter swaps are mainnet-only; development uses MockJupiterAdapter",
      );
    }
  }

  async function fetchQuote(
    params: z.infer<typeof SwapParamsSchema>,
  ): Promise<z.infer<typeof QuoteResponseSchema>> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
      swapMode: "ExactIn",
      restrictIntermediateTokens: "true",
    });
    const body = await requestJson(http, {
      url: `${baseUrl}/swap/v1/quote?${query.toString()}`,
      headers,
      label: "jupiter quote",
    });
    const parsed = QuoteResponseSchema.safeParse(body);
    if (!parsed.success)
      throw new ChainError("UPSTREAM_UNAVAILABLE", "jupiter quote: unexpected response");
    const q = parsed.data;
    if (
      q.inputMint !== params.inputMint ||
      q.outputMint !== params.outputMint ||
      q.inAmount !== params.amount ||
      q.slippageBps !== params.slippageBps
    ) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "jupiter quote does not match the request");
    }
    return q;
  }

  function guard(q: z.infer<typeof QuoteResponseSchema>): number {
    const impact = priceImpactBps(q.priceImpactPct);
    if (impact > maxImpact) {
      throw new ChainError(
        "VALIDATION_FAILED",
        `price impact ${impact} bps exceeds the ${maxImpact} bps limit`,
        { details: { priceImpactBps: impact } },
      );
    }
    if (guaranteedMinOut(q) === 0n) {
      throw new ChainError("VALIDATION_FAILED", "quote has a zero minimum output");
    }
    return impact;
  }

  const adapter = {
    manifest,

    async quote(input: {
      action: string;
      network: NetworkId;
      params: JsonObject;
    }): Promise<JupiterQuote> {
      assertNetwork(input.network);
      if (input.action !== "swap")
        throw new ChainError("VALIDATION_FAILED", `unknown jupiter action ${input.action}`);
      const params = parseParams(SwapParamsSchema, input.params);
      if (params.slippageBps > maxSlippage) {
        throw new ChainError(
          "VALIDATION_FAILED",
          `slippage ${params.slippageBps} bps exceeds the ${maxSlippage} bps cap`,
        );
      }
      if (params.inputMint === params.outputMint)
        throw new ChainError("VALIDATION_FAILED", "input and output mints are equal");
      if (parseBaseUnits(params.amount) === 0n)
        throw new ChainError("VALIDATION_FAILED", "amount must be greater than zero");
      const q = await fetchQuote(params);
      const impact = guard(q);
      const terms: JupiterSwapTerms = {
        inputMint: q.inputMint,
        outputMint: q.outputMint,
        inAmount: q.inAmount,
        minOutAmount: guaranteedMinOut(q).toString(),
        slippageBps: q.slippageBps,
        riskCategory: manifest.riskCategory,
      };
      return {
        pluginId: "jupiter",
        pluginData: toJsonObject(terms),
        inputAmount: q.inAmount,
        expectedOutputAmount: q.outAmount,
        expiresAt: new Date(now().getTime() + ttl).toISOString(),
        simulated: false,
        jupiterQuote: toJsonObject(q),
        priceImpactBps: impact,
      };
    },

    /**
     * Build the swap for an approved payload. If the stored Jupiter quote is gone or stale,
     * re-quote: the new route is accepted only if its guaranteed minimum is >= the approved
     * minOutAmount, so the payload (and its hash) stays valid across blockhash rebuilds.
     */
    /** Independent decode (verifyJupiterSwap) of a base64 swap against the payload. */
    verifyTransaction(
      serialized: string,
      encoding: "base64" | "hex",
      payload: CanonicalTransactionPayload,
    ): Promise<VerificationResult> {
      return runVerifier("jupiter", "base64", encoding, payload, (p) =>
        p.network === "solana-mainnet"
          ? verifyJupiterSwap(serialized, p)
          : { ok: false, reason: "Jupiter swaps are mainnet-only" },
      );
    },

    async buildTransaction(input: {
      payload: CanonicalTransactionPayload;
      quote: PluginQuote;
    }): Promise<UnsignedTransaction> {
      const payload = CanonicalTransactionPayloadSchema.parse(input.payload);
      assertNetwork(payload.network);
      assertPayloadMatchesQuote("jupiter", payload, input.quote, now());
      const terms = input.quote.pluginData as unknown as JupiterSwapTerms;
      const inputMint = parseAssetId(payload.asset.id).tokenAddress ?? solanaPrograms.WSOL_MINT;
      if (inputMint !== terms.inputMint)
        throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload asset is not the swap input");

      let raw = (input.quote as Partial<JupiterQuote>).jupiterQuote;
      if (raw === undefined || Date.parse(input.quote.expiresAt) <= now().getTime()) {
        const fresh = await fetchQuote({
          inputMint: terms.inputMint,
          outputMint: terms.outputMint,
          amount: terms.inAmount,
          slippageBps: terms.slippageBps,
          userPublicKey: payload.from,
        });
        guard(fresh);
        if (guaranteedMinOut(fresh) < parseBaseUnits(terms.minOutAmount)) {
          throw new ChainError(
            "VALIDATION_FAILED",
            "price moved: the new minimum output is below the approved one; request a new swap",
            { details: { approved: terms.minOutAmount, now: guaranteedMinOut(fresh).toString() } },
          );
        }
        raw = toJsonObject(fresh);
      }

      const feeCap = parseBaseUnits(payload.feeCap);
      const maxPriority = BigInt(config.maxPriorityFeeLamports ?? 200_000);
      const priorityBudget =
        feeCap > 5000n ? (feeCap - 5000n < maxPriority ? feeCap - 5000n : maxPriority) : 0n;
      const body = await requestJson(http, {
        url: `${baseUrl}/swap/v1/swap`,
        headers,
        body: {
          quoteResponse: raw,
          userPublicKey: payload.from,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: Number(priorityBudget),
              priorityLevel: "high",
            },
          },
        },
        label: "jupiter swap",
      });
      const swap = SwapResponseSchema.safeParse(body);
      if (!swap.success)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "jupiter swap: unexpected response");
      if (swap.data.simulationError !== undefined && swap.data.simulationError !== null) {
        throw new ChainError("VALIDATION_FAILED", "jupiter reports the swap would fail", {
          details: { simulationError: swap.data.simulationError },
        });
      }
      const serialized = swap.data.swapTransaction;
      const check = await verifyJupiterSwap(serialized, payload);
      if (!check.ok)
        throw new ChainError("VALIDATION_FAILED", `jupiter transaction rejected: ${check.reason}`);

      const sim = await rpc.simulate(serialized, { replaceRecentBlockhash: false });
      if (sim.err !== null) throw simulationError(sim.err, sim.logs);
      const height = await rpc.getBlockHeight("confirmed");
      const remaining = BigInt(swap.data.lastValidBlockHeight) - height;
      const tx = decodeSolanaTransaction(serialized);
      const budget = readComputeBudget(tx.instructions);
      return {
        family: "solana",
        network: payload.network,
        payloadHash: payloadHash(payload),
        encoding: "base64",
        serialized,
        estimatedFee: maxNetworkFee(
          tx.numSigners,
          budget.unitLimit,
          budget.microLamportsPerCu,
        ).toString(),
        validUntil: new Date(
          now().getTime() + Number(remaining > 0n ? remaining : 0n) * 400,
        ).toISOString(),
        simulated: false,
      };
    },
  };
  return adapter;
}

const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([
  JUPITER_PROGRAM,
  solanaPrograms.COMPUTE_BUDGET_PROGRAM,
  solanaPrograms.SYSTEM_PROGRAM,
  solanaPrograms.TOKEN_PROGRAM,
  solanaPrograms.TOKEN_2022_PROGRAM,
  solanaPrograms.ASSOCIATED_TOKEN_PROGRAM,
]);

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i] ?? 0);
  return v;
}

/**
 * Independent decode of a Jupiter swap transaction against the approved payload. Checks:
 *  - the user is fee payer and sole signer;
 *  - only Jupiter v6, ComputeBudget, System, Token(-2022) and ATA programs are invoked;
 *  - System transfers only from the user into the user's own wSOL account (wrapping),
 *    Token instructions only SyncNative / CloseAccount back to the user / idempotent ATA;
 *  - exactly one Jupiter ExactIn route whose encoded in_amount equals the payload amount and
 *    whose encoded quoted_out x (1 - slippage) >= the approved minOutAmount;
 *  - worst-case network fee <= payload.feeCap.
 * Limits (documented): accounts loaded through lookup tables (pool accounts, sometimes the
 * output token account) cannot be resolved offline; the route's on-chain slippage check is
 * what enforces the minimum output to the user's account.
 */
export async function verifyJupiterSwap(
  serialized: string,
  payload: CanonicalTransactionPayload,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const terms = payload.pluginData as unknown as JupiterSwapTerms | null;
    if (terms === null || payload.plugin !== "jupiter")
      return { ok: false, reason: "not a jupiter payload" };
    const tx = decodeSolanaTransaction(serialized);
    if (tx.feePayer !== payload.from) return { ok: false, reason: "fee payer is not the user" };
    if (tx.numSigners !== 1) return { ok: false, reason: "extra signers required" };
    const budget = readComputeBudget(tx.instructions);
    const fee = maxNetworkFee(tx.numSigners, budget.unitLimit, budget.microLamportsPerCu);
    if (fee > parseBaseUnits(payload.feeCap))
      return { ok: false, reason: `network fee ${fee} exceeds fee cap` };
    const [wsolAta] = await findAssociatedTokenPda({
      owner: toAddress(payload.from),
      mint: toAddress(solanaPrograms.WSOL_MINT),
      tokenProgram: toAddress(solanaPrograms.TOKEN_PROGRAM),
    });
    let routes = 0;
    for (const ix of budget.otherInstructions) {
      const program = ix.programAddress;
      if (!ALLOWED_PROGRAMS.has(program))
        return { ok: false, reason: `unexpected program ${program}` };
      const data = ix.data;
      if (program === solanaPrograms.SYSTEM_PROGRAM) {
        // TransferSol = u32 LE 2, then u64 lamports; source user, destination user's wSOL ATA.
        if (
          data.length !== 12 ||
          data[0] !== 2 ||
          data[1] !== 0 ||
          data[2] !== 0 ||
          data[3] !== 0
        ) {
          return { ok: false, reason: "unexpected System instruction" };
        }
        if (ix.accounts[0]?.address !== payload.from || ix.accounts[1]?.address !== wsolAta) {
          return {
            ok: false,
            reason: "System transfer is not a wrap into the user's wSOL account",
          };
        }
        if (readU64LE(new Uint8Array(data), 4) > parseBaseUnits(payload.amount)) {
          return { ok: false, reason: "wrap amount exceeds the swap input" };
        }
      } else if (
        program === solanaPrograms.TOKEN_PROGRAM ||
        program === solanaPrograms.TOKEN_2022_PROGRAM
      ) {
        const kind = data[0];
        if (kind === 17) continue; // SyncNative
        if (kind === 9) {
          // CloseAccount(account, destination, owner): rent must go back to the user.
          if (
            ix.accounts[1]?.address !== payload.from ||
            ix.accounts[2]?.address !== payload.from
          ) {
            return { ok: false, reason: "CloseAccount does not return funds to the user" };
          }
          continue;
        }
        return { ok: false, reason: `unexpected token instruction ${String(kind)}` };
      } else if (program === solanaPrograms.ASSOCIATED_TOKEN_PROGRAM) {
        if (data.length !== 1 || data[0] !== 1)
          return { ok: false, reason: "only idempotent ATA creation is allowed" };
        if (ix.accounts[0]?.address !== payload.from || ix.accounts[2]?.address !== payload.from) {
          return { ok: false, reason: "ATA creation not for the user" };
        }
      } else if (program === JUPITER_PROGRAM) {
        const disc = [...data.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (!ROUTE_DISCRIMINATORS.has(disc))
          return { ok: false, reason: "unknown Jupiter instruction" };
        if (data.length < 8 + 19) return { ok: false, reason: "malformed Jupiter route" };
        const bytes = new Uint8Array(data);
        const tail = bytes.length - 19;
        const inAmount = readU64LE(bytes, tail);
        const quotedOut = readU64LE(bytes, tail + 8);
        const slippage = BigInt((bytes[tail + 16] ?? 0) | ((bytes[tail + 17] ?? 0) << 8));
        const platformFee = bytes[tail + 18] ?? 0;
        if (inAmount !== parseBaseUnits(payload.amount))
          return { ok: false, reason: "route in_amount differs from the approved amount" };
        if (platformFee !== 0) return { ok: false, reason: "unexpected platform fee" };
        const guaranteed = (quotedOut * (10_000n - slippage)) / 10_000n;
        if (guaranteed < parseBaseUnits(terms.minOutAmount)) {
          return { ok: false, reason: "route minimum output is below the approved minimum" };
        }
        routes++;
      }
    }
    if (routes !== 1) return { ok: false, reason: "expected exactly one Jupiter route" };
    if (!isValidSolanaAddress(terms.outputMint)) return { ok: false, reason: "bad output mint" };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot decode: ${isChainError(error) || error instanceof Error ? error.message : "unknown"}`,
    };
  }
}
