import {
  chainFamilyOf,
  isSwapAvailableOn,
  networksForMode,
  swapUnavailableMessage,
  type PluginManifest,
  type PluginPermission,
  type ZyroPayMode,
} from "@zyropay/shared";
import type { IconName } from "@zyropay/ui";
import { env } from "@/lib/env";

/** Plain-language explanation of each plugin permission, shown before enabling. */
export const PERMISSION_COPY: Readonly<Record<PluginPermission, { title: string; body: string }>> =
  {
    read_wallets: {
      title: "See balances",
      body: "Reads balances and positions of the wallets you allow.",
    },
    build_transactions: {
      title: "Prepare transactions",
      body: "Builds transactions that you (or an autonomous agent within limits) sign.",
    },
    spend_funds: {
      title: "Move funds",
      body: "Can create payments, transfers or swaps out of your wallet. Each still follows your agent policies.",
    },
    deposit_to_protocol: {
      title: "Deposit into protocols",
      body: "Moves funds into third-party smart contracts, which carry their own risk.",
    },
    leverage: {
      title: "Use leverage",
      body: "Opens leveraged positions. You can lose more than you put in through fees and liquidation.",
    },
    external_http: {
      title: "Contact outside services",
      body: "Calls a third-party API on your behalf (for quotes or payments).",
    },
  };

export type PluginCategory = "Payments" | "Trading" | "Earn" | "Other";

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = ["Payments", "Trading", "Earn"];

/** Marketplace category, derived from what the plugin is allowed to do (the manifest has no category field). */
export function pluginCategory(
  m: Pick<PluginManifest, "requiredPermissions" | "tools">,
): PluginCategory {
  const perms = new Set(m.requiredPermissions);
  const tools = new Set(m.tools.map((t) => t.name));
  if (perms.has("leverage") || tools.has("swap") || tools.has("open_position")) return "Trading";
  if (perms.has("deposit_to_protocol")) return "Earn";
  if (tools.has("pay") || perms.has("spend_funds")) return "Payments";
  return "Other";
}

export const CATEGORY_ICON: Readonly<Record<PluginCategory, IconName>> = {
  Payments: "bolt",
  Trading: "swap",
  Earn: "layers",
  Other: "plug",
};

/** Whether the plugin offers the MCP `swap` tool (Jupiter). */
export function offersSwap(m: Pick<PluginManifest, "tools">): boolean {
  return m.tools.some((t) => t.mcpTool === "swap");
}

/**
 * The explanation shown wherever a swap could be started, when this build's networks have
 * no swap route (every development build: testnets only). Null where swaps can happen.
 * Same words as the API's SWAP_UNAVAILABLE_ON_NETWORK error.
 */
export function swapUnavailableReason(mode: ZyroPayMode = env.mode): string | null {
  const networks = networksForMode(mode);
  if (networks.some(isSwapAvailableOn)) return null;
  const solana = networks.find((n) => chainFamilyOf(n) === "solana");
  return solana === undefined ? null : swapUnavailableMessage(solana);
}

/**
 * Marketplace description. x402's shared manifest names ADA but not the chain, so the app
 * spells out the networks it pays on (Cardano included).
 */
export function pluginDescription(m: Pick<PluginManifest, "id" | "description">): string {
  if (m.id === "x402" && !/cardano/i.test(m.description))
    return "Pay HTTP 402 payment-required resources with stablecoins or ADA on Base, Solana and Cardano (x402 protocol).";
  return m.description;
}

/** Masumi escrow on the marketplace: shown next to x402 (it is how x402 escrows on Cardano). */
export const MASUMI_ESCROW_LISTING = {
  name: "Masumi escrow (Cardano)",
  line: "Locks agent payments until the seller delivers; refundable if they don't.",
  keywords: ["masumi", "escrow", "cardano", "x402", "refund", "agents"],
} as const;

/** Whether the Masumi escrow listing matches a marketplace search. */
export function masumiListingMatches(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    MASUMI_ESCROW_LISTING.name.toLowerCase().includes(q) ||
    MASUMI_ESCROW_LISTING.line.toLowerCase().includes(q) ||
    MASUMI_ESCROW_LISTING.keywords.some((k) => k.includes(q))
  );
}
