import { router } from "expo-router";
import { View } from "react-native";
import { Icon, PressableScale, radii, Row, spacing, Text, useTheme } from "@zyropay/ui";
import { AGENT_CLIENTS, type AgentClientGuide } from "@/lib/agent-clients";

/*
 * "Connect with Claude / ChatGPT / Grok". The assistants are named in plain
 * text with a neutral monogram. Their logos are deliberately not used: Anthropic's
 * trademark guidelines require prior approval, OpenAI asks developer apps to stay
 * free of its logos, and xAI's current asset pack could not be obtained from an
 * official source. See docs/BRAND_ASSETS.md before changing this.
 */

function Monogram({ name, inverse }: { readonly name: string; readonly inverse: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 30,
        height: 30,
        borderRadius: radii.pill,
        borderWidth: 1.5,
        borderColor: inverse ? colors.onPrimary : colors.text,
        alignItems: "center",
        justifyContent: "center",
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text
        variant="calloutStrong"
        style={{ color: inverse ? colors.onPrimary : colors.text, fontSize: 14, lineHeight: 18 }}
      >
        {name.slice(0, 1)}
      </Text>
    </View>
  );
}

function open(client: AgentClientGuide) {
  router.push({ pathname: "/agents/connect/[client]", params: { client: client.id } });
}

/** Full-width pills, primary ink. Used on the Agents empty state. */
export function ConnectButtons() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      {AGENT_CLIENTS.map((c) => (
        <PressableScale
          key={c.id}
          onPress={() => {
            open(c);
          }}
          haptic
          accessibilityLabel={`Connect with ${c.name}`}
          accessibilityHint={`Shows how to add ZyroPay to ${c.name} by ${c.vendor}`}
          testID={`connect-with-${c.id}`}
          style={{
            height: 56,
            borderRadius: radii.pill,
            backgroundColor: colors.primary,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: spacing.md,
          }}
        >
          <Monogram name={c.name} inverse />
          <Text variant="bodyStrong" style={{ color: colors.onPrimary }}>
            {`Connect with ${c.name}`}
          </Text>
        </PressableScale>
      ))}
    </View>
  );
}

/** Compact three-up row for when agents already exist. */
export function ConnectTiles() {
  const { colors } = useTheme();
  return (
    <Row gap={spacing.sm}>
      {AGENT_CLIENTS.map((c) => (
        <PressableScale
          key={c.id}
          onPress={() => {
            open(c);
          }}
          haptic
          accessibilityLabel={`Connect with ${c.name}`}
          containerStyle={{ flex: 1 }}
          style={{
            borderRadius: 20,
            backgroundColor: colors.surface,
            paddingVertical: spacing.lg,
            alignItems: "center",
            gap: spacing.sm,
          }}
        >
          <Monogram name={c.name} inverse={false} />
          <Text variant="label">{c.name}</Text>
          <Row gap={2}>
            <Icon name="plus" size={12} strokeWidth={2.4} color={colors.textSecondary} />
            <Text variant="caption" tone="secondary">
              Connect
            </Text>
          </Row>
        </PressableScale>
      ))}
    </Row>
  );
}
