import type { HttpOptions } from "@zyropay/blockchain";
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
  formatBaseUnits,
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

export const KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const KAMINO_FARMS_PROGRAM = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";

/** Anchor discriminators of the KLend value-moving instructions (sha256("global:<name>")[0..8]). */
const DEPOSIT_DISCRIMINATORS = new Set(["81c70402de271a2e", "d8e0bf1bcc9766af"]);
const WITHDRAW_DISCRIMINATORS = new Set(["4b5d5ddc2296dac4", "eb34779895c51407"]);

export interface KaminoAdapterConfig extends HttpOptions {
  readonly baseUrl?: string;
  /** Solana mainnet RPC: mint decimals and pre-handoff simulation. */
  readonly rpcUrl: string;
  readonly quoteTtlSeconds?: number;
  readonly now?: () => Date;
}

const ParamsSchema = z.strictObject({
  market: SolanaAddressSchema,
  reserve: SolanaAddressSchema,
  amount: BaseUnitAmountSchema,
  wallet: SolanaAddressSchema,
});

const ReserveMetricSchema = z.looseObject({
  reserve: z.string(),
  liquidityToken: z.string(),
  liquidityTokenMint: z.string(),
  supplyApy: z.string(),
  borrowApy: z.string(),
  totalSupplyUsd: z.string().optional(),
});
export type KaminoReserve = z.infer<typeof ReserveMetricSchema>;

const MarketSchema = z.looseObject({
  name: z.string(),
  lendingMarket: z.string(),
  isPrimary: z.boolean().optional(),
});
export type KaminoMarket = z.infer<typeof MarketSchema>;

export interface KaminoTerms {
  readonly action: "deposit" | "withdraw";
  readonly market: string;
  readonly reserve: string;
  readonly mint: string;
  readonly amount: string;
  readonly decimals: number;
  readonly supplyApy: string;
  readonly riskCategory: string;
}

export interface KaminoAdapter extends PluginAdapter {
  listMarkets(): Promise<KaminoMarket[]>;
  listReserves(market: string): Promise<KaminoReserve[]>;
  /** Independent decode (verifyKaminoTransaction) of a base64 KTX transaction. Never throws. */
  verifyTransaction(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
}

/**
 * Kamino Lend (KLend) deposit/withdraw via Kamino's public REST API (no key):
 *   discovery  GET /v2/kamino-market?programId=..., GET /kamino-market/{m}/reserves/metrics
 *   tx build   POST /ktx/klend/deposit | /ktx/klend/withdraw  {wallet, market, reserve, amount}
 * (https://kamino.com/docs/build/api-reference/introduction). Kamino returns an unsigned v0
 * transaction which we decode and simulate before it can be approved. Mainnet only.
 */
export function createKaminoAdapter(config: KaminoAdapterConfig): KaminoAdapter {
  const manifest = manifestFor("kamino");
  const http = resolveHttpOptions(config);
  const baseUrl = config.baseUrl ?? "https://api.kamino.finance";
  const now = config.now ?? (() => new Date());
  const ttl = (config.quoteTtlSeconds ?? 60) * 1000;
  const rpc = new SolanaRpc({ ...config, rpcUrl: config.rpcUrl, network: "solana-mainnet" });

  function assertNetwork(network: NetworkId): void {
    if (network !== "solana-mainnet")
      throw new ChainError("NETWORK_NOT_SUPPORTED", "Kamino is mainnet-only");
  }

  async function listReserves(market: string): Promise<KaminoReserve[]> {
    SolanaAddressSchema.parse(market);
    const body = await requestJson(http, {
      url: `${baseUrl}/kamino-market/${market}/reserves/metrics?env=mainnet-beta`,
      label: "kamino reserves",
    });
    const parsed = z.array(ReserveMetricSchema).safeParse(body);
    if (!parsed.success)
      throw new ChainError("UPSTREAM_UNAVAILABLE", "kamino reserves: unexpected response");
    return parsed.data;
  }

  return {
    manifest,

    async listMarkets() {
      const body = await requestJson(http, {
        url: `${baseUrl}/v2/kamino-market?programId=${KLEND_PROGRAM}`,
        label: "kamino markets",
      });
      const parsed = z.array(MarketSchema).safeParse(body);
      if (!parsed.success)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "kamino markets: unexpected response");
      return parsed.data;
    },

    listReserves,

    async quote(input): Promise<PluginQuote> {
      assertNetwork(input.network);
      if (input.action !== "deposit" && input.action !== "withdraw") {
        throw new ChainError("VALIDATION_FAILED", `unknown kamino action ${input.action}`);
      }
      const params = parseParams(ParamsSchema, input.params);
      if (parseBaseUnits(params.amount) === 0n)
        throw new ChainError("VALIDATION_FAILED", "amount must be greater than zero");
      const reserve = (await listReserves(params.market)).find((r) => r.reserve === params.reserve);
      if (reserve === undefined)
        throw new ChainError("VALIDATION_FAILED", "reserve is not part of this market");
      const mint = await rpc.getMint(reserve.liquidityTokenMint);
      if (mint === null) throw new ChainError("UPSTREAM_UNAVAILABLE", "reserve mint not found");
      const terms: KaminoTerms = {
        action: input.action,
        market: params.market,
        reserve: params.reserve,
        mint: reserve.liquidityTokenMint,
        amount: params.amount,
        decimals: mint.decimals,
        supplyApy: reserve.supplyApy,
        riskCategory: manifest.riskCategory,
      };
      return {
        pluginId: "kamino",
        pluginData: toJsonObject(terms),
        inputAmount: params.amount,
        expectedOutputAmount: input.action === "withdraw" ? params.amount : null,
        expiresAt: new Date(now().getTime() + ttl).toISOString(),
        simulated: false,
      };
    },

    verifyTransaction(serialized, encoding, payload) {
      return runVerifier("kamino", "base64", encoding, payload, (p) =>
        p.network === "solana-mainnet"
          ? verifyKaminoTransaction(serialized, p)
          : { ok: false, reason: "Kamino is mainnet-only" },
      );
    },

    async buildTransaction({ payload: raw, quote }): Promise<UnsignedTransaction> {
      const payload = CanonicalTransactionPayloadSchema.parse(raw);
      assertNetwork(payload.network);
      assertPayloadMatchesQuote("kamino", payload, quote, now());
      const terms = payload.pluginData as unknown as KaminoTerms;
      if (parseAssetId(payload.asset.id).tokenAddress !== terms.mint) {
        throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload asset is not the reserve token");
      }
      if (payload.asset.decimals !== terms.decimals)
        throw new ChainError("DECIMALS_MISMATCH", "decimals differ from the reserve mint");
      const body = await requestJson(http, {
        url: `${baseUrl}/ktx/klend/${terms.action}`,
        body: {
          wallet: payload.from,
          market: terms.market,
          reserve: terms.reserve,
          // Kamino takes a decimal string, not base units.
          amount: formatBaseUnits(terms.amount, terms.decimals),
        },
        label: `kamino ${terms.action}`,
      });
      const parsed = z.looseObject({ transaction: z.string().min(1) }).safeParse(body);
      if (!parsed.success)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "kamino ktx: unexpected response");
      const serialized = parsed.data.transaction;
      const check = verifyKaminoTransaction(serialized, payload);
      if (!check.ok)
        throw new ChainError("VALIDATION_FAILED", `kamino transaction rejected: ${check.reason}`);
      const sim = await rpc.simulate(serialized, { replaceRecentBlockhash: false });
      if (sim.err !== null) throw simulationError(sim.err, sim.logs);
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
        validUntil: new Date(now().getTime() + 60_000).toISOString(),
        simulated: false,
      };
    },
  };
}

const ALLOWED = new Set([
  KLEND_PROGRAM,
  KAMINO_FARMS_PROGRAM,
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  solanaPrograms.COMPUTE_BUDGET_PROGRAM,
  solanaPrograms.ASSOCIATED_TOKEN_PROGRAM,
  solanaPrograms.TOKEN_PROGRAM,
  solanaPrograms.TOKEN_2022_PROGRAM,
  solanaPrograms.MEMO_PROGRAM,
]);

function hex(bytes: ArrayLike<number>, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

function u64(bytes: ArrayLike<number>, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  return v;
}

/**
 * Independent decode of a Kamino KTX transaction. Checks the user is fee payer and sole
 * signer, only KLend/Farms/ALT/ComputeBudget/ATA/Token/Memo programs run (ALT only
 * Create/Extend for the user's own table, Token only SyncNative/CloseAccount), exactly one
 * KLend deposit (amount u64 at offset 8 must equal the payload amount) or withdraw
 * instruction, and the worst-case fee fits the fee cap. Withdraw instructions carry a
 * collateral (cToken) amount, which cannot be mapped to the liquidity amount offline: for
 * withdrawals only the instruction kind is checked (funds flow back to the user).
 */
export function verifyKaminoTransaction(
  serialized: string,
  payload: CanonicalTransactionPayload,
): { ok: true } | { ok: false; reason: string } {
  try {
    const terms = payload.pluginData as unknown as KaminoTerms;
    const tx = decodeSolanaTransaction(serialized);
    if (tx.feePayer !== payload.from) return { ok: false, reason: "fee payer is not the user" };
    if (tx.numSigners !== 1) return { ok: false, reason: "extra signers required" };
    const budget = readComputeBudget(tx.instructions);
    if (
      maxNetworkFee(1, budget.unitLimit, budget.microLamportsPerCu) > parseBaseUnits(payload.feeCap)
    ) {
      return { ok: false, reason: "network fee exceeds the fee cap" };
    }
    let actions = 0;
    for (const ix of budget.otherInstructions) {
      const program = ix.programAddress;
      if (!ALLOWED.has(program)) return { ok: false, reason: `unexpected program ${program}` };
      const data = ix.data;
      if (program === ADDRESS_LOOKUP_TABLE_PROGRAM) {
        const kind = data[0];
        if (!(kind === 0 || kind === 2) || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
          return { ok: false, reason: "only lookup-table create/extend allowed" };
        if (ix.accounts[1]?.address !== payload.from)
          return { ok: false, reason: "lookup table authority is not the user" };
      } else if (
        program === solanaPrograms.TOKEN_PROGRAM ||
        program === solanaPrograms.TOKEN_2022_PROGRAM
      ) {
        if (data[0] === 17) continue;
        if (
          data[0] === 9 &&
          ix.accounts[1]?.address === payload.from &&
          ix.accounts[2]?.address === payload.from
        )
          continue;
        return { ok: false, reason: "unexpected token instruction" };
      } else if (program === solanaPrograms.ASSOCIATED_TOKEN_PROGRAM) {
        if (data.length !== 1 || data[0] !== 1 || ix.accounts[0]?.address !== payload.from)
          return { ok: false, reason: "unexpected ATA instruction" };
      } else if (program === KLEND_PROGRAM) {
        const disc = hex(data, 0, 8);
        if (DEPOSIT_DISCRIMINATORS.has(disc)) {
          if (terms.action !== "deposit")
            return { ok: false, reason: "deposit in a withdraw request" };
          if (u64(data, 8) !== parseBaseUnits(payload.amount))
            return { ok: false, reason: "deposit amount differs from the approved amount" };
          actions++;
        } else if (WITHDRAW_DISCRIMINATORS.has(disc)) {
          if (terms.action !== "withdraw")
            return { ok: false, reason: "withdraw in a deposit request" };
          actions++;
        }
      }
    }
    if (actions !== 1) return { ok: false, reason: `expected exactly one KLend ${terms.action}` };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: isChainError(error) || error instanceof Error ? error.message : "cannot decode",
    };
  }
}

export type { JsonObject };
