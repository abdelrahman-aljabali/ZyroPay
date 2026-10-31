import { monitoringConfig, monitoringOptions } from "./monitoring-options";

/*
 * Web error monitoring (@sentry/react). Loaded with a dynamic import only when a DSN is
 * configured, so the first-load bundle does not carry the SDK. Errors thrown before the
 * chunk has loaded (the first few hundred ms) are not reported.
 *
 * The web host's Content-Security-Policy must allow the DSN's ingest origin in connect-src
 * (docs/MONITORING.md).
 */
let started = false;

export function initMonitoring(): void {
  if (started) return;
  started = true;
  const config = monitoringConfig();
  if (config === null) return;
  void import("@sentry/react")
    .then((Sentry) => {
      Sentry.init({
        ...monitoringOptions(config),
        // Breadcrumbs keep console and navigation; fetch/XHR URLs are scrubbed to origin+path.
        integrations: (defaults) => defaults.filter((i) => i.name !== "BrowserSession"),
      });
    })
    .catch(() => undefined);
}
