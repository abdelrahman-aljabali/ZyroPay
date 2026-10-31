import { getNetwork, type NetworkId } from "@zyropay/shared";
import { View } from "react-native";
import {
  Icon,
  ListGroup,
  NetworkLogo,
  PressableScale,
  radii,
  Row,
  spacing,
  Text,
  useTheme,
} from "@zyropay/ui";

export interface ChainPickerProps {
  /** From the shared registry, already filtered to the build's mode. */
  readonly networks: readonly NetworkId[];
  readonly value: NetworkId | null;
  readonly onChange: (network: NetworkId) => void;
  /** Secondary line per chain (e.g. "Same address on Base Sepolia"). */
  readonly describe?: (network: NetworkId) => string | undefined;
  readonly testID?: string;
}

/** Radio list of chains with their marks. A new registry entry shows up with no UI change. */
export function ChainPicker({ networks, value, onChange, describe, testID }: ChainPickerProps) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" testID={testID}>
      <ListGroup inset={spacing.lg + 32 + spacing.md}>
        {networks.map((n) => {
          const info = getNetwork(n);
          const selected = value === n;
          const note = describe?.(n);
          return (
            <PressableScale
              key={n}
              onPress={() => {
                onChange(n);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${info.displayName}${info.isTestnet ? ", testnet" : ""}`}
              accessibilityHint={note}
              scaleTo={1}
              highlight={colors.surfaceStrong}
              testID={testID ? `${testID}-${n}` : undefined}
            >
              <Row
                style={{
                  minHeight: 60,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                }}
              >
                <NetworkLogo network={n} size={32} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Row gap={spacing.sm}>
                    <Text variant="body">{info.displayName}</Text>
                    {info.isTestnet ? (
                      <View
                        style={{
                          backgroundColor: colors.cautionSoft,
                          borderRadius: radii.pill,
                          paddingHorizontal: 6,
                          paddingVertical: 1,
                        }}
                      >
                        <Text variant="caption" tone="caution">
                          Testnet
                        </Text>
                      </View>
                    ) : null}
                  </Row>
                  {note ? (
                    <Text variant="footnote" tone="secondary">
                      {note}
                    </Text>
                  ) : null}
                </View>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: radii.pill,
                    borderWidth: selected ? 0 : 1.5,
                    borderColor: colors.border,
                    backgroundColor: selected ? colors.primary : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selected ? (
                    <Icon name="check" size={14} strokeWidth={2.6} color={colors.onPrimary} />
                  ) : null}
                </View>
              </Row>
            </PressableScale>
          );
        })}
      </ListGroup>
    </View>
  );
}
