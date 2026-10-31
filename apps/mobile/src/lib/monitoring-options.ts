import { scrubBreadcrumb, scrubTelemetryEvent } from "@zyropay/shared";

/*
 * Error monitoring options shared by the native (@sentry/react-native) and web
 * (@sentry/react) SDKs. docs/MONITORING.md.
 *
 * Off unless EXPO_PUBLIC_SENTRY_DSN is set at build time (the DSN is public by design; it
 * only allows sending events). No PII, no screenshots or view hierarchies, no performance
 * traces, no session replay; every event and breadcrumb goes through the shared scrubber.
 */

export interface MonitoringConfig {
  readonly dsn: string;
  readonly environment: string;
}

/** Null when monitoring is off. Reads the inlined EXPO_PUBLIC_* values. */
export function monitoringConfig(
  dsn: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: string | undefined = process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.EXPO_PUBLIC_ZYROPAY_MODE,
): MonitoringConfig | null {
  const value = dsn?.trim() ?? "";
  if (!/^https:\/\/[^@\s]+@[^/\s]+\/\d+$/.test(value)) return null;
  return { dsn: value, environment: environment?.trim() || "development" };
}

/** Options both SDKs accept (Sentry JS 10 option names). */
export function monitoringOptions(config: MonitoringConfig) {
  return {
    dsn: config.dsn,
    environment: config.environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 50,
    beforeSend: <T extends object>(event: T): T => scrubTelemetryEvent(event),
    beforeBreadcrumb: <T extends object>(breadcrumb: T): T => scrubBreadcrumb(breadcrumb),
  };
}
