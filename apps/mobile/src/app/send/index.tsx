import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import {
  AssetRow,
  EmptyState,
  IconButton,
  ListSkeleton,
  Screen,
  ScreenHeader,
  spacing,
  Text,
} from "@zyropay/ui";
import { usePortfolio, useWallets } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { usePriceChanges } from "@/hooks/usePriceChanges";
import { pricedAssetIds } from "@/lib/asset-list";
import { firstParam } from "@/lib/utils";
import { useSendFlow } from "@/state/flows";

/** Send 1/5 — choose wallet and token. */
export default function SendChooseAsset() {
  const preselect = firstParam(useLocalSearchParams<{ assetId?: string }>().assetId);
  const portfolio = usePortfolio();
  const wallets = useWallets();
  const setBalance = useSendFlow((s) => s.setBalance);
  const reset = useSendFlow((s) => s.reset);
  // Only funded rows can be sent, so only they need a 24h series.
  const priceChanges = usePriceChanges(
    useMemo(
      () => pricedAssetIds((portfolio.data?.balances ?? []).filter((b) => b.amount !== "0")),
      [portfolio.data],
    ),
    portfolio.data?.currency,
  );

  useEffect(() => {
    reset();
  }, [reset]);

  // Deep entry from an asset screen: jump straight to the recipient when unambiguous.
  useEffect(() => {
    if (preselect === "" || !portfolio.data) return;
    const matches = portfolio.data.balances.filter(
      (b) => b.asset.id === preselect && b.amount !== "0",
    );
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) {
      setBalance(only);
      router.replace("/send/recipient");
    }
  }, [preselect, portfolio.data, setBalance]);

  const walletName = (id: string) => wallets.data?.find((w) => w.id === id)?.name ?? "Wallet";

  return (
    <Screen testID="send-choose-asset">
      <ScreenHeader
        title="Send"
        subtitle="Choose what to send."
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
      <QueryView
        query={portfolio}
        loading={<ListSkeleton rows={5} />}
        isEmpty={(p) => p.balances.every((b) => b.amount === "0")}
        empty={
          <EmptyState
            icon="wallet"
            title="Nothing to send yet"
            message="Top up or receive funds first."
          />
        }
      >
        {(p) => {
          const byWallet = new Map<string, typeof p.balances>();
          for (const b of p.balances) {
            if (b.amount === "0") continue;
            byWallet.set(b.walletId, [...(byWallet.get(b.walletId) ?? []), b]);
          }
          return (
            <View style={{ gap: spacing.xl }}>
              {[...byWallet.entries()].map(([walletId, list]) => (
                <View key={walletId} style={{ gap: spacing.xs }}>
                  <Text variant="label" tone="secondary">
                    {walletName(walletId)}
                  </Text>
                  {list.map((b) => (
                    <AssetRow
                      key={b.asset.id}
                      balance={b}
                      change={priceChanges.get(b.asset.id) ?? null}
                      simulated={p.simulated}
                      onPress={() => {
                        setBalance(b);
                        router.push("/send/recipient");
                      }}
                      testID={`send-asset-${b.asset.symbol}-${b.network}`}
                    />
                  ))}
                </View>
              ))}
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
