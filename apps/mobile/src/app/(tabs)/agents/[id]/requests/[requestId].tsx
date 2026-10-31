import { getNetwork } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";
import { View } from "react-native";
import {
  AddressText,
  Card,
  EmptyState,
  formatDateTime,
  Icon,
  KeyValueRow,
  LoadingSkeleton,
  NetworkBadge,
  Row,
  Screen,
  ScreenHeader,
  SecurityWarning,
  SimulatedBadge,
  spacing,
  StatusPill,
  Text,
  TextButton,
  useTheme,
} from "@zyropay/ui";
import { useAgent, useAgentAllowance, useAgentRequests } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { useKnownSymbols } from "@/hooks/useKnownSymbols";
import { ACTIVITY_STATE, activityTitle } from "@/lib/agent-activity";
import {
  ada,
  allowanceFallback,
  AUTO_PAID_LABEL,
  AUTO_PAID_NOTE,
  isAutoPaid,
} from "@/lib/allowance";
import { policyReasonText } from "@/lib/escrow";
import { firstParam } from "@/lib/utils";
import { explorerLink, x402Purpose } from "@/lib/x402";

/**
 * One request an agent made without an approval: an auto-payment from its Cardano allowance
 * (no tap), or an autonomous payment inside the limits. What it paid, to whom, and why it
 * didn't need you.
 */
export default function AgentRequestDetail() {
  const params = useLocalSearchParams<{ id: string; requestId: string }>();
  const id = firstParam(params.id);
  const requestId = firstParam(params.requestId);
  const agent = useAgent(id);
  const requests = useAgentRequests(id);
  const allowance = useAgentAllowance(id);
  // What's left today changes with every auto-payment: read it fresh, not from the cache.
  const { refetch: refetchAllowance } = allowance;
  useEffect(() => {
    void refetchAllowance();
  }, [refetchAllowance]);
  const symbols = useKnownSymbols();
  const { colors } = useTheme();
  return (
    <Screen testID="agent-request-detail">
      <ScreenHeader
        title="Payment"
        subtitle={agent.data?.name}
        size="inline"
        onBack={() => {
          if (router.canGoBack()) router.back();
          else router.replace(`/agents/${id}`);
        }}
      />
      <QueryView query={requests} loading={<LoadingSkeleton height={260} radius={24} />}>
        {(d) => {
          const item = d.items.find((i) => i.request.id === requestId);
          if (item === undefined)
            return (
              <EmptyState
                icon="clock"
                title="Not found"
                message="This request isn't in the agent's activity."
              />
            );
          const r = item.request;
          const p = r.payload;
          const auto = isAutoPaid(r);
          const purpose = x402Purpose(p);
          const fallback = allowanceFallback(r.policyReasons);
          const a = allowance.data;
          const url = explorerLink(p.network, r.txHash);
          return (
            <View style={{ gap: spacing.xl }}>
              <Card
                style={{ gap: spacing.sm }}
                testID={auto ? "request-auto-paid" : "request-detail-card"}
              >
                <Row justify="space-between">
                  <Text variant="caption" tone="secondary">
                    {auto ? AUTO_PAID_LABEL : item.autonomous ? "Autonomous" : "Request"}
                  </Text>
                  <StatusPill
                    label={ACTIVITY_STATE[r.state].label}
                    tone={ACTIVITY_STATE[r.state].tone}
                  />
                </Row>
                {purpose?.description ? (
                  <Text variant="bodyStrong">{purpose.description}</Text>
                ) : null}
                <Text variant="title">{activityTitle(item, symbols)}</Text>
                {auto ? (
                  <Row gap={spacing.sm} align="flex-start">
                    <Icon name="shieldCheck" size={18} color={colors.success} />
                    <Text variant="callout" style={{ flex: 1 }} testID="request-auto-paid-note">
                      {AUTO_PAID_NOTE}
                    </Text>
                  </Row>
                ) : null}
                {auto && a?.onChain != null ? (
                  <Text variant="footnote" tone="secondary" testID="request-remaining-today">
                    {`${ada(a.onChain.remainingTodayLovelace)} left today · ${ada(a.onChain.balanceLovelace)} in the allowance`}
                  </Text>
                ) : null}
              </Card>
              {fallback !== null ? (
                <SecurityWarning
                  severity="info"
                  title={fallback.title}
                  message={fallback.message}
                />
              ) : null}
              <Card style={{ paddingVertical: spacing.sm }}>
                <KeyValueRow
                  label={purpose ? "Seller" : "To"}
                  value={<AddressText address={p.to} align="right" />}
                />
                {auto ? <KeyValueRow label="Paid from" value="Your on-chain allowance" /> : null}
                <KeyValueRow label="Network" value={<NetworkBadge network={p.network} />} />
                {purpose ? (
                  <KeyValueRow
                    label="Resource"
                    value={
                      <Text variant="footnote" align="right" selectable>
                        {purpose.url}
                      </Text>
                    }
                  />
                ) : null}
                <KeyValueRow
                  label="Policy"
                  value={
                    r.policyReasons.map((x) => policyReasonText(x)).join(" ") ||
                    "Within your limits"
                  }
                />
                <KeyValueRow label="When" value={formatDateTime(r.createdAt)} />
              </Card>
              {url !== null && !r.simulated ? (
                <TextButton
                  label={`View on ${getNetwork(p.network).family === "cardano" ? "Cardanoscan" : "the explorer"}`}
                  icon="external"
                  onPress={() => {
                    void WebBrowser.openBrowserAsync(url);
                  }}
                  testID="request-explorer"
                />
              ) : null}
              {r.simulated ? <SimulatedBadge /> : null}
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
