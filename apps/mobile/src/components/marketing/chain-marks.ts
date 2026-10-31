import type { BrandSvgKey } from "@zyropay/ui";

/*
 * DECORATIVE MARKETING ARTWORK ONLY (onboarding welcome orbit).
 *
 * Well-known chains shown nominatively as an illustration of "the wider crypto world". This
 * list is deliberately NOT the shared network registry and nothing functional may read it:
 * it says nothing about which chains ZyroPay supports (that is `networksForMode`).
 *
 * Each mark is the brand's own official file (packages/ui/src/brand/svg, sources, hashes
 * and rules in docs/BRAND_ASSETS.md), unaltered and uniformly scaled on a plain round
 * plate. Where a brand's rules forbid this use or no official file could be obtained, the
 * orbit shows a neutral monogram instead, never a redrawn imitation.
 */

export interface MarketingChainMark {
  readonly id: string;
  /** For code readers only; the orbit is hidden from assistive tech (decorative). */
  readonly name: string;
  /** Official file per background, or null for a neutral monogram. */
  readonly marks: { readonly light: BrandSvgKey; readonly dark: BrandSvgKey } | null;
  /** Share of the plate's diameter the mark may fill (1 = the mark is itself a disk). */
  readonly fill: number;
  /** A brand with no variant for dark backgrounds keeps a white plate in dark mode. */
  readonly whitePlate?: boolean;
  /** Neutral fallback: one or two letters. */
  readonly monogram: string;
}

const same = (key: BrandSvgKey) => ({ light: key, dark: key });

export const MARKETING_CHAIN_MARKS: readonly MarketingChainMark[] = [
  // Inner ring (5)
  { id: "bitcoin", name: "Bitcoin", marks: same("bitcoin"), fill: 1, monogram: "B" },
  {
    id: "ethereum",
    name: "Ethereum",
    marks: { light: "ethereum-on-light", dark: "ethereum-on-dark" },
    fill: 0.62,
    monogram: "E",
  },
  { id: "solana", name: "Solana", marks: same("solana"), fill: 0.56, monogram: "S" },
  {
    id: "cardano",
    name: "Cardano",
    marks: { light: "cardano-on-light", dark: "cardano-on-dark" },
    fill: 0.62,
    monogram: "C",
  },
  // Base: "blue Square on a white ground ... in a circular mask, reduce to fifty percent".
  { id: "base", name: "Base", marks: same("base"), fill: 0.5, whitePlate: true, monogram: "B" },
  // Middle ring (7)
  // BNB Chain: "Projects should seek approval from BNB Chain before using the logo."
  { id: "bnb", name: "BNB Chain", marks: null, fill: 0, monogram: "BNB" },
  {
    id: "polygon",
    name: "Polygon",
    marks: same("polygon"),
    fill: 0.5,
    whitePlate: true,
    monogram: "P",
  },
  { id: "avalanche", name: "Avalanche", marks: same("avalanche"), fill: 0.58, monogram: "A" },
  // Arbitrum: "Use of our brand assets must be expressly authorized in writing".
  { id: "arbitrum", name: "Arbitrum", marks: null, fill: 0, monogram: "ARB" },
  // OP Mainnet symbol: a square tile, fitted inside the round plate.
  { id: "optimism", name: "Optimism", marks: same("optimism"), fill: 0.64, monogram: "OP" },
  // TRON: attribution and a link back on every use; not possible in a decorative orbit.
  { id: "tron", name: "Tron", marks: null, fill: 0, monogram: "TRX" },
  {
    id: "xrp",
    name: "XRP Ledger",
    marks: { light: "xrp-on-light", dark: "xrp-on-dark" },
    fill: 0.56,
    monogram: "X",
  },
  // Outer ring (8)
  { id: "ton", name: "TON", marks: same("ton"), fill: 1, monogram: "T" },
  { id: "sui", name: "Sui", marks: same("sui"), fill: 0.58, monogram: "S" },
  {
    id: "aptos",
    name: "Aptos",
    marks: { light: "aptos-on-light", dark: "aptos-on-dark" },
    fill: 0.62,
    monogram: "A",
  },
  { id: "polkadot", name: "Polkadot", marks: same("polkadot"), fill: 0.62, monogram: "D" },
  // Cosmos (ICF): "Only use ICF Trademarks with the express written permission of ICF."
  { id: "cosmos", name: "Cosmos", marks: null, fill: 0, monogram: "ATOM" },
  {
    id: "near",
    name: "NEAR",
    marks: { light: "near-on-light", dark: "near-on-dark" },
    fill: 0.5,
    monogram: "N",
  },
  // Litecoin: the only official vector is a black mark in display-p3 colour; no brand kit.
  { id: "litecoin", name: "Litecoin", marks: null, fill: 0, monogram: "LTC" },
  { id: "dogecoin", name: "Dogecoin", marks: same("dogecoin"), fill: 1, monogram: "D" },
];
