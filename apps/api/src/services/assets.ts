import type { Asset, AssetId, NetworkId, UsdMinor, WatchedAddress } from "@zyropay/shared";
import { nativeAsset, parseAssetId, parseBaseUnits, valueInUsdMinor } from "@zyropay/shared";
import type { Ctx } from "../deps";
import { AppError } from "../lib/errors";

/** Max network fee (native base units) a ZyroPay-built transaction may spend. */
export const FEE_CAPS: Readonly<Record<NetworkId, string>> = {
  "solana-mainnet": "1000000", // 0.001 SOL
  "solana-devnet": "1000000",
  "ethereum-mainnet": "5000000000000000", // 0.005 ETH
  "ethereum-sepolia": "5000000000000000",
  "base-mainnet": "500000000000000", // 0.0005 ETH
  "base-sepolia": "500000000000000",
  // Cardano: fee (~0.17-0.4 ADA) plus the min-ADA that rides with a native token (~1.2-1.5).
  "cardano-mainnet": "3000000", // 3 ADA
  "cardano-preprod": "3000000",
};

/**
 * Resolve the asset the user/agent wants to move, server side: the asset must be on the
 * network, `decimals` must match the asset (catches 10^n unit mistakes), and the wallet
 * must hold at least `amount`. Token metadata comes from the portfolio provider; a token
 * the wallet does not hold cannot be sent.
 */
export async function resolveSpendableAsset(
  ctx: Ctx,
  watched: WatchedAddress,
  assetId: AssetId,
  decimals: number,
  amount: string,
): Promise<{ asset: Asset; balance: bigint }> {
  const { network, tokenAddress } = parseAssetId(assetId);
  if (network !== watched.network)
    throw new AppError("BAD_REQUEST", "asset is on a different network");
  if (parseBaseUnits(amount) === 0n)
    throw new AppError("BAD_REQUEST", "amount must be greater than zero");

  let snapshot;
  try {
    snapshot = await ctx.deps.portfolio.getSnapshot({ addresses: [watched], currency: "USD" });
  } catch {
    throw new AppError("UPSTREAM_UNAVAILABLE", "balance lookup failed");
  }
  if (snapshot.simulated && !ctx.deps.config.useMocks) {
    throw new AppError("UPSTREAM_UNAVAILABLE", "simulated data refused");
  }
  const held = snapshot.balances.find(
    (b) => b.asset.id === assetId && b.address === watched.address,
  );
  const asset = held?.asset ?? (tokenAddress === null ? nativeAsset(network) : null);
  if (asset === null)
    throw new AppError("INSUFFICIENT_FUNDS", "the wallet does not hold this asset");
  if (asset.decimals !== decimals) {
    throw new AppError("DECIMALS_MISMATCH", `asset has ${asset.decimals} decimals`, {
      expected: asset.decimals,
    });
  }
  const balance = held === undefined ? 0n : parseBaseUnits(held.amount);
  if (parseBaseUnits(amount) > balance)
    throw new AppError("INSUFFICIENT_FUNDS", "insufficient balance");
  return { asset, balance };
}

/**
 * USD valuation in cents, computed server side (never from agent input), rounded UP.
 * Returns null (=> fail closed in policy) when the price is missing, stale, not in USD,
 * simulated outside mock mode, or the provider fails.
 */
export async function valueUsdMinor(
  ctx: Ctx,
  asset: { id: AssetId; decimals: number },
  amount: string,
): Promise<UsdMinor | null> {
  try {
    const { prices, simulated } = await ctx.deps.prices.getPrices({
      assetIds: [asset.id],
      currency: "USD",
    });
    if (simulated && !ctx.deps.config.useMocks) return null;
    const quote = prices[asset.id];
    if (quote === undefined || quote.price.currency !== "USD") return null;
    const age = ctx.deps.clock.now().getTime() - Date.parse(quote.asOf);
    if (!Number.isFinite(age) || age > ctx.deps.config.priceMaxAgeSeconds * 1000) return null;
    if (quote.price.value.startsWith("-")) return null;
    return valueInUsdMinor({ amount, decimals: asset.decimals }, quote.price.value);
  } catch (error) {
    ctx.deps.logger.warn("valuation.failed", { assetId: asset.id, error });
    return null;
  }
}
