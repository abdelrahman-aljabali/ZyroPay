/*
 * ZyroPay end-to-end local smoke test. Run: `pnpm smoke` (repo root).
 *
 * Starts the API and the MCP worker under `wrangler dev` against a fresh local Postgres
 * (Docker, or SMOKE_DATABASE_URL) with Mock chain adapters and MockTurnkey, then plays
 * every party for real over HTTP:
 *
 *   app    -> creates a session with a MockTurnkey `dev-*` passkey credential
 *   agent  -> connects through the MCP OAuth flow with the official MCP SDK client
 *   app    -> claims and approves the connection, enables spending (Always Ask)
 *   agent  -> get_balance, then send
 *   app    -> sees the approval, approves it with the mock passkey stamp
 *   system -> queue: sign (forwarded stamp) -> broadcast (MockBroadcaster) -> confirm
 *   agent  -> get_approval_status reaches CONFIRMED
 *
 * Exit code 0 only if every step passed. Nothing here talks to a real chain or Turnkey.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import { parsePushData, sha256Hex, TransactionRequestResultSchema } from "@zyropay/shared";
import {
  bytesToHex,
  decodeTransaction,
  mockPasskeyStamp,
  turnkeyTransactionType,
} from "@zyropay/wallet";
import { log, startStack, type Stack } from "./stack";

const TURNKEY = "https://api.turnkey.com";
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const results: { step: string; ok: boolean; detail: string }[] = [];

async function step<T>(name: string, fn: () => Promise<{ value: T; detail: string }>): Promise<T> {
  try {
    const { value, detail } = await fn();
    results.push({ step: name, ok: true, detail });
    log(`PASS  ${name} — ${detail}`);
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ step: name, ok: false, detail });
    log(`FAIL  ${name} — ${detail}`);
    throw error;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Json {
  [key: string]: unknown;
}

async function api(
  stack: Stack,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${stack.apiUrl}${path}`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Json) };
}

/** Typed read of a nested field of an untyped JSON response (throws when absent). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed accessor
function get<T>(value: unknown, ...path: (string | number)[]): T {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") throw new Error(`missing ${path.join(".")}`);
    cur = (cur as Record<string | number, unknown>)[key];
  }
  if (cur === undefined) throw new Error(`missing ${path.join(".")}`);
  return cur as T;
}

/** In-memory OAuth client state for the MCP SDK (a public client using DCR). */
class SmokeOAuthProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  get redirectUrl(): string {
    return REDIRECT_URI;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ZyroPay smoke agent",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

function toolResult(result: unknown): Json {
  const structured = (result as { structuredContent?: Json; isError?: boolean }).structuredContent;
  if ((result as { isError?: boolean }).isError === true || structured === undefined)
    throw new Error(`tool error: ${JSON.stringify(result).slice(0, 400)}`);
  return structured;
}

async function main(): Promise<void> {
  const stack = await startStack();
  try {
    // 1. App: dev session through MockTurnkey (`dev-*` credentials auto-provision a sub-org).
    const credentialId = `dev-smoke-${randomBytes(4).toString("hex")}`;
    const session = await step(
      "app creates a dev session (MockTurnkey dev-* passkey)",
      async () => {
        const organizationId = `mock-org-${sha256Hex(`org:${credentialId}`).slice(0, 16)}`;
        const body = JSON.stringify({ organizationId });
        const res = await api(stack, "POST", "/v1/auth/session", {
          body: {
            whoamiRequest: {
              url: `${TURNKEY}/public/v1/query/whoami`,
              body,
              stamp: mockPasskeyStamp(credentialId, body),
            },
          },
        });
        assert(
          res.status === 200,
          `POST /v1/auth/session ${String(res.status)} ${JSON.stringify(res.json)}`,
        );
        const token = get<string>(res.json, "session", "accessToken");
        const wallets = await api(stack, "GET", "/v1/wallets", { token });
        const wallet = get<Json>(wallets.json, "wallets", 0);
        const addresses = get<{ family: string; address: string }[]>(wallet, "addresses");
        const solana = addresses.find((a) => a.family === "solana")?.address ?? "";
        return {
          value: { token, organizationId, walletId: get<string>(wallet, "id"), solana },
          detail: `user ${get<string>(res.json, "user", "id")}, sub-org ${organizationId}, wallet ${get<string>(wallet, "id")}`,
        };
      },
    );
    // Register a device so pushes are actually dispatched (MockNotifier records them).
    await api(stack, "POST", "/v1/notifications/devices", {
      token: session.token,
      body: { expoPushToken: "ExponentPushToken[smoke-device]", platform: "ios" },
    });

    // 2. Agent: MCP OAuth with the official SDK; the app approves the connection via the API.
    const mcpUrl = `${stack.mcpOrigin}/mcp`;
    const provider = new SmokeOAuthProvider();
    const { client, agentId } = await step(
      "agent connects via MCP OAuth (SDK client: discovery, DCR, PKCE) and the app approves",
      async () => {
        const first = new StreamableHTTPClientTransport(new URL(mcpUrl), {
          authProvider: provider,
        });
        const probe = new Client({ name: "zyropay-smoke", version: "1.0.0" });
        await probe.connect(first).then(
          () => {
            throw new Error("expected the first connection to require authorization");
          },
          (error: unknown) => {
            if (!(error instanceof UnauthorizedError)) throw error;
          },
        );
        assert(provider.authorizationUrl, "no authorization URL from the SDK");
        // The "browser": open the authorize page and read the user code it shows.
        const page = await fetch(provider.authorizationUrl, { redirect: "manual" });
        const html = await page.text();
        assert(page.status === 200, `authorize page ${String(page.status)}`);
        const cookie = page.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
        const userCode = /id="code">([A-Z0-9-]+)</.exec(html)?.[1] ?? "";
        const handle = (/name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "").replace(
          /&#(\d+);/g,
          (_, n: string) => String.fromCharCode(Number(n)),
        );
        assert(userCode !== "" && handle !== "", "authorize page did not show a user code");
        // The "app": claim the code and approve, scoped to one wallet and two testnets.
        const claimed = await api(stack, "POST", "/v1/agent-connections/claim", {
          token: session.token,
          body: { userCode },
        });
        assert(
          claimed.status === 200,
          `claim ${String(claimed.status)} ${JSON.stringify(claimed.json)}`,
        );
        const connectionId = get<string>(claimed.json, "connection", "id");
        const approved = await api(stack, "POST", `/v1/agent-connections/${connectionId}/approve`, {
          token: session.token,
          body: {
            name: "Smoke agent",
            walletIds: [session.walletId],
            networks: ["solana-devnet", "base-sepolia"],
          },
        });
        assert(
          approved.status === 200,
          `approve ${String(approved.status)} ${JSON.stringify(approved.json)}`,
        );
        // The "browser" submits the consent page; the MCP worker redirects with the code.
        const done = await fetch(`${stack.mcpOrigin}/authorize`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
          body: new URLSearchParams({ handle }).toString(),
        });
        const location = done.headers.get("Location") ?? "";
        const code = location === "" ? null : new URL(location).searchParams.get("code");
        assert(done.status === 302 && code, `consent submit ${String(done.status)} ${location}`);
        await first.finishAuth(code);
        const connected = new Client({ name: "zyropay-smoke", version: "1.0.0" });
        await connected.connect(
          new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }),
        );
        const tools = await connected.listTools();
        return {
          value: { client: connected, agentId: get<string>(approved.json, "agent", "id") },
          detail: `user code ${userCode}, agent ${get<string>(approved.json, "agent", "id")}, ${String(tools.tools.length)} tools`,
        };
      },
    );

    // 3. App: allow spending to one recipient, Always Ask (the default mode).
    await step("app enables spending (Always Ask, recipient allowlist, limits)", async () => {
      const current = await api(stack, "GET", `/v1/agents/${agentId}/policy`, {
        token: session.token,
      });
      const { version, revoked: _r, ...policy } = get<Json>(current.json, "policy");
      const res = await api(stack, "PUT", `/v1/agents/${agentId}/policy`, {
        token: session.token,
        body: {
          expectedVersion: version,
          policy: {
            ...policy,
            spendingEnabled: true,
            recipientAllowlist: [{ family: "solana", address: RECIPIENT, label: "smoke" }],
            limits: {
              perTransactionUsdMinor: "5000",
              dailyUsdMinor: "10000",
              monthlyUsdMinor: "50000",
            },
          },
        },
      });
      assert(res.status === 200, `PUT policy ${String(res.status)} ${JSON.stringify(res.json)}`);
      return {
        value: null,
        detail: `policy v${String(get<number>(res.json, "policy", "version"))}, mode ${get<string>(res.json, "policy", "mode")}`,
      };
    });

    // 4. Agent: get_balance through MCP.
    await step("agent calls get_balance through MCP", async () => {
      const out = toolResult(await client.callTool({ name: "get_balance", arguments: {} }));
      const balances = get<{ asset: { symbol: string; network: string }; amount: string }[]>(
        out,
        "portfolio",
        "balances",
      );
      assert(balances.length > 0, "no balances");
      assert(get<boolean>(out, "portfolio", "simulated"), "expected simulated (mock) balances");
      return {
        value: null,
        detail: `${String(balances.length)} simulated balances, e.g. ${balances[0]?.amount ?? ""} base units ${balances[0]?.asset.symbol ?? ""} on ${balances[0]?.asset.network ?? ""}`,
      };
    });

    // 5. Agent: send through MCP -> PENDING_APPROVAL.
    const requestId = await step("agent calls send through MCP (needs approval)", async () => {
      const out = toolResult(
        await client.callTool({
          name: "send",
          arguments: {
            walletId: session.walletId,
            network: "solana-devnet",
            to: RECIPIENT,
            assetId: "solana-devnet:native",
            amount: "100000000",
            decimals: 9,
            idempotencyKey: `smoke-${randomBytes(6).toString("hex")}`,
          },
        }),
      );
      const request = TransactionRequestResultSchema.parse(get<Json>(out, "request"));
      assert(
        request.state === "PENDING_APPROVAL",
        `state ${request.state}, expected PENDING_APPROVAL`,
      );
      assert(request.approvalUrl?.startsWith("zyropay://approvals/"), "no approval deep link");
      return {
        value: request.requestId,
        detail: `request ${request.requestId} ${request.state}, ${request.approvalUrl ?? ""}`,
      };
    });

    // 6. App: the approval is visible through the API.
    const approval = await step("app sees the pending approval via the API", async () => {
      const list = await api(stack, "GET", "/v1/approvals?status=pending", {
        token: session.token,
      });
      const items = get<{ id: string; transactionRequestId: string }[]>(list.json, "approvals");
      const found = items.find((a) => a.transactionRequestId === requestId);
      assert(found, "approval not listed");
      const detail = await api(stack, "GET", `/v1/approvals/${found.id}`, { token: session.token });
      assert(detail.status === 200, `GET approval ${String(detail.status)}`);
      const feed = await api(stack, "GET", `/v1/agents/${agentId}/requests`, {
        token: session.token,
      });
      const inFeed = get<{ request: { id: string }; approvalId: string | null }[]>(
        feed.json,
        "items",
      ).find((i) => i.request.id === requestId);
      assert(inFeed?.approvalId === found.id, "request missing from the agent activity feed");
      return {
        value: { id: found.id, review: get<Json>(detail.json, "review") },
        detail: `approval ${found.id}; listed in the agent activity feed`,
      };
    });

    // 7. App: approve with the mock passkey (SIGN_TRANSACTION_V2 over the reviewed bytes).
    await step("app approves with the mock passkey stamp", async () => {
      const review = approval.review;
      const unsigned = get<{ encoding: "base64" | "hex"; serialized: string }>(
        review,
        "unsignedTransaction",
      );
      const network = get<string>(review, "payload", "network");
      const body = JSON.stringify({
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        timestampMs: String(Date.now()),
        organizationId: session.organizationId,
        parameters: {
          signWith: get<string>(review, "payload", "from"),
          unsignedTransaction: bytesToHex(
            decodeTransaction(unsigned.serialized, unsigned.encoding),
          ),
          type: turnkeyTransactionType(network.startsWith("solana") ? "solana" : "evm"),
        },
      });
      const res = await api(stack, "POST", `/v1/approvals/${approval.id}/approve`, {
        token: session.token,
        body: {
          payloadHash: get<string>(review, "payloadHash"),
          signRequest: {
            url: `${TURNKEY}/public/v1/submit/sign_transaction`,
            body,
            stamp: mockPasskeyStamp(credentialId, body),
          },
        },
      });
      assert(res.status === 200, `approve ${String(res.status)} ${JSON.stringify(res.json)}`);
      return {
        value: null,
        detail: `approval ${get<string>(res.json, "approval", "status")}, request ${get<string>(res.json, "request", "state")}`,
      };
    });

    // 8. System: queue signs/broadcasts/confirms; the agent observes CONFIRMED.
    await step("request reaches CONFIRMED (mock broadcaster), observed through MCP", async () => {
      const deadline = Date.now() + 60_000;
      let state = "";
      let txHash: string | null = null;
      while (Date.now() < deadline) {
        const out = toolResult(
          await client.callTool({ name: "get_approval_status", arguments: { requestId } }),
        );
        const request = TransactionRequestResultSchema.parse(get<Json>(out, "request"));
        state = request.state;
        txHash = request.txHash;
        if (state === "CONFIRMED" || state === "FAILED") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert(state === "CONFIRMED", `final state ${state}`);
      return { value: null, detail: `CONFIRMED, simulated tx ${txHash ?? "(none)"}` };
    });

    // 9. Push: the API dispatched the approval push with the shared PushData. With Mock
    // adapters the API logs each simulated push (`push.simulated`, ids and link only).
    await step("approval push carried the shared PushData (type, ids, deep link)", () => {
      const pushes = stack.logs.api
        .split("\n")
        .map((line) => line.slice(line.indexOf("{")))
        .filter((line) => line.includes('"push.simulated"'))
        .map((line) => JSON.parse(line) as { data: unknown });
      const parsed = pushes
        .map((p) => parsePushData(p.data))
        .find((p) => p?.data.type === "approval_requested" && p.data.approvalId === approval.id);
      assert(parsed, `no approval push for ${approval.id} among ${String(pushes.length)} pushes`);
      assert(parsed.route.screen === "approval", "push does not deep-link to the approval");
      assert(!JSON.stringify(parsed.data).includes("100000000"), "push payload carries the amount");
      return Promise.resolve({
        value: null,
        detail: `${String(pushes.length)} simulated pushes; approval push -> ${parsed.data.url}`,
      });
    });

    await client.close();
  } finally {
    const failed = results.some((r) => !r.ok);
    if (failed) log(`worker logs kept in ${stack.logDir} (api.log, mcp.log)`);
    await stack.stop(failed);
  }
}

main().then(
  () => {
    log(`${String(results.length)}/${String(results.length)} steps passed`);
    process.exit(0);
  },
  (error: unknown) => {
    log(`smoke test FAILED: ${error instanceof Error ? error.message : String(error)}`);
    log(`${String(results.filter((r) => r.ok).length)}/${String(results.length)} steps passed`);
    process.exit(1);
  },
);
