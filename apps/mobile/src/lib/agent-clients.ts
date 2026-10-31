/*
 * Connection instructions per MCP client. These describe the remote-MCP +
 * OAuth flow in ARCHITECTURE §2.4: the client opens the ZyroPay authorize page,
 * which shows a user code; the user confirms that code in this app.
 * Client UIs change often, so steps name the setting rather than exact pixels.
 */

export type AgentClientId = "claude" | "chatgpt" | "grok";

export interface AgentClientGuide {
  readonly id: AgentClientId;
  readonly name: string;
  readonly vendor: string;
  readonly steps: readonly string[];
  readonly note: string;
}

export const AGENT_CLIENTS: readonly AgentClientGuide[] = [
  {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    steps: [
      "In Claude (desktop, web or mobile), open Settings → Connectors.",
      "Choose “Add custom connector” and paste the ZyroPay MCP server URL.",
      "Claude opens the ZyroPay sign-in page, which shows an 8-character code.",
      "Come back here, tap “Enter code” and type the code you see.",
    ],
    note: "Custom connectors may require a paid Claude plan or admin approval in Team and Enterprise workspaces.",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    vendor: "OpenAI",
    steps: [
      "In ChatGPT, open Settings → Apps & Connectors (developer mode may need to be enabled).",
      "Create a connector and paste the ZyroPay MCP server URL. Choose OAuth for authentication.",
      "ChatGPT opens the ZyroPay sign-in page, which shows an 8-character code.",
      "Come back here, tap “Enter code” and type the code you see.",
    ],
    note: "Availability of custom MCP connectors depends on your ChatGPT plan and region.",
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    steps: [
      "In the Grok client or xAI API tooling you use, add a remote MCP server.",
      "Paste the ZyroPay MCP server URL and start the OAuth sign-in.",
      "The ZyroPay sign-in page shows an 8-character code.",
      "Come back here, tap “Enter code” and type the code you see.",
    ],
    note: "Remote MCP support in Grok varies by product; the xAI API supports remote MCP tools.",
  },
];

export function agentClient(id: string): AgentClientGuide | undefined {
  return AGENT_CLIENTS.find((c) => c.id === id);
}

/** Normalise typed input into the ABCD-1234 user-code format. */
export function formatUserCode(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function isCompleteUserCode(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}
