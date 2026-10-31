import { Tabs } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, PressableScale, radii, spacing, Text, useTheme, type IconName } from "@zyropay/ui";

/*
 * Expo web only (visual QA). Native builds use NativeTabs (Liquid Glass on
 * iOS 26, Material 3 on Android); the web has neither, so this draws a
 * floating pill bar in the app's own vocabulary. Never rendered on iOS/Android.
 */

const TABS: readonly { name: string; label: string; icon: IconName }[] = [
  { name: "(home)", label: "Home", icon: "home" },
  { name: "wallets", label: "Wallets", icon: "wallet" },
  { name: "agents", label: "Agents", icon: "sparkle" },
  { name: "approvals", label: "Approvals", icon: "shieldCheck" },
  { name: "settings", label: "Settings", icon: "settings" },
];

interface BarProps {
  readonly state: {
    index: number;
    routes: {
      key: string;
      name: string;
      state?: { index?: number; routes?: { name: string }[] };
    }[];
  };
  readonly navigation: { navigate: (name: string) => void };
}

function WebTabBar({ state, navigation, badge }: BarProps & { readonly badge: number }) {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  // Like iOS hidesBottomBarWhenPushed: pushed screens (stack depth > 0) own the bottom edge.
  const nested = state.routes[state.index]?.state;
  const top = nested?.routes?.[nested.index ?? 0]?.name;
  if (top !== undefined && top !== "index") return null;
  return (
    <View
      style={{
        position: "absolute",
        left: spacing.xl,
        right: spacing.xl,
        bottom: Math.max(insets.bottom, spacing.lg),
        flexDirection: "row",
        padding: spacing.xs + 2,
        borderRadius: radii.pill,
        backgroundColor: scheme === "dark" ? "rgba(28,28,30,0.92)" : "rgba(242,242,242,0.94)",
        borderWidth: 1,
        borderColor: colors.border,
      }}
      accessibilityRole="tablist"
    >
      {state.routes.map((route, i) => {
        const tab = TABS.find((t) => t.name === route.name);
        if (!tab) return null;
        const selected = state.index === i;
        return (
          <PressableScale
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
            onPress={() => {
              navigation.navigate(route.name);
            }}
            containerStyle={{ flex: 1 }}
            style={{
              height: 52,
              borderRadius: radii.pill,
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
              backgroundColor: selected ? colors.surfaceStrong : "transparent",
            }}
          >
            <View>
              <Icon
                name={tab.icon}
                size={21}
                strokeWidth={selected ? 2.1 : 1.75}
                color={selected ? colors.text : colors.textSecondary}
              />
              {tab.name === "approvals" && badge > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -9,
                    minWidth: 16,
                    height: 16,
                    paddingHorizontal: 4,
                    borderRadius: 8,
                    backgroundColor: colors.danger,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text
                    variant="caption"
                    style={{ color: "#FFFFFF", fontSize: 10, lineHeight: 12 }}
                  >
                    {String(badge)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              variant="caption"
              style={{
                fontSize: 10,
                lineHeight: 12,
                color: selected ? colors.text : colors.textSecondary,
              }}
            >
              {tab.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

export function WebTabs({ badge }: { readonly badge: number }) {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
      tabBar={(props) => <WebTabBar {...(props as unknown as BarProps)} badge={badge} />}
    >
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />
      ))}
    </Tabs>
  );
}
