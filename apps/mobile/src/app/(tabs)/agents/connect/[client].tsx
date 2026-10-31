import { router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import {
  breakAnywhere,
  Card,
  EmptyState,
  IconButton,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  SecurityWarning,
  spacing,
  Text,
  useTheme,
} from "@zyropay/ui";
import { agentClient } from "@/lib/agent-clients";
import { env } from "@/lib/env";
import { firstParam, useCopy } from "@/lib/utils";

/** Per-client instructions with the MCP server URL. */
export default function ClientInstructions() {
  const { colors } = useTheme();
  const guide = agentClient(firstParam(useLocalSearchParams<{ client: string }>().client));
  const { copied, copy } = useCopy();
  const back = () => {
    router.back();
  };

  if (!guide) {
    return (
      <Screen>
        <EmptyState icon="agent" title="Unknown client" actionLabel="Back" onAction={back} />
      </Screen>
    );
  }

  return (
    <Screen
      testID={`instructions-${guide.id}`}
      footer={
        <PrimaryButton
          label="Enter code"
          onPress={() => {
            router.push({ pathname: "/agents/claim", params: { client: guide.id } });
          }}
          testID="instructions-enter-code"
        />
      }
    >
      <ScreenHeader
        title={`Connect ${guide.name}`}
        subtitle={`by ${guide.vendor}`}
        size="inline"
        onBack={back}
      />
      <Card style={{ gap: spacing.sm }}>
        <Text variant="label" tone="secondary">
          MCP server URL
        </Text>
        <Row gap={spacing.sm}>
          <Text
            variant="mono"
            style={[{ flex: 1, minWidth: 0 }, breakAnywhere]}
            selectable
            testID="mcp-url"
          >
            {env.mcpUrl}
          </Text>
          <IconButton
            icon={copied ? "check" : "copy"}
            size={36}
            variant="plain"
            accessibilityLabel={copied ? "Copied" : "Copy MCP server URL"}
            onPress={() => {
              copy(env.mcpUrl);
            }}
            testID="copy-mcp-url"
          />
        </Row>
      </Card>
      <View style={{ gap: spacing.lg }}>
        {guide.steps.map((step, i) => (
          <Row key={step} align="flex-start" gap={spacing.md}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: colors.primary,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text variant="label" tone="inverse">
                {String(i + 1)}
              </Text>
            </View>
            <Text variant="callout" style={{ flex: 1 }}>
              {step}
            </Text>
          </Row>
        ))}
      </View>
      <SecurityWarning severity="info" title="Good to know" message={guide.note} />
      <SecurityWarning
        severity="warning"
        title="Only enter codes you started"
        message="If someone sends you a code, don't enter it: it would connect their agent to your wallet."
      />
    </Screen>
  );
}
