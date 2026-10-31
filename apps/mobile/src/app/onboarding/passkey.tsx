import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  EmptyMotif,
  EmptyState,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SecurityWarning,
  SimulatedBadge,
  spacing,
  Text,
  TextField,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { authenticate } from "@/lib/auth";
import { useSigner } from "@/lib/turnkey";
import { firstParam } from "@/lib/utils";
import { usePrefs } from "@/state";

/** Onboarding 3/7 — passkey registration (sign up) or passkey sign-in. */
export default function PasskeyStep() {
  const signer = useSigner();
  const mode =
    firstParam(useLocalSearchParams<{ mode?: string }>().mode) === "login" ? "logIn" : "signUp";
  const onboardingComplete = usePrefs((s) => s.onboardingComplete);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await authenticate(
        signer,
        mode,
        mode === "signUp" ? name.trim() || "ZyroPay user" : undefined,
      );
      // A returning user who finished onboarding before goes straight to the app (route guard).
      if (!(mode === "logIn" && onboardingComplete)) router.replace("/onboarding/wallet");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "signUp" ? "Create your passkey" : "Sign in";

  if (signer.kind === "unavailable") {
    return (
      <Screen edges={["top", "bottom"]} testID="onboarding-passkey-unavailable">
        <ScreenHeader
          title={title}
          onBack={() => {
            router.back();
          }}
        />
        <EmptyState
          icon="passkey"
          title="Turnkey not configured"
          message={signer.unavailableReason ?? "Passkey signing is not available in this build."}
        />
        <SecurityWarning
          severity="info"
          title="For UI work without credentials"
          message="Start Metro with EXPO_PUBLIC_USE_MOCKS=1 to use a clearly labelled simulated session."
        />
      </Screen>
    );
  }

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="onboarding-passkey"
      footer={
        <PrimaryButton
          label={mode === "signUp" ? "Create passkey" : "Sign in with passkey"}
          icon="passkey"
          onPress={() => {
            void run();
          }}
          loading={busy}
          testID="passkey-continue"
        />
      }
    >
      <ScreenHeader
        title={title}
        subtitle={
          mode === "signUp"
            ? "Your device creates a passkey protected by Face ID, Touch ID or your screen lock. It never leaves your device or your password manager."
            : "Use the passkey you created for ZyroPay."
        }
        onBack={() => {
          router.back();
        }}
      />
      {signer.kind === "simulated" ? (
        <View style={{ gap: spacing.sm }}>
          <SimulatedBadge />
          <Text variant="callout" tone="secondary">
            Development mock: this creates a simulated session. No passkey or Turnkey wallet is
            created.
          </Text>
        </View>
      ) : null}
      <View style={{ alignItems: "center", paddingVertical: spacing.lg }}>
        <EmptyMotif icon="passkey" size={148} />
      </View>
      {mode === "signUp" ? (
        <TextField
          label="Your name (optional)"
          hint="Shown in your password manager next to the passkey."
          value={name}
          onChangeText={setName}
          maxLength={64}
          autoComplete="name"
          testID="passkey-name"
        />
      ) : null}
      {error ? (
        <SecurityWarning severity="danger" title="That didn't work" message={error} />
      ) : null}
    </Screen>
  );
}
