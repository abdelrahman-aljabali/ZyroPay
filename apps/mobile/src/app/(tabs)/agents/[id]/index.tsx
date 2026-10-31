import { getNetwork } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  Card,
  ConfirmationSheet,
  Divider,
  formatDateTime,
  formatFiatMinor,
  KeyValueRow,
  ListRow,
  LoadingSkeleton,
  Screen,
  ScreenHeader,
  Section,
  SecurityWarning,
  spacing,
  StatusPill,
  Text,
  TextField,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import {
  useAgent,
  useAgentRequests,
  useRenameAgent,
  useRevokeAgent,
  useWallets,
} from "@/api/hooks";
import { AllowanceCard } from "@/components/AllowanceCard";
import { QueryView } from "@/components/QueryView";
import { useKnownSymbols } from "@/hooks/useKnownSymbols";
import { ACTIVITY_STATE, activitySubtitle, activityTitle } from "@/lib/agent-activity";
import { firstParam } from "@/lib/utils";

/** Agent detail: permissions summary, recent requests, rename, disconnect. */
export default function AgentDetail() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const agent = useAgent(id);
  const wallets = useWallets();
  const requests = useAgentRequests(id);
  const symbols = useKnownSymbols();
  const revoke = useRevokeAgent();
  const rename = useRenameAgent(id);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <Screen testID="agent-detail">
      <QueryView query={agent} loading={<LoadingSkeleton height={260} radius={24} />}>
        {(a) => {
          const p = a.policy;
          const revoked = p.revoked || a.revokedAt !== null;
          const walletNames = p.allowedWalletIds
            .map((wid) => wallets.data?.find((w) => w.id === wid)?.name ?? "Wallet")
            .join(", ");
          // Every request, autonomous payments included (approvals alone would miss those).
          const recent = (requests.data?.items ?? []).slice(0, 3);
          return (
            <View style={{ gap: spacing.xl }}>
              <ScreenHeader
                title={a.name}
                subtitle={
                  a.lastUsedAt ? `Last active ${formatDateTime(a.lastUsedAt)}` : "Not used yet"
                }
                size="inline"
                onBack={() => {
                  router.back();
                }}
              />
              {revoked ? (
                <SecurityWarning
                  severity="info"
                  title="Revoked"
                  message={`Disconnected ${a.revokedAt ? formatDateTime(a.revokedAt) : ""}. It can no longer read or request anything.`}
                />
              ) : null}
              <Card style={{ paddingVertical: spacing.sm }}>
                <KeyValueRow
                  label="Mode"
                  value={
                    <StatusPill
                      label={p.mode === "autonomous" ? "Autonomous" : "Always ask"}
                      tone={p.mode === "autonomous" ? "caution" : "neutral"}
                    />
                  }
                />
                <KeyValueRow label="Spending" value={p.spendingEnabled ? "On" : "Off"} />
                {p.mode === "autonomous" ? (
                  <>
                    <KeyValueRow
                      label="Per payment"
                      value={formatFiatMinor(p.limits.perTransactionUsdMinor, "USD")}
                    />
                    <KeyValueRow
                      label="Daily"
                      value={formatFiatMinor(p.limits.dailyUsdMinor, "USD")}
                    />
                    <KeyValueRow
                      label="Monthly"
                      value={formatFiatMinor(p.limits.monthlyUsdMinor, "USD")}
                    />
                    <KeyValueRow
                      label="Above limits"
                      value={p.overLimitBehavior === "deny" ? "Refuse" : "Ask me"}
                    />
                  </>
                ) : null}
                <KeyValueRow label="Wallets" value={walletNames || "None"} />
                <KeyValueRow
                  label="Networks"
                  value={
                    p.allowedNetworks.map((n) => getNetwork(n).displayName).join(", ") || "None"
                  }
                />
                <KeyValueRow
                  label="Recipients"
                  value={
                    p.restrictRecipients
                      ? `${String(p.recipientAllowlist.length)} allowed`
                      : "Any address"
                  }
                />
                <KeyValueRow label="Plugins" value={p.allowedProtocols.join(", ") || "None"} />
                <KeyValueRow
                  label="Access ends"
                  value={p.sessionExpiresAt ? formatDateTime(p.sessionExpiresAt) : "When revoked"}
                />
              </Card>

              {!revoked ? <AllowanceCard agent={a} /> : null}

              {!revoked ? (
                <Card style={{ paddingVertical: spacing.xs }}>
                  <ListRow
                    icon="sliders"
                    title="Permissions and limits"
                    onPress={() => {
                      router.push({ pathname: "/agents/[id]/policy", params: { id: a.id } });
                    }}
                    testID="agent-edit-policy"
                  />
                  <Divider inset={36} />
                  <ListRow
                    icon="clock"
                    title="Activity"
                    onPress={() => {
                      router.push({ pathname: "/agents/[id]/activity", params: { id: a.id } });
                    }}
                    testID="agent-activity"
                  />
                  <Divider inset={36} />
                  <ListRow
                    icon="user"
                    title="Rename"
                    onPress={() => {
                      setRenaming(a.name);
                    }}
                  />
                </Card>
              ) : null}

              {recent.length > 0 ? (
                <Section title="Recent activity">
                  {recent.map((item) => (
                    <ListRow
                      key={item.request.id}
                      title={activityTitle(item, symbols)}
                      subtitle={activitySubtitle(item)}
                      trailing={
                        <StatusPill
                          label={ACTIVITY_STATE[item.request.state].label}
                          tone={ACTIVITY_STATE[item.request.state].tone}
                        />
                      }
                      onPress={() => {
                        if (item.approvalId !== null)
                          router.push({
                            pathname: "/approvals/[id]",
                            params: { id: item.approvalId },
                          });
                        else router.push(`/agents/${a.id}/requests/${item.request.id}`);
                      }}
                      testID={`agent-recent-${item.request.id}`}
                    />
                  ))}
                </Section>
              ) : (
                <Text variant="callout" tone="secondary">
                  No payment requests from this agent yet.
                </Text>
              )}

              {!revoked ? (
                <ListRow
                  icon="logout"
                  title="Disconnect agent"
                  destructive
                  onPress={() => {
                    setConfirmRevoke(true);
                  }}
                  testID="agent-revoke"
                />
              ) : null}

              <ConfirmationSheet
                visible={confirmRevoke}
                title={`Disconnect ${a.name}?`}
                message="Its access is revoked immediately, pending requests are cancelled and any autonomous signing permission is removed."
                confirmLabel="Disconnect"
                destructive
                loading={revoke.isPending}
                onCancel={() => {
                  setConfirmRevoke(false);
                }}
                onConfirm={() => {
                  revoke.mutate(a.id, {
                    onSettled: () => {
                      setConfirmRevoke(false);
                    },
                  });
                }}
                testID="agent-revoke-sheet"
              >
                {revoke.isError ? (
                  <SecurityWarning
                    severity="danger"
                    title="Couldn't disconnect"
                    message={errorMessage(revoke.error)}
                  />
                ) : null}
              </ConfirmationSheet>

              <ConfirmationSheet
                visible={renaming !== null}
                title="Rename agent"
                confirmLabel="Save"
                loading={rename.isPending}
                onCancel={() => {
                  setRenaming(null);
                }}
                onConfirm={() => {
                  const next = renaming?.trim() ?? "";
                  if (next === "") return;
                  rename.mutate(next, {
                    onSuccess: () => {
                      setRenaming(null);
                    },
                  });
                }}
              >
                <TextField
                  label="Name"
                  value={renaming ?? ""}
                  onChangeText={setRenaming}
                  maxLength={64}
                />
                {rename.isError ? (
                  <SecurityWarning
                    severity="danger"
                    title="Couldn't rename"
                    message={errorMessage(rename.error)}
                  />
                ) : null}
              </ConfirmationSheet>
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
