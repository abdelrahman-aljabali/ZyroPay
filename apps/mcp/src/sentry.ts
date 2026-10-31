import type { CloudflareOptions } from "@sentry/cloudflare";
import { scrubBreadcrumb, scrubTelemetryEvent } from "@zyropay/shared";

/*
 * Error monitoring for the MCP worker (docs/MONITORING.md; same options as apps/api). Off unless a DSN is configured: no DSN, no SDK
 * traffic. Every event and breadcrumb goes through the shared scrubber (no request bodies,
 * headers, cookies, query strings, users, key material, tokens, e-mails or IPs), PII
 * collection is off and no performance traces are sent.
 */

export interface SentryEnv {
  readonly SENTRY_ENVIRONMENT?: string;
  readonly SENTRY_RELEASE?: string;
  readonly ZYROPAY_MODE?: string;
}

/** Sentry options for a worker; `dsn` is that worker's DSN variable (may be unset). */
export function sentryOptions(
  dsn: string | undefined,
  env: SentryEnv,
  /** Tests only: e.g. a capturing `transport`. */
  overrides: Partial<CloudflareOptions> = {},
): CloudflareOptions {
  const value = dsn?.trim() ?? "";
  return {
    ...(value !== "" ? { dsn: value } : {}),
    enabled: value !== "",
    environment: env.SENTRY_ENVIRONMENT ?? env.ZYROPAY_MODE ?? "development",
    ...(env.SENTRY_RELEASE ? { release: env.SENTRY_RELEASE } : {}),
    // Sentry 11: collect no user info, cookies, headers, query params, bodies, queue
    // payloads or local variables (the scrubber below also drops any that slip through).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
    },
    tracesSampleRate: 0,
    beforeSend: (event) => scrubTelemetryEvent(event),
    beforeSendTransaction: (event) => scrubTelemetryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    ...overrides,
  };
}
