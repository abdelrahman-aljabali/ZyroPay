import { useState } from "react";
import { TextInput, View } from "react-native";
import { Icon, PressableScale, radii, Row, spacing, Text, useTheme } from "@zyropay/ui";
import { detectKeyFamily } from "@/lib/import/private-key";
import type { SecretDraft, SecretSnapshot } from "@/lib/import/secret";
import { SECRET_INPUT_PROPS } from "./PhraseEntry";

export interface KeyEntryProps {
  readonly draft: SecretDraft;
  readonly snapshot: SecretSnapshot;
  readonly error: string | null;
  readonly readOnly: boolean;
}

/** One raw private key (EVM hex or Solana base58), masked unless the user reveals it. */
export function KeyEntry({ draft, snapshot, error, readOnly }: KeyEntryProps) {
  const theme = useTheme();
  const { colors } = theme;
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const value = snapshot.key;
  const family = value === "" ? null : detectKeyFamily(value);

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label" tone="secondary">
        Private key
      </Text>
      <Row
        style={{
          backgroundColor: colors.surface,
          borderRadius: radii.md,
          borderWidth: 1.5,
          borderColor: error ? colors.danger : focused ? colors.text : "transparent",
          paddingLeft: spacing.lg,
          paddingRight: spacing.sm,
          minHeight: 56,
        }}
      >
        <TextInput
          {...SECRET_INPUT_PROPS}
          value={value}
          editable={!readOnly}
          secureTextEntry={!revealed}
          onChangeText={(t) => {
            draft.setKey(t);
          }}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
          }}
          placeholder="0x… or base58"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Private key"
          testID="import-key"
          style={[
            theme.type("mono"),
            { flex: 1, color: colors.text, padding: 0, height: 52, outlineWidth: 0 },
          ]}
        />
        <PressableScale
          onPress={() => {
            setRevealed((r) => !r);
          }}
          accessibilityRole="button"
          accessibilityLabel={revealed ? "Hide key" : "Show key"}
          hitSlop={8}
          style={{ padding: spacing.sm }}
          testID="import-key-reveal"
        >
          <Icon name={revealed ? "eyeOff" : "eye"} size={20} color={colors.textSecondary} />
        </PressableScale>
      </Row>
      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : (
        <Text variant="caption" tone="secondary">
          {family === "evm"
            ? "Looks like an EVM key (Ethereum, Base and other EVM chains)."
            : family === "solana"
              ? "Looks like a Solana key."
              : "EVM: 64 hex characters. Solana: the base58 key Phantom or Solflare exports."}
        </Text>
      )}
    </View>
  );
}
