import { router } from "expo-router";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import {
  IconTile,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  spacing,
  Text,
  useTheme,
  type IconName,
} from "@zyropay/ui";

const POINTS: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: "passkey",
    title: "Your passkey is the only key",
    body: "Your wallet lives in a secure enclave at Turnkey and only your passkey can sign. ZyroPay cannot move your funds.",
  },
  {
    icon: "sparkle",
    title: "Agents ask before they pay",
    body: "Connect Claude, ChatGPT or Grok. By default every payment waits for you to approve it here.",
  },
  {
    icon: "sliders",
    title: "Limits you set",
    body: "Optionally let an agent make small payments on its own, inside daily and monthly limits you choose. You can revoke it at any time.",
  },
];

/** Onboarding 2/7 — what ZyroPay is. */
export default function Intro() {
  const { reducedMotion } = useTheme();
  return (
    <Screen
      edges={["top", "bottom"]}
      testID="onboarding-intro"
      footer={
        <PrimaryButton
          label="Continue"
          onPress={() => {
            router.push({ pathname: "/onboarding/passkey", params: { mode: "signup" } });
          }}
          testID="intro-continue"
        />
      }
    >
      <ScreenHeader
        title="How ZyroPay works"
        onBack={() => {
          router.back();
        }}
      />
      <View style={{ gap: spacing.xxl, paddingTop: spacing.sm }}>
        {POINTS.map((p, i) => (
          <Animated.View
            key={p.title}
            entering={reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(360)}
          >
            <Row align="flex-start" gap={spacing.lg}>
              <IconTile icon={p.icon} tone="inverse" size={44} />
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text variant="bodyStrong">{p.title}</Text>
                <Text variant="callout" tone="secondary">
                  {p.body}
                </Text>
              </View>
            </Row>
          </Animated.View>
        ))}
      </View>
    </Screen>
  );
}
