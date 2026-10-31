import { getNetwork, networksForMode, type NetworkId } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import {
  Card,
  formatCountdown,
  KeyValueRow,
  PrimaryButton,
  radii,
  Screen,
  ScreenHeader,
  SecondaryButton,
  SecurityWarning,
  spacing,
  Text,
  TextField,
  ToggleRow,
  useCountdown,
  useTheme,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import {
  useApproveConnection,
  useClaimConnection,
  useRejectConnection,
  useWallets,
} from "@/api/hooks";
import { agentClient, formatUserCode, isCompleteUserCode } from "@/lib/agent-clients";
import { env } from "@/lib/env";
import { firstParam } from "@/lib/utils";

const NETWORKS = networksForMode(env.mode);

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match?.[1] ?? url;
}

/**
 * Device-code style connect (ARCHITECTURE §2.4): enter the code shown on the
 * MCP authorize page, review who is asking, pick wallets and networks, approve.
 */
export default function ClaimConnection() {
  const theme = useTheme();
  const { colors } = theme;
  const client = agentClient(firstParam(useLocalSearchParams<{ client?: string }>().client));
  const [code, setCode] = useState("");
  const claim = useClaimConnection();
  const approve = useApproveConnection();
  const reject = useRejectConnection();
  const wallets = useWallets();
  const connection = claim.data;

  const [name, setName] = useState("");
  const [walletIds, setWalletIds] = useState<string[]>([]);
  const [networks, setNetworks] = useState<NetworkId[]>([...NETWORKS]);

  useEffect(() => {
    if (connection) setName(connection.clientName.slice(0, 64));
  }, [connection]);
  useEffect(() => {
    const first = wallets.data?.[0];
    if (first && walletIds.length === 0) setWalletIds([first.id]);
  }, [wallets.data, walletIds.length]);

  const remaining = useCountdown(connection?.expiresAt ?? "1970-01-01T00:00:00.000Z");
  const expired = connection !== undefined && remaining <= 0;
  const back = () => {
    router.back();
  };

  if (approve.isSuccess) {
    const agent = approve.data.agent;
    return (
      <Screen
        edges={["top", "bottom"]}
        testID="claim-success"
        footer={
          <>
            <PrimaryButton
              label="Review permissions"
              onPress={() => {
                router.replace({ pathname: "/agents/[id]/policy", params: { id: agent.id } });
              }}
              testID="claim-review-policy"
            />
            <SecondaryButton
              label="Done"
              onPress={() => {
                router.replace({ pathname: "/agents/[id]", params: { id: agent.id } });
              }}
              testID="claim-done"
            />
          </>
        }
      >
        <ScreenHeader
          title={`${agent.name} is connected`}
          subtitle="It can read the wallets you chose. Spending is off and every request will ask you first."
        />
        <SecurityWarning
          severity="info"
          title="Next: set permissions"
          message="Turn on spending, add allowed recipients or set limits whenever you're ready."
        />
      </Screen>
    );
  }

  if (!connection) {
    return (
      <Screen
        edges={["top", "bottom"]}
        testID="claim-code"
        footer={
          <PrimaryButton
            label="Continue"
            disabled={!isCompleteUserCode(code)}
            loading={claim.isPending}
            onPress={() => {
              claim.mutate(code);
            }}
            testID="claim-continue"
          />
        }
      >
        <ScreenHeader
          title="Enter code"
          subtitle={`Type the code shown on the ZyroPay page in ${client?.name ?? "your agent"}.`}
          size="inline"
          onBack={back}
        />
        <TextInput
          value={code}
          onChangeText={(t) => {
            setCode(formatUserCode(t));
          }}
          placeholder="ABCD-1234"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          maxLength={9}
          accessibilityLabel="Connection code"
          testID="claim-code-input"
          style={[
            theme.type("display"),
            {
              color: colors.text,
              backgroundColor: colors.surface,
              borderRadius: radii.card,
              paddingVertical: spacing.xl,
              textAlign: "center",
              letterSpacing: 4,
            },
          ]}
        />
        {claim.isError ? (
          <SecurityWarning
            severity="danger"
            title="Code not accepted"
            message={errorMessage(claim.error)}
          />
        ) : null}
      </Screen>
    );
  }

  const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] =>
    on ? [...list, item] : list.filter((x) => x !== item);

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="claim-review"
      footer={
        <>
          <PrimaryButton
            label="Approve connection"
            disabled={
              expired || walletIds.length === 0 || networks.length === 0 || name.trim() === ""
            }
            loading={approve.isPending}
            onPress={() => {
              approve.mutate({
                connectionId: connection.id,
                body: { name: name.trim(), walletIds, networks },
              });
            }}
            testID="claim-approve"
          />
          <SecondaryButton
            label="Decline"
            destructive
            disabled={approve.isPending}
            loading={reject.isPending}
            onPress={() => {
              reject.mutate(connection.id, {
                onSettled: () => {
                  router.back();
                },
              });
            }}
            testID="claim-decline"
          />
        </>
      }
    >
      <ScreenHeader title={`Connect ${connection.clientName}?`} size="inline" onBack={back} />
      <Card style={{ paddingVertical: spacing.sm }}>
        <KeyValueRow label="App" value={connection.clientName} emphasis />
        {connection.clientUri ? (
          <KeyValueRow label="Website" value={hostOf(connection.clientUri)} />
        ) : null}
        <KeyValueRow label="Returns to" value={hostOf(connection.redirectUri)} />
        <KeyValueRow label="Access" value={connection.scopes.join(", ") || "—"} />
        <KeyValueRow label="Code" value={connection.userCode} />
        <KeyValueRow label="Expires in" value={expired ? "Expired" : formatCountdown(remaining)} />
      </Card>
      {expired ? (
        <SecurityWarning
          severity="danger"
          title="This code expired"
          message="Start the connection again from your agent."
        />
      ) : null}
      <SecurityWarning
        severity="warning"
        title="Check the return address"
        message={`Only approve if you just started this from ${connection.clientName} and “${hostOf(connection.redirectUri)}” belongs to it.`}
      />
      <TextField
        label="Agent name"
        value={name}
        onChangeText={setName}
        maxLength={64}
        testID="claim-agent-name"
      />
      <View style={{ gap: spacing.xs }}>
        <Text variant="headline">Wallets it can see</Text>
        {wallets.data?.map((w) => (
          <ToggleRow
            key={w.id}
            title={w.name}
            value={walletIds.includes(w.id)}
            onValueChange={(on) => {
              setWalletIds((l) => toggle(l, w.id, on));
            }}
            testID={`claim-wallet-${w.name}`}
          />
        ))}
      </View>
      <View style={{ gap: spacing.xs }}>
        <Text variant="headline">Networks</Text>
        {NETWORKS.map((n) => (
          <ToggleRow
            key={n}
            title={getNetwork(n).displayName}
            subtitle={getNetwork(n).isTestnet ? "Testnet" : undefined}
            value={networks.includes(n)}
            onValueChange={(on) => {
              setNetworks((l) => toggle(l, n, on));
            }}
          />
        ))}
      </View>
      {approve.isError ? (
        <SecurityWarning
          severity="danger"
          title="Couldn't connect"
          message={errorMessage(approve.error)}
        />
      ) : null}
    </Screen>
  );
}
