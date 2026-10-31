import { FlashList } from "@shopify/flash-list";
import { router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  EmptyState,
  ListRow,
  ListSkeleton,
  screenGutter,
  ScreenHeader,
  SimulatedBadge,
  spacing,
  StatusPill,
  Text,
  useTheme,
} from "@zyropay/ui";
import { useAgent, useAgentRequests } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { useKnownSymbols } from "@/hooks/useKnownSymbols";
import { ACTIVITY_STATE, activitySubtitle, activityTitle } from "@/lib/agent-activity";
import { firstParam } from "@/lib/utils";

/** Agent activity: every request it made, in every state, including autonomous payments. */
export default function AgentActivity() {
  const { colors } = useTheme();
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const agent = useAgent(id);
  const requests = useAgentRequests(id);
  const symbols = useKnownSymbols();
  return (
    <SafeAreaView
      edges={["top"]}
      style={{ flex: 1, backgroundColor: colors.background }}
      testID="agent-activity-screen"
    >
      <View style={{ paddingHorizontal: screenGutter, gap: spacing.sm, paddingBottom: spacing.md }}>
        <ScreenHeader
          title="Activity"
          subtitle={agent.data?.name}
          size="inline"
          onBack={() => {
            router.back();
          }}
        />
        <Text variant="caption" tone="secondary">
          Every payment this agent asked for: the ones you approved or declined, and the ones it
          made on its own inside your limits, including auto-payments from its Cardano allowance.
        </Text>
      </View>
      <QueryView
        query={requests}
        loading={
          <View style={{ paddingHorizontal: screenGutter }}>
            <ListSkeleton rows={6} />
          </View>
        }
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState icon="clock" title="No activity yet" />}
      >
        {(d) => (
          <FlashList
            data={d.items}
            keyExtractor={(i) => i.request.id}
            contentContainerStyle={{ paddingHorizontal: screenGutter, paddingBottom: spacing.huge }}
            renderItem={({ item }) => (
              <ListRow
                title={activityTitle(item, symbols)}
                subtitle={activitySubtitle(item)}
                trailing={
                  <View style={{ alignItems: "flex-end", gap: spacing.xs }}>
                    <StatusPill
                      label={ACTIVITY_STATE[item.request.state].label}
                      tone={ACTIVITY_STATE[item.request.state].tone}
                    />
                    {item.request.simulated ? <SimulatedBadge /> : null}
                  </View>
                }
                onPress={() => {
                  if (item.approvalId !== null)
                    router.push({ pathname: "/approvals/[id]", params: { id: item.approvalId } });
                  else router.push(`/agents/${id}/requests/${item.request.id}`);
                }}
                testID={`agent-activity-${item.request.id}`}
              />
            )}
          />
        )}
      </QueryView>
    </SafeAreaView>
  );
}
