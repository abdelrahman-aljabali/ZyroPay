import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  Card,
  Icon,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  SecurityWarning,
  spacing,
  Text,
  ToggleRow,
} from "@zyropay/ui";

/** Onboarding 5/7 — recovery and export, explained honestly. */
export default function RecoveryStep() {
  const [understood, setUnderstood] = useState(false);
  return (
    <Screen
      edges={["top", "bottom"]}
      testID="onboarding-recovery"
      footer={
        <PrimaryButton
          label="Continue"
          disabled={!understood}
          onPress={() => {
            router.push("/onboarding/notifications");
          }}
          testID="recovery-continue"
        />
      }
    >
      <ScreenHeader
        title="Keeping access"
        subtitle="ZyroPay is self-custody. That means nobody, including us, can recover your wallet for you."
      />
      <View style={{ gap: spacing.md }}>
        <Card>
          <Row align="flex-start" gap={spacing.lg}>
            <Icon name="passkey" />
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Text variant="bodyStrong">Keep your passkey synced</Text>
              <Text variant="callout" tone="secondary">
                iCloud Keychain or Google Password Manager keeps your passkey on your other devices.
                Add a second passkey from Settings → Security.
              </Text>
            </View>
          </Row>
        </Card>
        <Card>
          <Row align="flex-start" gap={spacing.lg}>
            <Icon name="key" />
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Text variant="bodyStrong">Export a recovery phrase</Text>
              <Text variant="callout" tone="secondary">
                Any time, from Wallets → Export, after confirming with your passkey. Write it down
                offline. Anyone with it controls your funds.
              </Text>
            </View>
          </Row>
        </Card>
      </View>
      <SecurityWarning
        severity="warning"
        title="No reset button"
        message="If you lose every passkey and never exported a recovery phrase, the funds cannot be recovered."
      />
      <ToggleRow
        title="I understand"
        subtitle="ZyroPay can't restore my wallet."
        value={understood}
        onValueChange={setUnderstood}
        testID="recovery-understood"
      />
    </Screen>
  );
}
