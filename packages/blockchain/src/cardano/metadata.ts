/*
 * Cardano native-asset metadata from Blockfrost `/assets/{unit}`. Decimals are off-chain
 * convention, not ledger data: they come from the Cardano Token Registry (CIP-26,
 * `metadata.decimals`) or CIP-68/CIP-25 on-chain metadata (`onchain_metadata.decimals`).
 * An asset with neither is an integer asset (0 decimals), which is what the ledger counts.
 * Metadata is attacker-controlled: it is cleaned by `tokenAsset` like any other token's.
 */
import { ChainError } from "../errors";
import { isRecord } from "../http";
import type { BlockfrostClient } from "./blockfrost";

export interface CardanoAssetMetadata {
  readonly unit: string;
  readonly decimals: number;
  readonly ticker: string | null;
  readonly name: string | null;
  /** Total minted supply (string). "1" means an NFT. */
  readonly supply: string;
}

const cache = new Map<string, CardanoAssetMetadata>();
const MAX_CACHE = 2_000;

function decimalsOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 19)
    return value;
  if (typeof value === "string" && /^\d{1,2}$/.test(value) && Number(value) <= 19)
    return Number(value);
  return null;
}

/** Printable UTF-8 asset name, or null (asset names are arbitrary bytes). */
function assetNameText(assetNameHex: string): string | null {
  if (assetNameHex.length === 0) return null;
  try {
    const bytes = Uint8Array.from(assetNameHex.match(/../g) ?? [], (h) => parseInt(h, 16));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Memoized per isolate (metadata of an asset unit practically never changes). */
export async function readAssetMetadata(
  client: BlockfrostClient,
  unit: string,
): Promise<CardanoAssetMetadata | null> {
  const key = `${client.network}:${unit}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = await client.getOrNull(`/assets/${encodeURIComponent(unit)}`, "assets");
  if (body === null) return null;
  if (!isRecord(body) || body.asset !== unit) {
    throw new ChainError("UPSTREAM_UNAVAILABLE", "asset metadata: malformed");
  }
  const registry = isRecord(body.metadata) ? body.metadata : null;
  const onchain = isRecord(body.onchain_metadata) ? body.onchain_metadata : null;
  const decimals = decimalsOf(registry?.decimals) ?? decimalsOf(onchain?.decimals) ?? 0;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const meta: CardanoAssetMetadata = {
    unit,
    decimals,
    ticker: str(registry?.ticker) ?? str(onchain?.ticker) ?? str(onchain?.symbol),
    name: str(registry?.name) ?? str(onchain?.name) ?? assetNameText(unit.slice(56)),
    supply: typeof body.quantity === "string" ? body.quantity : "0",
  };
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, meta);
  return meta;
}
