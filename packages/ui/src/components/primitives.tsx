import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text as RNText,
  View,
  type AccessibilityRole,
  type PressableProps,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radii, spacing, type ColorTokens, type TypographyToken } from "../tokens";

/**
 * Long unbroken values (hashes, URLs, keys) wrap inside their box instead of running over
 * a neighbouring label. Native text already breaks a too-long word by character; browsers
 * need it asked for (react-native-web passes these through to CSS).
 */
export const breakAnywhere: TextStyle | null =
  Platform.OS === "web"
    ? ({ overflowWrap: "anywhere", wordBreak: "break-word" } as unknown as TextStyle)
    : null;

export type TextTone = "primary" | "secondary" | "success" | "danger" | "caution" | "inverse";

function toneColor(colors: ColorTokens, tone: TextTone): string {
  switch (tone) {
    case "primary":
      return colors.text;
    case "secondary":
      return colors.textSecondary;
    case "success":
      return colors.success;
    case "danger":
      return colors.danger;
    case "caution":
      return colors.caution;
    case "inverse":
      return colors.onPrimary;
  }
}

export interface TextProps extends RNTextProps {
  readonly variant?: TypographyToken;
  readonly tone?: TextTone;
  readonly align?: TextStyle["textAlign"];
  readonly style?: StyleProp<TextStyle>;
}

/** The only text primitive: typography token + semantic tone. Scales with Dynamic Type. */
export function Text({ variant = "body", tone = "primary", align, style, ...rest }: TextProps) {
  const theme = useTheme();
  return (
    <RNText
      maxFontSizeMultiplier={variant === "balance" || variant === "display" ? 1.3 : 1.8}
      {...rest}
      style={[
        theme.type(variant),
        { color: toneColor(theme.colors, tone), textAlign: align },
        style,
      ]}
    />
  );
}

/** Light haptic tick. Silently ignored where unsupported (web, some Android devices). */
export function tapHaptic(
  kind: "light" | "medium" | "success" | "warning" | "error" = "light",
): void {
  const run = async () => {
    switch (kind) {
      case "light":
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      case "medium":
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      case "success":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      case "warning":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      case "error":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };
  run().catch(() => undefined);
}

export interface PressableScaleProps extends Omit<PressableProps, "style" | "children"> {
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
  readonly haptic?: boolean;
  readonly accessibilityRole?: AccessibilityRole;
  /** Pressed scale; rows and big cards use motion.pressedScaleSubtle. */
  readonly scaleTo?: number;
  /** Colour washed over the content while pressed (list rows). */
  readonly highlight?: string;
  /** Style for the outer touch target (e.g. flex: 1 inside a Row). */
  readonly containerStyle?: StyleProp<ViewStyle>;
}

/**
 * Pressable with a quick scale-down on press and a snappier release (and an
 * optional pressed wash for rows). Reduced motion keeps the wash, drops the scale.
 */
export function PressableScale({
  style,
  children,
  haptic = false,
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  accessibilityRole = "button",
  accessibilityState,
  scaleTo = motion.pressedScale,
  highlight,
  containerStyle,
  ...rest
}: PressableScaleProps) {
  const { reducedMotion } = useTheme();
  const scale = useSharedValue(1);
  const wash = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const washStyle = useAnimatedStyle(() => ({ opacity: wash.value }));
  return (
    <Pressable
      {...rest}
      style={containerStyle}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled: disabled === true }}
      onPressIn={(e) => {
        if (!reducedMotion)
          scale.value = withTiming(scaleTo, { duration: 110, easing: Easing.out(Easing.quad) });
        wash.value = withTiming(1, { duration: 60 });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = reducedMotion ? withTiming(1, { duration: 0 }) : withSpring(1, motion.spring);
        wash.value = withTiming(0, { duration: motion.durationBase });
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic) tapHaptic("light");
        onPress?.(e);
      }}
    >
      <Animated.View
        style={[
          animated,
          style,
          // Dim only real controls that are disabled; display-only rows (no onPress) stay solid.
          disabled === true && onPress !== undefined ? { opacity: 0.4 } : null,
        ]}
      >
        {highlight ? (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: highlight,
              },
              washStyle,
            ]}
          />
        ) : null}
        {children}
      </Animated.View>
    </Pressable>
  );
}

export interface CardProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly padded?: boolean;
  readonly tone?: "surface" | "background" | "success" | "danger" | "caution";
  readonly testID?: string;
}

/** Flat grouped surface: radius 24, no shadow, no border. */
export function Card({ children, style, padded = true, tone = "surface", testID }: CardProps) {
  const { colors } = useTheme();
  const bg =
    tone === "surface"
      ? colors.surface
      : tone === "background"
        ? colors.background
        : tone === "success"
          ? colors.successSoft
          : tone === "danger"
            ? colors.dangerSoft
            : colors.cautionSoft;
  return (
    <View
      testID={testID}
      style={[
        { backgroundColor: bg, borderRadius: radii.card, overflow: "hidden" },
        padded ? { padding: spacing.lg } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider({ inset = 0 }: { readonly inset?: number }) {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border, marginLeft: inset }} />;
}

export function Spacer({ size = "lg" }: { readonly size?: keyof typeof spacing }) {
  return <View style={{ height: spacing[size] }} />;
}

export interface RowProps {
  readonly children: ReactNode;
  readonly gap?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly align?: ViewStyle["alignItems"];
  readonly justify?: ViewStyle["justifyContent"];
}

export function Row({ children, gap = spacing.md, style, align = "center", justify }: RowProps) {
  return (
    <View
      style={[{ flexDirection: "row", alignItems: align, justifyContent: justify, gap }, style]}
    >
      {children}
    </View>
  );
}
