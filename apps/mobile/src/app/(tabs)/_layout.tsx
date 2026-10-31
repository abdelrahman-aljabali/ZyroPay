import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useTheme } from "@zyropay/ui";
import { Platform } from "react-native";
import { useApprovals } from "@/api/hooks";
import { WebTabs } from "@/components/WebTabs";

/**
 * System tab bar: on iOS 26 this is the Liquid Glass bar, on Android a
 * Material 3 bottom navigation. SF Symbols / Material Symbols are the
 * platform's own glyphs, so the bar always looks native.
 */
export default function TabsLayout() {
  const { colors } = useTheme();
  const pending = useApprovals("pending");
  const pendingCount = pending.data?.approvals.length ?? 0;

  // Expo web (visual QA only) has no native tab bar.
  if (Platform.OS === "web") return <WebTabs badge={pendingCount} />;

  return (
    <NativeTabs
      tintColor={colors.text}
      iconColor={{ default: colors.textSecondary, selected: colors.text }}
      labelStyle={{ default: { color: colors.textSecondary }, selected: { color: colors.text } }}
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="wallets">
        <NativeTabs.Trigger.Label>Wallets</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "wallet.bifold", selected: "wallet.bifold.fill" }}
          md="account_balance_wallet"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="sparkles" md="smart_toy" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="approvals">
        <NativeTabs.Trigger.Label>Approvals</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "checkmark.shield", selected: "checkmark.shield.fill" }}
          md="verified_user"
        />
        {pendingCount > 0 ? (
          <NativeTabs.Trigger.Badge>{String(pendingCount)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
