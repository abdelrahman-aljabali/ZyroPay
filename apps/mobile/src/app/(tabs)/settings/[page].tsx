import { getNetwork, networksForMode } from "@zyropay/shared";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  Card,
  Icon,
  ListGroup,
  ROW_TEXT_INSET,
  EmptyState,
  KeyValueRow,
  ListRow,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SecurityWarning,
  SegmentedControl,
  spacing,
  SUPPORTED_DISPLAY_CURRENCIES,
  Text,
  ToggleRow,
  ZyroMark,
} from "@zyropay/ui";
import { resetMockState } from "@/api/mock/transport";
import { env } from "@/lib/env";
import { liveActivitiesSupported } from "@/lib/live-activity";
import { getPushPermission, registerForPush, type PushRegistration } from "@/lib/notifications";
import { signerKind, useSigner } from "@/lib/turnkey";
import { firstParam } from "@/lib/utils";
import { prefsStore, usePrefs, useSession } from "@/state";

const NETWORKS = networksForMode(env.mode);

const TITLES: Readonly<Record<string, string>> = {
  appearance: "Appearance",
  currency: "Currency",
  network: "Network",
  security: "Passkeys and session",
  notifications: "Notifications",
  privacy: "Privacy",
  about: "About",
};

export default function SettingsPage() {
  const page = firstParam(useLocalSearchParams<{ page: string }>().page);
  const title = TITLES[page];
  return (
    <Screen testID={`settings-page-${page}`}>
      <ScreenHeader
        title={title ?? "Settings"}
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      {page === "appearance" ? <Appearance /> : null}
      {page === "currency" ? <Currency /> : null}
      {page === "network" ? <NetworkPref /> : null}
      {page === "security" ? <Security /> : null}
      {page === "notifications" ? <Notifications /> : null}
      {page === "privacy" ? <Privacy /> : null}
      {page === "about" ? <About /> : null}
      {title === undefined ? <EmptyState icon="info" title="Not found" /> : null}
    </Screen>
  );
}

function Appearance() {
  const theme = usePrefs((s) => s.theme);
  return (
    <View style={{ gap: spacing.md }}>
      <SegmentedControl
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ]}
        value={theme}
        onChange={(t) => {
          prefsStore.getState().setTheme(t);
        }}
        testID="theme-picker"
      />
      <Text variant="caption" tone="secondary">
        ZyroPay starts in Light. System matches your device's light or dark setting. Animations
        follow your device's Reduce Motion setting.
      </Text>
    </View>
  );
}

function Currency() {
  const currency = usePrefs((s) => s.currency);
  return (
    <ListGroup inset={ROW_TEXT_INSET}>
      {SUPPORTED_DISPLAY_CURRENCIES.map((c) => (
        <View key={c}>
          <ListRow
            title={c}
            trailing={currency === c ? <Icon name="check" size={18} strokeWidth={2.4} /> : null}
            onPress={() => {
              prefsStore.getState().setCurrency(c);
            }}
          />
        </View>
      ))}
    </ListGroup>
  );
}

function NetworkPref() {
  const preferred = usePrefs((s) => s.preferredNetwork);
  return (
    <View style={{ gap: spacing.lg }}>
      <SecurityWarning
        severity={env.mode === "production" ? "info" : "warning"}
        title={env.mode === "production" ? "Mainnet build" : "Testnet build"}
        message={
          env.mode === "production"
            ? "This app uses real networks only. Test networks are never shown, so test and real funds can't mix."
            : "This app uses test networks only. Tokens here have no real value: dollar amounts use the mainnet price of SOL, ETH, ADA and USDC. Mainnet is not reachable from this build."
        }
      />
      <Text variant="headline">Default network</Text>
      <ListGroup inset={ROW_TEXT_INSET}>
        <ListRow
          title="Automatic"
          trailing={preferred === null ? <Icon name="check" size={18} strokeWidth={2.4} /> : null}
          onPress={() => {
            prefsStore.getState().setPreferredNetwork(null);
          }}
        />
        {NETWORKS.map((n) => (
          <View key={n}>
            <ListRow
              title={getNetwork(n).displayName}
              trailing={preferred === n ? <Icon name="check" size={18} strokeWidth={2.4} /> : null}
              onPress={() => {
                prefsStore.getState().setPreferredNetwork(n);
              }}
              testID={`network-pref-${n}`}
            />
          </View>
        ))}
      </ListGroup>
    </View>
  );
}

function Security() {
  const signer = useSigner();
  const session = useSession((s) => s.session);
  return (
    <View style={{ gap: spacing.lg }}>
      <Card style={{ paddingVertical: spacing.sm }}>
        <KeyValueRow
          label="Signing"
          value={
            signer.kind === "turnkey"
              ? "Passkey (Turnkey)"
              : signer.kind === "simulated"
                ? "Simulated"
                : "Unavailable"
          }
        />
        <KeyValueRow
          label="Sub-organization"
          value={session?.user.turnkeySubOrganizationId ?? "—"}
        />
        <KeyValueRow
          label="Session expires"
          value={session ? new Date(session.refreshTokenExpiresAt).toUTCString() : "—"}
        />
      </Card>
      {signer.unavailableReason ? (
        <SecurityWarning
          severity="info"
          title="Passkeys unavailable"
          message={signer.unavailableReason}
        />
      ) : null}
      <SecurityWarning
        severity="info"
        title="Add a backup passkey"
        message="Your passkey syncs through iCloud Keychain or Google Password Manager. To add a passkey on another device or a hardware key, sign in there and create one; each passkey is a root of your wallet only you control."
      />
      <Text variant="callout" tone="secondary">
        Every payment you approve is signed by your passkey. ZyroPay's servers forward that
        signature to Turnkey but cannot create one.
      </Text>
    </View>
  );
}

function Notifications() {
  const [status, setStatus] = useState<string>("unknown");
  const [result, setResult] = useState<PushRegistration | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getPushPermission()
      .then(setStatus)
      .catch(() => undefined);
  }, [result]);
  return (
    <View style={{ gap: spacing.lg }}>
      <Card style={{ paddingVertical: spacing.sm }}>
        <KeyValueRow label="Permission" value={status} />
        <KeyValueRow
          label="Live Activities"
          value={liveActivitiesSupported() ? "Available" : "Not available in this build"}
        />
        <KeyValueRow label="Fallback" value="Checks every 15 s while open" />
      </Card>
      {status === "denied" ? (
        <PrimaryButton
          label="Open system settings"
          onPress={() => {
            void Linking.openSettings();
          }}
        />
      ) : (
        <PrimaryButton
          label="Register this device"
          icon="bell"
          loading={busy}
          onPress={() => {
            setBusy(true);
            void registerForPush()
              .then(setResult)
              .finally(() => {
                setBusy(false);
              });
          }}
          testID="notifications-register"
        />
      )}
      {result?.status === "registered" ? (
        <SecurityWarning
          severity="info"
          title="Registered"
          message="Approval requests will notify this device."
        />
      ) : null}
      {result?.status === "unsupported" || result?.status === "error" ? (
        <SecurityWarning severity="warning" title="Not registered" message={result.reason} />
      ) : null}
    </View>
  );
}

function Privacy() {
  const analytics = usePrefs((s) => s.analyticsOptIn);
  return (
    <View style={{ gap: spacing.lg }}>
      <ListGroup inset={ROW_TEXT_INSET}>
        <ToggleRow
          title="Share anonymous usage data"
          subtitle="Off by default. Never includes addresses, amounts or keys."
          value={analytics}
          onValueChange={(v) => {
            prefsStore.getState().setAnalyticsOptIn(v);
          }}
        />
      </ListGroup>
      <Text variant="callout" tone="secondary">
        ZyroPay stores your email (if given), your wallet addresses and your push token to run the
        service. Session tokens live in your device's secure keychain. Your passkey never leaves
        your device or password manager.
      </Text>
      <ListGroup inset={ROW_TEXT_INSET}>
        <HideToggle />
      </ListGroup>
    </View>
  );
}

function HideToggle() {
  const hidden = usePrefs((s) => s.hideBalances);
  return (
    <ToggleRow
      title="Hide balances"
      subtitle="Touch and hold a hidden balance to peek."
      value={hidden}
      onValueChange={() => {
        prefsStore.getState().toggleHideBalances();
      }}
    />
  );
}

function About() {
  const version = Constants.expoConfig?.version ?? "0.0.0";
  return (
    <View style={{ gap: spacing.lg }}>
      <View style={{ alignItems: "center", gap: spacing.md, paddingVertical: spacing.lg }}>
        <ZyroMark size={64} />
        <Text variant="headline">ZyroPay</Text>
        <Text variant="caption" tone="secondary">
          {`Version ${version}`}
        </Text>
      </View>
      <Card style={{ paddingVertical: spacing.sm }}>
        <KeyValueRow label="Mode" value={env.mode} />
        <KeyValueRow
          label="API"
          value={env.mocksActive ? "Simulated (mock transport)" : env.apiUrl}
        />
        <KeyValueRow label="Signer" value={signerKind} />
      </Card>
      <Text variant="caption" tone="secondary">
        Non-custodial: keys are held in Turnkey's secure enclaves under your passkey. ZyroPay cannot
        move your funds.
      </Text>
      {env.mocksActive ? (
        <PrimaryButton
          label="Reset simulated data"
          onPress={() => {
            resetMockState();
          }}
        />
      ) : null}
    </View>
  );
}
