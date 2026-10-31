import type { Broadcaster, NetworkId } from "@zyropay/shared";
import { chainFamilyOf } from "@zyropay/shared";
import { createEvmBroadcaster, createSolanaBroadcaster } from "./broadcast";
import type { CardanoBroadcaster } from "./cardano/broadcast";
import { createCardanoBroadcaster } from "./cardano/broadcast";
import { ChainError } from "./errors";
import { EvmRpc } from "./evm/rpc";
import type { HttpOptions } from "./http";
import type { SolanaCommitment } from "./solana/rpc";
import { SolanaRpc } from "./solana/rpc";

export interface NetworkTrackingConfig {
  /** Solana / EVM RPC URL (required for those families). */
  readonly rpcUrl?: string;
  /** EVM: confirmations required. Default 2. Cardano: blocks required. Default 3. */
  readonly confirmations?: number;
  /** Cardano: Blockfrost project id of this network (and an optional base URL override). */
  readonly blockfrostProjectId?: string;
  readonly blockfrostBaseUrl?: string;
  /** Solana: commitment required. Default "confirmed". */
  readonly commitment?: SolanaCommitment;
}

export interface ConfirmationTrackerConfig extends HttpOptions {
  readonly networks: Partial<Record<NetworkId, NetworkTrackingConfig>>;
}

export type TrackedStatus =
  /** Not final yet; poll again. */
  | "pending"
  /** Reached the required commitment / confirmations. */
  | "confirmed"
  /** Landed and failed (reverted / instruction error). Fees were paid. */
  | "failed"
  /** Solana: blockhash expired; Cardano: TTL passed. It can never land; safe to rebuild. */
  | "expired"
  /** EVM: the nonce was consumed by a different transaction (replaced or cancelled). */
  | "replaced";

export interface TrackInput {
  readonly network: NetworkId;
  readonly txHash: string;
  /** Solana: lastValidBlockHeight of the signed transaction (enables `expired`). */
  readonly lastValidBlockHeight?: string;
  /** EVM: sender and nonce (enable `replaced` detection). */
  readonly from?: string;
  readonly nonce?: number;
  /** Cardano: TTL slot of the signed transaction (enables `expired`). */
  readonly validUntilSlot?: string;
}

export interface TrackResult {
  readonly status: TrackedStatus;
  readonly confirmations: number;
  readonly error: string | null;
  /** True when the tx is unknown to the node but may still be valid: rebroadcast the same bytes. */
  readonly rebroadcastSuggested: boolean;
  readonly simulated: false;
}

export interface ConfirmationTracker {
  track(input: TrackInput): Promise<TrackResult>;
}

/**
 * Turns broadcaster status into a terminal decision for the API's Cron watcher. Only the
 * chain decides: `expired` is returned only when the blockhash is provably past its last
 * valid block height, `replaced` only when the sender's confirmed nonce moved past ours
 * without our receipt.
 */
export function createConfirmationTracker(config: ConfirmationTrackerConfig): ConfirmationTracker {
  const broadcasters = new Map<NetworkId, Broadcaster>();
  const solanaRpcs = new Map<NetworkId, SolanaRpc>();
  const evmRpcs = new Map<NetworkId, EvmRpc>();
  const cardano = new Map<NetworkId, CardanoBroadcaster>();
  for (const [network, net] of Object.entries(config.networks) as [
    NetworkId,
    NetworkTrackingConfig,
  ][]) {
    const family = chainFamilyOf(network);
    if (family === "cardano") {
      if (!net.blockfrostProjectId) {
        throw new ChainError("INTERNAL_ERROR", `no Blockfrost project id for ${network}`);
      }
      cardano.set(
        network,
        createCardanoBroadcaster({
          ...config,
          network,
          blockfrostProjectId: net.blockfrostProjectId,
          ...(net.blockfrostBaseUrl !== undefined
            ? { blockfrostBaseUrl: net.blockfrostBaseUrl }
            : {}),
          confirmations: net.confirmations ?? 3,
        }),
      );
      continue;
    }
    if (net.rpcUrl === undefined) {
      throw new ChainError("INTERNAL_ERROR", `no RPC URL for ${network}`);
    }
    if (family === "solana") {
      const options = { ...config, rpcUrl: net.rpcUrl, network };
      broadcasters.set(
        network,
        createSolanaBroadcaster({ ...options, commitment: net.commitment ?? "confirmed" }),
      );
      solanaRpcs.set(network, new SolanaRpc(options));
    } else {
      const options = { ...config, rpcUrl: net.rpcUrl, network };
      broadcasters.set(
        network,
        createEvmBroadcaster({ ...options, confirmations: net.confirmations ?? 2 }),
      );
      evmRpcs.set(network, new EvmRpc(options));
    }
  }

  return {
    async track(input) {
      const ada = cardano.get(input.network);
      if (ada !== undefined) {
        const result = await ada.track({
          txHash: input.txHash,
          ...(input.validUntilSlot !== undefined ? { validUntilSlot: input.validUntilSlot } : {}),
        });
        return { ...result, simulated: false };
      }
      const broadcaster = broadcasters.get(input.network);
      if (broadcaster === undefined) {
        throw new ChainError(
          "NETWORK_NOT_SUPPORTED",
          `tracker not configured for ${input.network}`,
        );
      }
      const status = await broadcaster.getStatus({ network: input.network, txHash: input.txHash });
      const base = {
        confirmations: status.confirmations,
        error: status.error,
        simulated: false as const,
      };
      if (status.status === "confirmed" || status.status === "failed") {
        return { ...base, status: status.status, rebroadcastSuggested: false };
      }
      if (status.confirmations > 0)
        return { ...base, status: "pending", rebroadcastSuggested: false };

      const solana = solanaRpcs.get(input.network);
      if (solana !== undefined) {
        if (input.lastValidBlockHeight === undefined) {
          return { ...base, status: "pending", rebroadcastSuggested: false };
        }
        const height = await solana.getBlockHeight("confirmed");
        if (height > BigInt(input.lastValidBlockHeight)) {
          // Re-check once: the status may have landed between the two reads.
          const again = await broadcaster.getStatus({
            network: input.network,
            txHash: input.txHash,
          });
          if (again.status !== "pending" || again.confirmations > 0) {
            return {
              ...base,
              status: again.status,
              confirmations: again.confirmations,
              error: again.error,
              rebroadcastSuggested: false,
            };
          }
          return {
            ...base,
            status: "expired",
            error: "blockhash expired",
            rebroadcastSuggested: false,
          };
        }
        return { ...base, status: "pending", rebroadcastSuggested: true };
      }

      const evm = evmRpcs.get(input.network);
      if (evm !== undefined) {
        const tx = await evm.getTransaction(input.txHash);
        if (tx !== null) return { ...base, status: "pending", rebroadcastSuggested: false };
        if (input.from !== undefined && input.nonce !== undefined) {
          const latest = await evm.getNonce(input.from, "latest");
          if (latest > BigInt(input.nonce)) {
            return {
              ...base,
              status: "replaced",
              error: "nonce used by another transaction",
              rebroadcastSuggested: false,
            };
          }
        }
        return { ...base, status: "pending", rebroadcastSuggested: true };
      }
      return { ...base, status: "pending", rebroadcastSuggested: false };
    },
  };
}
