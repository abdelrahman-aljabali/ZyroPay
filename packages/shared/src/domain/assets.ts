import { z } from "zod";
import { AddressSchema } from "../addresses";
import { IsoDateTimeSchema } from "../common";
import { BaseUnitAmountSchema, DecimalsSchema, FiatValueSchema } from "../money";
import { CARDANO_ASSET_UNIT_RE } from "../cardano";
import type { ChainFamily, NetworkId } from "../networks";
import { NetworkIdSchema, NETWORKS } from "../networks";

/** `cardano_token`: a Cardano native asset (policy id + asset name), not a contract. */
export const AssetKindSchema = z.enum(["native", "spl", "erc20", "cardano_token"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * Asset id format: `<network>:native` or `<network>:<mint|contract|unit>`.
 * EVM contract addresses inside ids are EIP-55 checksummed. A Cardano unit is the policy id
 * (56 hex) followed by the asset name (0-64 hex), lowercase, as Blockfrost writes it.
 */
export const AssetIdSchema = z
  .string()
  .regex(
    /^(?:(?:solana-mainnet|solana-devnet|ethereum-mainnet|ethereum-sepolia|base-mainnet|base-sepolia):(?:native|[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})|(?:cardano-mainnet|cardano-preprod):(?:native|[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}))$/,
    "asset id must be <network>:native or <network>:<token address>",
  );
export type AssetId = z.infer<typeof AssetIdSchema>;

export function nativeAssetId(network: NetworkId): AssetId {
  return `${network}:native`;
}

export function tokenAssetId(network: NetworkId, tokenAddress: string): AssetId {
  return `${network}:${tokenAddress}`;
}

export function parseAssetId(id: AssetId): { network: NetworkId; tokenAddress: string | null } {
  const separator = id.indexOf(":");
  const network = NetworkIdSchema.parse(id.slice(0, separator));
  const rest = id.slice(separator + 1);
  return { network, tokenAddress: rest === "native" ? null : rest };
}

/** The token kind of each chain family. */
export const TOKEN_KIND: Readonly<Record<ChainFamily, Exclude<AssetKind, "native">>> = {
  solana: "spl",
  evm: "erc20",
  cardano: "cardano_token",
};

export const AssetSchema = z
  .object({
    id: AssetIdSchema,
    network: NetworkIdSchema,
    kind: AssetKindSchema,
    /** Mint (SPL), contract (ERC-20) or unit (Cardano token); null for the native asset. */
    address: z.union([AddressSchema, z.string().regex(CARDANO_ASSET_UNIT_RE)]).nullable(),
    symbol: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
    decimals: DecimalsSchema,
    logoUrl: z.url().nullable(),
    /** True when the token is on a curated list; unverified tokens get warnings in UI. */
    verified: z.boolean(),
  })
  .refine((a) => (a.kind === "native") === (a.address === null), {
    message: "native assets have no address; token assets must have one",
  })
  .refine((a) => a.kind === "native" || a.kind === TOKEN_KIND[NETWORKS[a.network].family], {
    message: "spl assets live on Solana networks, erc20 on EVM networks, cardano_token on Cardano",
  });
export type Asset = z.infer<typeof AssetSchema>;

export function nativeAsset(network: NetworkId): Asset {
  const currency = NETWORKS[network].nativeCurrency;
  return {
    id: nativeAssetId(network),
    network,
    kind: "native",
    address: null,
    symbol: currency.symbol,
    name: currency.name,
    decimals: currency.decimals,
    logoUrl: null,
    verified: true,
  };
}

/**
 * How a fiat value was obtained. `market`: a quote for the asset itself. `mainnet_proxy`
 * (development builds only, VALUE_TESTNETS_AT_MAINNET_PRICES): a testnet asset valued at its
 * mainnet counterpart's price (devnet SOL -> SOL, Sepolia ETH -> ETH, testnet USDC -> USDC,
 * preprod ADA -> ADA). Clients must label `mainnet_proxy` values ("testnet · mainnet price").
 */
export const PriceBasisSchema = z.enum(["market", "mainnet_proxy"]);
export type PriceBasis = z.infer<typeof PriceBasisSchema>;

/** Suffix the price providers append to `PriceQuote.source` for mainnet-proxy quotes. */
export const TESTNET_PROXY_SOURCE_SUFFIX = "+testnet-proxy";

export function priceBasisOfSource(source: string): PriceBasis {
  return source.endsWith(TESTNET_PROXY_SOURCE_SUFFIX) ? "mainnet_proxy" : "market";
}

export const PriceQuoteSchema = z.object({
  assetId: AssetIdSchema,
  /** Price of ONE whole unit of the asset (not one base unit). */
  price: FiatValueSchema,
  asOf: IsoDateTimeSchema,
  source: z.string().min(1),
  simulated: z.boolean(),
});
export type PriceQuote = z.infer<typeof PriceQuoteSchema>;

export const BalanceSchema = z.object({
  walletId: z.uuid(),
  address: AddressSchema,
  network: NetworkIdSchema,
  asset: AssetSchema,
  amount: BaseUnitAmountSchema,
  /** Null when no price is available; never guessed. */
  price: FiatValueSchema.nullable(),
  value: FiatValueSchema.nullable(),
  /** Set when `price` is: `mainnet_proxy` = a testnet asset valued at its mainnet price. */
  priceBasis: PriceBasisSchema.nullable().optional(),
});
export type Balance = z.infer<typeof BalanceSchema>;
