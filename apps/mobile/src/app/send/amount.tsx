import { formatBaseUnits, valueInUsdMinor, minorUnitsToDecimal } from "@zyropay/shared";
import { router } from "expo-router";
import {
  AmountInput,
  EmptyState,
  formatFiat,
  withPriceMarker,
  formatTokenAmount,
  NetworkBadge,
  PrimaryButton,
  Screen,
  ScreenHeader,
  shortenAddress,
  Text,
} from "@zyropay/ui";
import { checkAmount } from "@/lib/send";
import { useSendFlow } from "@/state/flows";

/** Send 3/5 — amount with balance and fiat estimate. */
export default function SendAmount() {
  const balance = useSendFlow((s) => s.balance);
  const to = useSendFlow((s) => s.to);
  const amount = useSendFlow((s) => s.amount);
  const setAmount = useSendFlow((s) => s.setAmount);

  if (!balance) {
    return (
      <Screen>
        <EmptyState
          icon="arrowUp"
          title="Start again"
          actionLabel="Choose asset"
          onAction={() => {
            router.replace("/send");
          }}
        />
      </Screen>
    );
  }

  const check = checkAmount(balance, amount);
  const isNative = balance.asset.kind === "native";
  let fiat: string | null = null;
  if (check.ok && balance.price && balance.price.currency === "USD") {
    fiat = withPriceMarker(
      `≈ ${formatFiat(minorUnitsToDecimal(valueInUsdMinor({ amount: check.baseUnits, decimals: balance.asset.decimals }, balance.price.value)), "USD")}`,
      balance.priceBasis,
    );
  }

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="send-amount"
      footer={
        <PrimaryButton
          label="Review"
          disabled={!check.ok}
          onPress={() => {
            router.push("/send/review");
          }}
          testID="send-amount-continue"
        />
      }
    >
      <ScreenHeader
        title="Amount"
        subtitle={`To ${shortenAddress(to, 6, 6)}`}
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <NetworkBadge network={balance.network} />
      <AmountInput
        value={amount}
        onChangeText={setAmount}
        decimals={balance.asset.decimals}
        symbol={balance.asset.symbol}
        secondary={fiat}
        error={check.ok ? null : check.error}
        helper={`Balance ${formatTokenAmount(balance.amount, balance.asset.decimals, { symbol: balance.asset.symbol })}`}
        {...(isNative
          ? {}
          : {
              onMax: () => {
                setAmount(formatBaseUnits(balance.amount, balance.asset.decimals));
              },
            })}
        autoFocus
        testID="send-amount-input"
      />
      {isNative ? (
        <Text variant="caption" tone="secondary" align="center">
          {`Network fees are paid in ${balance.asset.symbol}, so leave a little for the fee.`}
        </Text>
      ) : null}
    </Screen>
  );
}
