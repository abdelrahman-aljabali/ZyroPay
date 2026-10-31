import * as Linking from "expo-linking";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { View } from "react-native";
import {
  Card,
  EmptyState,
  formatCountdown,
  formatFiat,
  formatTokenAmount,
  KeyValueRow,
  NetworkBadge,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SecurityWarning,
  SimulatedBadge,
  spacing,
  Text,
  useCountdown,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useCreateOnrampSession } from "@/api/hooks";
import { useKnownSymbols } from "@/hooks/useKnownSymbols";
import { useTopUpFlow } from "@/state/flows";
import { nativeAsset, parseAssetId } from "@zyropay/shared";

/** Top up 3/4 — quote review, then the provider-hosted checkout in an auth browser session. */
export default function TopUpQuote() {
  const flow = useTopUpFlow();
  const createSession = useCreateOnrampSession();
  const symbols = useKnownSymbols();
  const [browserError, setBrowserError] = useState<string | null>(null);
  const q = flow.quote;
  const remaining = useCountdown(q?.expiresAt ?? "1970-01-01T00:00:00.000Z");

  if (!q || !flow.walletId) {
    return (
      <Screen>
        <EmptyState
          icon="plus"
          title="Quote missing"
          actionLabel="Start again"
          onAction={() => {
            router.replace("/topup");
          }}
        />
      </Screen>
    );
  }

  const { tokenAddress } = parseAssetId(q.assetId);
  const symbol =
    tokenAddress === null ? nativeAsset(q.network).symbol : (symbols.get(q.assetId) ?? "tokens");
  const expired = remaining <= 0;

  const checkout = () => {
    if (!flow.walletId) return;
    setBrowserError(null);
    createSession.mutate(
      { quoteId: q.quoteId, walletId: flow.walletId },
      {
        onSuccess: (s) => {
          flow.setSession(s.sessionId, s.simulated);
          const returnUrl = Linking.createURL("/topup/return");
          // Provider-hosted checkout: card details never touch ZyroPay. Resolves on redirect or dismiss.
          WebBrowser.openAuthSessionAsync(s.url, returnUrl)
            .then(() => {
              router.replace("/topup/status");
            })
            .catch((e: unknown) => {
              setBrowserError(e instanceof Error ? e.message : "Couldn't open the checkout");
            });
        },
      },
    );
  };

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="topup-quote"
      footer={
        <PrimaryButton
          label={expired ? "Quote expired" : `Continue to ${q.provider}`}
          icon="external"
          disabled={expired}
          loading={createSession.isPending}
          onPress={checkout}
          testID="topup-checkout"
        />
      }
    >
      <ScreenHeader
        title="Quote"
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <View style={{ alignItems: "center", gap: spacing.xs }}>
        <Text variant="label" tone="secondary">
          You get about
        </Text>
        <Text variant="title" style={{ fontVariant: ["tabular-nums"] }}>
          {formatTokenAmount(q.cryptoAmount, q.decimals, { symbol })}
        </Text>
        {q.simulated ? <SimulatedBadge /> : null}
      </View>
      <Card style={{ paddingVertical: spacing.sm }}>
        <KeyValueRow label="You pay" value={formatFiat(q.fiat.value, q.fiat.currency)} emphasis />
        <KeyValueRow label="Fees" value={formatFiat(q.fees.value, q.fees.currency)} />
        <KeyValueRow label="Provider" value={q.provider} />
        <KeyValueRow label="Network" value={<NetworkBadge network={q.network} />} />
        <KeyValueRow label="Valid for" value={expired ? "Expired" : formatCountdown(remaining)} />
      </Card>
      <Text variant="caption" tone="secondary">
        The final amount is set by the provider at payment time. Identity checks happen on their
        page; ZyroPay never sees your card.
      </Text>
      {createSession.isError ? (
        <SecurityWarning
          severity="danger"
          title="Checkout unavailable"
          message={errorMessage(createSession.error)}
        />
      ) : null}
      {browserError ? (
        <SecurityWarning severity="danger" title="Checkout unavailable" message={browserError} />
      ) : null}
    </Screen>
  );
}
