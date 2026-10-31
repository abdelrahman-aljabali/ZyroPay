import { router } from "expo-router";
import { View } from "react-native";
import {
  Icon,
  motion,
  PressableScale,
  radii,
  Row,
  Screen,
  ScreenHeader,
  spacing,
  Text,
  useTheme,
  type IconName,
} from "@zyropay/ui";

function Option({
  icon,
  title,
  body,
  points,
  onPress,
  inverted,
  testID,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
  readonly onPress: () => void;
  readonly inverted?: boolean;
  readonly testID: string;
}) {
  const { colors } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      haptic
      scaleTo={motion.pressedScaleSubtle}
      accessibilityLabel={`${title}. ${body}`}
      testID={testID}
      style={{
        borderRadius: radii.card,
        backgroundColor: colors.surface,
        padding: spacing.xl,
        gap: spacing.lg,
      }}
    >
      <Row justify="space-between" align="flex-start">
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            backgroundColor: inverted === true ? colors.primary : colors.background,
            borderWidth: inverted === true ? 0 : 1.5,
            borderColor: colors.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={23} color={inverted === true ? colors.onPrimary : colors.text} />
        </View>
        <Icon name="arrowRight" size={20} color={colors.textSecondary} />
      </Row>
      <View style={{ gap: spacing.xs }}>
        <Text variant="headline">{title}</Text>
        <Text variant="callout" tone="secondary">
          {body}
        </Text>
      </View>
      <View style={{ gap: spacing.sm }}>
        {points.map((p) => (
          <Row key={p} gap={spacing.sm} align="flex-start">
            <Icon name="check" size={16} strokeWidth={2.2} color={colors.textSecondary} />
            <Text variant="footnote" tone="secondary" style={{ flex: 1 }}>
              {p}
            </Text>
          </Row>
        ))}
      </View>
    </PressableScale>
  );
}

/** Add wallet: create a passkey wallet, import one (ADR-003), or watch an address read-only. */
export default function AddWallet() {
  return (
    <Screen testID="wallets-add-screen">
      <ScreenHeader
        title="Add wallet"
        subtitle="Choose how this wallet works in ZyroPay."
        size="inline"
        backIcon="close"
        onBack={() => {
          router.back();
        }}
      />
      <Option
        icon="passkey"
        inverted
        title="Create new wallet"
        body="A fresh wallet on the chain you pick, secured by your passkey."
        points={[
          "Created in your own Turnkey sub-organization",
          "ZyroPay never holds a key that can move funds",
          "Can send, receive, and be shared with agents",
        ]}
        onPress={() => {
          router.push("/wallets/add/create");
        }}
        testID="add-wallet-create"
      />
      <Option
        icon="key"
        title="Import wallet"
        body="Bring a wallet you already have, with its recovery phrase or a private key."
        points={[
          "Encrypted on this phone, sent only to Turnkey's enclave",
          "ZyroPay never sees your phrase or key",
          "Secured by your passkey from then on",
        ]}
        onPress={() => {
          router.push("/wallets/add/import");
        }}
        testID="add-wallet-import"
      />
      <Option
        icon="eye"
        title="Watch an address"
        body="Follow any address's balance without its keys."
        points={["Paste or scan any address", "Read only: can't send or be used by agents"]}
        onPress={() => {
          router.push("/wallets/add/watch");
        }}
        testID="add-wallet-watch"
      />
    </Screen>
  );
}
