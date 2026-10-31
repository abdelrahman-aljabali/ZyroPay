import { getNetwork, type NetworkId } from "@zyropay/shared";
import { useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { formatCountdown } from "../format";
import { NetworkLogo } from "../icons/CryptoLogo";
import { Icon } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radii, sizes, spacing } from "../tokens";
import { TextButton } from "./buttons";
import { SimulatedBadge, StatusPill } from "./feedback";
import { Card, PressableScale, Row, tapHaptic, Text } from "./primitives";

/** Remaining ms until `expiresAt`, ticking every second. */
export function useCountdown(expiresAt: string): number {
  const target = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => target - Date.now());
  useEffect(() => {
    setRemaining(target - Date.now());
    const id = setInterval(() => {
      setRemaining(target - Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [target]);
  return remaining;
}

export interface HoldToConfirmProps {
  readonly label: string;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
  readonly holdMs?: number;
  readonly testID?: string;
}

/**
 * Press and hold until the fill completes. Releasing early cancels. Screen
 * readers get a plain activate action, because a timed hold is not accessible.
 */
export function HoldToConfirm({
  label,
  onConfirm,
  disabled = false,
  holdMs = motion.approveHoldMs,
  testID,
}: HoldToConfirmProps) {
  const { colors, reducedMotion } = useTheme();
  const progress = useSharedValue(0);
  const [width, setWidth] = useState(0);
  const fill = useAnimatedStyle(() => ({ width: progress.value * width }));

  const finish = () => {
    tapHaptic("success");
    onConfirm();
  };

  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Touch and hold to confirm"
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: "activate", label }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "activate" && !disabled) onConfirm();
      }}
      onLayout={(e) => {
        setWidth(e.nativeEvent.layout.width);
      }}
      onPressIn={() => {
        tapHaptic("light");
        progress.value = withTiming(1, { duration: holdMs, easing: Easing.linear }, (done) => {
          if (done === true) scheduleOnRN(finish);
        });
      }}
      onPressOut={() => {
        cancelAnimation(progress);
        progress.value = reducedMotion ? 0 : withTiming(0, { duration: motion.durationFast });
      }}
      style={{
        height: sizes.buttonHeight,
        borderRadius: radii.pill,
        backgroundColor: colors.primary,
        overflow: "hidden",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Animated.View
        style={[
          { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: colors.success },
          fill,
        ]}
      />
      <Row justify="center" gap={spacing.sm}>
        <Icon name="passkey" color={colors.onPrimary} size={20} />
        <Text variant="bodyStrong" style={{ color: colors.onPrimary }}>
          {label}
        </Text>
      </Row>
    </Pressable>
  );
}

export interface ApprovalCardProps {
  readonly agentName: string;
  /** e.g. "Send", "Swap", "Pay (x402)". */
  readonly action: string;
  readonly amountLabel: string;
  readonly fiatLabel: string | null;
  readonly recipientLabel: string | null;
  /** Caption of the recipient row; default "To" (e.g. "Seller" for an x402 payment). */
  readonly recipientCaption?: string;
  /** What the payment is for (e.g. an x402 resource), shown under the agent line. */
  readonly purpose?: ReactNode;
  /** One plain sentence above the approve button (e.g. why the passkey is required). */
  readonly note?: string;
  readonly network: NetworkId;
  readonly expiresAt: string;
  readonly simulated?: boolean;
  /** Plain-language risk line, e.g. { tone: "caution", label: "New recipient" }. */
  readonly risk?: { readonly tone: "neutral" | "caution" | "danger"; readonly label: string };
  /** List mode: tap opens detail; no gestures. */
  readonly onPress?: () => void;
  /** Detail mode: long-press approves (then passkey), swipe left rejects. */
  readonly onApprove?: () => void;
  readonly onReject?: () => void;
  readonly busy?: boolean;
  readonly testID?: string;
}

const SWIPE_THRESHOLD = 110;

export function ApprovalCard({
  agentName,
  action,
  amountLabel,
  fiatLabel,
  recipientLabel,
  recipientCaption = "To",
  purpose,
  note,
  network,
  expiresAt,
  simulated = false,
  risk,
  onPress,
  onApprove,
  onReject,
  busy = false,
  testID,
}: ApprovalCardProps) {
  const { colors, reducedMotion } = useTheme();
  const remaining = useCountdown(expiresAt);
  const expired = remaining <= 0;
  const translateX = useSharedValue(0);

  const reject = () => {
    tapHaptic("warning");
    onReject?.();
  };

  const pan = Gesture.Pan()
    .enabled(onReject !== undefined && !busy && !expired)
    .activeOffsetX([-16, 16])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      translateX.value = Math.min(0, e.translationX);
    })
    .onEnd((e) => {
      if (e.translationX < -SWIPE_THRESHOLD) {
        translateX.value = withTiming(-600, { duration: motion.durationBase });
        scheduleOnRN(reject);
      } else {
        translateX.value = withSpring(0, motion.spring);
      }
    });

  // A rejected-then-cancelled card must come back into view.
  useEffect(() => {
    if (!busy) translateX.value = reducedMotion ? 0 : withSpring(0, motion.spring);
  }, [busy, reducedMotion, translateX]);

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const revealStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, -translateX.value / SWIPE_THRESHOLD),
  }));

  const urgent = !expired && remaining < 60_000;
  const riskTone = risk?.tone ?? "neutral";
  const riskInk =
    riskTone === "danger"
      ? colors.danger
      : riskTone === "caution"
        ? colors.caution
        : colors.success;
  const riskBg =
    riskTone === "danger"
      ? colors.dangerSoft
      : riskTone === "caution"
        ? colors.cautionSoft
        : colors.successSoft;
  const net = getNetwork(network);
  const hairline = <View style={{ height: 1, backgroundColor: colors.separator }} />;

  const body = (
    <Card style={{ gap: spacing.lg }}>
      {/* 1. Who is asking, and how long you have */}
      <Row justify="space-between">
        <Row gap={spacing.md} style={{ flexShrink: 1 }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text variant="calloutStrong" style={{ color: colors.onPrimary }}>
              {agentName.slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text variant="calloutStrong" numberOfLines={1}>
              {agentName}
            </Text>
            <Text variant="footnote" tone="secondary" numberOfLines={1}>
              {`wants to ${action.toLowerCase()}`}
            </Text>
          </View>
        </Row>
        <Row
          gap={spacing.xs}
          style={{
            backgroundColor: expired
              ? colors.dangerSoft
              : urgent
                ? colors.cautionSoft
                : colors.surfaceRaised,
            borderRadius: radii.pill,
            paddingHorizontal: spacing.sm + 2,
            paddingVertical: spacing.xs,
          }}
        >
          <Icon
            name="clock"
            size={14}
            strokeWidth={2}
            color={expired ? colors.danger : urgent ? colors.caution : colors.textSecondary}
          />
          <Text
            variant="label"
            style={{
              fontVariant: ["tabular-nums"],
              color: expired ? colors.danger : urgent ? colors.caution : colors.text,
            }}
            accessibilityLabel={expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
          >
            {expired ? "Expired" : formatCountdown(remaining)}
          </Text>
        </Row>
      </Row>

      {purpose ?? null}

      {/* 2. The amount, biggest thing on the card */}
      <View style={{ gap: spacing.xxs }}>
        <Text
          variant="title"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {amountLabel}
        </Text>
        {fiatLabel ? (
          <Text variant="callout" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
            {fiatLabel}
          </Text>
        ) : (
          <StatusPill label="No price available" tone="caution" />
        )}
      </View>

      {hairline}

      {/* 3. Where it goes and on which chain */}
      <View style={{ gap: spacing.md }}>
        {recipientLabel ? (
          <Row justify="space-between">
            <Text variant="footnote" tone="secondary">
              {recipientCaption}
            </Text>
            <Text variant="mono" numberOfLines={1}>
              {recipientLabel}
            </Text>
          </Row>
        ) : null}
        <Row justify="space-between">
          <Text variant="footnote" tone="secondary">
            Network
          </Text>
          <Row gap={spacing.xs + 2}>
            <NetworkLogo network={network} size={18} />
            <Text variant="label">{net.displayName}</Text>
            {net.isTestnet ? (
              <Text variant="label" tone="caution">
                Testnet
              </Text>
            ) : null}
          </Row>
        </Row>
      </View>

      {/* 4. Risk, stated plainly */}
      {risk || simulated ? (
        <Row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
          {risk ? (
            <Row
              gap={spacing.xs + 2}
              style={{
                backgroundColor: riskBg,
                borderRadius: radii.pill,
                paddingHorizontal: spacing.sm + 2,
                paddingVertical: spacing.xs,
              }}
            >
              <Icon
                name={riskTone === "neutral" ? "shieldCheck" : "warning"}
                size={14}
                strokeWidth={2}
                color={riskInk}
              />
              <Text variant="label" style={{ color: riskInk }}>
                {risk.label}
              </Text>
            </Row>
          ) : null}
          {simulated ? <SimulatedBadge /> : null}
        </Row>
      ) : null}

      {onApprove ? (
        <View style={{ gap: spacing.sm, paddingTop: spacing.xs }}>
          {note ? (
            <Row gap={spacing.xs + 2} align="flex-start">
              <View style={{ paddingTop: 1 }}>
                <Icon name="passkey" size={16} strokeWidth={2} color={colors.textSecondary} />
              </View>
              <Text variant="footnote" tone="secondary" style={{ flexShrink: 1 }}>
                {note}
              </Text>
            </Row>
          ) : null}
          <HoldToConfirm
            label={busy ? "Waiting for passkey…" : "Hold to approve"}
            onConfirm={onApprove}
            disabled={busy || expired}
            testID="approval-hold-to-approve"
          />
          {onReject && Platform.OS === "web" ? (
            // Web: a mouse, trackpad or keyboard cannot reliably swipe a card, so rejecting
            // is an explicit button there (native keeps the swipe and the a11y action).
            <Row justify="center">
              <TextButton
                label="Reject"
                tone="danger"
                icon="close"
                onPress={reject}
                testID="approval-reject"
              />
            </Row>
          ) : onReject ? (
            <Row gap={spacing.xs} justify="center">
              <Icon name="chevronLeft" size={14} color={colors.textSecondary} />
              <Text variant="footnote" tone="secondary" align="center">
                Swipe left to reject
              </Text>
            </Row>
          ) : null}
        </View>
      ) : null}
    </Card>
  );

  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        accessibilityLabel={`${agentName} wants to ${action.toLowerCase()} ${amountLabel}${fiatLabel ? `, ${fiatLabel}` : ""}${recipientLabel ? `, ${recipientCaption.toLowerCase()} ${recipientLabel}` : ""}, on ${net.displayName}${risk ? `, ${risk.label}` : ""}${expired ? ", expired" : `, expires in ${formatCountdown(remaining)}`}`}
        scaleTo={motion.pressedScaleSubtle}
        testID={testID}
      >
        {body}
      </PressableScale>
    );
  }

  return (
    <View testID={testID}>
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            left: 0,
            borderRadius: radii.card,
            backgroundColor: colors.dangerSoft,
            alignItems: "flex-end",
            justifyContent: "center",
            paddingRight: spacing.xxl,
          },
          revealStyle,
        ]}
      >
        <Row gap={spacing.sm}>
          <Icon name="close" color={colors.danger} />
          <Text variant="bodyStrong" tone="danger">
            Reject
          </Text>
        </Row>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={cardStyle}
          accessibilityActions={
            onReject ? [{ name: "reject", label: "Reject request" }] : undefined
          }
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "reject") reject();
          }}
        >
          {body}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
