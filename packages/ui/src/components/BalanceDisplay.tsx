import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  animatableMinorToFiat,
  currencyInfo,
  fiatToAnimatableMinor,
  formatFiat,
  splitFiat,
} from "../format";
import { Icon } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { motion, spacing } from "../tokens";
import { SimulatedBadge } from "./feedback";
import { PressableScale, Row, tapHaptic, Text } from "./primitives";

/**
 * Animates from the previous value to the new one with a strong ease-out.
 * Intermediate frames are display-only approximations; the final frame is
 * always the exact string.
 */
function useCountUp(value: string, currency: string, enabled: boolean): string {
  const exact = formatFiat(value, currency);
  const [display, setDisplay] = useState(exact);
  const previous = useRef<number | null>(null);
  useEffect(() => {
    const digits = currencyInfo(currency).minorDigits;
    const target = fiatToAnimatableMinor(value, digits);
    const from = previous.current;
    previous.current = target;
    if (!enabled || from === null || from === target) {
      setDisplay(exact);
      return;
    }
    let frame = 0;
    const start = Date.now();
    const duration = 650;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      if (t >= 1) {
        setDisplay(exact);
        return;
      }
      setDisplay(animatableMinorToFiat(from + (target - from) * eased, currency));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [value, currency, enabled, exact]);
  return display;
}

export interface BalanceChange {
  /** Signed fiat decimal string, e.g. "-12.40". */
  readonly value: string;
  /** Pre-formatted percentage ("0.82%" / "−1.20%"), or null when the base is zero. */
  readonly percent: string | null;
  /** e.g. "Today" / "24h". */
  readonly label: string;
}

export interface BalanceDisplayProps {
  /** Decimal string, e.g. "12345.67". */
  readonly value: string;
  readonly currency: string;
  readonly hidden: boolean;
  readonly onToggleHidden: () => void;
  readonly label?: string;
  /** Data came from a Mock* provider: always labelled, never shown as real. */
  readonly simulated?: boolean;
  readonly stale?: boolean;
  /** Assets with no price; the total excludes them. */
  readonly unpricedCount?: number;
  /** 24h change of the priced holdings; omitted when no trustworthy history exists. */
  readonly change?: BalanceChange | null;
  /** Extra footnote, e.g. "Testnet · valued at mainnet prices". */
  readonly note?: string | null;
  readonly testID?: string;
}

const MASK = "••••••";

/**
 * Total balance: the whole units at display size with the cents set smaller
 * and quieter, a count-up between values, an optional 24h change line, and a
 * hide toggle. Press and hold the masked number to peek until release.
 */
export function BalanceDisplay({
  value,
  currency,
  hidden,
  onToggleHidden,
  label = "Total balance",
  simulated = false,
  stale = false,
  unpricedCount = 0,
  change,
  note = null,
  testID,
}: BalanceDisplayProps) {
  const { colors, reducedMotion } = useTheme();
  const [peeking, setPeeking] = useState(false);
  const shown = useCountUp(value, currency, !reducedMotion && !hidden);
  const visible = !hidden || peeking;
  const exact = formatFiat(value, currency);
  const { main, fraction } = splitFiat(peeking ? exact : shown);
  const negativeChange = change?.value.trim().startsWith("-") === true;
  const zeroChange = change ? /^-?0(\.0+)?$/.test(change.value.trim()) : false;
  const changeColor = zeroChange
    ? colors.textSecondary
    : negativeChange
      ? colors.danger
      : colors.success;

  return (
    <View style={{ gap: spacing.xs }} testID={testID}>
      <Row justify="space-between">
        <Row gap={spacing.sm}>
          <PressableScale
            onPress={onToggleHidden}
            accessibilityLabel={hidden ? "Show balance" : "Hide balance"}
            hitSlop={12}
            testID="balance-visibility-toggle"
            style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 28 }}
          >
            <Text variant="callout" tone="secondary">
              {label}
            </Text>
            <Icon name={hidden ? "eyeOff" : "eye"} size={17} color={colors.textSecondary} />
          </PressableScale>
          {simulated ? <SimulatedBadge /> : null}
        </Row>
      </Row>
      <Pressable
        accessibilityRole="text"
        accessibilityLabel={visible ? `${label}: ${exact}` : `${label} hidden`}
        accessibilityHint={hidden ? "Touch and hold to peek" : undefined}
        delayLongPress={motion.peekHoldMs}
        onLongPress={() => {
          if (!hidden) return;
          tapHaptic("light");
          setPeeking(true);
        }}
        onPressOut={() => {
          setPeeking(false);
        }}
      >
        <Text
          variant="balance"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
          testID="balance-amount"
        >
          {visible ? main : MASK}
          {visible && fraction !== "" ? (
            <Text
              variant="balance"
              style={{ color: colors.textSecondary, fontSize: 40, letterSpacing: -1.2 }}
            >
              {fraction}
            </Text>
          ) : null}
        </Text>
      </Pressable>
      {change && visible ? (
        <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(motion.durationBase)}>
          <Row gap={spacing.xs}>
            {!zeroChange ? (
              <Icon
                name={negativeChange ? "arrowDown" : "arrowUp"}
                size={14}
                strokeWidth={2.4}
                color={changeColor}
              />
            ) : null}
            <Text
              variant="calloutStrong"
              style={{ color: changeColor, fontVariant: ["tabular-nums"] }}
              accessibilityLabel={`${change.label}: ${negativeChange ? "down" : "up"} ${formatFiat(change.value.replace("-", ""), currency)}${change.percent ? `, ${change.percent.replace("−", "")}` : ""}`}
            >
              {formatFiat(change.value.replace("-", ""), currency)}
              {change.percent ? ` (${change.percent.replace("−", "")})` : ""}
            </Text>
            <Text variant="callout" tone="secondary">
              {change.label}
            </Text>
          </Row>
        </Animated.View>
      ) : null}
      {stale || unpricedCount > 0 || note !== null ? (
        <Text variant="footnote" tone="secondary" testID={testID ? `${testID}-note` : undefined}>
          {[
            note,
            stale ? "Prices may be out of date" : null,
            unpricedCount > 0
              ? `${String(unpricedCount)} asset${unpricedCount === 1 ? "" : "s"} without a price not included`
              : null,
          ]
            .filter((s): s is string => s !== null)
            .join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}
