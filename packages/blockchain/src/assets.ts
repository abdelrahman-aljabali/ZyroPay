import type { Asset, AssetId, AssetKind, NetworkId } from "@zyropay/shared";
import {
  chainFamilyOf,
  sha256Hex,
  toChecksumAddress,
  TOKEN_KIND,
  tokenAssetId,
} from "@zyropay/shared";

export interface KnownToken {
  readonly network: NetworkId;
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Mainnet asset with the same value (used only by the opt-in testnet price proxy). */
  readonly mainnetEquivalent: AssetId | null;
}

const evm = (a: string): string => toChecksumAddress(a);

/**
 * Curated tokens shown as `verified: true`. Every other token is unverified and the app warns
 * before sending it. Sources: Circle USDC addresses
 * (https://developers.circle.com/stablecoins/usdc-contract-addresses), Tether.
 */
export const KNOWN_TOKENS: readonly KnownToken[] = [
  {
    network: "solana-mainnet",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    mainnetEquivalent: null,
  },
  {
    network: "solana-mainnet",
    address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    mainnetEquivalent: null,
  },
  {
    network: "solana-devnet",
    address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    symbol: "USDC",
    name: "USD Coin (Devnet)",
    decimals: 6,
    mainnetEquivalent: "solana-mainnet:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    network: "ethereum-mainnet",
    address: evm("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    mainnetEquivalent: null,
  },
  {
    network: "ethereum-mainnet",
    address: evm("0xdac17f958d2ee523a2206206994597c13d831ec7"),
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    mainnetEquivalent: null,
  },
  {
    network: "ethereum-sepolia",
    address: evm("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"),
    symbol: "USDC",
    name: "USD Coin (Sepolia)",
    decimals: 6,
    mainnetEquivalent: `ethereum-mainnet:${evm("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")}`,
  },
  {
    network: "base-mainnet",
    address: evm("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    mainnetEquivalent: null,
  },
  {
    network: "base-sepolia",
    address: evm("0x036cbd53842c5426634e7929541ec2318f3dcf7e"),
    symbol: "USDC",
    name: "USD Coin (Base Sepolia)",
    decimals: 6,
    mainnetEquivalent: `base-mainnet:${evm("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")}`,
  },
];

export function findKnownToken(network: NetworkId, address: string): KnownToken | undefined {
  const family = chainFamilyOf(network);
  return KNOWN_TOKENS.find(
    (t) =>
      t.network === network &&
      (family === "solana"
        ? t.address === address
        : t.address.toLowerCase() === address.toLowerCase()),
  );
}

function clean(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  // Strip control characters and trim: token metadata is attacker-controlled.
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  out = out.trim().slice(0, max);
  return out.length > 0 ? out : null;
}

function safeLogo(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Build a shared `Asset` for a token, preferring curated metadata over provider metadata. */
export function tokenAsset(input: {
  network: NetworkId;
  address: string;
  decimals: number;
  symbol?: string | null;
  name?: string | null;
  logoUrl?: unknown;
}): Asset {
  const family = chainFamilyOf(input.network);
  const address = family === "evm" ? toChecksumAddress(input.address) : input.address;
  const known = findKnownToken(input.network, address);
  const kind: AssetKind = TOKEN_KIND[family];
  const fallback = `${address.slice(0, 4)}…${address.slice(-4)}`;
  const symbol = known?.symbol ?? clean(input.symbol, 32) ?? fallback;
  return {
    id: tokenAssetId(input.network, address),
    network: input.network,
    kind,
    address,
    symbol,
    name: known?.name ?? clean(input.name, 128) ?? symbol,
    decimals: known?.decimals ?? input.decimals,
    logoUrl: safeLogo(input.logoUrl),
    verified: known !== undefined,
  };
}

/**
 * Deterministic UUID (RFC 9562 version 8, custom) from a stable key, so the same on-chain
 * transfer always gets the same `Transaction.id` across polls and pages.
 */
export function deterministicUuid(key: string): string {
  const hex = sha256Hex(key).slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
