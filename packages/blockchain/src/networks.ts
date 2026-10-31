import type { ChainFamily, NetworkId } from "@zyropay/shared";
import { chainFamilyOf, isValidAddressForNetwork, NETWORKS } from "@zyropay/shared";
import { ChainError } from "./errors";

export interface RpcKeys {
  /**
   * One Helius key, or an ordered list (primary first). The URL carries the first key; the
   * others are reached through the failover fetch (`heliusKeyPool(...).wrap(fetch)`).
   */
  readonly heliusApiKey?: string | readonly string[] | undefined;
  readonly alchemyApiKey?: string | undefined;
}

const HELIUS_HOST: Partial<Record<NetworkId, string>> = {
  "solana-mainnet": "mainnet.helius-rpc.com",
  "solana-devnet": "devnet.helius-rpc.com",
};

const ALCHEMY_SUBDOMAIN: Partial<Record<NetworkId, string>> = {
  "ethereum-mainnet": "eth-mainnet",
  "ethereum-sepolia": "eth-sepolia",
  "base-mainnet": "base-mainnet",
  "base-sepolia": "base-sepolia",
};

/**
 * Authenticated RPC URL for a network: Helius for Solana, Alchemy for Ethereum and Base.
 * The URL embeds the API key, so never log it. Throws when the needed key is missing:
 * there is no silent fallback to a public endpoint (public RPCs are rate-limited and must
 * be opted into explicitly with `publicRpcUrlFor`).
 */
export function rpcUrlFor(network: NetworkId, keys: RpcKeys): string {
  const helius = HELIUS_HOST[network];
  if (helius !== undefined) {
    const key = typeof keys.heliusApiKey === "string" ? keys.heliusApiKey : keys.heliusApiKey?.[0];
    if (!key) throw new ChainError("INTERNAL_ERROR", "HELIUS_API_KEY is not set");
    return `https://${helius}/?api-key=${encodeURIComponent(key)}`;
  }
  const alchemy = ALCHEMY_SUBDOMAIN[network];
  if (alchemy !== undefined) {
    if (!keys.alchemyApiKey) throw new ChainError("INTERNAL_ERROR", "ALCHEMY_API_KEY is not set");
    return `https://${alchemy}.g.alchemy.com/v2/${encodeURIComponent(keys.alchemyApiKey)}`;
  }
  throw new ChainError("NETWORK_NOT_SUPPORTED", `no RPC provider for ${network}`);
}

/** Networks reached over JSON-RPC (Cardano is reached through Blockfrost's REST API). */
export type RpcNetworkId = Exclude<NetworkId, "cardano-mainnet" | "cardano-preprod">;

/** Keyless public endpoints. Rate-limited; for local development and live tests only. */
export const PUBLIC_RPC_URLS: Readonly<Record<RpcNetworkId, string>> = {
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
  "ethereum-mainnet": "https://ethereum-rpc.publicnode.com",
  "ethereum-sepolia": "https://ethereum-sepolia-rpc.publicnode.com",
  "base-mainnet": "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

export function publicRpcUrlFor(network: RpcNetworkId): string {
  return PUBLIC_RPC_URLS[network];
}

/** Throws NETWORK_NOT_SUPPORTED unless `network` belongs to `family`. */
export function assertFamily(network: NetworkId, family: ChainFamily): void {
  if (chainFamilyOf(network) !== family) {
    throw new ChainError("NETWORK_NOT_SUPPORTED", `${network} is not a ${family} network`);
  }
}

/** Throws NETWORK_MODE_MISMATCH when a request targets a network other than the bound one. */
export function assertSameNetwork(bound: NetworkId, requested: NetworkId): void {
  if (bound !== requested) {
    throw new ChainError(
      "NETWORK_MODE_MISMATCH",
      `this component is bound to ${bound}; refusing ${requested}`,
    );
  }
}

/** Throws INVALID_ADDRESS when `address` is not valid for `network`'s family. */
export function assertAddress(network: NetworkId, address: string, field = "address"): void {
  if (!isValidAddressForNetwork(network, address)) {
    throw new ChainError(
      "INVALID_ADDRESS",
      `${field} is not a valid ${NETWORKS[network].family} address for ${network}`,
    );
  }
}
