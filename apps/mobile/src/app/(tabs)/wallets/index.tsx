import { networksForMode, type Wallet, type WatchWallet } from "@zyropay/shared";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import {
  CardSkeleton,
  EmptyState,
  formatFiat,
  IconButton,
  isMainnetPriced,
  MainnetPriceBadge,
  Screen,
  ScreenHeader,
  Section,
  SimulatedBadge,
  spacing,
  WalletCard,
  WatchWalletCard,
} from "@zyropay/ui";
import { usePortfolio, useWallets, useWatchWalletPortfolio, useWatchWallets } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { WalletSheets, type WalletTarget } from "@/components/WalletSheets";
import { env } from "@/lib/env";
import { usePrefs } from "@/state";

const NETWORKS = networksForMode(env.mode);

function sumCents(values: readonly (string | undefined)[]): bigint {
  return values.reduce((sum, v) => (v ? sum + BigInt(v.replace(".", "")) : sum), 0n);
}

function centsLabel(cents: bigint, currency: string): string {
  return formatFiat(
    `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`,
    currency,
  );
}

function WatchCard({
  wallet,
  hidden,
  onMore,
}: {
  readonly wallet: WatchWallet;
  readonly hidden: boolean;
  readonly onMore: () => void;
}) {
  const currency = usePrefs((s) => s.currency);
  const portfolio = useWatchWalletPortfolio(wallet.id, currency);
  return (
    <WatchWalletCard
      wallet={wallet}
      networks={NETWORKS}
      hidden={hidden}
      totalLabel={
        portfolio.data
          ? formatFiat(portfolio.data.totalValue.value, portfolio.data.totalValue.currency)
          : null
      }
      onMore={onMore}
      onPress={onMore}
      testID={`watch-card-${wallet.name}`}
    />
  );
}

/** Wallets: your passkey wallets, then read-only (watch) addresses. "+" adds either kind. */
export default function Wallets() {
  const wallets = useWallets();
  const watch = useWatchWallets();
  const currency = usePrefs((s) => s.currency);
  const hidden = usePrefs((s) => s.hideBalances);
  const portfolio = usePortfolio({ currency });
  const [target, setTarget] = useState<WalletTarget | null>(null);

  const totals = useMemo(() => {
    const map = new Map<string, string>();
    const data = portfolio.data;
    if (!data) return map;
    for (const w of wallets.data ?? []) {
      const mine = data.balances.filter((b) => b.walletId === w.id);
      map.set(w.id, centsLabel(sumCents(mine.map((b) => b.value?.value)), data.currency));
    }
    return map;
  }, [portfolio.data, wallets.data]);

  const count = wallets.data?.length ?? 0;
  const watching = watch.data?.length ?? 0;
  const subtitle =
    wallets.data === undefined
      ? undefined
      : `${String(count)} ${count === 1 ? "wallet" : "wallets"}${watching > 0 ? ` · ${String(watching)} watched` : ""}`;

  const add = () => {
    router.push("/wallets/add");
  };

  return (
    <Screen
      testID="wallets-screen"
      refreshing={wallets.isRefetching}
      onRefresh={() => {
        void wallets.refetch();
        void watch.refetch();
        void portfolio.refetch();
      }}
    >
      <ScreenHeader
        title="Wallets"
        subtitle={subtitle}
        actions={
          <IconButton
            icon="plus"
            variant="primary"
            accessibilityLabel="Add wallet"
            onPress={add}
            testID="wallets-add"
          />
        }
      />
      <Section
        title="Your wallets"
        badge={
          portfolio.data?.simulated === true ? (
            <SimulatedBadge />
          ) : portfolio.data?.balances.some(isMainnetPriced) === true ? (
            <MainnetPriceBadge />
          ) : undefined
        }
        footer="Keys live in your Turnkey sub-organization and are unlocked only by your passkey."
      >
        <QueryView
          query={wallets}
          loading={<CardSkeleton rows={2} height={164} />}
          isEmpty={(w) => w.length === 0}
          empty={
            <EmptyState
              variant="card"
              icon="wallet"
              title="No wallets yet"
              message="Create one with your passkey. It takes a few seconds."
              actionLabel="Add wallet"
              onAction={add}
            />
          }
        >
          {(list: Wallet[]) => (
            <View style={{ gap: spacing.md }}>
              {list.map((w) => (
                <WalletCard
                  key={w.id}
                  wallet={w}
                  networks={NETWORKS}
                  hidden={hidden}
                  totalLabel={portfolio.data ? (totals.get(w.id) ?? null) : undefined}
                  onPress={() => {
                    router.push({ pathname: "/wallets/[id]", params: { id: w.id } });
                  }}
                  onMore={() => {
                    setTarget({ kind: "wallet", id: w.id, name: w.name });
                  }}
                  testID={`wallet-card-${w.name}`}
                />
              ))}
            </View>
          )}
        </QueryView>
      </Section>

      {watch.data && watch.data.length > 0 ? (
        <Section
          title="Watching"
          meta={String(watch.data.length)}
          footer="Read-only addresses. They can't send, sign, or be shared with agents, and don't count toward your total."
        >
          <View style={{ gap: spacing.md }}>
            {watch.data.map((w) => (
              <WatchCard
                key={w.id}
                wallet={w}
                hidden={hidden}
                onMore={() => {
                  setTarget({ kind: "watch", id: w.id, name: w.name, address: w.address });
                }}
              />
            ))}
          </View>
        </Section>
      ) : null}

      <WalletSheets
        target={target}
        onClose={() => {
          setTarget(null);
        }}
      />
    </Screen>
  );
}
