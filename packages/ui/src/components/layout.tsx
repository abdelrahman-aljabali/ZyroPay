import type { ReactNode } from "react";
import {
  Platform,
  RefreshControl,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { screenGutter, spacing } from "../tokens";
import { IconButton } from "./buttons";
import { breakAnywhere, Row, Text } from "./primitives";

export interface ScreenProps {
  readonly children: ReactNode;
  /** Wrap content in a ScrollView (default true). */
  readonly scroll?: boolean;
  readonly edges?: readonly Edge[];
  readonly contentStyle?: StyleProp<ViewStyle>;
  /** Pinned below the scroll area (primary action). */
  readonly footer?: ReactNode;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly testID?: string;
}

/**
 * Screen scaffold: solid background, safe areas, 20-pt gutters. Scroll views use
 * automatic content insets so native tab bars / large titles never cover content.
 */
export function Screen({
  children,
  scroll = true,
  edges = ["top"],
  contentStyle,
  footer,
  refreshing,
  onRefresh,
  testID,
}: ScreenProps) {
  const { colors } = useTheme();
  const padding: ViewStyle = {
    paddingHorizontal: screenGutter,
    // Web (visual QA) draws a floating tab bar over the content; native tab bars inset automatically.
    paddingBottom: Platform.OS === "web" ? 120 : spacing.huge,
    gap: spacing.xl,
  };
  return (
    <SafeAreaView
      edges={edges}
      style={{ flex: 1, backgroundColor: colors.background }}
      testID={testID}
    >
      {scroll ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[padding, contentStyle]}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing === true}
                onRefresh={onRefresh}
                tintColor={colors.textSecondary}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, padding, contentStyle]}>{children}</View>
      )}
      {footer ? (
        <View
          style={{
            paddingHorizontal: screenGutter,
            paddingTop: spacing.md,
            paddingBottom: spacing.lg,
            gap: spacing.md,
          }}
        >
          {footer}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

export interface ScreenHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: () => void;
  /** Right-aligned actions (IconButtons). Large headers align them with the title. */
  readonly actions?: ReactNode;
  /** "large" = 34-pt tab-root title; "inline" = pushed screen. */
  readonly size?: "large" | "inline";
  /** Back control: chevron (pushed) or close (modal flows). */
  readonly backIcon?: "chevronLeft" | "close";
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  actions,
  size = "large",
  backIcon = "chevronLeft",
}: ScreenHeaderProps) {
  if (size === "large") {
    return (
      <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
        {onBack ? <IconButton icon={backIcon} accessibilityLabel="Back" onPress={onBack} /> : null}
        <Row justify="space-between" align="flex-start">
          <View style={{ flex: 1, gap: spacing.xxs }}>
            <Text variant="title" accessibilityRole="header" numberOfLines={2}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="callout" tone="secondary">
                {subtitle}
              </Text>
            ) : null}
          </View>
          {actions ? <Row gap={spacing.sm}>{actions}</Row> : null}
        </Row>
      </View>
    );
  }
  return (
    <View style={{ gap: spacing.lg, paddingTop: spacing.sm }}>
      {onBack || actions ? (
        <Row justify="space-between">
          {onBack ? (
            <IconButton
              icon={backIcon}
              accessibilityLabel={backIcon === "close" ? "Close" : "Back"}
              onPress={onBack}
            />
          ) : (
            <View />
          )}
          <Row gap={spacing.sm}>{actions}</Row>
        </Row>
      ) : null}
      {title !== "" || subtitle ? (
        <View style={{ gap: spacing.xs }}>
          {title !== "" ? (
            <Text variant="headline" accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {subtitle ? (
            <Text variant="callout" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export interface SectionProps {
  readonly title?: string;
  /** Small count or note next to the title, e.g. "3". */
  readonly meta?: string;
  /** Inline after the title, e.g. a SimulatedBadge covering every value in the section. */
  readonly badge?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  /** Explanatory line under the content (iOS grouped-list footer). */
  readonly footer?: string;
}

export function Section({ title, meta, badge, action, children, footer }: SectionProps) {
  return (
    <View style={{ gap: spacing.md }}>
      {title || action ? (
        <Row justify="space-between" style={{ minHeight: 28 }}>
          {title ? (
            <Row gap={spacing.sm} style={{ flexShrink: 1 }}>
              <Text variant="section" accessibilityRole="header" numberOfLines={1}>
                {title}
              </Text>
              {meta ? (
                <Text variant="section" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
                  {meta}
                </Text>
              ) : null}
              {badge}
            </Row>
          ) : (
            <View />
          )}
          {action}
        </Row>
      ) : null}
      {children}
      {footer ? (
        <Text variant="footnote" tone="secondary" style={{ paddingHorizontal: spacing.xs }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

export interface KeyValueRowProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly emphasis?: boolean;
}

/**
 * Label/value pair used on review, receipt and detail screens. The value never runs under
 * the label: it takes the remaining width and wraps inside it. Pass a full address as
 * `<AddressText align="right" />` (grouped, so it wraps between groups), never as one
 * unbroken mono string.
 */
export function KeyValueRow({ label, value, emphasis }: KeyValueRowProps) {
  return (
    <Row justify="space-between" align="flex-start" style={{ paddingVertical: spacing.sm }}>
      <Text variant="callout" tone="secondary" style={{ flexShrink: 0, maxWidth: "40%" }}>
        {label}
      </Text>
      {typeof value === "string" ? (
        <Text
          variant={emphasis === true ? "calloutStrong" : "callout"}
          align="right"
          style={[{ flex: 1, minWidth: 0 }, breakAnywhere]}
          selectable
        >
          {value}
        </Text>
      ) : (
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-end" }}>
          <View style={{ maxWidth: "100%" }}>{value}</View>
        </View>
      )}
    </Row>
  );
}
