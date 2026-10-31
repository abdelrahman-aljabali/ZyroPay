/**
 * End-to-end harness: runs the real worker in workerd (wrangler `unstable_dev`, i.e.
 * Miniflare) against the contract-validated FakeApi test double, and drives the OAuth flow
 * with the official MCP SDK client. The "browser" and the "mobile app" are simulated:
 * the browser by plain HTTP requests carrying the consent cookie, the app by FakeApi's
 * approve/reject/expire controls.
 */
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { unstable_dev } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";
import { FakeApi } from "./fake-api";

export const INTERNAL_TOKEN = "test-internal-service-token-0123456789abcdef";
const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789";
export const REDIRECT_URI = "http://127.0.0.1:53682/callback";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export interface Harness {
  worker: Unstable_DevWorker;
  api: FakeApi;
  origin: string;
  mcpUrl: string;
  stop(): Promise<void>;
}

export async function startHarness(extraVars: Record<string, string> = {}): Promise<Harness> {
  const api = new FakeApi(INTERNAL_TOKEN);
  await api.start();
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const worker = await unstable_dev(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), {
    config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    ip: "127.0.0.1",
    port,
    persist: false,
    logLevel: "warn",
    vars: {
      ZYROPAY_MODE: "development",
      MCP_PUBLIC_URL: origin,
      API_INTERNAL_URL: api.url,
      INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
      MCP_OAUTH_COOKIE_SECRET: COOKIE_SECRET,
      MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "900",
      ...extraVars,
    },
    experimental: { disableExperimentalWarning: true },
  });
  api.onRevoke = async (agentId, userId) => {
    const res = await fetch(`${origin}/internal/v1/agents/${agentId}/revoke-grants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`revoke push failed: ${res.status}`);
  };
  return {
    worker,
    api,
    origin,
    mcpUrl: `${origin}/mcp`,
    async stop() {
      await worker.stop();
      await api.stop();
    },
  };
}

/** In-memory OAuth client state for the MCP SDK (a public client using DCR). */
class TestOAuthProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;

  constructor(private readonly redirect = REDIRECT_URI) {}

  get redirectUrl(): string {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Test Agent",
      redirect_uris: [this.redirect],
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

export interface ConsentPage {
  status: number;
  html: string;
  cookie: string;
  handle: string;
  userCode: string;
  ticket: string;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Simulated browser: open the authorize URL and scrape the waiting page. */
export async function openAuthorize(url: URL | string): Promise<ConsentPage> {
  const response = await fetch(url, { redirect: "manual" });
  const html = await response.text();
  const ticketLiteral = /var t=("[^"]+")/.exec(html)?.[1];
  return {
    status: response.status,
    html,
    cookie: cookieHeader(response),
    handle:
      /name="handle" value="([^"]+)"/
        .exec(html)?.[1]
        ?.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))) ?? "",
    userCode: /id="code">([A-Z0-9-]+)</.exec(html)?.[1] ?? "",
    ticket: ticketLiteral ? (JSON.parse(ticketLiteral) as string) : "",
  };
}

/** Simulated browser: the page's form post after the app decided. */
export async function submitConsent(
  origin: string,
  page: ConsentPage,
  cookie = page.cookie,
): Promise<Response> {
  return fetch(`${origin}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ handle: page.handle }).toString(),
  });
}

/**
 * Full happy path with the official SDK client: discovery (401 -> PRM -> AS metadata),
 * DCR, authorization with PKCE S256 + resource, approval in the "app", code exchange.
 */
export async function connectWithOAuth(
  h: Harness,
  options: { spendingEnabled?: boolean; provider?: TestOAuthProvider } = {},
): Promise<{ client: Client; provider: TestOAuthProvider; agentId: string }> {
  const provider = options.provider ?? new TestOAuthProvider();
  const first = new StreamableHTTPClientTransport(new URL(h.mcpUrl), { authProvider: provider });
  const probe = new Client({ name: "zyropay-test", version: "1.0.0" });
  await probe.connect(first).then(
    () => {
      throw new Error("expected the first connection to require authorization");
    },
    (error: unknown) => {
      if (!(error instanceof UnauthorizedError)) throw error;
    },
  );
  if (!provider.authorizationUrl) throw new Error("no authorization URL");
  const page = await openAuthorize(provider.authorizationUrl);
  if (page.status !== 200)
    throw new Error(`authorize page ${page.status}: ${page.html.slice(0, 300)}`);
  const agent = h.api.approve(page.userCode, { spendingEnabled: options.spendingEnabled ?? false });
  const done = await submitConsent(h.origin, page);
  const location = done.headers.get("Location");
  if (done.status !== 302 || !location) throw new Error(`consent submit ${done.status}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  await first.finishAuth(code);

  const client = new Client({ name: "zyropay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.mcpUrl), { authProvider: provider }),
  );
  return { client, provider, agentId: agent.id };
}
