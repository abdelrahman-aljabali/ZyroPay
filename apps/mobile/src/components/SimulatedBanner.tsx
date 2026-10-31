import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, spacing, Text, useTheme } from "@zyropay/ui";
import { env } from "@/lib/env";

/**
 * Persistent banner while the DEV mock transport is active. It cannot be
 * dismissed: simulated balances must never be mistaken for real ones.
 */
export function SimulatedBanner() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  if (!env.mocksActive) return null;
  return (
    <Pressable
      onPress={() => {
        setExpanded((v) => !v);
      }}
      accessibilityRole="button"
      accessibilityLabel="Simulated data. Development mock is active. Balances and transactions are not real."
      testID="simulated-banner"
      style={{
        backgroundColor: colors.cautionSoft,
        paddingTop: insets.top + spacing.xs,
        paddingBottom: spacing.xs,
        paddingHorizontal: spacing.lg,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.sm,
        }}
      >
        <Icon name="warning" size={14} color={colors.caution} />
        <Text variant="caption" style={{ color: colors.caution }}>
          Simulated data · development mock
        </Text>
      </View>
      {expanded ? (
        <Text
          variant="caption"
          align="center"
          style={{ color: colors.caution, marginTop: spacing.xs }}
        >
          EXPO_PUBLIC_USE_MOCKS=1. Nothing here is real money and nothing is signed or broadcast.
        </Text>
      ) : null}
    </Pressable>
  );
}
