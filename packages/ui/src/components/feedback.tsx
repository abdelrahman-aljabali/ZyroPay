import { getNetwork, type NetworkId } from "@zyropay/shared";
import { useEffect, type ReactNode } from "react";
import { View, type DimensionValue } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { NetworkLogo } from "../icons/CryptoLogo";
import { Icon, type IconName } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { radii, spacing } from "../tokens";
import { PrimaryButton, SecondaryButton } from "./buttons";
import { Card, Row, Text } from "./primitives";

export interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: string;
  readonly message?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
  /** "card": inside a rounded surface (list placeholders); "plain": on the page. */
  readonly variant?: "plain" | "card";
  /** Extra content under the copy (e.g. a stack of connect buttons). */
  readonly children?: ReactNode;
  readonly testID?: string;
}

/**
 * Orbit motif: the icon at the centre of two hairline rings, the outer one
 * dashed and turning very slowly with a single satellite. Static under
 * reduced motion.
 */
export function EmptyMotif({
  icon,
  size = 112,
}: {
  readonly icon: IconName;
  readonly size?: number;
}) {
  const { colors, reducedMotion } = useTheme();
  const spin = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) return;
    spin.value = withRepeat(withTiming(1, { duration: 24_000, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(spin);
    };
  }, [spin, reducedMotion]);
  const turning = useAnimatedStyle(() => ({
    transform: [{ rotate: `${String(spin.value * 360)}deg` }],
  }));
  const c = size / 2;
  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Circle cx={c} cy={c} r={c * 0.7} stroke={colors.border} strokeWidth={1.25} fill="none" />
      </Svg>
      <Animated.View style={[{ position: "absolute", width: size, height: size }, turning]}>
        <Svg width={size} height={size}>
          <Circle
            cx={c}
            cy={c}
            r={c - 3}
            stroke={colors.border}
            strokeWidth={1.25}
            strokeDasharray="2 6"
            strokeLinecap="round"
            fill="none"
          />
          <Circle cx={c} cy={3} r={3} fill={colors.text} />
        </Svg>
      </Animated.View>
      <View
        style={{
          width: size * 0.46,
          height: size * 0.46,
          borderRadius: radii.pill,
          backgroundColor: colors.surfaceStrong,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={Math.round(size * 0.2)} color={colors.text} />
      </View>
    </View>
  );
}

export function EmptyState({
  icon = "dot",
  title,
  message,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  variant = "plain",
  children,
  testID,
}: EmptyStateProps) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        {
          alignItems: "center",
          paddingVertical: variant === "card" ? spacing.xxl : spacing.xxxl,
          paddingHorizontal: variant === "card" ? spacing.xl : 0,
          gap: spacing.md,
        },
        variant === "card" ? { backgroundColor: colors.surface, borderRadius: radii.card } : null,
      ]}
      testID={testID}
    >
      <EmptyMotif icon={icon} size={variant === "card" ? 96 : 112} />
      <View style={{ gap: spacing.xs, alignItems: "center", marginTop: spacing.xs }}>
        <Text variant="bodyStrong" align="center" accessibilityRole="header">
          {title}
        </Text>
        {message ? (
          <Text variant="callout" tone="secondary" align="center" style={{ maxWidth: 300 }}>
            {message}
          </Text>
        ) : null}
      </View>
      {children ? (
        <View style={{ alignSelf: "stretch", gap: spacing.sm, marginTop: spacing.sm }}>
          {children}
        </View>
      ) : null}
      {actionLabel && onAction ? (
        <View style={{ alignSelf: "stretch", marginTop: spacing.sm }}>
          <PrimaryButton label={actionLabel} onPress={onAction} />
        </View>
      ) : null}
      {secondaryLabel && onSecondary ? (
        <View style={{ alignSelf: "stretch" }}>
          <SecondaryButton label={secondaryLabel} onPress={onSecondary} />
        </View>
      ) : null}
    </View>
  );
}

export interface ErrorStateProps {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: ErrorStateProps) {
  return (
    <EmptyState
      icon="warning"
      title={title}
      message={message}
      {...(onRetry ? { actionLabel: "Try again", onAction: onRetry } : {})}
    />
  );
}

export interface LoadingSkeletonProps {
  readonly width?: DimensionValue;
  readonly height?: number;
  readonly radius?: number;
  /** Render N stacked rows (list placeholder). */
  readonly rows?: number;
}

/** Pulse for skeletons; static when reduced motion is on. */
function usePulse() {
  const { reducedMotion } = useTheme();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) return;
    opacity.value = withRepeat(
      withTiming(0.5, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity, reducedMotion]);
  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

/** Pulsing placeholder block. */
export function LoadingSkeleton({
  width = "100%",
  height = 16,
  radius = radii.sm,
  rows = 1,
}: LoadingSkeletonProps) {
  const { colors } = useTheme();
  const style = usePulse();
  return (
    <View style={{ gap: spacing.md }} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <Animated.View
          key={i}
          style={[{ width, height, borderRadius: radius, backgroundColor: colors.skeleton }, style]}
        />
      ))}
    </View>
  );
}

function Bone({
  width,
  height,
  radius = 6,
  onSurface = false,
}: {
  readonly width: DimensionValue;
  readonly height: number;
  readonly radius?: number;
  readonly onSurface?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: onSurface ? colors.surfaceStrong : colors.skeleton,
      }}
    />
  );
}

/** Placeholder shaped exactly like AssetRow / TransactionRow inside a ListGroup card. */
export function ListSkeleton({
  rows = 4,
  grouped = true,
}: {
  readonly rows?: number;
  readonly grouped?: boolean;
}) {
  const { colors } = useTheme();
  const style = usePulse();
  return (
    <Animated.View
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      style={[
        grouped
          ? { backgroundColor: colors.surface, borderRadius: radii.card, overflow: "hidden" }
          : null,
        style,
      ]}
    >
      {Array.from({ length: rows }, (_, i) => (
        <View key={i}>
          {i > 0 && grouped ? (
            <View
              style={{ height: 1, backgroundColor: colors.separator, marginLeft: spacing.lg }}
            />
          ) : null}
          <Row style={{ minHeight: 68, paddingHorizontal: grouped ? spacing.lg : 0 }}>
            <Bone width={40} height={40} radius={radii.pill} onSurface={grouped} />
            <View style={{ flex: 1, gap: spacing.sm }}>
              <Bone
                width={`${String(46 + ((i * 17) % 22))}%` as DimensionValue}
                height={13}
                onSurface={grouped}
              />
              <Bone width="30%" height={11} onSurface={grouped} />
            </View>
            <View style={{ alignItems: "flex-end", gap: spacing.sm }}>
              <Bone width={64} height={13} onSurface={grouped} />
              <Bone width={44} height={11} onSurface={grouped} />
            </View>
          </Row>
        </View>
      ))}
    </Animated.View>
  );
}

/** Placeholder for the balance header: label, big number, change line. */
export function BalanceSkeleton() {
  const style = usePulse();
  return (
    <Animated.View
      style={[{ gap: spacing.md, paddingVertical: spacing.xs }, style]}
      accessibilityLabel="Loading balance"
      accessibilityRole="progressbar"
    >
      <Bone width={104} height={14} />
      <Bone width="66%" height={58} radius={14} />
      <Bone width={168} height={14} />
    </Animated.View>
  );
}

/** Placeholder for stacked cards (wallets, agents, approvals, plugins). */
export function CardSkeleton({
  rows = 2,
  height = 150,
}: {
  readonly rows?: number;
  readonly height?: number;
}) {
  const { colors } = useTheme();
  const style = usePulse();
  return (
    <Animated.View
      style={[{ gap: spacing.md }, style]}
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
    >
      {Array.from({ length: rows }, (_, i) => (
        <View
          key={i}
          style={{
            height,
            borderRadius: radii.card,
            backgroundColor: colors.surface,
            padding: spacing.lg,
            gap: spacing.md,
          }}
        >
          <Row>
            <Bone width={44} height={44} radius={13} onSurface />
            <View style={{ flex: 1, gap: spacing.sm }}>
              <Bone width="45%" height={14} onSurface />
              <Bone width="30%" height={11} onSurface />
            </View>
          </Row>
          <Bone width="80%" height={12} onSurface />
          <Bone width="58%" height={12} onSurface />
        </View>
      ))}
    </Animated.View>
  );
}

export interface NetworkBadgeProps {
  readonly network: NetworkId;
  readonly compact?: boolean;
}

/** Chain mark + name; testnets are amber with "Testnet" so they are never mistaken for mainnet. */
export function NetworkBadge({ network, compact = false }: NetworkBadgeProps) {
  const { colors } = useTheme();
  const info = getNetwork(network);
  const label = compact
    ? info.displayName.replace(/ (Devnet|Sepolia|Testnet|Preprod|Preview)$/, "")
    : info.displayName;
  return (
    <View
      accessibilityLabel={`${info.displayName}${info.isTestnet ? ", testnet" : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs + 1,
        alignSelf: "flex-start",
        backgroundColor: info.isTestnet ? colors.cautionSoft : colors.surface,
        borderRadius: radii.pill,
        paddingLeft: 3,
        paddingRight: spacing.sm,
        paddingVertical: 3,
      }}
    >
      <NetworkLogo network={network} size={16} />
      <Text variant="caption" style={{ color: info.isTestnet ? colors.caution : colors.text }}>
        {label}
      </Text>
      {info.isTestnet ? (
        <Text variant="caption" style={{ color: colors.caution }}>
          · Testnet
        </Text>
      ) : null}
    </View>
  );
}

/** "Simulated" pill shown on every value that came from a Mock* provider. */
export function SimulatedBadge() {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel="Simulated data"
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: colors.cautionSoft,
        borderRadius: radii.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.caution }} />
      <Text variant="caption" style={{ color: colors.caution }}>
        Simulated
      </Text>
    </View>
  );
}

/**
 * Section-header badge for lists whose dollar values are testnet assets valued at their
 * mainnet counterpart's price (development builds only). Neutral, not a warning: the
 * values are real prices, the assets are not real money.
 */
export function MainnetPriceBadge() {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel="Testnet assets valued at mainnet prices"
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: colors.surfaceStrong,
        borderRadius: radii.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
      }}
    >
      <View
        style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.textSecondary }}
      />
      <Text variant="caption" tone="secondary">
        Mainnet prices
      </Text>
    </View>
  );
}

export interface SecurityWarningProps {
  readonly title: string;
  readonly message?: string;
  readonly severity?: "info" | "warning" | "danger";
  readonly children?: ReactNode;
}

export function SecurityWarning({
  title,
  message,
  severity = "warning",
  children,
}: SecurityWarningProps) {
  const { colors } = useTheme();
  const tone = severity === "danger" ? "danger" : severity === "warning" ? "caution" : "surface";
  const ink =
    severity === "danger" ? colors.danger : severity === "warning" ? colors.caution : colors.text;
  return (
    <Card tone={tone} style={{ gap: spacing.sm, borderRadius: radii.md + 4 }}>
      <Row align="flex-start" gap={spacing.md}>
        <Icon name={severity === "info" ? "info" : "warning"} color={ink} size={20} />
        <View style={{ flex: 1, gap: spacing.xs }} accessibilityRole="alert">
          <Text variant="calloutStrong" style={{ color: ink }}>
            {title}
          </Text>
          {message ? (
            <Text variant="footnote" tone="secondary" style={{ lineHeight: 19 }}>
              {message}
            </Text>
          ) : null}
          {children}
        </View>
      </Row>
    </Card>
  );
}

export interface ProgressBarProps {
  /** 0..1 (clamped). */
  readonly value: number;
  /** What the bar measures, for screen readers ("Spent today"). */
  readonly accessibilityLabel: string;
  /** Spoken value ("2 ADA of 15 ADA"). */
  readonly valueText?: string;
  readonly tone?: "neutral" | "caution" | "danger";
  readonly testID?: string;
}

/** A thin meter (spent against a cap). Announced as a progress bar with its value. */
export function ProgressBar({
  value,
  accessibilityLabel,
  valueText,
  tone = "neutral",
  testID,
}: ProgressBarProps) {
  const { colors } = useTheme();
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const fill =
    tone === "danger" ? colors.danger : tone === "caution" ? colors.caution : colors.primary;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(v * 100),
        ...(valueText ? { text: valueText } : {}),
      }}
      style={{
        height: 6,
        borderRadius: radii.pill,
        backgroundColor: colors.surfaceStrong,
        overflow: "hidden",
      }}
      testID={testID}
    >
      <View
        style={{
          width: `${v * 100}%`,
          minWidth: v > 0 ? 6 : 0,
          height: "100%",
          borderRadius: radii.pill,
          backgroundColor: fill,
        }}
      />
    </View>
  );
}

export interface StatusPillProps {
  readonly label: string;
  readonly tone: "success" | "danger" | "neutral" | "caution";
}

export function StatusPill({ label, tone }: StatusPillProps) {
  const { colors } = useTheme();
  const bg =
    tone === "success"
      ? colors.successSoft
      : tone === "danger"
        ? colors.dangerSoft
        : tone === "caution"
          ? colors.cautionSoft
          : colors.surfaceStrong;
  const fg =
    tone === "success"
      ? colors.success
      : tone === "danger"
        ? colors.danger
        : tone === "caution"
          ? colors.caution
          : colors.text;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: bg,
        borderRadius: radii.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
      }}
    >
      <Text variant="caption" style={{ color: fg }}>
        {label}
      </Text>
    </View>
  );
}
