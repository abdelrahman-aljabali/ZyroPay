import { describe, expect, it } from "vitest";
import { monitoringConfig, monitoringOptions } from "./monitoring-options";

const DSN = "https://0123456789abcdef@o123.ingest.de.sentry.io/4500000000000001";
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("app error monitoring", () => {
  it("is off without a (well-formed) DSN", () => {
    expect(monitoringConfig(undefined, "development")).toBeNull();
    expect(monitoringConfig("", "development")).toBeNull();
    expect(monitoringConfig("not a dsn", "development")).toBeNull();
    expect(monitoringConfig(DSN, undefined)).toEqual({ dsn: DSN, environment: "development" });
  });

  it("never sends PII or traces, and scrubs events and breadcrumbs", () => {
    const config = monitoringConfig(DSN, "production");
    if (config === null) throw new Error("expected a config");
    const o = monitoringOptions(config);
    expect(o.sendDefaultPii).toBe(false);
    expect(o.tracesSampleRate).toBe(0);
    const event = o.beforeSend({
      message: `phrase ${PHRASE}`,
      user: { id: "u", ip_address: "198.51.100.4" },
      request: {
        url: "https://app.zyropay.example/wallets/add/import?x=1",
        data: { mnemonic: PHRASE },
        headers: { cookie: "a=b" },
      },
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain("abandon");
    expect(text).not.toContain("198.51.100.4");
    expect(text).not.toContain("x=1");
    expect(text).not.toContain("cookie");
    const crumb = o.beforeBreadcrumb({
      category: "fetch",
      data: { url: "https://api.zyropay.example/v1/session?token=zp_rt_abcdefghijklmnop" },
    });
    expect(JSON.stringify(crumb)).not.toContain("zp_rt_");
  });
});
