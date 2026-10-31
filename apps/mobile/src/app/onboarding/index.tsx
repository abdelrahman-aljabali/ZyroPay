import { router } from "expo-router";
import { View } from "react-native";
import Animated, { Easing, FadeInDown } from "react-native-reanimated";
import { PrimaryButton, Screen, SecondaryButton, spacing, Text, useTheme } from "@zyropay/ui";
import { OrbitHero } from "@/components/OrbitHero";
import { env } from "@/lib/env";
import { usePrefs } from "@/state";

/** Onboarding 1/7 — Welcome. */
export default function Welcome() {
  const returning = usePrefs((s) => s.onboardingComplete);
  const { reducedMotion } = useTheme();
  return (
    <Screen
      scroll={false}
      edges={["top", "bottom"]}
      testID="onboarding-welcome"
      footer={
        <>
          <PrimaryButton
            label={returning ? "Sign in with passkey" : "Create your wallet"}
            onPress={() => {
              router.push(
                returning
                  ? { pathname: "/onboarding/passkey", params: { mode: "login" } }
                  : "/onboarding/intro",
              );
            }}
            testID="welcome-create"
          />
          {returning ? (
            <SecondaryButton
              label="Create a new wallet"
              onPress={() => {
                router.push("/onboarding/intro");
              }}
            />
          ) : (
            <SecondaryButton
              label="I already have a passkey"
              onPress={() => {
                router.push({ pathname: "/onboarding/passkey", params: { mode: "login" } });
              }}
              testID="welcome-login"
            />
          )}
        </>
      }
    >
      <View style={{ flex: 1, justifyContent: "center", gap: spacing.xxxl }}>
        {/* Decorative only: well-known chains as illustration, not ZyroPay's supported list. */}
        <OrbitHero />
        <Animated.View
          entering={
            reducedMotion
              ? undefined
              : FadeInDown.duration(420).easing(Easing.bezier(0.23, 1, 0.32, 1))
          }
          style={{ gap: spacing.md }}
        >
          <Text variant="display" accessibilityRole="header">
            Your AI asks. You decide.
          </Text>
          <Text variant="body" tone="secondary">
            A simple wallet for the AI age. Your assistant can request a payment — nothing leaves
            until you approve it.
          </Text>
          {env.mode === "development" ? (
            <Text variant="footnote" tone="caution">
              Development build · testnets only
            </Text>
          ) : null}
        </Animated.View>
      </View>
    </Screen>
  );
}
