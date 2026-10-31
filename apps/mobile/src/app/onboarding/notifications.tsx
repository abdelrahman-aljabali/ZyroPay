import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  Icon,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SecondaryButton,
  SecurityWarning,
  spacing,
  useTheme,
} from "@zyropay/ui";
import { registerForPush, type PushRegistration } from "@/lib/notifications";
import { prefsStore } from "@/state";

/** Onboarding 6/7 — notifications permission (approvals are time-limited). */
export default function NotificationsStep() {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PushRegistration | null>(null);

  const next = () => {
    prefsStore.getState().setNotificationsPrompted();
    router.push("/onboarding/done");
  };

  const enable = async () => {
    setBusy(true);
    const r = await registerForPush();
    setBusy(false);
    setResult(r);
    if (r.status === "registered") next();
  };

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="onboarding-notifications"
      footer={
        <>
          <PrimaryButton
            label={result && result.status !== "registered" ? "Continue" : "Turn on notifications"}
            icon="bell"
            loading={busy}
            onPress={() => {
              if (result && result.status !== "registered") next();
              else void enable();
            }}
            testID="notifications-enable"
          />
          <SecondaryButton label="Not now" onPress={next} testID="notifications-skip" />
        </>
      }
    >
      <ScreenHeader
        title="Know when an agent asks"
        subtitle="Approval requests expire after a few minutes. A notification lets you approve in time. Without it, the app checks while it is open."
      />
      <View style={{ alignItems: "center", paddingVertical: spacing.xl }}>
        <View
          style={{
            width: 96,
            height: 96,
            borderRadius: 48,
            backgroundColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="bell" size={44} />
        </View>
      </View>
      {result?.status === "denied" ? (
        <SecurityWarning
          severity="info"
          title="Notifications are off"
          message="You can turn them on later in your phone's Settings. Pending approvals still show in the Approvals tab."
        />
      ) : null}
      {result?.status === "unsupported" || result?.status === "error" ? (
        <SecurityWarning
          severity="info"
          title="Push isn't available here"
          message={result.reason}
        />
      ) : null}
    </Screen>
  );
}
