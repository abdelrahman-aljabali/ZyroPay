import { z } from "zod";
import { AddressSchema } from "./addresses";
import { CursorSchema, IdempotencyKeySchema } from "./common";
import { AgentPolicySchema } from "./domain/agents";
import { AssetIdSchema } from "./domain/assets";
import { PortfolioSnapshotSchema } from "./domain/portfolio";
import { TransactionRequestResultSchema } from "./domain/requests";
import { TransactionSchema } from "./domain/transactions";
import {
  MasumiAgentIdentifierSchema,
  MasumiAgentSearchResultSchema,
  MasumiAgentVerificationSchema,
} from "./domain/masumi";
import { WalletSchema } from "./domain/wallets";
import { BaseUnitAmountSchema, DecimalsSchema } from "./money";
import { NetworkIdSchema } from "./networks";
import type { McpToolName } from "./tools";
import { X402ReceiptSummarySchema } from "./x402-receipt";

/*
 * MCP tool contracts. Amounts are base-unit integer strings PLUS the asset's decimals:
 * the API rejects the request if `decimals` does not match the asset, which catches the
 * most common LLM unit mistake (sending 10^decimals too much or too little).
 */

/**
 * The resource's answer to the paid retry, as the agent sees it. `body` is the parsed JSON
 * (or text) of the response, capped by the MCP worker; it is untrusted third-party content.
 */
export const X402ResourceResponseSchema = z.object({
  httpStatus: z.number().int().min(100).max(599),
  contentType: z.string().max(128).nullable(),
  body: z.unknown(),
  truncated: z.boolean(),
  /** Decoded PAYMENT-RESPONSE header (settlement receipt), when the resource sent one. */
  settlement: z
    .object({
      success: z.boolean(),
      transaction: z.string().max(128).nullable(),
      network: z.string().max(64).nullable(),
      errorReason: z.string().max(200).nullable(),
    })
    .nullable(),
  /**
   * ZyroPay's verdict on the seller's X-Delivery-Receipt (signed by the paid address over
   * the exact body), as the API answered it. Absent when the API could not be told.
   */
  receipt: X402ReceiptSummarySchema.nullable().optional(),
});
export type X402ResourceResponse = z.infer<typeof X402ResourceResponseSchema>;

const SpendCommon = {
  walletId: z.uuid().describe("Wallet to spend from (see get_wallets)."),
  network: NetworkIdSchema,
  idempotencyKey: IdempotencyKeySchema.describe(
    "Unique per logical payment; retries with the same key return the same request.",
  ),
};

export const mcpTools = {
  get_balance: {
    description: "Portfolio balances (base units + decimals) and fiat values for allowed wallets.",
    valueMoving: false,
    input: z.object({
      walletId: z.uuid().optional(),
      network: NetworkIdSchema.optional(),
    }),
    output: z.object({ portfolio: PortfolioSnapshotSchema }),
  },
  get_wallets: {
    description: "Wallets and addresses this agent may use.",
    valueMoving: false,
    input: z.object({}),
    output: z.object({ wallets: z.array(WalletSchema) }),
  },
  get_transactions: {
    description: "Recent normalized transactions for allowed wallets.",
    valueMoving: false,
    input: z.object({
      walletId: z.uuid().optional(),
      network: NetworkIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: CursorSchema.optional(),
    }),
    output: z.object({
      transactions: z.array(TransactionSchema),
      nextCursor: CursorSchema.nullable(),
    }),
  },
  send: {
    description:
      "Request a transfer. Returns a transaction request; it may need the user's approval in the ZyroPay app.",
    valueMoving: true,
    input: z.object({
      ...SpendCommon,
      to: AddressSchema,
      assetId: AssetIdSchema,
      amount: BaseUnitAmountSchema.describe(
        "Integer amount in base units (e.g. lamports, wei, lovelace).",
      ),
      decimals: DecimalsSchema.describe("Decimals of the asset; must match the asset."),
    }),
    output: z.object({ request: TransactionRequestResultSchema }),
  },
  swap: {
    description:
      "Request a token swap through the Jupiter plugin. Swaps are available on Solana mainnet only: on any other network, including every test network (Solana Devnet, Ethereum Sepolia, Base Sepolia, Cardano Preprod), the request fails with SWAP_UNAVAILABLE_ON_NETWORK and nothing is created. In that case tell the user that swaps are not available on that network; do not ask them for token mint addresses.",
    valueMoving: true,
    input: z.object({
      ...SpendCommon,
      inputAssetId: AssetIdSchema,
      outputAssetId: AssetIdSchema,
      amount: BaseUnitAmountSchema.describe("Input amount in base units."),
      decimals: DecimalsSchema.describe("Decimals of the input asset."),
      slippageBps: z.number().int().min(1).max(1000).default(50),
    }),
    output: z.object({ request: TransactionRequestResultSchema }),
  },
  pay_x402: {
    description: "Pay for an HTTP resource that responded 402 Payment Required (x402).",
    valueMoving: true,
    input: z.object({
      ...SpendCommon,
      resourceUrl: z.url({ protocol: /^https$/ }),
      method: z.enum(["GET", "POST"]).default("GET"),
      maxAmount: BaseUnitAmountSchema.describe("Upper bound the agent accepts, base units."),
      assetId: AssetIdSchema,
      decimals: DecimalsSchema,
      escrow: z
        .boolean()
        .optional()
        .describe(
          "Cardano only. true: pay into Masumi escrow (the 402 must offer assetTransferMethod masumi); the seller is paid only after delivering, and the user can get a refund otherwise. false: pay directly. Omitted: escrow when the 402 offers it and the agent's policy requires escrow, else direct.",
        ),
    }),
    output: z.object({ request: TransactionRequestResultSchema }),
  },
  get_approval_status: {
    description:
      "Current state of a transaction request created by this agent. For pay_x402, once the user has approved and the payment is signed, this call delivers the payment to the resource and returns the paid response in `resource` (exactly once).",
    valueMoving: false,
    input: z.object({ requestId: z.uuid() }),
    output: z.object({
      request: TransactionRequestResultSchema,
      resource: X402ResourceResponseSchema.optional(),
    }),
  },
  get_agent_policy: {
    description: "This agent's permissions, mode and spending limits.",
    valueMoving: false,
    input: z.object({}),
    output: z.object({ policy: AgentPolicySchema }),
  },
} as const satisfies Record<
  McpToolName,
  { description: string; valueMoving: boolean; input: z.ZodObject; output: z.ZodObject }
>;

export type McpTools = typeof mcpTools;
export type McpToolInput<T extends McpToolName> = z.input<McpTools[T]["input"]>;
export type McpToolOutput<T extends McpToolName> = z.infer<McpTools[T]["output"]>;

/**
 * Masumi registry discovery tools (read-only, public chain data, no wallet access). They are
 * not policy tools (`MCP_TOOL_NAMES` / `allowedTools`): every active agent with the read
 * scope may use them. Paying an agent found here still goes through pay_x402 and the policy.
 */
export const MCP_DISCOVERY_TOOL_NAMES = ["find_agents", "verify_agent"] as const;
export type McpDiscoveryToolName = (typeof MCP_DISCOVERY_TOOL_NAMES)[number];

export const mcpDiscoveryTools = {
  find_agents: {
    description:
      "Find AI agents registered in the Masumi agent registry on Cardano (on-chain NFTs), e.g. to buy a service from one. Returns name, description, endpoint (apiBaseUrl), capability, tags, pricing and whether it is payable through Masumi escrow.",
    valueMoving: false,
    input: z.object({
      query: z
        .string()
        .max(200)
        .optional()
        .describe("Words to look for in name, description, tags and capability."),
      capability: z.string().max(200).optional().describe("Exact capability name."),
      tag: z.string().max(64).optional(),
      maxPrice: z
        .object({
          amount: BaseUnitAmountSchema.describe("Base units (lovelace for ADA)."),
          unit: z
            .string()
            .max(130)
            .default("lovelace")
            .describe('"lovelace" or the token unit (policy id + asset name hex).'),
        })
        .optional()
        .describe("Only agents whose fixed price is at most this (free agents included)."),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    output: MasumiAgentSearchResultSchema,
  },
  verify_agent: {
    description:
      "Check a Masumi agent's on-chain registry identity before paying it: the registry NFT is live and held by a payment key, it advertises the canonical Masumi escrow, and its endpoint is public https (and covers resourceUrl, when given).",
    valueMoving: false,
    input: z.object({
      agentIdentifier: MasumiAgentIdentifierSchema.describe(
        "The agent's agentIdentifier from find_agents (120 hex characters).",
      ),
      resourceUrl: z
        .url({ protocol: /^https$/ })
        .optional()
        .describe("The paid URL you intend to call; must be under the agent's apiBaseUrl."),
      sellerAddress: z
        .string()
        .min(32)
        .max(128)
        .optional()
        .describe("The seller address of a 402 you received, to check it holds the NFT."),
    }),
    output: MasumiAgentVerificationSchema,
  },
} as const satisfies Record<
  McpDiscoveryToolName,
  { description: string; valueMoving: boolean; input: z.ZodObject; output: z.ZodObject }
>;
