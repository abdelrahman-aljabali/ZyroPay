import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  EmptyState,
  isMainnetPriced,
  ListSkeleton,
  MainnetPriceBadge,
  screenGutter,
  ScreenHeader,
  spacing,
  TransactionRow,
  useTheme,
} from "@zyropay/ui";
import { useTransactions } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { useAllowanceAddresses } from "@/hooks/useAllowanceAddresses";
import { transactionKindCopy } from "@/lib/tx-kind";
import { usePrefs } from "@/state";

/** Full transaction history (FlashList v2). */
export default function Activity() {
  const { colors } = useTheme();
  const hidden = usePrefs((s) => s.hideBalances);
  const txs = useTransactions({ limit: 100 });
  const allowances = useAllowanceAddresses();
  return (
    <SafeAreaView
      edges={["top"]}
      style={{ flex: 1, backgroundColor: colors.background }}
      testID="activity-screen"
    >
      <View style={{ paddingHorizontal: screenGutter, paddingBottom: spacing.md }}>
        <ScreenHeader
          title="Activity"
          size="inline"
          onBack={() => {
            router.back();
          }}
        />
        {txs.data?.transactions.some(isMainnetPriced) === true ? <MainnetPriceBadge /> : null}
      </View>
      <QueryView
        query={txs}
        loading={
          <View style={{ paddingHorizontal: screenGutter }}>
            <ListSkeleton rows={8} />
          </View>
        }
        isEmpty={(t) => t.transactions.length === 0}
        empty={<EmptyState icon="clock" title="No transactions yet" />}
      >
        {(t) => (
          <FlashList
            data={t.transactions}
            keyExtractor={(tx) => tx.id}
            contentContainerStyle={{ paddingHorizontal: screenGutter, paddingBottom: spacing.huge }}
            contentInsetAdjustmentBehavior="automatic"
            onRefresh={() => {
              void txs.refetch();
            }}
            refreshing={txs.isRefetching}
            renderItem={({ item }) => (
              <TransactionRow
                transaction={item}
                label={transactionKindCopy(item, allowances)?.label}
                hidden={hidden}
                onPress={() => {
                  router.push({ pathname: "/tx/[id]", params: { id: item.id } });
                }}
              />
            )}
          />
        )}
      </QueryView>
    </SafeAreaView>
  );
}
