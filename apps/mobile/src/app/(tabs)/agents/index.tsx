import { router } from "expo-router";
import { View } from "react-native";
import {
  AgentCard,
  CardSkeleton,
  EmptyState,
  IconButton,
  ListGroup,
  ListRow,
  Screen,
  ScreenHeader,
  Section,
  spacing,
  TextButton,
} from "@zyropay/ui";
import { useAgents, useApprovals } from "@/api/hooks";
import { ConnectButtons, ConnectTiles } from "@/components/AgentConnect";
import { QueryView } from "@/components/QueryView";

/** Connected agents, active first; revoked ones listed separately; connect shortcuts. */
export default function Agents() {
  const agents = useAgents();
  const pending = useApprovals("pending");
  const pendingFor = (agentId: string) =>
    pending.data?.approvals.filter((a) => a.agentId === agentId).length ?? 0;
  const activeCount =
    agents.data?.filter((a) => !a.policy.revoked && a.revokedAt === null).length ?? 0;

  return (
    <Screen
      testID="agents-screen"
      refreshing={agents.isRefetching}
      onRefresh={() => {
        void agents.refetch();
      }}
    >
      <ScreenHeader
        title="Agents"
        subtitle={agents.data ? `${String(activeCount)} active` : undefined}
        actions={
          <IconButton
            icon="plus"
            variant="primary"
            accessibilityLabel="Connect an agent"
            onPress={() => {
              router.push("/agents/connect");
            }}
            testID="agents-connect"
          />
        }
      />
      <QueryView
        query={agents}
        loading={<CardSkeleton rows={2} height={132} />}
        isEmpty={(list) =>
          list.filter((a) => !a.policy.revoked && a.revokedAt === null).length === 0
        }
        empty={
          <EmptyState
            variant="card"
            icon="sparkle"
            title="Connect your first agent"
            message="Add ZyroPay to the assistant you already use. New agents start in Always Ask with spending off."
          >
            <ConnectButtons />
            <TextButton
              label="I already have a code"
              tone="secondary"
              onPress={() => {
                router.push("/agents/claim");
              }}
            />
          </EmptyState>
        }
      >
        {(list) => {
          const active = list.filter((a) => !a.policy.revoked && a.revokedAt === null);
          const revoked = list.filter((a) => a.policy.revoked || a.revokedAt !== null);
          return (
            <View style={{ gap: spacing.xxl }}>
              <View style={{ gap: spacing.md }}>
                {active.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    pendingApprovals={pendingFor(a.id)}
                    onPress={() => {
                      router.push({ pathname: "/agents/[id]", params: { id: a.id } });
                    }}
                    testID={`agent-card-${a.name}`}
                  />
                ))}
              </View>
              <ListGroup>
                <ListRow
                  icon="search"
                  title="Discover agents"
                  subtitle="Agents registered on Masumi (Cardano) that yours can hire"
                  onPress={() => {
                    router.push("/agents/discover");
                  }}
                  testID="agents-discover"
                />
              </ListGroup>
              <Section
                title="Connect another"
                footer="Agents connect over MCP. You confirm each one here with a one-time code."
              >
                <ConnectTiles />
              </Section>
              {revoked.length > 0 ? (
                <Section title="Revoked" meta={String(revoked.length)}>
                  <View style={{ gap: spacing.md }}>
                    {revoked.map((a) => (
                      <AgentCard
                        key={a.id}
                        agent={a}
                        onPress={() => {
                          router.push({ pathname: "/agents/[id]", params: { id: a.id } });
                        }}
                      />
                    ))}
                  </View>
                </Section>
              ) : null}
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
