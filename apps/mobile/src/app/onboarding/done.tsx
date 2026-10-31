import { useEffect } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ZoomIn } from "react-native-reanimated";
import { Icon, PrimaryButton, Screen, spacing, tapHaptic, Text, useTheme } from "@zyropay/ui";
import { prefsStore } from "@/state";

/** Onboarding 7/7 — done. Completing flips the route guard into the app. */
export default function Done() {
  const { colors, reducedMotion } = useTheme();
  useEffect(() => {
    tapHaptic("success");
  }, []);
  return (
    <Screen
      scroll={false}
      edges={["top", "bottom"]}
      testID="onboarding-done"
      footer={
        <PrimaryButton
          label="Open ZyroPay"
          onPress={() => {
            prefsStore.getState().completeOnboarding();
          }}
          testID="done-open"
        />
      }
    >
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.xl }}>
        <Animated.View
          entering={
            reducedMotion
              ? undefined
              : ZoomIn.withInitialValues({ transform: [{ scale: 0.6 }] })
                  .springify()
                  .damping(16)
                  .stiffness(200)
          }
          style={{
            width: 104,
            height: 104,
            borderRadius: 52,
            backgroundColor: colors.primary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="check" size={46} color={colors.onPrimary} strokeWidth={2.5} />
        </Animated.View>
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.delay(160).duration(320)}
          style={{ gap: spacing.sm, alignItems: "center" }}
        >
          <Text variant="title" align="center" accessibilityRole="header">
            You're set
          </Text>
          <Text variant="body" tone="secondary" align="center" style={{ maxWidth: 300 }}>
            Your passkey wallet is ready. Top up, send, or connect your first agent.
          </Text>
        </Animated.View>
      </View>
    </Screen>
  );
}
