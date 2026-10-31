import { getNetwork } from "@zyropay/shared";
import { router } from "expo-router";
import {
  addressPlaceholder,
  AddressInput,
  EmptyState,
  NetworkBadge,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SecurityWarning,
} from "@zyropay/ui";
import { checkRecipient } from "@/lib/send";
import { readClipboard } from "@/lib/utils";
import { useSendFlow } from "@/state/flows";

/** Send 2/5 — recipient address, validated with the shared address helpers. */
export default function SendRecipient() {
  const balance = useSendFlow((s) => s.balance);
  const to = useSendFlow((s) => s.to);
  const setTo = useSendFlow((s) => s.setTo);

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

  const check = to === "" ? null : checkRecipient(balance, to);
  const net = getNetwork(balance.network);

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="send-recipient"
      footer={
        <PrimaryButton
          label="Continue"
          disabled={check?.ok !== true}
          onPress={() => {
            router.push("/send/amount");
          }}
          testID="send-recipient-continue"
        />
      }
    >
      <ScreenHeader
        title={`Send ${balance.asset.symbol}`}
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <NetworkBadge network={balance.network} />
      <AddressInput
        value={to}
        onChangeText={setTo}
        valid={check === null ? null : check.ok}
        errorMessage={check && !check.ok ? check.error : undefined}
        placeholder={addressPlaceholder(balance.network)}
        onPaste={() => {
          void readClipboard().then(setTo);
        }}
        testID="send-recipient-input"
      />
      {check?.ok === true && check.warning ? (
        <SecurityWarning severity="warning" title="Check the address" message={check.warning} />
      ) : null}
      <SecurityWarning
        severity={net.isTestnet ? "warning" : "info"}
        title={`Sending on ${net.displayName}`}
        message={`Make sure the recipient uses ${net.displayName}. Funds sent to an address on another network can be lost.${net.isTestnet ? " Testnet tokens have no real value; dollar amounts use mainnet prices." : ""}`}
      />
    </Screen>
  );
}
