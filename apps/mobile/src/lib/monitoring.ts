import type * as SentryNative from "@sentry/react-native";
import { monitoringConfig, monitoringOptions } from "./monitoring-options";

/*
 * Native error monitoring (@sentry/react-native). Web: monitoring.web.ts.
 *
 * The SDK is required only when a DSN is configured, so builds without monitoring never
 * touch it (and Expo Go never hits a missing native module).
 */
let started = false;

export function initMonitoring(): void {
  if (started) return;
  started = true;
  const config = monitoringConfig();
  if (config === null) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/react-native") as typeof SentryNative;
    Sentry.init({
      ...monitoringOptions(config),
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableCaptureFailedRequests: false,
    });
  } catch {
    // Monitoring must never take the app down.
  }
}
