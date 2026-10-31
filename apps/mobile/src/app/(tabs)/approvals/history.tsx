import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  EmptyState,
  formatDateTime,
  ListRow,
  ListSkeleton,
  screenGutter,
  ScreenHeader,
  spacing,
  StatusPill,
  useTheme,
} from "@zyropay/ui";
import { useAgents, useApprovals } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";

const TONE = {
  approved: "success",
  rejected: "danger",
  expired: "neutral",
  cancelled: "neutral",
  pending: "caution",
} as const;

/** Decided approvals (approved, rejected, expired, cancelled). */
export default function ApprovalHistory() {
  const { colors } = useTheme();
  const approvals = useApprovals();
  const agents = useAgents();
  const name = (agentId: string | null) =>
    agents.data?.find((a) => a.id === agentId)?.name ?? "You";
  return (
    <SafeAreaView
      edges={["top"]}
      style={{ flex: 1, backgroundColor: colors.background }}
      testID="approval-history"
    >
      <View style={{ paddingHorizontal: screenGutter, paddingBottom: spacing.md }}>
        <ScreenHeader
          title="History"
          size="inline"
          onBack={() => {
            router.back();
          }}
        />
      </View>
      <QueryView
        query={approvals}
        loading={
          <View style={{ paddingHorizontal: screenGutter }}>
            <ListSkeleton rows={6} />
          </View>
        }
        isEmpty={(d) => d.approvals.every((a) => a.status === "pending")}
        empty={<EmptyState icon="clock" title="No decisions yet" />}
      >
        {(d) => (
          <FlashList
            data={d.approvals.filter((a) => a.status !== "pending")}
            keyExtractor={(a) => a.id}
            contentContainerStyle={{ paddingHorizontal: screenGutter, paddingBottom: spacing.huge }}
            renderItem={({ item }) => (
              <ListRow
                title={name(item.agentId)}
                subtitle={formatDateTime(item.decidedAt ?? item.createdAt)}
                trailing={
                  <StatusPill
                    label={item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                    tone={TONE[item.status]}
                  />
                }
                onPress={() => {
                  router.push({ pathname: "/approvals/[id]", params: { id: item.id } });
                }}
              />
            )}
          />
        )}
      </QueryView>
    </SafeAreaView>
  );
}
