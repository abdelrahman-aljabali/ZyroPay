import { router } from "expo-router";
import {
  AgentAvatar,
  ListGroup,
  ListRow,
  ROW_TEXT_INSET,
  Screen,
  ScreenHeader,
  SecondaryButton,
  SecurityWarning,
} from "@zyropay/ui";
import { AGENT_CLIENTS } from "@/lib/agent-clients";

/** Connect an agent: pick the client. */
export default function ConnectAgent() {
  return (
    <Screen testID="connect-agent">
      <ScreenHeader
        title="Connect an agent"
        subtitle="Agents connect over MCP. You confirm every connection here with a one-time code."
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <ListGroup inset={ROW_TEXT_INSET + 6}>
        {AGENT_CLIENTS.map((c) => (
          <ListRow
            key={c.id}
            leading={<AgentAvatar name={c.name} size={36} />}
            title={`Connect with ${c.name}`}
            subtitle={`by ${c.vendor} · over MCP`}
            onPress={() => {
              router.push({ pathname: "/agents/connect/[client]", params: { client: c.id } });
            }}
            testID={`connect-client-${c.id}`}
          />
        ))}
      </ListGroup>
      <SecondaryButton
        label="I already have a code"
        onPress={() => {
          router.push("/agents/claim");
        }}
        testID="connect-have-code"
      />
      <SecurityWarning
        severity="info"
        title="Safe by default"
        message="A new agent can read the wallets you choose. It cannot spend until you turn spending on, and in Always Ask mode every payment waits for your passkey."
      />
    </Screen>
  );
}
