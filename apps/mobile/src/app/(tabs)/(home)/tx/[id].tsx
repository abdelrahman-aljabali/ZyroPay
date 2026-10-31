import { getNetwork, nativeAsset } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { View } from "react-native";
import {
  Card,
  formatDateTime,
  formatFiat,
  withPriceMarker,
  formatTokenAmount,
  IconButton,
  KeyValueRow,
  LoadingSkeleton,
  NetworkBadge,
  Row,
  Screen,
  ScreenHeader,
  SecondaryButton,
  shortenAddress,
  SimulatedBadge,
  spacing,
  StatusPill,
  Text,
} from "@zyropay/ui";
import { useTransaction } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { useAllowanceAddresses } from "@/hooks/useAllowanceAddresses";
import { transactionKindCopy } from "@/lib/tx-kind";
import { firstParam, useCopy } from "@/lib/utils";

/** Transaction detail / receipt. */
export default function TransactionDetail() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const tx = useTransaction(id);
  const allowances = useAllowanceAddresses();
  const { copied, copy } = useCopy();
  return (
    <Screen testID="tx-detail">
      <ScreenHeader
        title="Transaction"
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <QueryView query={tx} loading={<LoadingSkeleton height={240} radius={24} />}>
        {(t) => {
          const incoming = t.direction === "in";
          const native = nativeAsset(t.network);
          // Escrow locks and refunds (Masumi, Cardano) say so instead of "Sent" / "Received".
          const kind = transactionKindCopy(t, allowances);
          return (
            <View style={{ gap: spacing.xl }}>
              <View style={{ alignItems: "center", gap: spacing.sm }}>
                <Text variant="label" tone="secondary" testID="tx-detail-kind">
                  {kind !== null
                    ? kind.label
                    : incoming
                      ? "Received"
                      : t.direction === "out"
                        ? "Sent"
                        : "Moved between your accounts"}
                </Text>
                <Text
                  variant="title"
                  tone={incoming ? "success" : "primary"}
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {`${incoming ? "+" : t.direction === "out" ? "−" : ""}${formatTokenAmount(t.amount, t.asset.decimals, { symbol: t.asset.symbol, maxFractionDigits: 9 })}`}
                </Text>
                {t.valueAtTime ? (
                  <Text variant="callout" tone="secondary">
                    {withPriceMarker(
                      `${formatFiat(t.valueAtTime.value, t.valueAtTime.currency)} at the time`,
                      t.priceBasis,
                    )}
                  </Text>
                ) : null}
                <Row gap={spacing.sm}>
                  <StatusPill
                    label={
                      t.status === "confirmed"
                        ? "Confirmed"
                        : t.status === "pending"
                          ? "Pending"
                          : "Failed"
                    }
                    tone={
                      t.status === "confirmed"
                        ? "success"
                        : t.status === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  />
                  {t.simulated ? <SimulatedBadge /> : null}
                </Row>
                {kind !== null ? (
                  <Text
                    variant="footnote"
                    tone="secondary"
                    align="center"
                    style={{ maxWidth: 420 }}
                    testID="tx-detail-kind-note"
                  >
                    {kind.note}
                  </Text>
                ) : null}
              </View>
              <Card style={{ paddingVertical: spacing.sm }}>
                <KeyValueRow label="Network" value={<NetworkBadge network={t.network} />} />
                <KeyValueRow
                  label={kind !== null && incoming ? `From (${kind.counterparty})` : "From"}
                  value={shortenAddress(t.from, 6, 6)}
                />
                <KeyValueRow
                  label={kind !== null && !incoming ? `To (${kind.counterparty})` : "To"}
                  value={shortenAddress(t.to, 6, 6)}
                />
                <KeyValueRow label="Date" value={formatDateTime(t.timestamp)} />
                {t.fee !== null ? (
                  <KeyValueRow
                    label="Network fee"
                    value={formatTokenAmount(t.fee, native.decimals, {
                      symbol: native.symbol,
                      maxFractionDigits: 9,
                    })}
                  />
                ) : null}
                {t.blockNumber !== null ? (
                  <KeyValueRow label="Block" value={t.blockNumber} />
                ) : null}
                <KeyValueRow
                  label="Hash"
                  value={
                    <Row gap={spacing.sm}>
                      <Text variant="mono">{shortenAddress(t.txHash, 6, 6)}</Text>
                      <IconButton
                        icon={copied ? "check" : "copy"}
                        size={32}
                        variant="plain"
                        accessibilityLabel={copied ? "Copied" : "Copy transaction hash"}
                        onPress={() => {
                          copy(t.txHash);
                        }}
                      />
                    </Row>
                  }
                />
              </Card>
              {t.explorerUrl ? (
                <SecondaryButton
                  label={`View on ${getNetwork(t.network).isTestnet ? "testnet explorer" : "explorer"}`}
                  icon="external"
                  accessibilityHint="Opens the transaction in a block explorer"
                  testID="tx-detail-explorer"
                  onPress={() => {
                    if (t.explorerUrl) void WebBrowser.openBrowserAsync(t.explorerUrl);
                  }}
                />
              ) : null}
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
