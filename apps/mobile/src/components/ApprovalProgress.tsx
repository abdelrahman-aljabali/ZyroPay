import { getNetwork, type NetworkId } from "@zyropay/shared";
import * as WebBrowser from "expo-web-browser";
import { ActivityIndicator, View } from "react-native";
import {
  Card,
  Icon,
  IconButton,
  KeyValueRow,
  radii,
  Row,
  SecondaryButton,
  shortenAddress,
  spacing,
  Text,
  useTheme,
} from "@zyropay/ui";
import { useCopy } from "@/lib/utils";
import { type DeliveryNotice, explorerLink, type RequestProgress } from "@/lib/x402";

type StepStatus = RequestProgress["steps"][number]["status"];

export function StepMark({ status }: { readonly status: StepStatus }) {
  const { colors } = useTheme();
  const size = 22;
  const base = {
    width: size,
    height: size,
    borderRadius: radii.pill,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  if (status === "done")
    return (
      <View style={[base, { backgroundColor: colors.success }]}>
        <Icon name="check" size={14} strokeWidth={2.4} color={colors.onPrimary} />
      </View>
    );
  if (status === "failed")
    return (
      <View style={[base, { backgroundColor: colors.dangerSoft }]}>
        <Icon name="close" size={14} strokeWidth={2.4} color={colors.dangerText} />
      </View>
    );
  if (status === "active")
    return (
      <View style={[base, { borderWidth: 2, borderColor: colors.text }]}>
        <ActivityIndicator
          size="small"
          color={colors.text}
          style={{ transform: [{ scale: 0.6 }] }}
        />
      </View>
    );
  return <View style={[base, { borderWidth: 2, borderColor: colors.separator }]} />;
}

/** x402: whether the seller's signed delivery receipt checked out. */
function DeliveryReceipt({ notice }: { readonly notice: DeliveryNotice }) {
  const { colors } = useTheme();
  const ink =
    notice.tone === "success"
      ? colors.success
      : notice.tone === "danger"
        ? colors.dangerText
        : colors.textSecondary;
  return (
    <Card
      style={{
        gap: spacing.xxs,
        ...(notice.tone === "danger" ? { backgroundColor: colors.dangerSoft } : {}),
      }}
      testID={`approval-delivery-${notice.tone}`}
    >
      <View accessibilityRole="summary" accessibilityLiveRegion="polite">
        <Text variant="caption" tone="secondary" style={{ marginBottom: 2 }}>
          Receipt
        </Text>
        <Row gap={spacing.sm}>
          <Icon
            name={
              notice.tone === "success"
                ? "shieldCheck"
                : notice.tone === "danger"
                  ? "warning"
                  : "info"
            }
            size={18}
            color={ink}
          />
          <Text variant="calloutStrong" style={{ color: ink }} testID="approval-delivery-title">
            {notice.title}
          </Text>
        </Row>
        <Text variant="footnote" tone="secondary" testID="approval-delivery-message">
          {notice.message}
        </Text>
        {notice.proof !== undefined ? (
          <Text variant="footnote" tone="secondary" testID="approval-delivery-proof">
            {notice.proof}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * After approval: where the request is (signed, submitted, paid / failed) as a short
 * timeline, the transaction id (copyable) and an explorer link once there is one. For
 * x402, once the seller answered: whether its delivery receipt was verified.
 */
export function ApprovalProgress({
  progress,
  network,
  txHash,
  simulated,
  showTitle = true,
  delivery = null,
}: {
  readonly progress: RequestProgress;
  /** x402 only: the delivery receipt verdict (deliveryNotice), once the seller answered. */
  readonly delivery?: DeliveryNotice | null;
  /** Off when the screen already headlines the state. */
  readonly showTitle?: boolean;
  readonly network: NetworkId;
  readonly txHash: string | null;
  readonly simulated: boolean;
}) {
  const { colors } = useTheme();
  const { copied, copy } = useCopy();
  const explorer = explorerLink(network, txHash);
  const steps = [
    { key: "approved", label: "Approved with your passkey", status: "done" as StepStatus },
    ...progress.steps,
  ];
  const ink =
    progress.tone === "danger"
      ? colors.dangerText
      : progress.tone === "success"
        ? colors.success
        : colors.text;
  return (
    <View style={{ gap: spacing.md }}>
      <Card style={{ gap: spacing.md }} testID="approval-status">
        <View
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          style={{ gap: spacing.xxs }}
        >
          {showTitle ? (
            <Text variant="calloutStrong" style={{ color: ink }} testID="approval-status-title">
              {progress.title}
            </Text>
          ) : null}
          <Text
            variant={showTitle ? "footnote" : "calloutStrong"}
            tone={showTitle ? "secondary" : "primary"}
            style={showTitle ? undefined : { color: ink }}
            testID="approval-status-message"
          >
            {progress.message}
          </Text>
        </View>
        <View style={{ height: 1, backgroundColor: colors.separator }} />
        <View style={{ gap: spacing.sm }}>
          {steps.map((s) => (
            <View key={s.key} testID={`approval-step-${s.key}-${s.status}`}>
              <Row gap={spacing.md}>
                <StepMark status={s.status} />
                <Text
                  variant={s.status === "active" ? "calloutStrong" : "callout"}
                  tone={s.status === "todo" ? "secondary" : "primary"}
                  style={s.status === "failed" ? { color: colors.dangerText } : undefined}
                  accessibilityLabel={`${s.label}: ${
                    s.status === "done"
                      ? "done"
                      : s.status === "active"
                        ? "in progress"
                        : s.status === "failed"
                          ? "failed"
                          : "not yet"
                  }`}
                >
                  {s.label}
                </Text>
              </Row>
            </View>
          ))}
        </View>
      </Card>
      {delivery ? <DeliveryReceipt notice={delivery} /> : null}
      {txHash ? (
        <Card style={{ paddingVertical: spacing.sm }}>
          <KeyValueRow
            label="Transaction"
            value={
              <Row gap={spacing.sm}>
                <Text variant="mono" testID="approval-tx-hash" accessibilityLabel={txHash}>
                  {shortenAddress(txHash, 8, 8)}
                </Text>
                <IconButton
                  icon={copied ? "check" : "copy"}
                  size={32}
                  variant="plain"
                  accessibilityLabel={copied ? "Copied" : "Copy transaction id"}
                  onPress={() => {
                    copy(txHash);
                  }}
                  testID="approval-tx-hash-copy"
                />
              </Row>
            }
          />
        </Card>
      ) : null}
      {explorer ? (
        <SecondaryButton
          label={`View on ${getNetwork(network).isTestnet ? "testnet explorer" : "explorer"}`}
          icon="external"
          onPress={() => {
            void WebBrowser.openBrowserAsync(explorer);
          }}
          testID="approval-explorer-link"
        />
      ) : null}
      {simulated ? (
        <Text variant="footnote" tone="secondary" align="center">
          Simulated: nothing was signed or sent, and the transaction id is not on chain.
        </Text>
      ) : null}
    </View>
  );
}
