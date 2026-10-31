import { addBaseUnits, getNetwork } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  AssetLogo,
  Card,
  EmptyState,
  formatFiat,
  formatTokenAmount,
  formatUnitPrice,
  isMainnetPriced,
  KeyValueRow,
  MAINNET_PRICE_MARKER,
  MAINNET_PRICE_NOTE,
  LoadingSkeleton,
  NetworkBadge,
  PriceChangeText,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SecondaryButton,
  SecurityWarning,
  SegmentedControl,
  SimulatedBadge,
  spacing,
  Text,
  TransactionRow,
  withPriceMarker,
} from "@zyropay/ui";
import { priceBasisOfSource, type PriceHistory, type PriceRange } from "@zyropay/shared";
import { usePortfolio, usePriceHistory, useTransactions } from "@/api/hooks";
import { PriceChart } from "@/components/PriceChart";
import { QueryView } from "@/components/QueryView";
import { transactionKindCopy } from "@/lib/tx-kind";
import { usePriceChanges } from "@/hooks/usePriceChanges";
import { firstParam } from "@/lib/utils";
import { usePrefs } from "@/state";

const RANGES: readonly { value: PriceRange; label: string }[] = [
  { value: "1D", label: "1D" },
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
  { value: "1Y", label: "1Y" },
];

/** Fail closed: the API never invents a series, it says why there is none. */
const UNAVAILABLE: Readonly<
  Record<Extract<PriceHistory, { status: "unavailable" }>["reason"], string>
> = {
  UNSUPPORTED_ASSET: "No price history is available for this asset.",
  TESTNET_ASSET: "This testnet asset has no mainnet counterpart to price it by.",
  CURRENCY_UNSUPPORTED: "Price history is only available in US dollars.",
  PROVIDER_UNAVAILABLE: "Price history is unavailable right now.",
};

/** Asset detail: holdings across wallets, Skia price chart, actions, asset history. */
export default function AssetDetail() {
  const assetId = firstParam(useLocalSearchParams<{ assetId: string }>().assetId);
  const [range, setRange] = useState<PriceRange>("1W");
  const hidden = usePrefs((s) => s.hideBalances);
  const currency = usePrefs((s) => s.currency);
  const portfolio = usePortfolio({ currency });
  const history = usePriceHistory(assetId, range, currency);
  const balances = portfolio.data?.balances.filter((b) => b.asset.id === assetId) ?? [];
  const asset = balances[0]?.asset;
  const quote = balances.find((b) => b.price !== null);
  const changes = usePriceChanges(quote ? [assetId] : [], currency);
  const change = changes.get(assetId) ?? null;
  const txs = useTransactions({ network: asset?.network, limit: 50 });
  const assetTxs = txs.data?.transactions.filter((t) => t.asset.id === assetId).slice(0, 10) ?? [];

  const back = () => {
    router.back();
  };

  if (portfolio.isPending) {
    return (
      <Screen>
        <ScreenHeader title="" size="inline" onBack={back} />
        <LoadingSkeleton height={40} width="60%" />
        <LoadingSkeleton height={180} radius={24} />
      </Screen>
    );
  }
  if (!asset) {
    return (
      <Screen>
        <ScreenHeader title="Asset" size="inline" onBack={back} />
        <EmptyState
          icon="search"
          title="Asset not in your portfolio"
          message="It may have been moved out of your wallets."
        />
      </Screen>
    );
  }

  const total = addBaseUnits(...balances.map((b) => b.amount));
  const totalCents = balances.reduce(
    (sum, b) => (b.value ? sum + BigInt(b.value.value.replace(".", "")) : sum),
    0n,
  );
  const priced = balances.every((b) => b.value !== null);
  const valueLabel = priced
    ? withPriceMarker(
        formatFiat(
          `${(totalCents / 100n).toString()}.${(totalCents % 100n).toString().padStart(2, "0")}`,
          balances[0]?.value?.currency ?? "USD",
        ),
        balances.some(isMainnetPriced) ? "mainnet_proxy" : null,
      )
    : "No price available";

  return (
    <Screen testID="asset-detail">
      <ScreenHeader title="" size="inline" onBack={back} />
      <Row gap={spacing.md}>
        <AssetLogo asset={asset} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline" accessibilityRole="header">
            {asset.name}
          </Text>
          <Text variant="footnote" tone="secondary">
            {asset.symbol}
          </Text>
        </View>
      </Row>
      <Row gap={spacing.sm}>
        <NetworkBadge network={asset.network} />
        {portfolio.data?.simulated ? <SimulatedBadge /> : null}
      </Row>
      {!asset.verified ? (
        <SecurityWarning
          severity="warning"
          title="Unverified token"
          message="This token is not on a curated list. Unknown airdrops are a common scam: don't interact with links or sites that mention it."
        />
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <Text variant="label" tone="secondary">
          {`${asset.symbol} price`}
        </Text>
        <Text
          variant="title"
          tone={quote?.price ? "primary" : "secondary"}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          style={{ fontVariant: ["tabular-nums"] }}
          testID="asset-price"
        >
          {quote?.price ? formatUnitPrice(quote.price.value, quote.price.currency) : "No price"}
        </Text>
        {change || (quote && isMainnetPriced(quote)) ? (
          <Row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
            {change ? (
              <PriceChangeText
                change={change}
                variant="calloutStrong"
                suffix="24h"
                testID="asset-price-change"
              />
            ) : null}
            {quote && isMainnetPriced(quote) ? (
              <Text variant="footnote" tone="secondary">
                {MAINNET_PRICE_MARKER}
              </Text>
            ) : null}
          </Row>
        ) : null}
      </View>

      <Card style={{ gap: spacing.xxs }} testID="asset-holding">
        <Text variant="label" tone="secondary">
          Your balance
        </Text>
        <Row justify="space-between" align="flex-end" style={{ flexWrap: "wrap" }}>
          <Text variant="section" style={{ fontVariant: ["tabular-nums"], flexShrink: 1 }}>
            {hidden ? "••••" : formatTokenAmount(total, asset.decimals, { symbol: asset.symbol })}
          </Text>
          <Text variant="callout" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
            {hidden ? "••••" : valueLabel}
          </Text>
        </Row>
      </Card>

      <Row gap={spacing.md}>
        <View style={{ flex: 1 }}>
          <PrimaryButton
            label="Send"
            icon="arrowUp"
            onPress={() => {
              router.push({ pathname: "/send", params: { assetId: asset.id } });
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <SecondaryButton
            label="Receive"
            icon="qr"
            onPress={() => {
              const walletId = balances[0]?.walletId;
              if (walletId)
                router.push({
                  pathname: "/wallets/[id]/receive",
                  params: { id: walletId, network: asset.network },
                });
            }}
          />
        </View>
      </Row>

      {asset.verified ? (
        <Section title="Price">
          <SegmentedControl
            options={RANGES}
            value={range}
            onChange={setRange}
            testID="price-range"
          />
          {history.isPending ? (
            <LoadingSkeleton height={180} radius={24} />
          ) : history.isError ? (
            <Text variant="callout" tone="secondary">
              Price history couldn't be loaded. Pull to refresh to try again.
            </Text>
          ) : history.data.status === "unavailable" ? (
            <Text variant="callout" tone="secondary" testID="price-history-unavailable">
              {UNAVAILABLE[history.data.reason]}
            </Text>
          ) : (
            <View style={{ gap: spacing.sm }}>
              <PriceChart history={history.data} />
              {history.data.simulated ? <SimulatedBadge /> : null}
              {priceBasisOfSource(history.data.source) === "mainnet_proxy" ? (
                <Text variant="footnote" tone="secondary" testID="price-history-mainnet-note">
                  {`${MAINNET_PRICE_NOTE}: this chart is the mainnet ${asset.symbol} series.`}
                </Text>
              ) : null}
            </View>
          )}
        </Section>
      ) : null}

      {balances.length > 1 ? (
        <Section title="By wallet">
          <Card style={{ paddingVertical: spacing.sm }}>
            {balances.map((b) => (
              <KeyValueRow
                key={b.walletId}
                label={b.walletId === balances[0]?.walletId ? "Main" : "Other wallet"}
                value={
                  hidden
                    ? "••••"
                    : formatTokenAmount(b.amount, asset.decimals, { symbol: asset.symbol })
                }
              />
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title="History">
        <QueryView
          query={txs}
          isEmpty={() => assetTxs.length === 0}
          empty={
            <Text
              variant="callout"
              tone="secondary"
            >{`No ${asset.symbol} transfers on ${getNetwork(asset.network).displayName} yet.`}</Text>
          }
        >
          {() => (
            <View style={{ gap: spacing.xs }}>
              {assetTxs.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  transaction={tx}
                  label={transactionKindCopy(tx)?.label}
                  hidden={hidden}
                  onPress={() => {
                    router.push({ pathname: "/tx/[id]", params: { id: tx.id } });
                  }}
                />
              ))}
            </View>
          )}
        </QueryView>
      </Section>
    </Screen>
  );
}
