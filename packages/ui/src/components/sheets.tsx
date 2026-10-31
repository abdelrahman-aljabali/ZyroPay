import { useEffect, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import QRCode from "react-native-qrcode-svg";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Icon, type IconName } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radii, screenGutter, spacing } from "../tokens";
import { PrimaryButton, SecondaryButton } from "./buttons";
import { KeyValueRow } from "./layout";
import { Card, PressableScale, Row, Text } from "./primitives";

const SHEET_EASE = Easing.bezier(...motion.easeSheet);
const OPEN_MS = 340;
const CLOSE_MS = 220;

export interface BottomSheetProps {
  readonly visible: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
  /** Pinned under the scrollable content (actions). */
  readonly footer?: ReactNode;
  /** Dismissing by backdrop, drag or back button is blocked while true (e.g. signing). */
  readonly blocking?: boolean;
  readonly testID?: string;
}

/**
 * Bottom sheet: backdrop fades, the sheet rises on an iOS-like curve and
 * leaves faster than it came. Drag the handle down (or flick) to dismiss.
 * Reduced motion swaps the slide for a fade.
 */
export function BottomSheet({
  visible,
  onDismiss,
  children,
  footer,
  blocking = false,
  testID,
}: BottomSheetProps) {
  const { colors, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const height = useSharedValue(600);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.value = 0;
      progress.value = withTiming(1, {
        duration: reducedMotion ? motion.durationBase : OPEN_MS,
        easing: SHEET_EASE,
      });
    } else if (mounted) {
      progress.value = withTiming(
        0,
        { duration: CLOSE_MS, easing: Easing.out(Easing.cubic) },
        (done) => {
          if (done === true) scheduleOnRN(setMounted, false);
        },
      );
    }
  }, [visible, mounted, progress, drag, reducedMotion]);

  const dismiss = () => {
    if (!blocking) onDismiss();
  };

  const pan = Gesture.Pan()
    .enabled(!blocking)
    .onUpdate((e) => {
      // Rubber-band upward drags; follow downward ones.
      drag.value = e.translationY > 0 ? e.translationY : e.translationY / 6;
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) {
        scheduleOnRN(onDismiss);
      } else {
        drag.value = withTiming(0, { duration: motion.durationBase, easing: SHEET_EASE });
      }
    });

  const backdrop = useAnimatedStyle(() => ({ opacity: progress.value }));
  const sheet = useAnimatedStyle(() =>
    reducedMotion
      ? { opacity: progress.value, transform: [{ translateY: drag.value }] }
      : { transform: [{ translateY: (1 - progress.value) * height.value + drag.value }] },
  );

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={dismiss}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          <Animated.View
            style={[
              {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: colors.scrim,
              },
              backdrop,
            ]}
          >
            <Pressable
              style={{ flex: 1 }}
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
            />
          </Animated.View>
          <Animated.View
            testID={testID}
            accessibilityViewIsModal
            onLayout={(e) => {
              height.value = e.nativeEvent.layout.height + 40;
            }}
            style={[
              {
                backgroundColor: colors.background,
                borderTopLeftRadius: radii.sheet,
                borderTopRightRadius: radii.sheet,
                paddingHorizontal: screenGutter,
                paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.xs,
                maxHeight: "92%",
              },
              sheet,
            ]}
          >
            <GestureDetector gesture={pan}>
              <View
                style={{ paddingTop: spacing.sm, paddingBottom: spacing.md, alignItems: "center" }}
              >
                <View
                  style={{
                    width: 36,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: colors.surfaceStrong,
                  }}
                />
              </View>
            </GestureDetector>
            <ScrollView
              contentContainerStyle={{ gap: spacing.lg, paddingBottom: spacing.xs }}
              bounces={false}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
            {footer ? (
              <View style={{ gap: spacing.md, paddingTop: spacing.lg }}>{footer}</View>
            ) : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

export interface ConfirmationSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly message?: string;
  readonly rows?: readonly { readonly label: string; readonly value: string }[];
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly loading?: boolean;
  /** Leading icon in a round badge above the title. */
  readonly icon?: IconName;
  readonly testID?: string;
}

/** Bottom sheet for irreversible confirmations. Backdrop tap, drag and Android back cancel. */
export function ConfirmationSheet({
  visible,
  title,
  message,
  rows,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = "Cancel",
  destructive,
  loading,
  icon,
  testID,
}: ConfirmationSheetProps) {
  const { colors } = useTheme();
  return (
    <BottomSheet
      visible={visible}
      onDismiss={onCancel}
      blocking={loading === true}
      testID={testID}
      footer={
        <>
          <PrimaryButton
            label={confirmLabel}
            onPress={onConfirm}
            destructive={destructive}
            loading={loading}
            testID={testID ? `${testID}-confirm` : undefined}
          />
          <SecondaryButton
            label={cancelLabel}
            onPress={onCancel}
            disabled={loading}
            testID={testID ? `${testID}-cancel` : undefined}
          />
        </>
      }
    >
      <View style={{ gap: spacing.sm }}>
        {icon ? (
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: radii.pill,
              backgroundColor: destructive === true ? colors.dangerSoft : colors.surface,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: spacing.xs,
            }}
          >
            <Icon
              name={icon}
              size={22}
              color={destructive === true ? colors.danger : colors.text}
            />
          </View>
        ) : null}
        <Text variant="headline" accessibilityRole="header">
          {title}
        </Text>
        {message ? (
          <Text variant="callout" tone="secondary">
            {message}
          </Text>
        ) : null}
      </View>
      {rows && rows.length > 0 ? (
        <Card style={{ paddingVertical: spacing.sm }}>
          {rows.map((r) => (
            <KeyValueRow key={r.label} label={r.label} value={r.value} />
          ))}
        </Card>
      ) : null}
      {children}
    </BottomSheet>
  );
}

export interface ActionSheetAction {
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  readonly subtitle?: string;
  readonly testID?: string;
}

export interface ActionSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly subtitle?: string;
  readonly actions: readonly ActionSheetAction[];
  readonly onDismiss: () => void;
  readonly testID?: string;
}

/** A short list of actions for one object (rename, remove...). */
export function ActionSheet({
  visible,
  title,
  subtitle,
  actions,
  onDismiss,
  testID,
}: ActionSheetProps) {
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onDismiss={onDismiss} testID={testID}>
      <View style={{ gap: spacing.xs }}>
        <Text variant="headline" accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Card padded={false}>
        {actions.map((a, i) => (
          <View key={a.label}>
            {i > 0 ? (
              <View style={{ height: 1, backgroundColor: colors.separator, marginLeft: 60 }} />
            ) : null}
            <PressableScale
              onPress={a.onPress}
              accessibilityLabel={a.label}
              testID={a.testID}
              scaleTo={1}
              highlight={colors.surfaceStrong}
            >
              <Row
                style={{
                  minHeight: 56,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                }}
              >
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: radii.xs,
                    backgroundColor:
                      a.destructive === true ? colors.dangerSoft : colors.surfaceRaised,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon
                    name={a.icon}
                    size={17}
                    color={a.destructive === true ? colors.danger : colors.text}
                  />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="body" tone={a.destructive === true ? "danger" : "primary"}>
                    {a.label}
                  </Text>
                  {a.subtitle ? (
                    <Text variant="footnote" tone="secondary">
                      {a.subtitle}
                    </Text>
                  ) : null}
                </View>
              </Row>
            </PressableScale>
          </View>
        ))}
      </Card>
    </BottomSheet>
  );
}

export interface QRDisplayProps {
  readonly value: string;
  readonly size?: number;
  /** Spoken label, e.g. "QR code for your Solana address". */
  readonly accessibilityLabel: string;
}

/**
 * QR always renders dark-on-white with a quiet zone, whatever the app theme,
 * because inverted codes fail on many scanners.
 */
export function QRDisplay({ value, size = 220, accessibilityLabel }: QRDisplayProps) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{
        alignSelf: "center",
        backgroundColor: "#FFFFFF",
        borderRadius: radii.card,
        padding: spacing.xl,
      }}
    >
      <QRCode
        value={value}
        size={size}
        color="#000000"
        backgroundColor="#FFFFFF"
        ecl="M"
        quietZone={4}
      />
    </View>
  );
}
