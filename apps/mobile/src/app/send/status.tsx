import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { View } from "react-native";
import {
  Card,
  EmptyState,
  KeyValueRow,
  NetworkBadge,
  PrimaryButton,
  Screen,
  SecondaryButton,
  shortenAddress,
  SimulatedBadge,
  spacing,
  StatusPill,
} from "@zyropay/ui";
import { useSendProgress } from "@/api/hooks";
import { summarizeReview } from "@/lib/review";
import { useSendFlow } from "@/state/flows";

const STATE_LABEL: Partial<Record<string, string>> = {
  BROADCAST: "Sent to the network",
  CONFIRMED: "Confirmed",
  SIGNING: "Signing",
  APPROVED: "Approved",
  FAILED: "Failed",
};

/** Send 5/5 — status and receipt. */
export default function SendStatus() {
  const { result, review, balance, reset } = useSendFlow();
  // The submit answer stops at BROADCAST; follow the chain until it confirms or fails.
  const state =
    useSendProgress(result, balance?.walletId ?? "", review?.payload.network ?? "solana-devnet") ??
    "";
  const done = () => {
    reset();
    router.dismissAll();
  };
  if (!result || !review || !balance) {
    return (
      <Screen>
        <EmptyState icon="check" title="Nothing in progress" actionLabel="Close" onAction={done} />
      </Screen>
    );
  }
  const s = summarizeReview(review, balance.asset.symbol);
  const failed = state === "FAILED";
  const confirmed = state === "CONFIRMED";
  return (
    <Screen
      edges={["top", "bottom"]}
      testID="send-status"
      footer={<PrimaryButton label="Done" onPress={done} testID="send-done" />}
    >
      <EmptyState
        icon={failed ? "warning" : "check"}
        title={failed ? "Payment failed" : confirmed ? "Payment confirmed" : "Payment sent"}
        message={
          result.simulated
            ? "Simulated: nothing was signed or broadcast."
            : failed
              ? "Nothing left your wallet except possibly the network fee."
              : confirmed
                ? "The network has confirmed it."
                : "It usually confirms within a minute."
        }
      />
      <View style={{ alignItems: "center", gap: spacing.sm }}>
        <StatusPill
          label={STATE_LABEL[state] ?? state}
          tone={failed ? "danger" : confirmed ? "success" : "neutral"}
        />
        {result.simulated ? <SimulatedBadge /> : null}
      </View>
      <Card style={{ paddingVertical: spacing.sm }}>
        <KeyValueRow label="Amount" value={s.amountLabel} emphasis />
        {s.fiatLabel ? <KeyValueRow label="Value" value={s.fiatLabel} /> : null}
        <KeyValueRow label="To" value={s.recipientShort} />
        <KeyValueRow label="Network" value={<NetworkBadge network={review.payload.network} />} />
        <KeyValueRow label="Fee (max)" value={s.feeLabel} />
        {result.txHash ? (
          <KeyValueRow label="Hash" value={shortenAddress(result.txHash, 6, 6)} />
        ) : null}
      </Card>
      {result.explorerUrl ? (
        <SecondaryButton
          label="View on explorer"
          icon="external"
          onPress={() => {
            if (result.explorerUrl) void WebBrowser.openBrowserAsync(result.explorerUrl);
          }}
        />
      ) : null}
    </Screen>
  );
}
