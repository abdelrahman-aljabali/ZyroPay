import { parseAssetId } from "@zyropay/shared";
import { router } from "expo-router";
import {
  AmountInput,
  Chip,
  EmptyState,
  NetworkBadge,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  SecurityWarning,
  spacing,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useQuoteOnramp } from "@/api/hooks";
import { usePrefs } from "@/state";
import { useTopUpFlow } from "@/state/flows";

const PRESETS = ["50", "100", "250"];

/** Top up 2/4 — fiat amount, then fetch a quote. */
export default function TopUpAmount() {
  const flow = useTopUpFlow();
  const currency = usePrefs((s) => s.currency);
  const quote = useQuoteOnramp();
  const fiatCurrency = currency === "JPY" ? "USD" : currency;

  if (!flow.assetId || !flow.walletId) {
    return (
      <Screen>
        <EmptyState
          icon="plus"
          title="Choose an asset first"
          actionLabel="Back"
          onAction={() => {
            router.replace("/topup");
          }}
        />
      </Screen>
    );
  }
  const { network } = parseAssetId(flow.assetId);
  const valid = /^\d+(\.\d{1,2})?$/.test(flow.fiatAmount) && flow.fiatAmount !== "0";

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="topup-amount"
      footer={
        <PrimaryButton
          label="Get quote"
          disabled={!valid}
          loading={quote.isPending}
          onPress={() => {
            if (!flow.assetId || !flow.walletId) return;
            quote.mutate(
              {
                fiat: { value: flow.fiatAmount, currency: fiatCurrency },
                network,
                assetId: flow.assetId,
                walletId: flow.walletId,
              },
              {
                onSuccess: (q) => {
                  flow.setQuote(q);
                  router.push("/topup/quote");
                },
              },
            );
          }}
          testID="topup-get-quote"
        />
      }
    >
      <ScreenHeader
        title="How much?"
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <NetworkBadge network={network} />
      <AmountInput
        value={flow.fiatAmount}
        onChangeText={flow.setFiatAmount}
        decimals={2}
        symbol={fiatCurrency}
        autoFocus
        testID="topup-amount-input"
      />
      <Row justify="center" gap={spacing.sm}>
        {PRESETS.map((p) => (
          <Chip
            key={p}
            label={`${p} ${fiatCurrency}`}
            selected={flow.fiatAmount === p}
            onPress={() => {
              flow.setFiatAmount(p);
            }}
          />
        ))}
      </Row>
      {quote.isError ? (
        <SecurityWarning severity="danger" title="No quote" message={errorMessage(quote.error)} />
      ) : null}
    </Screen>
  );
}
