import { z } from "zod";
import type { ZyroPayMode } from "./common";

export const NETWORK_IDS = [
  "solana-mainnet",
  "solana-devnet",
  "ethereum-mainnet",
  "ethereum-sepolia",
  "base-mainnet",
  "base-sepolia",
  "cardano-mainnet",
  "cardano-preprod",
] as const;

export const NetworkIdSchema = z.enum(NETWORK_IDS);
export type NetworkId = z.infer<typeof NetworkIdSchema>;

export const ChainFamilySchema = z.enum(["solana", "evm", "cardano"]);
export type ChainFamily = z.infer<typeof ChainFamilySchema>;

export interface NativeCurrency {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface NetworkInfo {
  readonly id: NetworkId;
  readonly family: ChainFamily;
  readonly displayName: string;
  readonly isTestnet: boolean;
  /** EIP-155 chain id; null for Solana and Cardano. */
  readonly evmChainId: number | null;
  /**
   * Cardano only: the network id encoded in every Shelley address header (1 = mainnet,
   * 0 = every testnet, so preprod and preview addresses look the same) and the network
   * magic of the genesis (mainnet 764824073, preprod 1). Null for other families.
   */
  readonly cardano: { readonly networkId: 0 | 1; readonly networkMagic: number } | null;
  /** CAIP-2 chain identifier (used by x402 and wallet interop). */
  readonly caip2: string;
  /** The network on the other side of the mainnet/testnet divide. */
  readonly counterpart: NetworkId;
  readonly nativeCurrency: NativeCurrency;
  /** Explorer URL for a transaction; `{tx}` is replaced with the hash/signature. */
  readonly explorerTxUrl: string;
}

const SOL: NativeCurrency = { symbol: "SOL", name: "Solana", decimals: 9 };
const ETH: NativeCurrency = { symbol: "ETH", name: "Ether", decimals: 18 };
/** 1 ADA = 1,000,000 lovelace. */
const ADA: NativeCurrency = { symbol: "ADA", name: "Cardano", decimals: 6 };

export const NETWORKS: Readonly<Record<NetworkId, NetworkInfo>> = {
  "solana-mainnet": {
    id: "solana-mainnet",
    family: "solana",
    displayName: "Solana",
    isTestnet: false,
    evmChainId: null,
    cardano: null,
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    counterpart: "solana-devnet",
    nativeCurrency: SOL,
    explorerTxUrl: "https://solscan.io/tx/{tx}",
  },
  "solana-devnet": {
    id: "solana-devnet",
    family: "solana",
    displayName: "Solana Devnet",
    isTestnet: true,
    evmChainId: null,
    cardano: null,
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    counterpart: "solana-mainnet",
    nativeCurrency: SOL,
    explorerTxUrl: "https://solscan.io/tx/{tx}?cluster=devnet",
  },
  "ethereum-mainnet": {
    id: "ethereum-mainnet",
    family: "evm",
    displayName: "Ethereum",
    isTestnet: false,
    evmChainId: 1,
    cardano: null,
    caip2: "eip155:1",
    counterpart: "ethereum-sepolia",
    nativeCurrency: ETH,
    explorerTxUrl: "https://etherscan.io/tx/{tx}",
  },
  "ethereum-sepolia": {
    id: "ethereum-sepolia",
    family: "evm",
    displayName: "Ethereum Sepolia",
    isTestnet: true,
    evmChainId: 11155111,
    cardano: null,
    caip2: "eip155:11155111",
    counterpart: "ethereum-mainnet",
    nativeCurrency: ETH,
    explorerTxUrl: "https://sepolia.etherscan.io/tx/{tx}",
  },
  "base-mainnet": {
    id: "base-mainnet",
    family: "evm",
    displayName: "Base",
    isTestnet: false,
    evmChainId: 8453,
    cardano: null,
    caip2: "eip155:8453",
    counterpart: "base-sepolia",
    nativeCurrency: ETH,
    explorerTxUrl: "https://basescan.org/tx/{tx}",
  },
  "base-sepolia": {
    id: "base-sepolia",
    family: "evm",
    displayName: "Base Sepolia",
    isTestnet: true,
    evmChainId: 84532,
    cardano: null,
    caip2: "eip155:84532",
    counterpart: "base-mainnet",
    nativeCurrency: ETH,
    explorerTxUrl: "https://sepolia.basescan.org/tx/{tx}",
  },
  // CAIP-2 for Cardano is CIP-34: cip34:<network id>-<network magic>.
  "cardano-mainnet": {
    id: "cardano-mainnet",
    family: "cardano",
    displayName: "Cardano",
    isTestnet: false,
    evmChainId: null,
    cardano: { networkId: 1, networkMagic: 764824073 },
    caip2: "cip34:1-764824073",
    counterpart: "cardano-preprod",
    nativeCurrency: ADA,
    explorerTxUrl: "https://cardanoscan.io/transaction/{tx}",
  },
  "cardano-preprod": {
    id: "cardano-preprod",
    family: "cardano",
    displayName: "Cardano Preprod",
    isTestnet: true,
    evmChainId: null,
    cardano: { networkId: 0, networkMagic: 1 },
    caip2: "cip34:0-1",
    counterpart: "cardano-mainnet",
    nativeCurrency: ADA,
    explorerTxUrl: "https://preprod.cardanoscan.io/transaction/{tx}",
  },
};

export function getNetwork(id: NetworkId): NetworkInfo {
  return NETWORKS[id];
}

export function chainFamilyOf(id: NetworkId): ChainFamily {
  return NETWORKS[id].family;
}

export function isTestnet(id: NetworkId): boolean {
  return NETWORKS[id].isTestnet;
}

export function isMainnet(id: NetworkId): boolean {
  return !NETWORKS[id].isTestnet;
}

export const MAINNET_NETWORKS: readonly NetworkId[] = NETWORK_IDS.filter(isMainnet);
export const TESTNET_NETWORKS: readonly NetworkId[] = NETWORK_IDS.filter(isTestnet);

export function networksOfFamily(family: ChainFamily): NetworkId[] {
  return NETWORK_IDS.filter((id) => NETWORKS[id].family === family);
}

/** EIP-155 chain id. Throws for non-EVM networks. */
export function evmChainId(id: NetworkId): number {
  const chainId = NETWORKS[id].evmChainId;
  if (chainId === null) throw new Error(`${id} is not an EVM network`);
  return chainId;
}

/** Cardano address network id (1 mainnet, 0 testnet). Throws for non-Cardano networks. */
export function cardanoNetworkId(id: NetworkId): 0 | 1 {
  const info = NETWORKS[id].cardano;
  if (info === null) throw new Error(`${id} is not a Cardano network`);
  return info.networkId;
}

export function networkFromEvmChainId(chainId: number): NetworkId | undefined {
  return NETWORK_IDS.find((id) => NETWORKS[id].evmChainId === chainId);
}

export function explorerTxUrl(id: NetworkId, txHash: string): string {
  return NETWORKS[id].explorerTxUrl.replace("{tx}", encodeURIComponent(txHash));
}

/**
 * Mainnet/testnet separation. A deployment runs in exactly one mode:
 * production => mainnets only, development => testnets only. Real funds and test
 * funds never share a deployment, a database, or an approval screen.
 */
export function networksForMode(mode: ZyroPayMode): readonly NetworkId[] {
  return mode === "production" ? MAINNET_NETWORKS : TESTNET_NETWORKS;
}

export function isNetworkAllowedInMode(id: NetworkId, mode: ZyroPayMode): boolean {
  return networksForMode(mode).includes(id);
}

export class NetworkModeError extends Error {
  constructor(
    readonly network: NetworkId,
    readonly mode: ZyroPayMode,
  ) {
    super(`network ${network} is not available in ${mode} mode`);
    this.name = "NetworkModeError";
  }
}

export function assertNetworkAllowedInMode(id: NetworkId, mode: ZyroPayMode): void {
  if (!isNetworkAllowedInMode(id, mode)) throw new NetworkModeError(id, mode);
}

/** True when both networks are on the same side of the mainnet/testnet divide. */
export function sameEnvironment(a: NetworkId, b: NetworkId): boolean {
  return NETWORKS[a].isTestnet === NETWORKS[b].isTestnet;
}
