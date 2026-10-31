import { ZyroPayModeSchema, type ZyroPayMode } from "@zyropay/shared";

/*
 * Public runtime config. Expo inlines EXPO_PUBLIC_* at bundle time, so each
 * variable must be read with a static `process.env.EXPO_PUBLIC_X` expression.
 * Never put secrets here: everything below ships inside the app bundle.
 */

export interface AppEnv {
  readonly apiUrl: string;
  readonly mcpUrl: string;
  readonly mode: ZyroPayMode;
  /** EXPO_PUBLIC_USE_MOCKS=1 was set. */
  readonly mocksRequested: boolean;
  /** Mocks are refused in production mode, mirroring the API (ARCHITECTURE rule 6/7). */
  readonly mocksActive: boolean;
  readonly mocksRefused: boolean;
  /**
   * EXPO_PUBLIC_DEV_PASSKEY=mock-turnkey (development only): sign with a simulated `dev-*`
   * passkey that the local API's MockTurnkey accepts, so Expo Go can use a real local API
   * without Turnkey credentials. Set by `pnpm dev`; refused in production.
   */
  readonly devMockPasskey: boolean;
  readonly deepLinkScheme: string;
  readonly turnkey: {
    readonly apiBaseUrl: string;
    readonly organizationId: string;
    readonly authProxyConfigId: string;
    readonly rpId: string;
    readonly rpName: string;
  };
}

export function readEnv(raw: Record<string, string | undefined>): AppEnv {
  const parsedMode = ZyroPayModeSchema.safeParse(raw.EXPO_PUBLIC_ZYROPAY_MODE);
  const mode: ZyroPayMode = parsedMode.success ? parsedMode.data : "development";
  const mocksRequested = raw.EXPO_PUBLIC_USE_MOCKS === "1";
  const mocksRefused = mocksRequested && mode === "production";
  const apiUrl = (raw.EXPO_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/+$/, "");
  return {
    apiUrl,
    mcpUrl: (raw.EXPO_PUBLIC_MCP_URL ?? "http://localhost:8788/mcp").replace(/\/+$/, ""),
    mode,
    mocksRequested,
    mocksActive: mocksRequested && !mocksRefused,
    mocksRefused,
    devMockPasskey: raw.EXPO_PUBLIC_DEV_PASSKEY === "mock-turnkey" && mode === "development",
    deepLinkScheme: raw.EXPO_PUBLIC_DEEP_LINK_SCHEME ?? "zyropay",
    turnkey: {
      apiBaseUrl: raw.EXPO_PUBLIC_TURNKEY_API_BASE_URL ?? "https://api.turnkey.com",
      organizationId: raw.EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID ?? "",
      authProxyConfigId: raw.EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID ?? "",
      rpId: raw.EXPO_PUBLIC_PASSKEY_RP_ID ?? "",
      rpName: raw.EXPO_PUBLIC_PASSKEY_RP_NAME ?? "ZyroPay",
    },
  };
}

export const env: AppEnv = readEnv({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  EXPO_PUBLIC_MCP_URL: process.env.EXPO_PUBLIC_MCP_URL,
  EXPO_PUBLIC_ZYROPAY_MODE: process.env.EXPO_PUBLIC_ZYROPAY_MODE,
  EXPO_PUBLIC_USE_MOCKS: process.env.EXPO_PUBLIC_USE_MOCKS,
  EXPO_PUBLIC_DEV_PASSKEY: process.env.EXPO_PUBLIC_DEV_PASSKEY,
  EXPO_PUBLIC_DEEP_LINK_SCHEME: process.env.EXPO_PUBLIC_DEEP_LINK_SCHEME,
  EXPO_PUBLIC_TURNKEY_API_BASE_URL: process.env.EXPO_PUBLIC_TURNKEY_API_BASE_URL,
  EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID: process.env.EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID,
  EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: process.env.EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID,
  EXPO_PUBLIC_PASSKEY_RP_ID: process.env.EXPO_PUBLIC_PASSKEY_RP_ID,
  EXPO_PUBLIC_PASSKEY_RP_NAME: process.env.EXPO_PUBLIC_PASSKEY_RP_NAME,
});

export function isTurnkeyConfigured(e: AppEnv = env): boolean {
  return (
    e.turnkey.organizationId !== "" && e.turnkey.authProxyConfigId !== "" && e.turnkey.rpId !== ""
  );
}
