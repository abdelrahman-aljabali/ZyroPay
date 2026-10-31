import type {
  BaseUnitAmount,
  CanonicalTransactionPayload,
  NetworkId,
  TransactionBuilder,
  UnsignedTransaction,
} from "@zyropay/shared";
import {
  addressesEqual,
  CanonicalTransactionPayloadSchema,
  evmChainId,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
} from "@zyropay/shared";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  parseTransaction,
  serializeTransaction,
} from "viem";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { JsonRpcError } from "../http";
import { assertAddress, assertFamily, assertSameNetwork } from "../networks";
import { EvmRpc } from "./rpc";

/** OP-stack GasPriceOracle predeploy (Base): charges an L1 data fee on top of L2 gas. */
export const OP_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const gasPriceOracleAbi = parseAbi(["function getL1Fee(bytes _data) view returns (uint256)"]);
const OP_STACK_NETWORKS: ReadonlySet<NetworkId> = new Set(["base-mainnet", "base-sepolia"]);

export interface EvmTransactionBuilderConfig extends HttpOptions {
  readonly rpcUrl: string;
  readonly network: NetworkId;
  /** Hard ceiling for maxFeePerGas, wei. Default 300 gwei. */
  readonly maxFeePerGasCap?: bigint;
  /** Hard ceiling for maxPriorityFeePerGas, wei. Default 10 gwei. */
  readonly maxPriorityFeePerGasCap?: bigint;
  /** maxFeePerGas = baseFee * multiplier + priority. Default 2. */
  readonly baseFeeMultiplier?: bigint;
  /** Extra gas over eth_estimateGas, basis points. Default 2000 (20%). */
  readonly gasLimitMarginBps?: number;
  /** Margin on the OP-stack L1 data fee, basis points. Default 5000 (50%). */
  readonly l1FeeMarginBps?: number;
  readonly now?: () => Date;
}

export interface EvmUnsignedTransaction extends UnsignedTransaction {
  readonly family: "evm";
  readonly encoding: "hex";
  readonly chainId: number;
  readonly nonce: number;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  /** Estimated OP-stack L1 data fee (with margin), wei; "0" on Ethereum. */
  readonly l1DataFee: BaseUnitAmount;
}

export interface EvmBuildOptions {
  /**
   * Explicit nonce. Default: the account's pending nonce. The API must pass explicit nonces
   * when several requests from one address are in flight, or two would share a nonce.
   */
  readonly nonce?: number;
}

export interface EvmTransactionBuilder extends TransactionBuilder<"evm"> {
  readonly network: NetworkId;
  buildTransfer(
    payload: CanonicalTransactionPayload,
    options?: EvmBuildOptions,
  ): Promise<EvmUnsignedTransaction>;
  estimateTransferFee(
    input: Pick<CanonicalTransactionPayload, "network" | "from" | "to" | "asset" | "amount">,
  ): Promise<{ estimatedFee: BaseUnitAmount; recommendedFeeCap: BaseUnitAmount }>;
  /**
   * Arbitrary contract call (plugins: Aave supply/withdraw, ERC-20 approve). Simulates with
   * eth_call, estimates gas and fits fees under payload.feeCap. It does NOT check that the
   * call matches the payload: the plugin adapter must run its own decoder before signing.
   */
  buildContractCall(
    payload: CanonicalTransactionPayload,
    call: { to: string; data: Hex; value?: bigint },
    options?: EvmBuildOptions,
  ): Promise<EvmUnsignedTransaction>;
  /**
   * Same nonce, same call, fees bumped by `bumpBps` (default 1250 = 12.5%; nodes require
   * >= 10%) to replace a stuck transaction. Throws if the bumped worst-case fee exceeds the
   * payload's feeCap: a higher fee needs a new payload and a new approval.
   */
  buildReplacement(
    stored: EvmUnsignedTransaction,
    payload: CanonicalTransactionPayload,
    options?: { bumpBps?: number },
  ): Promise<EvmUnsignedTransaction>;
  /**
   * Unsigned 0-value self-transfer at `nonce` with bumped fees, to cancel a stuck
   * transaction. It is not bound to any payload: the API must treat it as its own request.
   */
  buildCancellation(input: {
    from: string;
    nonce: number;
    minMaxFeePerGas: bigint;
    minMaxPriorityFeePerGas: bigint;
  }): Promise<{ serialized: Hex; maxFee: bigint }>;
  /** latest vs pending nonce: pending > latest means transactions are queued/stuck. */
  getNonceState(address: string): Promise<{ latest: number; pending: number }>;
}

function bump(value: bigint, bps: bigint): bigint {
  return value + (value * bps + 9_999n) / 10_000n;
}

/** Calldata and value for a transfer payload. */
function callFor(
  payload: Pick<CanonicalTransactionPayload, "network" | "to" | "asset" | "amount">,
): { to: Hex; value: bigint; data: Hex } {
  const amount = parseBaseUnits(payload.amount);
  if (payload.asset.kind === "native") {
    return { to: getAddress(payload.to), value: amount, data: "0x" };
  }
  if (payload.asset.kind !== "erc20") {
    throw new ChainError("VALIDATION_FAILED", "spl assets cannot be sent on EVM networks");
  }
  const token = parseAssetId(payload.asset.id).tokenAddress;
  if (token === null) throw new ChainError("VALIDATION_FAILED", "erc20 asset needs a contract");
  return {
    to: getAddress(token),
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(payload.to), amount],
    }),
  };
}

export function createEvmTransactionBuilder(
  config: EvmTransactionBuilderConfig,
): EvmTransactionBuilder {
  assertFamily(config.network, "evm");
  const rpc = new EvmRpc(config);
  const chainId = evmChainId(config.network);
  const maxFeeCap = config.maxFeePerGasCap ?? 300_000_000_000n;
  const maxTipCap = config.maxPriorityFeePerGasCap ?? 10_000_000_000n;
  const baseMultiplier = config.baseFeeMultiplier ?? 2n;
  const gasMargin = BigInt(config.gasLimitMarginBps ?? 2000);
  const l1Margin = BigInt(config.l1FeeMarginBps ?? 5000);
  const isOpStack = OP_STACK_NETWORKS.has(config.network);
  const nowMs = (): number => (config.now ?? (() => new Date()))().getTime();

  type Input = Pick<CanonicalTransactionPayload, "network" | "from" | "to" | "asset" | "amount">;

  async function validate(input: Input): Promise<void> {
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
      const token = parseAssetId(input.asset.id).tokenAddress ?? "";
      if (addressesEqual("evm", token, input.to)) {
        throw new ChainError("INVALID_ADDRESS", "recipient is the token contract itself");
      }
      const code = await rpc.getCode(token);
      if (code === "0x") throw new ChainError("VALIDATION_FAILED", "token address has no code");
      const raw = await rpc.ethCall({
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
      });
      const decimals = decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: raw });
      if (decimals !== input.asset.decimals) {
        throw new ChainError(
          "DECIMALS_MISMATCH",
          `token has ${decimals} decimals, request says ${input.asset.decimals}`,
        );
      }
    }
  }

  async function fees(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    baseFee: bigint;
  }> {
    const { baseFee, priorityFee } = await rpc.feeData();
    const tip = priorityFee > maxTipCap ? maxTipCap : priorityFee;
    let maxFee = baseFee * baseMultiplier + tip;
    if (maxFee > maxFeeCap) maxFee = maxFeeCap;
    if (maxFee < baseFee + tip) {
      throw new ChainError(
        "UPSTREAM_UNAVAILABLE",
        "network base fee is above the configured maxFeePerGas cap",
        { retryable: true },
      );
    }
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, baseFee };
  }

  async function estimateGas(
    from: string,
    call: { to: Hex; value: bigint; data: Hex },
  ): Promise<bigint> {
    try {
      const gas = await rpc.estimateGas({ from, ...call });
      return bump(gas, gasMargin);
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async function simulate(
    from: string,
    call: { to: Hex; value: bigint; data: Hex },
    isToken: boolean,
  ): Promise<void> {
    let result: Hex;
    try {
      result = await rpc.ethCall({ from, ...call }, "pending");
    } catch (error) {
      throw mapExecutionError(error);
    }
    if (isToken && result !== "0x") {
      const ok = decodeFunctionResult({ abi: erc20Abi, functionName: "transfer", data: result });
      if (!ok) throw new ChainError("VALIDATION_FAILED", "token transfer returned false");
    }
  }

  async function l1Fee(tx: TransactionSerializableEIP1559): Promise<bigint> {
    if (!isOpStack) return 0n;
    const raw = await rpc.ethCall({
      to: OP_GAS_PRICE_ORACLE,
      data: encodeFunctionData({
        abi: gasPriceOracleAbi,
        functionName: "getL1Fee",
        args: [serializeTransaction(tx)],
      }),
    });
    const fee = decodeFunctionResult({
      abi: gasPriceOracleAbi,
      functionName: "getL1Fee",
      data: raw,
    });
    return bump(fee, l1Margin);
  }

  function toUnsigned(
    payload: CanonicalTransactionPayload,
    tx: TransactionSerializableEIP1559,
    l1: bigint,
  ): EvmUnsignedTransaction {
    const gas = tx.gas ?? 0n;
    const maxFee = tx.maxFeePerGas ?? 0n;
    return {
      family: "evm",
      network: payload.network,
      payloadHash: payloadHash(payload),
      encoding: "hex",
      serialized: serializeTransaction(tx),
      estimatedFee: (gas * maxFee + l1).toString(),
      validUntil: null,
      simulated: false,
      chainId,
      nonce: tx.nonce ?? 0,
      gasLimit: gas.toString(),
      maxFeePerGas: maxFee.toString(),
      maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString(),
      l1DataFee: l1.toString(),
    };
  }

  /** Gas, EIP-1559 fees (fitted under the payload's feeCap), nonce, L1 fee; serialize. */
  async function assemble(
    payload: CanonicalTransactionPayload,
    call: { to: Hex; value: bigint; data: Hex },
    options: EvmBuildOptions,
  ): Promise<EvmUnsignedTransaction> {
    const gas = await estimateGas(payload.from, call);
    const f = await fees();
    const nonce = options.nonce ?? Number(await rpc.getNonce(payload.from, "pending"));
    const feeCap = parseBaseUnits(payload.feeCap);
    let tx: TransactionSerializableEIP1559 = {
      type: "eip1559",
      chainId,
      nonce,
      gas,
      maxFeePerGas: f.maxFeePerGas,
      maxPriorityFeePerGas: f.maxPriorityFeePerGas,
      ...call,
    };
    const l1 = await l1Fee(tx);
    if (gas * f.maxFeePerGas + l1 > feeCap) {
      // Lower maxFeePerGas to fit the cap, but never below what the next block needs.
      const fitted = feeCap > l1 ? (feeCap - l1) / gas : 0n;
      if (fitted < f.baseFee + f.maxPriorityFeePerGas) {
        throw new ChainError(
          "VALIDATION_FAILED",
          `fee cap ${payload.feeCap} is below the current network fee`,
          { details: { required: (gas * (f.baseFee + f.maxPriorityFeePerGas) + l1).toString() } },
        );
      }
      tx = { ...tx, maxFeePerGas: fitted };
    }
    return toUnsigned(payload, tx, l1);
  }

  const builder: EvmTransactionBuilder = {
    family: "evm",
    network: config.network,

    async estimateTransferFee(input) {
      await validate(input);
      const call = callFor(input);
      const gas = await estimateGas(input.from, call);
      const f = await fees();
      const l1 = await l1Fee({
        type: "eip1559",
        chainId,
        nonce: 0,
        gas,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        ...call,
      });
      const fee = gas * f.maxFeePerGas + l1;
      return { estimatedFee: fee.toString(), recommendedFeeCap: (fee + fee / 2n).toString() };
    },

    async buildTransfer(rawPayload, options = {}) {
      const payload = CanonicalTransactionPayloadSchema.parse(rawPayload);
      assertFamily(payload.network, "evm");
      if (Date.parse(payload.expiresAt) <= nowMs()) {
        throw new ChainError("REQUEST_EXPIRED", "payload has expired");
      }
      await validate(payload);
      const call = callFor(payload);
      await simulate(payload.from, call, payload.asset.kind === "erc20");
      const unsigned = await assemble(payload, call, options);
      const verified = await builder.verifyMatchesPayload(unsigned.serialized, "hex", payload);
      if (!verified.ok) {
        throw new ChainError(
          "INTERNAL_ERROR",
          `built transaction failed self-check: ${verified.reason}`,
        );
      }
      return unsigned;
    },

    async buildContractCall(rawPayload, call, options = {}) {
      const payload = CanonicalTransactionPayloadSchema.parse(rawPayload);
      assertSameNetwork(config.network, payload.network);
      assertAddress(payload.network, payload.from, "from");
      if (Date.parse(payload.expiresAt) <= nowMs()) {
        throw new ChainError("REQUEST_EXPIRED", "payload has expired");
      }
      const target = { to: getAddress(call.to), value: call.value ?? 0n, data: call.data };
      if ((await rpc.getCode(target.to)) === "0x") {
        throw new ChainError("VALIDATION_FAILED", "call target has no code");
      }
      await simulate(payload.from, target, false);
      return assemble(payload, target, options);
    },

    verifyMatchesPayload(serialized, encoding, payload) {
      return Promise.resolve(verifyEvmTransfer(serialized, encoding, payload, config.network));
    },

    async buildReplacement(stored, rawPayload, options = {}) {
      const payload = CanonicalTransactionPayloadSchema.parse(rawPayload);
      const check = verifyEvmTransfer(stored.serialized, "hex", payload, config.network);
      if (!check.ok) throw new ChainError("PAYLOAD_HASH_MISMATCH", check.reason);
      const old = parseTransaction(stored.serialized as Hex);
      if (old.type !== "eip1559") throw new ChainError("VALIDATION_FAILED", "not an EIP-1559 tx");
      const bps = BigInt(Math.max(options.bumpBps ?? 1250, 1000));
      const current = await fees();
      const oldMax = old.maxFeePerGas ?? 0n;
      const oldTip = old.maxPriorityFeePerGas ?? 0n;
      const tip = [bump(oldTip, bps), current.maxPriorityFeePerGas].reduce((a, b) =>
        a > b ? a : b,
      );
      const maxFee = [bump(oldMax, bps), current.maxFeePerGas, tip].reduce((a, b) =>
        a > b ? a : b,
      );
      const tx: TransactionSerializableEIP1559 = {
        ...old,
        type: "eip1559",
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      };
      const l1 = BigInt(stored.l1DataFee);
      if ((tx.gas ?? 0n) * maxFee + l1 > parseBaseUnits(payload.feeCap)) {
        throw new ChainError(
          "VALIDATION_FAILED",
          "replacement fee exceeds the approved fee cap; create a new request",
        );
      }
      return toUnsigned(payload, tx, l1);
    },

    async buildCancellation(input) {
      assertAddress(config.network, input.from, "from");
      const current = await fees();
      const tip =
        input.minMaxPriorityFeePerGas > current.maxPriorityFeePerGas
          ? input.minMaxPriorityFeePerGas
          : current.maxPriorityFeePerGas;
      const maxFee = [input.minMaxFeePerGas, current.maxFeePerGas, tip].reduce((a, b) =>
        a > b ? a : b,
      );
      const tx: TransactionSerializableEIP1559 = {
        type: "eip1559",
        chainId,
        nonce: input.nonce,
        to: getAddress(input.from),
        value: 0n,
        data: "0x",
        gas: 21_000n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      };
      return { serialized: serializeTransaction(tx), maxFee: 21_000n * maxFee };
    },

    async getNonceState(address) {
      assertAddress(config.network, address);
      const [latest, pending] = await Promise.all([
        rpc.getNonce(address, "latest"),
        rpc.getNonce(address, "pending"),
      ]);
      return { latest: Number(latest), pending: Number(pending) };
    },
  };
  return builder;
}

/**
 * Independent decode of an unsigned EVM transfer (ADR-001 D2 step 3). Pure. Checks: unsigned
 * EIP-1559, chain id of the payload's network, no access list, exact recipient/value/calldata
 * for the asset, and gas * maxFeePerGas <= feeCap. The OP-stack L1 data fee is not encoded in
 * the transaction; the builder includes its estimate when fitting the fee cap.
 */
export function verifyEvmTransfer(
  serialized: string,
  encoding: "base64" | "hex",
  rawPayload: CanonicalTransactionPayload,
  network: NetworkId,
): { ok: true } | { ok: false; reason: string } {
  try {
    if (encoding !== "hex") return { ok: false, reason: "EVM transactions are hex" };
    const payload = CanonicalTransactionPayloadSchema.parse(rawPayload);
    if (payload.network !== network) return { ok: false, reason: "payload is for another network" };
    const tx = parseTransaction(serialized as Hex);
    if (tx.type !== "eip1559") return { ok: false, reason: "only EIP-1559 transactions are built" };
    // Reject any signature field, including the legacy `v`.
    const legacyV = (tx as { v?: unknown }).v;
    if (
      tx.r !== undefined ||
      tx.s !== undefined ||
      tx.yParity !== undefined ||
      legacyV !== undefined
    ) {
      return { ok: false, reason: "transaction is already signed" };
    }
    if (tx.chainId !== evmChainId(network)) return { ok: false, reason: "wrong chain id" };
    if (tx.accessList !== undefined && tx.accessList.length > 0) {
      return { ok: false, reason: "access lists are not allowed" };
    }
    const gas = tx.gas ?? 0n;
    const maxFee = tx.maxFeePerGas ?? 0n;
    if (gas === 0n || maxFee === 0n) return { ok: false, reason: "missing gas or fee" };
    if (gas * maxFee > parseBaseUnits(payload.feeCap)) {
      return { ok: false, reason: `gas * maxFeePerGas exceeds fee cap ${payload.feeCap}` };
    }
    if ((tx.maxPriorityFeePerGas ?? 0n) > maxFee) return { ok: false, reason: "tip above max fee" };
    const amount = parseBaseUnits(payload.amount);
    const to = tx.to ?? null;
    const data = tx.data ?? "0x";
    const value = tx.value ?? 0n;
    if (to === null) return { ok: false, reason: "contract creation is not allowed" };

    if (payload.asset.kind === "native") {
      if (!addressesEqual("evm", to, payload.to)) return { ok: false, reason: "wrong recipient" };
      if (value !== amount) return { ok: false, reason: "wrong amount" };
      if (data !== "0x") return { ok: false, reason: "native transfer must not carry calldata" };
      return { ok: true };
    }
    if (payload.asset.kind !== "erc20") return { ok: false, reason: "unsupported asset kind" };
    const token = parseAssetId(payload.asset.id).tokenAddress ?? "";
    if (!addressesEqual("evm", to, token)) return { ok: false, reason: "wrong token contract" };
    if (value !== 0n) return { ok: false, reason: "token transfer must not send ether" };
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== "transfer")
      return { ok: false, reason: "calldata is not transfer()" };
    const [recipient, sent] = decoded.args;
    if (!addressesEqual("evm", recipient, payload.to))
      return { ok: false, reason: "wrong recipient" };
    if (sent !== amount) return { ok: false, reason: "wrong amount" };
    const canonical = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, sent],
    });
    if (canonical !== data.toLowerCase()) {
      return { ok: false, reason: "calldata has trailing bytes" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot decode transaction: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

/** Map an eth_call/eth_estimateGas failure to a shared error code. */
export function mapExecutionError(error: unknown): ChainError {
  if (error instanceof JsonRpcError) {
    const msg = error.rpcMessage.toLowerCase();
    if (
      msg.includes("insufficient funds") ||
      msg.includes("exceeds balance") ||
      msg.includes("transfer amount exceeds")
    ) {
      return new ChainError("INSUFFICIENT_FUNDS", "insufficient funds for amount plus gas", {
        cause: error,
      });
    }
    if (msg.includes("revert") || error.rpcCode === 3) {
      return new ChainError("VALIDATION_FAILED", `transaction would revert: ${error.rpcMessage}`, {
        cause: error,
      });
    }
    return new ChainError("UPSTREAM_UNAVAILABLE", error.message, { cause: error });
  }
  if (error instanceof ChainError) return error;
  return new ChainError("INTERNAL_ERROR", "unexpected error", { cause: error });
}
