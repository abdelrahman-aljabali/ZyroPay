import type { ReactNode } from "react";
import { ActivityIndicator } from "react-native";
import { Icon, type IconName } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { radii, sizes, spacing } from "../tokens";
import { PressableScale, Text } from "./primitives";

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly icon?: IconName;
  /** Destructive styling (red label / fill). */
  readonly destructive?: boolean;
  readonly accessibilityHint?: string;
  readonly testID?: string;
  readonly compact?: boolean;
}

/** 56-pt pill, solid ink. One per screen. */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  icon,
  destructive,
  accessibilityHint,
  testID,
  compact,
}: ButtonProps) {
  const { colors } = useTheme();
  const bg = destructive === true ? colors.danger : colors.primary;
  const fg = destructive === true ? "#FFFFFF" : colors.onPrimary;
  const isDisabled = disabled === true || loading === true;
  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      haptic
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading === true }}
      testID={testID}
      style={{
        height: compact === true ? sizes.buttonHeightCompact : sizes.buttonHeight,
        borderRadius: radii.pill,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: spacing.sm,
        paddingHorizontal: spacing.xxl,
      }}
    >
      {loading === true ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} color={fg} size={20} /> : null}
          <Text variant="bodyStrong" style={{ color: fg }}>
            {label}
          </Text>
        </>
      )}
    </PressableScale>
  );
}

/** 56-pt pill on the gray surface. */
export function SecondaryButton({
  label,
  onPress,
  disabled,
  loading,
  icon,
  destructive,
  accessibilityHint,
  testID,
  compact,
}: ButtonProps) {
  const { colors } = useTheme();
  const fg = destructive === true ? colors.danger : colors.text;
  const isDisabled = disabled === true || loading === true;
  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      haptic
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      testID={testID}
      style={{
        height: compact === true ? sizes.buttonHeightCompact : sizes.buttonHeight,
        borderRadius: radii.pill,
        backgroundColor: colors.surface,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: spacing.sm,
        paddingHorizontal: spacing.xxl,
      }}
    >
      {loading === true ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} color={fg} size={20} /> : null}
          <Text variant="bodyStrong" style={{ color: fg }}>
            {label}
          </Text>
        </>
      )}
    </PressableScale>
  );
}

export interface IconButtonProps {
  readonly icon: IconName;
  /** Required: icon-only controls must be named for VoiceOver/TalkBack. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly variant?: "surface" | "plain" | "primary";
  readonly size?: number;
  readonly disabled?: boolean;
  readonly testID?: string;
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  variant = "surface",
  size = sizes.iconButton,
  disabled,
  testID,
}: IconButtonProps) {
  const { colors } = useTheme();
  const bg =
    variant === "surface" ? colors.surface : variant === "primary" ? colors.primary : "transparent";
  const fg = variant === "primary" ? colors.onPrimary : colors.text;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic
      accessibilityLabel={accessibilityLabel}
      hitSlop={size < sizes.touchTarget ? (sizes.touchTarget - size) / 2 : 0}
      testID={testID}
      style={{
        width: size,
        height: size,
        borderRadius: radii.pill,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} color={fg} size={Math.round(size * 0.48)} />
    </PressableScale>
  );
}

export interface ActionButtonProps {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly testID?: string;
  /** Solid ink fill for the one primary action in a row. */
  readonly primary?: boolean;
}

/** Quick action pill (Top up / Send / Receive). Lay several out in a Row; each takes an equal share. */
export function ActionButton({
  icon,
  label,
  onPress,
  disabled,
  testID,
  primary,
}: ActionButtonProps) {
  const { colors } = useTheme();
  const bg = primary === true ? colors.primary : colors.surface;
  const fg = primary === true ? colors.onPrimary : colors.text;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic
      accessibilityLabel={label}
      testID={testID}
      containerStyle={{ flex: 1 }}
      style={{
        height: 52,
        borderRadius: radii.pill,
        backgroundColor: bg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
      }}
    >
      <Icon name={icon} color={fg} size={19} strokeWidth={2} />
      <Text variant="calloutStrong" style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

export interface TextButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: IconName;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly testID?: string;
  readonly accessibilityHint?: string;
}

/** Plain text action ("See all", "Edit"). 44-pt hit area around a compact label. */
export function TextButton({
  label,
  onPress,
  icon,
  tone = "primary",
  testID,
  accessibilityHint,
}: TextButtonProps) {
  const { colors } = useTheme();
  const fg =
    tone === "danger" ? colors.danger : tone === "secondary" ? colors.textSecondary : colors.text;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      testID={testID}
      hitSlop={10}
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 28 }}
    >
      <Text variant="calloutStrong" style={{ color: fg }}>
        {label}
      </Text>
      {icon ? <Icon name={icon} size={16} color={fg} strokeWidth={2} /> : null}
    </PressableScale>
  );
}

export interface ChipProps {
  readonly label: string;
  /** Leading element, e.g. a NetworkLogo. */
  readonly leading?: ReactNode;
  readonly selected?: boolean;
  readonly onPress?: () => void;
  readonly testID?: string;
}

/** Filter chip (chain filter, history filter). */
export function Chip({ label, selected = false, onPress, testID, leading }: ChipProps) {
  const { colors } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      testID={testID}
      hitSlop={4}
      style={{
        height: 36,
        paddingLeft: leading ? spacing.xs + 2 : spacing.lg,
        paddingRight: spacing.lg,
        borderRadius: radii.pill,
        backgroundColor: selected ? colors.primary : colors.surface,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.sm,
      }}
    >
      {leading}
      <Text variant="label" style={{ color: selected ? colors.onPrimary : colors.text }}>
        {label}
      </Text>
    </PressableScale>
  );
}
