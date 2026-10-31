import { z } from "zod";
import { IsoDateTimeSchema } from "../common";
import { BaseUnitAmountSchema, formatBaseUnits } from "../money";
import { NetworkIdSchema } from "../networks";

/*
 * Masumi agent registry (docs/CARDANO_X402.md "Discover and identify"): agents registered as
 * NFTs under the Masumi registry V2 policy on Cardano. Every string below except the
 * identifiers, hashes and amounts is third-party metadata the agent's owner wrote on chain:
 * untrusted data (the MCP worker sanitizes it and wraps it as data before a model sees it).
 */

/** Registry V2 policy id (56 hex) || asset name (64 hex). */
export const MasumiAgentIdentifierSchema = z
  .string()
  .regex(/^[0-9a-f]{120}$/, "agentIdentifier must be 120 lowercase hex characters");
export type MasumiAgentIdentifier = z.infer<typeof MasumiAgentIdentifierSchema>;

/** `unit` is "lovelace" or policyId||assetName hex; `amount` in base units. */
export const MasumiPriceAmountSchema = z.object({
  unit: z.string().max(130),
  amount: BaseUnitAmountSchema,
  /**
   * ZyroPay's reading of a unit it knows (ADA, Masumi's tUSDM on preprod, USDM on mainnet):
   * `display` is e.g. "1 tUSDM". Absent for any other unit: its decimals are not known, so only
   * the base units can be shown.
   */
  symbol: z.string().max(12).optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  display: z.string().max(100).optional(),
});
export type MasumiPriceAmount = z.infer<typeof MasumiPriceAmountSchema>;

/** tUSDM, the stablecoin Masumi prices in on preprod (CIP-67 fungible label + "tUSDM"). */
export const MASUMI_TUSDM_PREPROD_UNIT =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
/** USDM on Cardano mainnet (CIP-67 fungible label + "USDM"). */
export const MASUMI_USDM_MAINNET_UNIT =
  "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d";

/**
 * Units ZyroPay can name, matched exactly (policy id included): a token minted under another
 * policy with the same asset name stays unknown.
 */
const KNOWN_MASUMI_UNITS: ReadonlyMap<string, { symbol: string; decimals: number }> = new Map([
  ["", { symbol: "ADA", decimals: 6 }],
  ["lovelace", { symbol: "ADA", decimals: 6 }],
  [MASUMI_TUSDM_PREPROD_UNIT, { symbol: "tUSDM", decimals: 6 }],
  [MASUMI_USDM_MAINNET_UNIT, { symbol: "USDM", decimals: 6 }],
]);

/** The unit's symbol and decimals when ZyroPay knows it, else null. */
export function knownMasumiUnit(unit: string): { symbol: string; decimals: number } | null {
  const key = unit.trim().replace(".", "").toLowerCase();
  return KNOWN_MASUMI_UNITS.get(key) ?? null;
}

/** Adds `symbol`, `decimals` and `display` ("1 tUSDM") to an amount in a known unit. */
export function describeMasumiPriceAmount(price: {
  unit: string;
  amount: string;
}): MasumiPriceAmount {
  const base = { unit: price.unit, amount: price.amount };
  const known = knownMasumiUnit(price.unit);
  if (known === null || !/^\d{1,78}$/.test(price.amount)) return base;
  return {
    ...base,
    symbol: known.symbol,
    decimals: known.decimals,
    display: `${formatBaseUnits(price.amount, known.decimals)} ${known.symbol}`,
  };
}

export const MasumiAgentPricingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Fixed"), amounts: z.array(MasumiPriceAmountSchema).max(25) }),
  z.object({ type: z.literal("Dynamic") }),
  z.object({ type: z.literal("Free") }),
  z.object({ type: z.literal("Unknown") }),
]);
export type MasumiAgentPricing = z.infer<typeof MasumiAgentPricingSchema>;

/** A registry entry as ZyroPay shows it (subset of the on-chain metadata). */
export const MasumiAgentSummarySchema = z.object({
  agentIdentifier: MasumiAgentIdentifierSchema,
  network: NetworkIdSchema,
  name: z.string().max(200),
  description: z.string().max(2_000).nullable(),
  /** Where the agent is reached; a paid resource must be served under it. */
  apiBaseUrl: z.string().max(2_048),
  capability: z.object({ name: z.string().max(200), version: z.string().max(60) }).nullable(),
  tags: z.array(z.string().max(64)).max(20),
  pricing: MasumiAgentPricingSchema,
  /** True when the agent is payable through the canonical Masumi V2 escrow on this network. */
  masumiEscrow: z.boolean(),
  /** Time of the registration (mint/update) transaction, when known. */
  registeredAt: IsoDateTimeSchema.nullable(),
  /** Payment key hash of the NFT holder: the seller key that must sign the x402 terms. */
  sellerPaymentKeyHash: z
    .string()
    .regex(/^[0-9a-f]{56}$/)
    .nullable(),
  /** False once the registry NFT is burned (deregistered or superseded). */
  active: z.boolean(),
});
export type MasumiAgentSummary = z.infer<typeof MasumiAgentSummarySchema>;

/** GET /v1/masumi/agents (and the agent-side internal twin). */
export const MasumiAgentSearchQuerySchema = z.object({
  /** Case-insensitive substring over name, description, tags and capability. */
  q: z.string().max(200).optional(),
  /** Exact capability name (case-insensitive). */
  capability: z.string().max(200).optional(),
  tag: z.string().max(64).optional(),
  /** With maxPriceAmount: only Free agents and Fixed prices entirely in this unit, at most it. */
  maxPriceUnit: z.string().max(130).optional(),
  maxPriceAmount: BaseUnitAmountSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type MasumiAgentSearchQuery = z.infer<typeof MasumiAgentSearchQuerySchema>;

export const MasumiAgentSearchResultSchema = z.object({
  agents: z.array(MasumiAgentSummarySchema),
  /** Live registry entries inspected. */
  scanned: z.number().int().min(0),
  /** True when the scan stopped before the end of the registry. */
  truncated: z.boolean(),
});
export type MasumiAgentSearchResult = z.infer<typeof MasumiAgentSearchResultSchema>;

/**
 * One registry entry: `active` (live), `burned` (deregistered or updated; `agent` is the
 * last metadata), `not_found`, or `invalid` (not a Masumi V2 identifier, or unusable
 * metadata; see `reason`).
 */
export const MasumiAgentResolutionSchema = z.object({
  status: z.enum(["active", "burned", "not_found", "invalid"]),
  agent: MasumiAgentSummarySchema.nullable(),
  reason: z.string().max(200).nullable(),
});
export type MasumiAgentResolution = z.infer<typeof MasumiAgentResolutionSchema>;

/** Reasons a seller identity check fails (closed set, see @zyropay/integrations). */
export const MASUMI_VERIFY_REASONS = [
  "invalid_identifier",
  "network_mismatch",
  "wrong_policy",
  "not_found",
  "burned",
  "multiple_holders",
  "metadata_invalid",
  "holder_not_key_address",
  "seller_missing",
  "seller_invalid",
  "seller_mismatch",
  "no_escrow_source",
  "endpoint_invalid",
  "endpoint_insecure",
  "endpoint_mismatch",
  "price_mismatch",
  "not_trusted",
  "upstream_unavailable",
] as const;
export const MasumiVerifyReasonSchema = z.enum(MASUMI_VERIFY_REASONS);

export const MasumiAgentVerifyBodySchema = z.strictObject({
  agentIdentifier: MasumiAgentIdentifierSchema,
  /** The address that signs the seller's x402 terms. Omitted: the NFT holder is assumed. */
  sellerAddress: z.string().min(32).max(128).optional(),
  /** The resource to pay: must be served under the registered endpoint. */
  resourceUrl: z
    .url({ protocol: /^https?$/ })
    .max(2_048)
    .optional(),
});

export const MasumiAgentVerificationSchema = z.object({
  /** Every check passed (fail closed: an unreachable registry is never ok). */
  ok: z.boolean(),
  reasons: z.array(MasumiVerifyReasonSchema),
  /** Human-readable detail per reason. */
  details: z.array(z.string().max(300)).max(20),
  /** False when no sellerAddress was given: the current NFT holder was assumed. */
  sellerChecked: z.boolean(),
  agent: MasumiAgentSummarySchema.nullable(),
});
export type MasumiAgentVerification = z.infer<typeof MasumiAgentVerificationSchema>;

/**
 * Who a pay_x402 pays, as ZyroPay verified it when quoting (Masumi escrow payments):
 *  - `registered: true`: the seller's signed terms claim `agentIdentifier` and the registry
 *    check passed (the signing key holds the live registry NFT whose metadata names this
 *    endpoint and price); `name` is the registered name (third-party text).
 *  - `registered: false`: the seller claims no registry identity (`reasons`: "not_claimed").
 * A claim that fails the check is refused when quoting, so it never reaches an approval.
 * Null for direct (non-escrow) x402 payments, which carry no identity claim.
 */
export const X402SellerIdentitySchema = z.object({
  registered: z.boolean(),
  agentIdentifier: MasumiAgentIdentifierSchema.nullable(),
  name: z.string().max(200).nullable(),
  reasons: z.array(z.string().max(64)).max(20),
});
export type X402SellerIdentity = z.infer<typeof X402SellerIdentitySchema>;
