import { getNetwork, networksForMode, type NetworkId } from "@zyropay/shared";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import {
  ActionButton,
  AssetRow,
  BalanceDisplay,
  BalanceSkeleton,
  Chip,
  EmptyState,
  IconButton,
  ListGroup,
  isMainnetPriced,
  ListSkeleton,
  MAINNET_PRICE_NOTE,
  MainnetPriceBadge,
  NetworkLogo,
  Row,
  Screen,
  Section,
  SimulatedBadge,
  spacing,
  TextButton,
  TransactionRow,
  ZyroMark,
} from "@zyropay/ui";
import { usePortfolio, useTransactions, useWallets } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { useAllowanceAddresses } from "@/hooks/useAllowanceAddresses";
import { transactionKindCopy } from "@/lib/tx-kind";
import { usePortfolioChange } from "@/hooks/usePortfolioChange";
import { usePriceChanges } from "@/hooks/usePriceChanges";
import { listedBalances, pricedAssetIds } from "@/lib/asset-list";
import { env } from "@/lib/env";
import { prefsStore, usePrefs } from "@/state";

/** Every chain list comes from the shared registry, filtered to this build's mode. */
const NETWORKS = networksForMode(env.mode);

/** Portfolio: balance with 24h change, quick actions, chain filter, assets, recent activity. */
export default function Home() {
  const [network, setNetwork] = useState<NetworkId | undefined>(undefined);
  const hidden = usePrefs((s) => s.hideBalances);
  const currency = usePrefs((s) => s.currency);
  const portfolio = usePortfolio({ network, currency });
  const change = usePortfolioChange(portfolio.data);
  const rows = useMemo(
    () => listedBalances(portfolio.data?.balances ?? [], { mergeWallets: true }),
    [portfolio.data],
  );
  const priceChanges = usePriceChanges(
    useMemo(() => pricedAssetIds(rows), [rows]),
    currency,
  );
  const txs = useTransactions({ network, limit: 5 });
  const allowances = useAllowanceAddresses();
  const wallets = useWallets();
  const firstWallet = wallets.data?.[0];
  const mainnetPriced = portfolio.data?.balances.some(isMainnetPriced) === true;
  const txsMainnetPriced = txs.data?.transactions.some(isMainnetPriced) === true;

  const refresh = () => {
    void portfolio.refetch();
    void txs.refetch();
  };

  return (
    <Screen testID="home-screen" refreshing={portfolio.isRefetching} onRefresh={refresh}>
      <Row justify="space-between" style={{ paddingTop: spacing.md }}>
        <ZyroMark size={36} />
        <Row gap={spacing.sm}>
          <IconButton
            icon="clock"
            accessibilityLabel="All activity"
            onPress={() => {
              router.push("/activity");
            }}
          />
          <IconButton
            icon="plug"
            accessibilityLabel="Plugins"
            onPress={() => {
              router.push("/plugins");
            }}
          />
        </Row>
      </Row>

      <View style={{ paddingTop: spacing.sm }}>
        {portfolio.isPending ? (
          <BalanceSkeleton />
        ) : portfolio.isSuccess ? (
          <BalanceDisplay
            value={portfolio.data.totalValue.value}
            currency={portfolio.data.totalValue.currency}
            hidden={hidden}
            onToggleHidden={() => {
              prefsStore.getState().toggleHideBalances();
            }}
            simulated={portfolio.data.simulated}
            stale={portfolio.data.stale}
            unpricedCount={portfolio.data.unpricedAssetCount}
            change={network === undefined ? change : null}
            note={mainnetPriced ? MAINNET_PRICE_NOTE : null}
            label={network ? `Balance on ${getNetwork(network).displayName}` : "Total balance"}
            testID="home-balance"
          />
        ) : null}
      </View>

      <Row gap={spacing.sm}>
        <ActionButton
          icon="plus"
          label="Top up"
          primary
          onPress={() => {
            router.push("/topup");
          }}
          testID="action-topup"
        />
        <ActionButton
          icon="arrowUp"
          label="Send"
          onPress={() => {
            router.push("/send");
          }}
          testID="action-send"
        />
        <ActionButton
          icon="arrowDown"
          label="Receive"
          disabled={!firstWallet}
          onPress={() => {
            if (firstWallet)
              router.push({ pathname: "/wallets/[id]/receive", params: { id: firstWallet.id } });
          }}
          testID="action-receive"
        />
      </Row>

      <Section
        title="Assets"
        badge={
          portfolio.data?.simulated === true ? (
            <SimulatedBadge />
          ) : mainnetPriced ? (
            <MainnetPriceBadge />
          ) : undefined
        }
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.xl }}
          style={{ marginHorizontal: -spacing.xl, paddingHorizontal: spacing.xl }}
          accessibilityLabel="Filter by network"
        >
          <Chip
            label="All"
            selected={network === undefined}
            onPress={() => {
              setNetwork(undefined);
            }}
            testID="chain-filter-all"
          />
          {NETWORKS.map((n) => (
            <Chip
              key={n}
              label={getNetwork(n).displayName}
              leading={<NetworkLogo network={n} size={24} />}
              selected={network === n}
              onPress={() => {
                setNetwork(n);
              }}
              testID={`chain-filter-${n}`}
            />
          ))}
        </ScrollView>
        <QueryView
          query={portfolio}
          loading={<ListSkeleton rows={4} />}
          isEmpty={() => rows.length === 0}
          empty={
            <EmptyState
              variant="card"
              icon="wallet"
              title={network ? `Nothing on ${getNetwork(network).displayName}` : "No assets yet"}
              message={
                network
                  ? "Switch network or receive funds to this chain."
                  : "Top up with a card or receive crypto to get started."
              }
              actionLabel="Top up"
              onAction={() => {
                router.push("/topup");
              }}
            />
          }
        >
          {(p) => (
            <ListGroup inset={72}>
              {rows.map((b) => (
                <AssetRow
                  key={`${b.walletId}:${b.asset.id}`}
                  balance={b}
                  change={priceChanges.get(b.asset.id) ?? null}
                  hidden={hidden}
                  simulated={p.simulated}
                  onPress={() => {
                    router.push({ pathname: "/asset/[assetId]", params: { assetId: b.asset.id } });
                  }}
                  testID={`asset-row-${b.asset.symbol}`}
                />
              ))}
            </ListGroup>
          )}
        </QueryView>
      </Section>

      <Section
        title="Recent activity"
        badge={
          txs.data?.transactions.some((t) => t.simulated) === true ? (
            <SimulatedBadge />
          ) : txsMainnetPriced ? (
            <MainnetPriceBadge />
          ) : undefined
        }
        action={
          txs.data && txs.data.transactions.length > 0 ? (
            <TextButton
              label="See all"
              tone="secondary"
              onPress={() => {
                router.push("/activity");
              }}
            />
          ) : undefined
        }
      >
        <QueryView
          query={txs}
          loading={<ListSkeleton rows={3} />}
          isEmpty={(t) => t.transactions.length === 0}
          empty={
            <EmptyState
              variant="card"
              icon="clock"
              title="No transactions yet"
              message="Transfers in and out of your wallets appear here."
            />
          }
        >
          {(t) => (
            <ListGroup inset={72}>
              {t.transactions.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  transaction={tx}
                  label={transactionKindCopy(tx, allowances)?.label}
                  hidden={hidden}
                  onPress={() => {
                    router.push({ pathname: "/tx/[id]", params: { id: tx.id } });
                  }}
                  testID={`tx-row-${tx.id}`}
                />
              ))}
            </ListGroup>
          )}
        </QueryView>
      </Section>
    </Screen>
  );
}
