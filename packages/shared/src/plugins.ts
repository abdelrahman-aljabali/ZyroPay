import { z } from "zod";
import { getNetwork, NetworkIdSchema, type NetworkId } from "./networks";
import { McpToolNameSchema } from "./tools";

/** Plugin ids are lowercase slugs; the known set is KNOWN_PLUGIN_IDS. */
export const PluginIdSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, "plugin id must be a lowercase slug");
export type PluginId = z.infer<typeof PluginIdSchema>;

export const KNOWN_PLUGIN_IDS = ["jupiter", "x402", "kamino", "aave", "hyperliquid"] as const;
export type KnownPluginId = (typeof KNOWN_PLUGIN_IDS)[number];

export const PluginPermissionSchema = z.enum([
  /** Read balances/positions of allowed wallets. */
  "read_wallets",
  /** Build transactions that the user or an autonomous agent will sign. */
  "build_transactions",
  /** Move value out of a wallet (transfers, payments, swaps). */
  "spend_funds",
  /** Deposit into third-party contracts/programs (lending, vaults). */
  "deposit_to_protocol",
  /** Open leveraged positions. */
  "leverage",
  /** Call a third-party HTTP API on the user's behalf. */
  "external_http",
]);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const RiskCategorySchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskCategory = z.infer<typeof RiskCategorySchema>;

export const PluginToolSchema = z.object({
  /** Plugin-level action name, e.g. "swap", "deposit". */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  valueMoving: z.boolean(),
  /** The MCP tool that surfaces this action, if any. */
  mcpTool: McpToolNameSchema.nullable(),
});
export type PluginTool = z.infer<typeof PluginToolSchema>;

export const PluginConfigRequirementSchema = z.object({
  /** Environment variable name (must also be listed in .env.example). */
  envVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string().min(1),
  secret: z.boolean(),
  required: z.boolean(),
});
export type PluginConfigRequirement = z.infer<typeof PluginConfigRequirementSchema>;

export const PluginStatusSchema = z.enum(["available", "coming_soon"]);

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  homepage: z.url(),
  status: PluginStatusSchema,
  networks: z.array(NetworkIdSchema),
  tools: z.array(PluginToolSchema).min(1),
  requiredPermissions: z.array(PluginPermissionSchema).min(1),
  riskCategory: RiskCategorySchema,
  configRequirements: z.array(PluginConfigRequirementSchema),
  /** Free-text caveats shown to the user before enabling. */
  notes: z.array(z.string()),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Canonical registry (metadata only; adapters live in packages/integrations). */
export const PLUGIN_REGISTRY: readonly PluginManifest[] = [
  {
    id: "jupiter",
    name: "Jupiter",
    description: "Token swaps on Solana through the Jupiter aggregator.",
    homepage: "https://jup.ag",
    status: "available",
    networks: ["solana-mainnet"],
    tools: [
      {
        name: "swap",
        description: "Swap one SPL/SOL asset for another at a quoted minimum output.",
        valueMoving: true,
        mcpTool: "swap",
      },
    ],
    requiredPermissions: ["read_wallets", "build_transactions", "spend_funds", "external_http"],
    riskCategory: "medium",
    configRequirements: [
      {
        envVar: "JUPITER_API_KEY",
        description: "Jupiter API key (api.jup.ag).",
        secret: true,
        required: true,
      },
    ],
    notes: [
      "Solana mainnet only: Jupiter does not route on devnet or any other test network, so swaps there fail with SWAP_UNAVAILABLE_ON_NETWORK (never simulated).",
      "Router programs can move any token the transaction touches; ZyroPay binds the approval to the quoted minimum output.",
    ],
  },
  {
    id: "x402",
    name: "x402 payments",
    description: "Pay HTTP 402 payment-required resources with stablecoins or ADA (x402 protocol).",
    homepage: "https://x402.org",
    status: "available",
    networks: [
      "base-mainnet",
      "base-sepolia",
      "solana-mainnet",
      "solana-devnet",
      "cardano-mainnet",
      "cardano-preprod",
    ],
    tools: [
      {
        name: "pay",
        description: "Pay for an HTTP resource that answered 402 Payment Required.",
        valueMoving: true,
        mcpTool: "pay_x402",
      },
    ],
    requiredPermissions: ["read_wallets", "build_transactions", "spend_funds", "external_http"],
    riskCategory: "medium",
    configRequirements: [
      {
        envVar: "X402_FACILITATOR_URL",
        description: "x402 facilitator used to verify/settle payments.",
        secret: false,
        required: true,
      },
    ],
    notes: [
      "Payment amount is capped by the agent-supplied maxAmount and by policy limits.",
      "Cardano: the exact scheme's default (address-to-address) transfer method only; every Cardano payment needs the user's passkey.",
    ],
  },
  {
    id: "kamino",
    name: "Kamino",
    description: "Lending and liquidity vaults on Solana.",
    homepage: "https://kamino.finance",
    status: "coming_soon",
    networks: ["solana-mainnet"],
    tools: [
      {
        name: "deposit",
        description: "Deposit into a Kamino market.",
        valueMoving: true,
        mcpTool: null,
      },
      {
        name: "withdraw",
        description: "Withdraw from a Kamino market.",
        valueMoving: true,
        mcpTool: null,
      },
    ],
    requiredPermissions: ["read_wallets", "build_transactions", "deposit_to_protocol"],
    riskCategory: "high",
    configRequirements: [],
    notes: ["Smart-contract and liquidation risk. Not exposed to agents yet."],
  },
  {
    id: "aave",
    name: "Aave",
    description: "Lending markets on Ethereum and Base (Aave v3).",
    homepage: "https://aave.com",
    status: "coming_soon",
    networks: ["ethereum-mainnet", "base-mainnet", "ethereum-sepolia", "base-sepolia"],
    tools: [
      { name: "supply", description: "Supply an asset to Aave.", valueMoving: true, mcpTool: null },
      {
        name: "withdraw",
        description: "Withdraw a supplied asset.",
        valueMoving: true,
        mcpTool: null,
      },
    ],
    requiredPermissions: ["read_wallets", "build_transactions", "deposit_to_protocol"],
    riskCategory: "high",
    configRequirements: [],
    notes: ["Requires ERC-20 approvals; approvals are separate transaction requests."],
  },
  {
    id: "hyperliquid",
    name: "Hyperliquid",
    description: "Perpetual futures on the Hyperliquid L1.",
    homepage: "https://hyperliquid.xyz",
    status: "coming_soon",
    networks: [],
    tools: [
      {
        name: "open_position",
        description: "Open a perpetual position.",
        valueMoving: true,
        mcpTool: null,
      },
    ],
    requiredPermissions: [
      "read_wallets",
      "build_transactions",
      "spend_funds",
      "leverage",
      "external_http",
    ],
    riskCategory: "critical",
    configRequirements: [],
    notes: [
      "Runs on its own chain (deposits bridge from Arbitrum); no supported ZyroPay network yet.",
      "Leverage can lose more than the position size in fees and liquidation.",
    ],
  },
];

export function getPluginManifest(id: string): PluginManifest | undefined {
  return PLUGIN_REGISTRY.find((p) => p.id === id);
}

/** Networks with a real swap route: Jupiter routes on Solana mainnet only. */
export const SWAP_NETWORKS: readonly NetworkId[] = ["solana-mainnet"];

export function isSwapAvailableOn(network: NetworkId): boolean {
  return SWAP_NETWORKS.includes(network);
}

/**
 * The one explanation for a swap requested where no route exists, shared by the API error
 * (SWAP_UNAVAILABLE_ON_NETWORK), the MCP tool and the app, so every surface says the same.
 */
export function swapUnavailableMessage(network: NetworkId): string {
  const info = getNetwork(network);
  const where = info.isTestnet ? `${info.displayName} (test network)` : info.displayName;
  return `Swaps are available on Solana mainnet only. This wallet is on ${where}, so no swap can be made.`;
}
