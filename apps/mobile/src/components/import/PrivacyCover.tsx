import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { Icon, spacing, Text, useTheme } from "@zyropay/ui";

/**
 * Covers the screen while the app is inactive or in the background, so the app switcher
 * snapshot and anyone glancing at a backgrounded phone never see a phrase being typed.
 * Screen recording and screenshots are handled by usePreventScreenCapture.
 */
export function PrivacyCover() {
  const { colors } = useTheme();
  const [hidden, setHidden] = useState(AppState.currentState !== "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      setHidden(s !== "active");
    });
    return () => {
      sub.remove();
    };
  }, []);
  if (!hidden) return null;
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.md,
          zIndex: 10,
        },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name="lock" size={28} color={colors.textSecondary} />
      <Text variant="callout" tone="secondary">
        Hidden while ZyroPay is in the background
      </Text>
    </View>
  );
}
