import {
  getNetwork,
  nativeAsset,
  networksForMode,
  type Asset,
  type Balance,
} from "@zyropay/shared";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import {
  AssetLogo,
  IconButton,
  isMainnetPriced,
  ListSkeleton,
  MAINNET_PRICE_MARKER,
  NetworkBadge,
  PressableScale,
  priceA11y,
  PriceLine,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SegmentedControl,
  spacing,
  Text,
} from "@zyropay/ui";
import { usePortfolio, useWallets } from "@/api/hooks";
import { usePriceChanges } from "@/hooks/usePriceChanges";
import { env } from "@/lib/env";
import { useTopUpFlow } from "@/state/flows";

const NETWORKS = networksForMode(env.mode);

/** Top up 1/4 — asset and destination wallet. */
export default function TopUpChoose() {
  const wallets = useWallets();
  const portfolio = usePortfolio();
  const setAsset = useTopUpFlow((s) => s.setAsset);
  const reset = useTopUpFlow((s) => s.reset);
  const [walletId, setWalletId] = useState<string | null>(null);

  useEffect(() => {
    reset();
  }, [reset]);
  useEffect(() => {
    if (walletId === null && wallets.data?.[0]) setWalletId(wallets.data[0].id);
  }, [wallets.data, walletId]);

  // Natives of this build's networks plus verified tokens the user already holds.
  const assets = useMemo<Asset[]>(() => {
    const map = new Map<string, Asset>();
    for (const n of NETWORKS) map.set(`${n}:native`, nativeAsset(n));
    for (const b of portfolio.data?.balances ?? [])
      if (b.asset.verified) map.set(b.asset.id, b.asset);
    return [...map.values()];
  }, [portfolio.data]);
  // A price is shown wherever the portfolio already priced the asset (any wallet).
  const priced = useMemo(() => {
    const map = new Map<string, Balance>();
    for (const b of portfolio.data?.balances ?? [])
      if (b.price !== null && !map.has(b.asset.id)) map.set(b.asset.id, b);
    return map;
  }, [portfolio.data]);
  const priceChanges = usePriceChanges(
    useMemo(() => [...priced.keys()], [priced]),
    portfolio.data?.currency,
  );

  return (
    <Screen testID="topup-choose">
      <ScreenHeader
        title="Top up"
        subtitle="Buy crypto with a card or bank transfer through a licensed provider."
        size="inline"
        actions={
          <IconButton
            icon="close"
            accessibilityLabel="Close"
            onPress={() => {
              router.dismissAll();
            }}
          />
        }
      />
      {wallets.data && wallets.data.length > 1 && walletId ? (
        <Section title="To wallet">
          <SegmentedControl
            options={wallets.data.map((w) => ({ value: w.id, label: w.name }))}
            value={walletId}
            onChange={setWalletId}
          />
        </Section>
      ) : null}
      <Section title="Asset">
        {portfolio.isPending ? (
          <ListSkeleton rows={4} />
        ) : (
          <View style={{ gap: spacing.xs }}>
            {assets.map((a) => {
              const quote = priced.get(a.id);
              const change = priceChanges.get(a.id) ?? null;
              return (
                <PressableScale
                  key={a.id}
                  disabled={walletId === null}
                  accessibilityLabel={`${a.name} on ${getNetwork(a.network).displayName}${quote ? `, ${priceA11y(quote, change)}${isMainnetPriced(quote) ? " (mainnet price)" : ""}` : ""}`}
                  onPress={() => {
                    if (!walletId) return;
                    setAsset(a.id, walletId);
                    router.push("/topup/amount");
                  }}
                  testID={`topup-asset-${a.symbol}-${a.network}`}
                >
                  <Row style={{ minHeight: 64, paddingVertical: spacing.xs }}>
                    <AssetLogo asset={a} size={40} />
                    <View style={{ flex: 1, gap: spacing.xxs }}>
                      <Text variant="bodyStrong">{a.name}</Text>
                      {quote ? (
                        <PriceLine
                          price={quote.price}
                          change={change}
                          {...(isMainnetPriced(quote) ? { marker: MAINNET_PRICE_MARKER } : {})}
                          testID={`topup-price-${a.symbol}-${a.network}`}
                        />
                      ) : null}
                      <NetworkBadge network={a.network} compact />
                    </View>
                    <Text variant="label" tone="secondary">
                      {a.symbol}
                    </Text>
                  </Row>
                </PressableScale>
              );
            })}
          </View>
        )}
      </Section>
      {env.mode === "development" ? (
        <Text variant="caption" tone="secondary">
          Development builds use the provider's sandbox. No real card is charged and test tokens
          have no real value (dollar amounts use mainnet prices).
        </Text>
      ) : null}
    </Screen>
  );
}
