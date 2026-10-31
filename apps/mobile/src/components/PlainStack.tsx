import { Stack } from "expo-router";
import { useTheme } from "@zyropay/ui";

/** Native stack without system headers: screens render their own ScreenHeader. */
export default function PlainStack() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
