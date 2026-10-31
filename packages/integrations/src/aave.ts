import type { EvmTransactionBuilderConfig, HttpOptions } from "@zyropay/blockchain";
import { ChainError, createEvmTransactionBuilder, EvmRpc } from "@zyropay/blockchain";
import type {
  CanonicalTransactionPayload,
  NetworkId,
  PluginAdapter,
  PluginQuote,
  UnsignedTransaction,
  VerificationResult,
} from "@zyropay/shared";
import {
  addressesEqual,
  BaseUnitAmountSchema,
  CanonicalTransactionPayloadSchema,
  EvmAddressSchema,
  evmChainId,
  parseAssetId,
  parseBaseUnits,
} from "@zyropay/shared";
import type { Abi, Hex } from "viem";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  parseTransaction,
} from "viem";
import { z } from "zod";
import {
  assertPayloadMatchesQuote,
  manifestFor,
  parseParams,
  runVerifier,
  toJsonObject,
} from "./common";

/**
 * Aave v3 market addresses (bgd-labs/aave-address-book: AaveV3Ethereum, AaveV3Base,
 * AaveV3Sepolia, AaveV3BaseSepolia). Testnet markets list Aave faucet tokens, not Circle USDC.
 */
export const AAVE_V3_MARKETS: Partial<Record<NetworkId, { pool: string; dataProvider: string }>> = {
  "ethereum-mainnet": {
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    dataProvider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
  },
  "base-mainnet": {
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    dataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
  },
  "ethereum-sepolia": {
    pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
    dataProvider: "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31",
  },
  "base-sepolia": {
    pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    dataProvider: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
  },
};

export const poolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function getReservesList() view returns (address[])",
]);

const dataProviderAbi = parseAbi([
  "function getAllReservesTokens() view returns ((string symbol, address tokenAddress)[])",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);

export interface AaveReserve {
  readonly symbol: string;
  readonly asset: string;
  readonly decimals: number;
  readonly isActive: boolean;
  readonly isFrozen: boolean;
  /** Supply APR as a ray (1e27) integer string: liquidityRate. */
  readonly liquidityRateRay: string;
  readonly totalSupplied: string;
}

export interface AaveAdapterConfig extends HttpOptions {
  /** RPC per network (Alchemy URLs from rpcUrlFor). Only listed networks are served. */
  readonly rpcUrls: Partial<Record<NetworkId, string>>;
  readonly builder?: Omit<EvmTransactionBuilderConfig, "rpcUrl" | "network">;
  readonly quoteTtlSeconds?: number;
  readonly now?: () => Date;
}

const ParamsSchema = z.strictObject({
  asset: EvmAddressSchema,
  amount: BaseUnitAmountSchema,
  wallet: EvmAddressSchema,
});

export interface AaveTerms {
  readonly action: "supply" | "withdraw" | "approve";
  readonly pool: string;
  readonly asset: string;
  readonly amount: string;
  readonly decimals: number;
  readonly liquidityRateRay: string;
  readonly riskCategory: string;
}

export interface AaveAdapter extends PluginAdapter {
  listReserves(network: NetworkId): Promise<AaveReserve[]>;
  /** Current allowance of `owner` to the pool for `asset`. */
  allowance(network: NetworkId, asset: string, owner: string): Promise<bigint>;
  /** Independent decode (verifyAaveTransaction) of a 0x-hex unsigned tx. Never throws. */
  verifyTransaction(
    serialized: string,
    encoding: "base64" | "hex",
    payload: CanonicalTransactionPayload,
  ): Promise<VerificationResult>;
}

/**
 * Aave v3 adapter: markets read + supply / withdraw / approve transaction building with viem
 * against the Pool (IPool: supply, withdraw) on Ethereum and Base (and their Sepolia test
 * markets). Approvals are separate requests (exact amount, never unlimited). Payload mapping:
 *   supply:   to = Pool, asset = underlying, amount = supplied amount
 *   withdraw: to = wallet (funds come back), asset = underlying, amount = withdrawn amount
 *   approve:  to = Pool (spender), asset = underlying, amount = allowance
 */
export function createAaveAdapter(config: AaveAdapterConfig): AaveAdapter {
  const manifest = manifestFor("aave");
  const now = config.now ?? (() => new Date());
  const ttl = (config.quoteTtlSeconds ?? 120) * 1000;

  function market(network: NetworkId): { pool: Hex; dataProvider: Hex; rpcUrl: string } {
    const m = AAVE_V3_MARKETS[network];
    const rpcUrl = config.rpcUrls[network];
    if (m === undefined || rpcUrl === undefined)
      throw new ChainError("NETWORK_NOT_SUPPORTED", `Aave is not configured on ${network}`);
    return { pool: getAddress(m.pool), dataProvider: getAddress(m.dataProvider), rpcUrl };
  }

  function rpcFor(network: NetworkId): EvmRpc {
    return new EvmRpc({ ...config, rpcUrl: market(network).rpcUrl, network });
  }

  async function read<T>(
    rpc: EvmRpc,
    to: Hex,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args: [...args] });
    const raw = await rpc.ethCall({ to, data });
    return decodeFunctionResult({ abi, functionName, data: raw }) as T;
  }

  async function reserve(network: NetworkId, asset: string): Promise<AaveReserve> {
    const { dataProvider } = market(network);
    const rpc = rpcFor(network);
    const tokens = await read<ReadonlyArray<{ symbol: string; tokenAddress: string }>>(
      rpc,
      dataProvider,
      dataProviderAbi,
      "getAllReservesTokens",
    );
    const token = tokens.find((t) => addressesEqual("evm", t.tokenAddress, asset));
    if (token === undefined)
      throw new ChainError("VALIDATION_FAILED", "asset is not an Aave reserve on this network");
    return describe(rpc, dataProvider, token);
  }

  async function describe(
    rpc: EvmRpc,
    dataProvider: Hex,
    token: { symbol: string; tokenAddress: string },
  ): Promise<AaveReserve> {
    const asset = getAddress(token.tokenAddress);
    const conf = await read<
      readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]
    >(rpc, dataProvider, dataProviderAbi, "getReserveConfigurationData", [asset]);
    const data = await read<readonly bigint[]>(
      rpc,
      dataProvider,
      dataProviderAbi,
      "getReserveData",
      [asset],
    );
    return {
      symbol: token.symbol.slice(0, 32),
      asset,
      decimals: Number(conf[0]),
      isActive: conf[8],
      isFrozen: conf[9],
      liquidityRateRay: (data[5] ?? 0n).toString(),
      totalSupplied: (data[2] ?? 0n).toString(),
    };
  }

  const adapter: AaveAdapter = {
    manifest,

    async listReserves(network) {
      const { dataProvider } = market(network);
      const rpc = rpcFor(network);
      const tokens = await read<ReadonlyArray<{ symbol: string; tokenAddress: string }>>(
        rpc,
        dataProvider,
        dataProviderAbi,
        "getAllReservesTokens",
      );
      const out: AaveReserve[] = [];
      for (const t of tokens.slice(0, 100)) out.push(await describe(rpc, dataProvider, t));
      return out;
    },

    async allowance(network, asset, owner) {
      return read<bigint>(rpcFor(network), getAddress(asset), erc20Abi, "allowance", [
        getAddress(owner),
        market(network).pool,
      ]);
    },

    async quote(input): Promise<PluginQuote> {
      const action = input.action;
      if (action !== "supply" && action !== "withdraw" && action !== "approve") {
        throw new ChainError("VALIDATION_FAILED", `unknown aave action ${action}`);
      }
      const { pool } = market(input.network);
      const params = parseParams(ParamsSchema, input.params);
      const amount = parseBaseUnits(params.amount);
      if (amount === 0n)
        throw new ChainError("VALIDATION_FAILED", "amount must be greater than zero");
      const r = await reserve(input.network, params.asset);
      if (!r.isActive) throw new ChainError("VALIDATION_FAILED", "reserve is not active");
      if (action === "supply" && r.isFrozen)
        throw new ChainError("VALIDATION_FAILED", "reserve is frozen for supply");
      if (action === "supply") {
        const allowed = await adapter.allowance(input.network, r.asset, params.wallet);
        if (allowed < amount) {
          throw new ChainError(
            "VALIDATION_FAILED",
            "allowance too low: request an 'approve' for this amount first",
            { details: { requiredAction: "approve", allowance: allowed.toString() } },
          );
        }
      }
      const terms: AaveTerms = {
        action,
        pool,
        asset: r.asset,
        amount: params.amount,
        decimals: r.decimals,
        liquidityRateRay: r.liquidityRateRay,
        riskCategory: manifest.riskCategory,
      };
      return {
        pluginId: "aave",
        pluginData: toJsonObject(terms),
        inputAmount: params.amount,
        expectedOutputAmount: action === "approve" ? null : params.amount,
        expiresAt: new Date(now().getTime() + ttl).toISOString(),
        simulated: false,
      };
    },

    verifyTransaction(serialized, encoding, payload) {
      return runVerifier("aave", "hex", encoding, payload, (p) =>
        verifyAaveTransaction(serialized, p),
      );
    },

    async buildTransaction({ payload: raw, quote }): Promise<UnsignedTransaction> {
      const payload = CanonicalTransactionPayloadSchema.parse(raw);
      assertPayloadMatchesQuote("aave", payload, quote, now());
      const terms = payload.pluginData as unknown as AaveTerms;
      const { pool, rpcUrl } = market(payload.network);
      if (!addressesEqual("evm", terms.pool, pool))
        throw new ChainError("PAYLOAD_HASH_MISMATCH", "pool differs from the configured market");
      const call = callFor(terms, payload.from);
      const builder = createEvmTransactionBuilder({
        ...config,
        ...config.builder,
        rpcUrl,
        network: payload.network,
        now,
      });
      const unsigned = await builder.buildContractCall(payload, call);
      const check = verifyAaveTransaction(unsigned.serialized, payload);
      if (!check.ok)
        throw new ChainError("INTERNAL_ERROR", `aave self-check failed: ${check.reason}`);
      return unsigned;
    },
  };
  return adapter;
}

function callFor(terms: AaveTerms, from: string): { to: Hex; data: Hex } {
  const asset = getAddress(terms.asset);
  const amount = BigInt(terms.amount);
  switch (terms.action) {
    case "supply":
      return {
        to: getAddress(terms.pool),
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "supply",
          args: [asset, amount, getAddress(from), 0],
        }),
      };
    case "withdraw":
      return {
        to: getAddress(terms.pool),
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "withdraw",
          args: [asset, amount, getAddress(from)],
        }),
      };
    case "approve":
      return {
        to: asset,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [getAddress(terms.pool), amount],
        }),
      };
  }
}

/**
 * Independent decode of an Aave transaction against the payload: chain id, target (Pool or
 * token), exact calldata (asset, amount, onBehalfOf/to = the user, spender = the Pool, no
 * trailing bytes), zero value, fee cap. Also checks the payload's to/asset mapping.
 */
export function verifyAaveTransaction(
  serialized: string,
  payload: CanonicalTransactionPayload,
): { ok: true } | { ok: false; reason: string } {
  try {
    const terms = payload.pluginData as unknown as AaveTerms;
    const tx = parseTransaction(serialized as Hex);
    if (tx.type !== "eip1559" || tx.chainId !== evmChainId(payload.network))
      return { ok: false, reason: "wrong tx type or chain" };
    if ((tx.value ?? 0n) !== 0n) return { ok: false, reason: "aave calls must not send ether" };
    if ((tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) > parseBaseUnits(payload.feeCap))
      return { ok: false, reason: "fee exceeds cap" };
    const token = parseAssetId(payload.asset.id).tokenAddress;
    if (token === null || !addressesEqual("evm", token, terms.asset))
      return { ok: false, reason: "payload asset is not the reserve" };
    if (payload.amount !== terms.amount) return { ok: false, reason: "amount mismatch" };
    const expected = callFor(terms, payload.from);
    if (tx.to === undefined || tx.to === null || !addressesEqual("evm", tx.to, expected.to))
      return { ok: false, reason: "wrong target contract" };
    if ((tx.data ?? "0x").toLowerCase() !== expected.data.toLowerCase())
      return { ok: false, reason: "calldata differs" };
    const expectedTo = terms.action === "withdraw" ? payload.from : terms.pool;
    if (!addressesEqual("evm", payload.to, expectedTo))
      return { ok: false, reason: "payload recipient mapping is wrong" };
    // Defense in depth: decode again with the ABI.
    const abi = terms.action === "approve" ? erc20Abi : poolAbi;
    decodeFunctionData({ abi, data: tx.data ?? "0x" });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "cannot decode" };
  }
}
