import type { Agent, CardanoAllowance } from "@zyropay/shared";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { View } from "react-native";
import {
  Card,
  ConfirmationSheet,
  Divider,
  formatDateTime,
  formatFiat,
  formatRelativeTime,
  Icon,
  KeyValueRow,
  LoadingSkeleton,
  PrimaryButton,
  ProgressBar,
  Row,
  SecondaryButton,
  Section,
  SecurityWarning,
  shortenAddress,
  spacing,
  StatusPill,
  Text,
  TextButton,
  TextField,
  useTheme,
} from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";
import { useAgentAllowance, useAllowanceSpends } from "@/api/hooks";
import { useAdaPrice } from "@/hooks/useAdaPrice";
import {
  ada,
  ALLOWANCE_NETWORK,
  allowanceActions,
  allowanceStatusView,
  amountKeystrokes,
  explorerAddressLink,
  isLiveAllowance,
  amountToLovelace,
  lovelaceToFiat,
  payeesLabel,
  spentToday,
  limitLabel,
} from "@/lib/allowance";
import { env } from "@/lib/env";
import { useCopy } from "@/lib/utils";
import { explorerLink } from "@/lib/x402";
import { useAllowanceSigning } from "./AllowanceSigning";

/** Why this agent can't use auto-pay yet, or null. */
export function autoPayBlocker(agent: Agent): string | null {
  const p = agent.policy;
  if (!p.spendingEnabled) return "Spending is off for this agent. Turn it on in Permissions first.";
  if (!p.allowedNetworks.includes(ALLOWANCE_NETWORK))
    return "This agent isn't allowed to use Cardano Preprod. Allow it in Permissions first.";
  if (!p.allowedTools.includes("send") && !p.allowedTools.includes("pay_x402"))
    return "This agent can't make payments. Allow transfers or x402 payments in Permissions first.";
  return null;
}

function goSetup(agentId: string) {
  router.push(`/agents/${agentId}/autopay`);
}

/**
 * Auto-pay on Cardano on the agent detail: the allowance as Cardano holds it (balance, spent
 * today against the cap, limits, payees, expiry, the agent's fee float, the contract) with Top
 * up and Revoke & withdraw (both passkey, verified on the device), or the way to set it up.
 */
export function AllowanceCard({ agent }: { readonly agent: Agent }) {
  const query = useAgentAllowance(agent.id);
  const a = query.data;

  let body;
  if (query.isPending) body = <LoadingSkeleton height={180} radius={24} />;
  else if (query.isError && a === undefined)
    body = (
      <Card style={{ gap: spacing.sm }} testID="allowance-load-error">
        <Text variant="calloutStrong">
          {isApiError(query.error, "NETWORK_ERROR")
            ? "You're offline"
            : "Couldn't read the allowance"}
        </Text>
        <Text variant="footnote" tone="secondary">
          {isApiError(query.error, "NETWORK_ERROR")
            ? "Auto-pay keeps working on Cardano within its limits. Connect to see its balance."
            : errorMessage(query.error)}
        </Text>
        <TextButton
          label="Try again"
          icon="refresh"
          onPress={() => {
            void query.refetch();
          }}
          testID="allowance-retry"
        />
      </Card>
    );
  else if (a != null && isLiveAllowance(a))
    body = <LiveAllowance agent={agent} allowance={a} stale={query.isError} />;
  else body = <AllowanceEmpty agent={agent} last={a ?? null} />;

  return (
    <Section title="Auto-pay on Cardano">
      <View testID="allowance-card">{body}</View>
    </Section>
  );
}

function AllowanceEmpty({
  agent,
  last,
}: {
  readonly agent: Agent;
  readonly last: CardanoAllowance | null;
}) {
  const blocker = autoPayBlocker(agent);
  return (
    <Card style={{ gap: spacing.md }} testID="allowance-empty">
      <Row gap={spacing.sm}>
        <Icon name="bolt" size={18} />
        <Text variant="calloutStrong" style={{ flex: 1 }}>
          Off
        </Text>
        {last !== null ? (
          <StatusPill label={allowanceStatusView(last).label} tone="neutral" />
        ) : null}
      </Row>
      <Text variant="footnote" tone="secondary">
        Let this agent pay small amounts in ADA without asking you each time, from an allowance you
        fund. Cardano itself enforces the limits — not ZyroPay. Anything above them still comes to
        you.
      </Text>
      {blocker !== null ? (
        <View testID="allowance-blocked">
          <SecurityWarning severity="info" title="Not available yet" message={blocker}>
            <TextButton
              label="Open Permissions"
              icon="sliders"
              onPress={() => {
                router.push({ pathname: "/agents/[id]/policy", params: { id: agent.id } });
              }}
            />
          </SecurityWarning>
        </View>
      ) : (
        <SecondaryButton
          label={last?.status === "revoked" ? "Set up auto-pay again" : "Set up auto-pay"}
          icon="bolt"
          onPress={() => {
            goSetup(agent.id);
          }}
          testID="allowance-setup"
        />
      )}
    </Card>
  );
}

function LiveAllowance({
  agent,
  allowance: a,
  stale,
}: {
  readonly agent: Agent;
  readonly allowance: CardanoAllowance;
  readonly stale: boolean;
}) {
  const { colors } = useTheme();
  const status = allowanceStatusView(a);
  const actions = allowanceActions(a);
  const today = spentToday(a);
  const fiat = a.limits.fiat;
  const price = useAdaPrice(fiat?.currency ?? "EUR");
  const spends = useAllowanceSpends(agent.id, a.onChain !== null);
  const [topUp, setTopUp] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const signing = useAllowanceSigning(agent.id);
  const { copied, copy } = useCopy();
  const simulated = env.mocksActive;
  const cur = fiat?.currency;
  const balance = a.onChain?.balanceLovelace ?? null;
  const balanceFiat =
    balance !== null && price !== null ? lovelaceToFiat(BigInt(balance), price.value) : null;
  const topUpLovelace = topUp === null ? null : amountToLovelace(topUp, "ADA", null);
  const ink =
    status.tone === "danger"
      ? colors.dangerText
      : status.tone === "success"
        ? colors.success
        : colors.text;

  return (
    <View style={{ gap: spacing.md }} testID={`allowance-state-${a.status}`}>
      <Card style={{ gap: spacing.md }}>
        <View
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          style={{ gap: spacing.xxs }}
        >
          <Row justify="space-between">
            <Text variant="caption" tone="secondary">
              On-chain allowance
            </Text>
            <StatusPill label={status.label} tone={status.tone} />
          </Row>
          {balance !== null ? (
            <View style={{ gap: 2 }}>
              <Text
                variant="title"
                testID="allowance-balance"
                accessibilityLabel={`${ada(balance)} left in the allowance`}
              >
                {ada(balance)}
              </Text>
              <Text variant="footnote" tone="secondary">
                {balanceFiat !== null && price !== null
                  ? `≈ ${formatFiat(balanceFiat, price.currency)} left · 2 ADA stays as Cardano's minimum`
                  : "Left · 2 ADA stays as Cardano's minimum"}
              </Text>
            </View>
          ) : (
            <Text variant="calloutStrong" style={{ color: ink }}>
              {a.status === "pending_create" ? "Waiting for your passkey" : "Waiting for Cardano"}
            </Text>
          )}
          <Text variant="footnote" tone="secondary" testID="allowance-message">
            {status.message}
          </Text>
        </View>
        {today !== null ? (
          <View style={{ gap: spacing.xs }} testID="allowance-today">
            <Row justify="space-between">
              <Text variant="footnote" tone="secondary">
                Spent today
              </Text>
              <Text variant="footnote">{today.label}</Text>
            </Row>
            <ProgressBar
              value={today.fraction}
              accessibilityLabel="Spent today"
              valueText={today.label}
              tone={today.fraction >= 1 ? "caution" : "neutral"}
            />
            {a.onChain !== null ? (
              <Text variant="caption" tone="secondary">
                {`Resets ${formatRelativeTime(a.onChain.periodEndsAt)} · up to ${ada(a.onChain.availableNowLovelace)} can be paid right now`}
              </Text>
            ) : null}
          </View>
        ) : null}
        {stale ? (
          <Text variant="caption" tone="secondary">
            Couldn't refresh just now; showing the last reading.
          </Text>
        ) : null}
      </Card>

      {a.float?.low === true ? (
        <SecurityWarning
          severity="warning"
          title="Agent's ADA for fees is low"
          message={`The agent has ${ada(a.float.lovelace)} left for network fees, so payments will soon come to you. Revoke and set up again with a bigger float.`}
        />
      ) : null}

      <Card style={{ paddingVertical: spacing.sm }} testID="allowance-details">
        <KeyValueRow
          label="Max per payment"
          value={limitLabel(a.limits.perPaymentLovelace, fiat?.perPayment, cur)}
        />
        <KeyValueRow
          label="Max per day"
          value={limitLabel(a.limits.perDayLovelace, fiat?.perDay, cur)}
        />
        <KeyValueRow label="Payees" value={payeesLabel(a.limits.payees)} />
        <KeyValueRow label="Expires" value={formatDateTime(a.limits.expiresAt)} />
        <KeyValueRow
          label="Agent's fee ADA"
          value={a.float !== null ? ada(a.float.lovelace) : ada(a.floatLovelace)}
        />
        <KeyValueRow
          label="Contract"
          value={
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text
                variant="mono"
                align="right"
                accessibilityLabel={`Contract address ${a.scriptAddress}`}
                testID="allowance-script"
              >
                {shortenAddress(a.scriptAddress, 10, 6)}
              </Text>
              <Row gap={spacing.md}>
                <TextButton
                  label={copied ? "Copied" : "Copy"}
                  icon="copy"
                  onPress={() => {
                    copy(a.scriptAddress);
                  }}
                  accessibilityHint="Copies the allowance contract address"
                  testID="allowance-copy-script"
                />
                {simulated ? null : (
                  <TextButton
                    label="Cardanoscan"
                    icon="external"
                    onPress={() => {
                      void WebBrowser.openBrowserAsync(
                        explorerAddressLink(ALLOWANCE_NETWORK, a.scriptAddress),
                      );
                    }}
                    accessibilityHint="Opens the allowance contract in the Cardano explorer"
                    testID="allowance-explorer"
                  />
                )}
              </Row>
            </View>
          }
        />
        {a.limits.payees.mode === "list" && a.limits.payees.addresses.length > 1
          ? a.limits.payees.addresses.map((p) => (
              <KeyValueRow
                key={p}
                label="Payee"
                value={
                  <Text variant="mono" tone="secondary" align="right" accessibilityLabel={p}>
                    {shortenAddress(p, 10, 6)}
                  </Text>
                }
              />
            ))
          : null}
      </Card>

      {(spends.data ?? []).length > 0 ? (
        <Card style={{ paddingVertical: spacing.sm, gap: spacing.xs }} testID="allowance-spends">
          <Text variant="caption" tone="secondary">
            Auto-paid recently
          </Text>
          {(spends.data ?? []).slice(0, 3).map((s, i) => {
            const url = explorerLink(ALLOWANCE_NETWORK, s.txHash);
            return (
              <View key={s.id}>
                {i > 0 ? <Divider /> : null}
                <Row justify="space-between" style={{ paddingVertical: spacing.xs }}>
                  <View style={{ flex: 1 }}>
                    <Text variant="callout">{`${ada(s.lovelace)} to ${shortenAddress(s.payee, 8, 4)}`}</Text>
                    <Text variant="caption" tone="secondary">
                      {`${s.status === "confirmed" ? "Confirmed" : s.status === "failed" ? "Failed" : "Confirming"} · ${formatRelativeTime(s.createdAt)}`}
                    </Text>
                  </View>
                  {url !== null && !simulated ? (
                    <TextButton
                      label="View"
                      icon="external"
                      onPress={() => {
                        void WebBrowser.openBrowserAsync(url);
                      }}
                      accessibilityHint="Opens the payment in the Cardano explorer"
                    />
                  ) : null}
                </Row>
              </View>
            );
          })}
        </Card>
      ) : null}

      {signing.done !== null ? (
        <Text variant="footnote" tone="success" testID="allowance-done">
          {signing.done}
        </Text>
      ) : null}
      {signing.errorView}

      {actions.finish ? (
        <PrimaryButton
          label="Finish setup"
          icon="passkey"
          onPress={() => {
            goSetup(agent.id);
          }}
          testID="allowance-finish"
        />
      ) : null}
      {actions.topUp ? (
        <SecondaryButton
          label="Top up"
          icon="plus"
          disabled={signing.busy}
          loading={signing.preparing === "top_up"}
          onPress={() => {
            setTopUp("10");
          }}
          testID="allowance-topup"
        />
      ) : null}
      {actions.revoke ? (
        <SecondaryButton
          label="Revoke & withdraw"
          icon="arrowDownLeft"
          disabled={signing.busy}
          loading={signing.preparing === "revoke"}
          onPress={() => {
            setConfirmRevoke(true);
          }}
          testID="allowance-revoke"
        />
      ) : null}
      {(actions.topUp || actions.revoke) && !signing.signable ? (
        <Text variant="footnote" tone="secondary">
          {signing.unavailableReason ?? "Signing with your passkey isn't available here."}
        </Text>
      ) : null}
      {a.createTxHash !== null && !simulated ? (
        <TextButton
          label="View the create transaction"
          icon="external"
          onPress={() => {
            void WebBrowser.openBrowserAsync(explorerLink(ALLOWANCE_NETWORK, a.createTxHash) ?? "");
          }}
          testID="allowance-create-tx"
        />
      ) : null}

      <ConfirmationSheet
        visible={topUp !== null}
        icon="plus"
        title="Top up the allowance"
        message="How much ADA to add. The limits and today's spending stay as they are."
        confirmLabel="Review"
        onCancel={() => {
          setTopUp(null);
        }}
        onConfirm={() => {
          if (topUpLovelace === null || topUpLovelace === 0n) return;
          setTopUp(null);
          void signing.start(
            { action: "top_up", body: { budget: { lovelace: topUpLovelace.toString() } } },
            { addLovelace: topUpLovelace },
          );
        }}
        testID="allowance-topup-sheet"
      >
        <TextField
          label="Add (ADA)"
          value={topUp ?? ""}
          onChangeText={(t) => {
            setTopUp(amountKeystrokes(t));
          }}
          keyboardType="decimal-pad"
          error={
            topUp !== null && topUp !== "" && (topUpLovelace === null || topUpLovelace === 0n)
              ? "Enter an amount like 10 or 2.5."
              : null
          }
          hint={
            topUpLovelace !== null && price !== null
              ? `≈ ${formatFiat(lovelaceToFiat(topUpLovelace, price.value) ?? "0", price.currency)} · paid from your wallet, plus a small network fee`
              : "Paid from your wallet, plus a small network fee."
          }
          testID="allowance-topup-amount"
        />
      </ConfirmationSheet>

      <ConfirmationSheet
        visible={confirmRevoke}
        icon="arrowDownLeft"
        title="Revoke and withdraw?"
        message={`Everything in the allowance${balance !== null ? ` (${ada(balance)})` : ""} and the agent's ADA for fees come back to your wallet, and the agent's key is destroyed. Its payments come to you for approval again.`}
        confirmLabel="Review"
        destructive
        onCancel={() => {
          setConfirmRevoke(false);
        }}
        onConfirm={() => {
          setConfirmRevoke(false);
          void signing.start({ action: "revoke" });
        }}
        testID="allowance-revoke-sheet"
      />

      {signing.reviewSheet}
    </View>
  );
}
