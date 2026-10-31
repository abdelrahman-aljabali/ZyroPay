import type { NetworkId } from "@zyropay/shared";
import { NETWORKS } from "@zyropay/shared";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord, JsonRpcClient, resolveHttpOptions, toBigInt } from "../http";
import type { MintExtension } from "./constants";

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

export interface SolanaRpcOptions extends HttpOptions {
  readonly rpcUrl: string;
  readonly network: NetworkId;
}

export interface ParsedMintInfo {
  readonly programId: string;
  readonly decimals: number;
  /** Token-2022 extensions with their parsed state (empty for the classic Token program). */
  readonly extensions: readonly MintExtension[];
}

export interface SimulationResult {
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: bigint | null;
}

/**
 * Typed wrapper around the Solana JSON-RPC methods ZyroPay needs. Uses plain fetch (not the
 * kit RPC client) so every call can be replayed from recorded fixtures, and so u64 values are
 * parsed losslessly. The first call checks the node's genesis hash against the bound network:
 * a devnet URL can never serve a mainnet builder or the reverse.
 */
export class SolanaRpc {
  private readonly rpc: JsonRpcClient;
  private genesisChecked: Promise<void> | null = null;

  constructor(readonly options: SolanaRpcOptions) {
    this.rpc = new JsonRpcClient(options.rpcUrl, resolveHttpOptions(options), "solana-rpc");
  }

  get network(): NetworkId {
    return this.options.network;
  }

  /** Raw call without the genesis check (used by the genesis check itself). */
  raw<T>(method: string, params: unknown[]): Promise<T> {
    return this.rpc.call<T>(method, params);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    await this.assertGenesis();
    return this.rpc.call<T>(method, params);
  }

  assertGenesis(): Promise<void> {
    this.genesisChecked ??= (async () => {
      const genesis = await this.rpc.call("getGenesisHash", []);
      const expected = NETWORKS[this.options.network].caip2.split(":")[1] ?? "";
      if (typeof genesis !== "string" || !genesis.startsWith(expected)) {
        throw new ChainError(
          "NETWORK_MODE_MISMATCH",
          `RPC endpoint does not serve ${this.options.network} (genesis hash mismatch)`,
        );
      }
    })().catch((error: unknown) => {
      this.genesisChecked = null;
      throw error;
    });
    return this.genesisChecked;
  }

  async getLatestBlockhash(
    commitment: SolanaCommitment = "confirmed",
  ): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const result = await this.call<unknown>("getLatestBlockhash", [{ commitment }]);
    const value = isRecord(result) ? result.value : undefined;
    if (!isRecord(value) || typeof value.blockhash !== "string") {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "getLatestBlockhash: malformed response");
    }
    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: toBigInt(value.lastValidBlockHeight, "lastValidBlockHeight"),
    };
  }

  async getBlockHeight(commitment: SolanaCommitment = "confirmed"): Promise<bigint> {
    return toBigInt(await this.call<unknown>("getBlockHeight", [{ commitment }]), "blockHeight");
  }

  async getBalance(address: string, commitment: SolanaCommitment = "confirmed"): Promise<bigint> {
    const result = await this.call<unknown>("getBalance", [address, { commitment }]);
    return toBigInt(isRecord(result) ? result.value : undefined, "balance");
  }

  /** Account owner program and lamports, or null when the account does not exist. */
  async getAccountOwner(address: string): Promise<{ owner: string; lamports: bigint } | null> {
    const result = await this.call<unknown>("getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
    ]);
    const value = isRecord(result) ? result.value : undefined;
    if (value === null) return null;
    if (!isRecord(value) || typeof value.owner !== "string") {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "getAccountInfo: malformed response");
    }
    return { owner: value.owner, lamports: toBigInt(value.lamports, "lamports") };
  }

  /** Parsed SPL mint (Token or Token-2022). Null if the account does not exist or is no mint. */
  async getMint(mint: string): Promise<ParsedMintInfo | null> {
    const result = await this.call<unknown>("getAccountInfo", [
      mint,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const value = isRecord(result) ? result.value : undefined;
    if (value === null || !isRecord(value)) return null;
    const data = value.data;
    if (!isRecord(data) || !isRecord(data.parsed)) return null;
    const parsed = data.parsed;
    if (parsed.type !== "mint" || !isRecord(parsed.info)) return null;
    const decimals = parsed.info.decimals;
    if (typeof decimals !== "number" || typeof value.owner !== "string") return null;
    const extensions = Array.isArray(parsed.info.extensions)
      ? parsed.info.extensions.flatMap((e): MintExtension[] =>
          isRecord(e) && typeof e.extension === "string"
            ? [{ name: e.extension, state: isRecord(e.state) ? e.state : {} }]
            : [],
        )
      : [];
    return { programId: value.owner, decimals, extensions };
  }

  /** Recent per-slot prioritization fees (micro-lamports per CU) for the given accounts. */
  async getRecentPrioritizationFees(accounts: readonly string[]): Promise<bigint[]> {
    const result = await this.call<unknown>("getRecentPrioritizationFees", [accounts]);
    if (!Array.isArray(result)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "getRecentPrioritizationFees: malformed");
    }
    return result.map((r) =>
      toBigInt(isRecord(r) ? r.prioritizationFee : undefined, "prioritizationFee"),
    );
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<bigint> {
    return toBigInt(
      await this.call<unknown>("getMinimumBalanceForRentExemption", [dataLength]),
      "rentExemption",
    );
  }

  async simulate(
    base64Tx: string,
    options: { replaceRecentBlockhash: boolean },
  ): Promise<SimulationResult> {
    const result = await this.call<unknown>("simulateTransaction", [
      base64Tx,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: options.replaceRecentBlockhash,
        commitment: "confirmed",
      },
    ]);
    const value = isRecord(result) ? result.value : undefined;
    if (!isRecord(value)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "simulateTransaction: malformed response");
    }
    const logs = Array.isArray(value.logs)
      ? value.logs.filter((l): l is string => typeof l === "string")
      : [];
    const units =
      value.unitsConsumed === undefined || value.unitsConsumed === null
        ? null
        : toBigInt(value.unitsConsumed, "unitsConsumed");
    return { err: value.err ?? null, logs, unitsConsumed: units };
  }
}
