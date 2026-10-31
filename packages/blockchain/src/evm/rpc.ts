import type { NetworkId } from "@zyropay/shared";
import { evmChainId } from "@zyropay/shared";
import type { Hex } from "viem";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord, JsonRpcClient, resolveHttpOptions, toBigInt } from "../http";

export interface EvmRpcOptions extends HttpOptions {
  readonly rpcUrl: string;
  readonly network: NetworkId;
}

export interface EvmCall {
  readonly from?: string;
  readonly to: string;
  readonly value?: bigint;
  readonly data?: Hex;
}

export interface EvmReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function callObject(call: EvmCall): Record<string, string> {
  const out: Record<string, string> = { to: call.to };
  if (call.from !== undefined) out.from = call.from;
  if (call.value !== undefined) out.value = hex(call.value);
  if (call.data !== undefined) out.data = call.data;
  return out;
}

/**
 * Typed EVM JSON-RPC over fetch. The first call asserts `eth_chainId` equals the bound
 * network's EIP-155 id, so a Sepolia URL can never serve a mainnet builder.
 */
export class EvmRpc {
  private readonly rpc: JsonRpcClient;
  private chainChecked: Promise<void> | null = null;
  readonly chainId: number;

  constructor(readonly options: EvmRpcOptions) {
    this.rpc = new JsonRpcClient(options.rpcUrl, resolveHttpOptions(options), "evm-rpc");
    this.chainId = evmChainId(options.network);
  }

  get network(): NetworkId {
    return this.options.network;
  }

  assertChain(): Promise<void> {
    this.chainChecked ??= (async () => {
      const id = toBigInt(await this.rpc.call("eth_chainId", []), "chainId");
      if (id !== BigInt(this.chainId)) {
        throw new ChainError(
          "NETWORK_MODE_MISMATCH",
          `RPC endpoint serves chain ${id}, expected ${this.chainId} (${this.options.network})`,
        );
      }
    })().catch((error: unknown) => {
      this.chainChecked = null;
      throw error;
    });
    return this.chainChecked;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    await this.assertChain();
    return this.rpc.call<T>(method, params);
  }

  async getBalance(address: string): Promise<bigint> {
    return toBigInt(await this.call<unknown>("eth_getBalance", [address, "latest"]), "balance");
  }

  async getNonce(address: string, block: "latest" | "pending"): Promise<bigint> {
    return toBigInt(await this.call<unknown>("eth_getTransactionCount", [address, block]), "nonce");
  }

  async blockNumber(): Promise<bigint> {
    return toBigInt(await this.call<unknown>("eth_blockNumber", []), "blockNumber");
  }

  async ethCall(call: EvmCall, block: "latest" | "pending" = "latest"): Promise<Hex> {
    const result = await this.call<unknown>("eth_call", [callObject(call), block]);
    if (typeof result !== "string" || !result.startsWith("0x")) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "eth_call: malformed result");
    }
    return result as Hex;
  }

  async estimateGas(call: EvmCall): Promise<bigint> {
    return toBigInt(await this.call<unknown>("eth_estimateGas", [callObject(call)]), "gas");
  }

  async getCode(address: string): Promise<Hex> {
    const result = await this.call<unknown>("eth_getCode", [address, "latest"]);
    return (typeof result === "string" ? result : "0x") as Hex;
  }

  /** Base fee of the pending block and the median priority fee of recent blocks. */
  async feeData(): Promise<{ baseFee: bigint; priorityFee: bigint }> {
    const history = await this.call<unknown>("eth_feeHistory", ["0x5", "latest", [50]]);
    if (!isRecord(history) || !Array.isArray(history.baseFeePerGas)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "eth_feeHistory: malformed result");
    }
    const baseFees = history.baseFeePerGas;
    // The last entry is the base fee of the next (pending) block.
    const baseFee = toBigInt(baseFees[baseFees.length - 1], "baseFeePerGas");
    const rewards = Array.isArray(history.reward)
      ? history.reward
          .map((r: unknown): unknown => (Array.isArray(r) ? (r[0] as unknown) : undefined))
          .filter((r) => r !== undefined)
          .map((r) => toBigInt(r, "reward"))
      : [];
    rewards.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let priorityFee = rewards.length > 0 ? (rewards[Math.floor(rewards.length / 2)] ?? 0n) : 0n;
    if (priorityFee === 0n) {
      try {
        priorityFee = toBigInt(await this.call<unknown>("eth_maxPriorityFeePerGas", []), "tip");
      } catch {
        priorityFee = 0n;
      }
    }
    return { baseFee, priorityFee };
  }

  async sendRawTransaction(signed: Hex): Promise<string> {
    const result = await this.call<unknown>("eth_sendRawTransaction", [signed]);
    if (typeof result !== "string") {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "eth_sendRawTransaction: malformed result");
    }
    return result;
  }

  async getReceipt(txHash: string): Promise<EvmReceipt | null> {
    const r = await this.call<unknown>("eth_getTransactionReceipt", [txHash]);
    if (r === null) return null;
    if (!isRecord(r)) throw new ChainError("UPSTREAM_UNAVAILABLE", "receipt: malformed result");
    return {
      status: toBigInt(r.status, "status") === 1n ? "success" : "reverted",
      blockNumber: toBigInt(r.blockNumber, "blockNumber"),
      gasUsed: toBigInt(r.gasUsed, "gasUsed"),
      effectiveGasPrice: toBigInt(r.effectiveGasPrice ?? "0x0", "effectiveGasPrice"),
    };
  }

  /** Mempool/chain lookup; null when the node does not know the hash. */
  async getTransaction(
    txHash: string,
  ): Promise<{ nonce: bigint; from: string; blockNumber: bigint | null } | null> {
    const t = await this.call<unknown>("eth_getTransactionByHash", [txHash]);
    if (t === null) return null;
    if (!isRecord(t) || typeof t.from !== "string") {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "transaction: malformed result");
    }
    return {
      nonce: toBigInt(t.nonce, "nonce"),
      from: t.from,
      blockNumber:
        t.blockNumber === null || t.blockNumber === undefined
          ? null
          : toBigInt(t.blockNumber, "blockNumber"),
    };
  }
}
