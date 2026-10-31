import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  Avatar,
  Card,
  ConfirmationSheet,
  ListGroup,
  ROW_TEXT_INSET,
  ListRow,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SimulatedBadge,
  spacing,
  Text,
  type IconName,
} from "@zyropay/ui";
import { useAgents } from "@/api/hooks";
import { signOut } from "@/lib/auth";
import { env } from "@/lib/env";
import { useSigner } from "@/lib/turnkey";
import { usePrefs, useSession } from "@/state";

type Page =
  "appearance" | "security" | "notifications" | "currency" | "network" | "privacy" | "about";

/** Settings root. */
export default function Settings() {
  const user = useSession((s) => s.session?.user ?? null);
  const simulated = useSession((s) => s.session?.simulated ?? false);
  const theme = usePrefs((s) => s.theme);
  const currency = usePrefs((s) => s.currency);
  const agents = useAgents();
  const signer = useSigner();
  const qc = useQueryClient();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const activeAgents = agents.data?.filter((a) => !a.policy.revoked).length ?? 0;

  const row = (icon: IconName, title: string, page: Page, value?: string) => (
    <ListRow
      icon={icon}
      title={title}
      {...(value === undefined ? {} : { value })}
      onPress={() => {
        router.push({ pathname: "/settings/[page]", params: { page } });
      }}
      testID={`settings-${page}`}
    />
  );

  return (
    <Screen testID="settings-screen">
      <ScreenHeader title="Settings" />
      <Card>
        <Row>
          <Avatar label={user?.displayName ?? "Z"} size={56} inverted />
          <View style={{ flex: 1, gap: spacing.xxs }}>
            <Text variant="headline">{user?.displayName ?? "ZyroPay user"}</Text>
            <Text variant="footnote" tone="secondary">
              {user?.email ?? "No email on file"}
            </Text>
            {simulated ? <SimulatedBadge /> : null}
          </View>
        </Row>
      </Card>

      <Section title="General">
        <ListGroup inset={ROW_TEXT_INSET}>
          {row(
            "moon",
            "Appearance",
            "appearance",
            theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light",
          )}
          {row("globe", "Currency", "currency", currency)}
          {row("link", "Network", "network", env.mode === "production" ? "Mainnet" : "Testnet")}
          {row("bell", "Notifications", "notifications")}
        </ListGroup>
      </Section>

      <Section title="Security">
        <ListGroup inset={ROW_TEXT_INSET}>
          {row("passkey", "Passkeys and session", "security")}
          <ListRow
            icon="agent"
            title="Connected agents"
            value={String(activeAgents)}
            onPress={() => {
              router.navigate("/agents");
            }}
          />
          <ListRow
            icon="key"
            title="Export recovery phrase"
            onPress={() => {
              router.navigate("/wallets");
            }}
          />
          <ListRow
            icon="plug"
            title="Plugins"
            onPress={() => {
              router.push("/plugins");
            }}
          />
        </ListGroup>
      </Section>

      <Section title="About">
        <ListGroup inset={ROW_TEXT_INSET}>
          {row("lock", "Privacy", "privacy")}
          {row("info", "About ZyroPay", "about")}
        </ListGroup>
      </Section>

      <ListGroup inset={ROW_TEXT_INSET}>
        <ListRow
          icon="logout"
          title="Sign out"
          destructive
          onPress={() => {
            setConfirmSignOut(true);
          }}
          testID="settings-sign-out"
        />
      </ListGroup>

      <ConfirmationSheet
        visible={confirmSignOut}
        title="Sign out?"
        message="Your wallet stays safe in Turnkey. Sign back in with your passkey. Connected agents keep their permissions until you revoke them."
        confirmLabel="Sign out"
        destructive
        loading={signingOut}
        onCancel={() => {
          setConfirmSignOut(false);
        }}
        onConfirm={() => {
          setSigningOut(true);
          void signOut(signer, qc).finally(() => {
            setSigningOut(false);
            setConfirmSignOut(false);
          });
        }}
        testID="sign-out-sheet"
      />
    </Screen>
  );
}
