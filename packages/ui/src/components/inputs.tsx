import { useState } from "react";
import { Platform, Switch, TextInput, View, type TextInputProps } from "react-native";
import { sanitizeAmountInput } from "../format";
import { Icon } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { radii, sizes, spacing } from "../tokens";
import { breakAnywhere, PressableScale, Row, Text } from "./primitives";
import { useInGroup } from "./rows";

export interface AmountInputProps {
  /** Human decimal string the user typed (not base units). */
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  readonly decimals: number;
  readonly symbol: string;
  /** e.g. "Balance 1.25 SOL". */
  readonly helper?: string;
  /** e.g. "≈ $123.45". */
  readonly secondary?: string | null;
  readonly error?: string | null;
  readonly onMax?: () => void;
  readonly autoFocus?: boolean;
  readonly testID?: string;
}

/** Large centred amount entry; rejects keystrokes beyond the asset's decimals. */
export function AmountInput({
  value,
  onChangeText,
  decimals,
  symbol,
  helper,
  secondary,
  error,
  onMax,
  autoFocus,
  testID,
}: AmountInputProps) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <View style={{ alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xl }}>
      <Row gap={spacing.sm} justify="center">
        <TextInput
          testID={testID}
          value={value}
          onChangeText={(text) => {
            const next = sanitizeAmountInput(text, decimals);
            if (next !== null) onChangeText(next);
          }}
          placeholder="0"
          placeholderTextColor={colors.textSecondary}
          keyboardType="decimal-pad"
          autoFocus={autoFocus}
          accessibilityLabel={`Amount in ${symbol}`}
          style={[
            theme.type("display"),
            {
              color: error ? colors.danger : colors.text,
              minWidth: 60,
              textAlign: "center",
              padding: 0,
              outlineWidth: 0,
              fontVariant: ["tabular-nums"],
            },
          ]}
          maxFontSizeMultiplier={1.3}
        />
        <Text variant="headline" tone="secondary">
          {symbol}
        </Text>
      </Row>
      {secondary ? (
        <Text variant="callout" tone="secondary">
          {secondary}
        </Text>
      ) : null}
      {error ? (
        <Text variant="label" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {helper || onMax ? (
        <Row gap={spacing.sm}>
          {helper ? (
            <Text variant="label" tone="secondary">
              {helper}
            </Text>
          ) : null}
          {onMax ? (
            <PressableScale
              onPress={onMax}
              accessibilityLabel="Use maximum amount"
              style={{
                backgroundColor: colors.surface,
                borderRadius: radii.pill,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.xs,
              }}
            >
              <Text variant="label">Max</Text>
            </PressableScale>
          ) : null}
        </Row>
      ) : null}
    </View>
  );
}

export interface AddressInputProps {
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  /** Validation result from the shared address helpers; null = not validated yet. */
  readonly valid: boolean | null;
  readonly errorMessage?: string;
  readonly placeholder?: string;
  readonly onPaste?: () => void;
  readonly label?: string;
  readonly testID?: string;
}

export function AddressInput({
  value,
  onChangeText,
  valid,
  errorMessage = "This is not a valid address for the selected network.",
  placeholder = "Address",
  onPaste,
  label = "Recipient",
  testID,
}: AddressInputProps) {
  const theme = useTheme();
  const { colors } = theme;
  const border = valid === false ? colors.danger : valid === true ? colors.success : "transparent";
  // Web: a multiline TextInput is a <textarea> that does not grow, so a 63-108 character
  // Cardano address would scroll inside one line. Size it to its content (at least three
  // lines once there is text) and let it break anywhere. Native grows on its own.
  const [contentHeight, setContentHeight] = useState(0);
  const lineHeight = theme.type("mono").lineHeight ?? 22;
  const webHeight =
    Platform.OS === "web" && value !== ""
      ? { height: Math.max(lineHeight * 3, contentHeight) }
      : null;
  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label" tone="secondary">
        {label}
      </Text>
      <Row
        style={{
          backgroundColor: colors.surface,
          borderRadius: radii.md,
          borderWidth: 1.5,
          borderColor: border,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        }}
      >
        <TextInput
          testID={testID}
          value={value}
          onChangeText={(t) => {
            onChangeText(t.trim());
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          onContentSizeChange={(e) => {
            setContentHeight(Math.ceil(e.nativeEvent.contentSize.height));
          }}
          accessibilityLabel={label}
          style={[
            theme.type("mono"),
            { color: colors.text, flex: 1, padding: 0, minHeight: 22, outlineWidth: 0 },
            breakAnywhere,
            webHeight,
          ]}
        />
        {valid === true ? <Icon name="check" color={colors.success} size={20} /> : null}
        {onPaste && value === "" ? (
          <PressableScale
            onPress={onPaste}
            accessibilityLabel="Paste address"
            style={{
              backgroundColor: colors.background,
              borderRadius: radii.pill,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs,
            }}
          >
            <Text variant="label">Paste</Text>
          </PressableScale>
        ) : null}
      </Row>
      {valid === false && value.length > 0 ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

export interface SearchFieldProps extends Pick<
  TextInputProps,
  "value" | "onChangeText" | "placeholder" | "testID"
> {
  readonly accessibilityLabel?: string;
}

/** Gray pill search field. */
export function SearchField({
  value,
  onChangeText,
  placeholder = "Search",
  testID,
  accessibilityLabel,
}: SearchFieldProps) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Row
      gap={spacing.sm}
      style={{
        height: sizes.searchHeight,
        borderRadius: radii.pill,
        backgroundColor: colors.surface,
        paddingHorizontal: spacing.md,
      }}
    >
      <Icon name="search" size={18} color={colors.textSecondary} />
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel={accessibilityLabel ?? placeholder}
        style={[
          theme.type("callout"),
          // alignSelf stretch: the whole pill is the tap target, not just the text line.
          { color: colors.text, flex: 1, alignSelf: "stretch", padding: 0, outlineWidth: 0 },
        ]}
      />
    </Row>
  );
}

export interface TextFieldProps extends Omit<TextInputProps, "style"> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
}

export function TextField({ label, hint, error, ...rest }: TextFieldProps) {
  const theme = useTheme();
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label" tone="secondary">
        {label}
      </Text>
      <TextInput
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel={label}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        style={[
          theme.type("body"),
          {
            color: colors.text,
            backgroundColor: colors.surface,
            borderRadius: radii.md,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderWidth: 1.5,
            borderColor: error ? colors.danger : focused ? colors.text : "transparent",
            // The focus border above is the focus indicator; drop the browser's extra ring (web QA).
            outlineWidth: 0,
          },
        ]}
      />
      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="secondary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface ToggleRowProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly testID?: string;
}

export function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
  testID,
}: ToggleRowProps) {
  const { colors } = useTheme();
  const inGroup = useInGroup();
  return (
    <Row
      style={{
        minHeight: 56,
        paddingVertical: spacing.sm + 2,
        paddingHorizontal: inGroup ? spacing.lg : 0,
      }}
    >
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={title}
        trackColor={{ false: colors.surfaceStrong, true: colors.success }}
        // react-native-web draws a 40×20 switch, too small to hit with a thumb; use the
        // iOS switch size (51×31) on the web.
        style={Platform.OS === "web" ? { width: 51, height: 31 } : undefined}
      />
    </Row>
  );
}

export interface SegmentedControlProps<T extends string> {
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly testID?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testID,
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      style={{
        flexDirection: "row",
        gap: spacing.xs,
        backgroundColor: colors.surface,
        borderRadius: radii.pill,
        padding: spacing.xs,
      }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <PressableScale
            key={o.value}
            onPress={() => {
              onChange(o.value);
            }}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected }}
            testID={testID ? `${testID}-${o.value}` : undefined}
            containerStyle={{ flex: 1 }}
            style={{
              height: 40,
              borderRadius: radii.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? colors.background : "transparent",
            }}
          >
            <Text variant="label" tone={selected ? "primary" : "secondary"}>
              {o.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}
