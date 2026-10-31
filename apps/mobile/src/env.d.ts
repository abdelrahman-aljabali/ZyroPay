/*
 * Typed environment for the app bundle (EXPO_PUBLIC_*) and for app.config.ts (build time).
 *
 * expo-modules-core merges `ExpoProcessEnv` (which has a `[key: string]: any` index
 * signature) into `NodeJS.ProcessEnv`, so without these declarations every
 * `process.env.X` read is `any`. Declaring each variable we read makes it `string |
 * undefined` again. Keep this list in sync with the repo-root .env.example.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    // --- bundled into the app (public; never secrets) -------------------------------
    EXPO_PUBLIC_API_URL?: string;
    EXPO_PUBLIC_MCP_URL?: string;
    EXPO_PUBLIC_ZYROPAY_MODE?: string;
    EXPO_PUBLIC_USE_MOCKS?: string;
    EXPO_PUBLIC_DEV_PASSKEY?: string;
    EXPO_PUBLIC_DEEP_LINK_SCHEME?: string;
    EXPO_PUBLIC_TURNKEY_API_BASE_URL?: string;
    EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID?: string;
    EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID?: string;
    EXPO_PUBLIC_PASSKEY_RP_ID?: string;
    EXPO_PUBLIC_PASSKEY_RP_NAME?: string;
    /** Sentry DSN of the mobile/web project (public). Unset = error monitoring off. */
    EXPO_PUBLIC_SENTRY_DSN?: string;
    EXPO_PUBLIC_SENTRY_ENVIRONMENT?: string;
    // --- build time only (app.config.ts) ------------------------------------------------
    APP_VARIANT?: string;
    APP_DEEP_LINK_SCHEME?: string;
    IOS_BUNDLE_ID?: string;
    ANDROID_PACKAGE_NAME?: string;
    APPLE_TEAM_ID?: string;
    PASSKEY_RP_ID?: string;
    EXPO_OWNER?: string;
    EXPO_PROJECT_ID?: string;
  }
}
