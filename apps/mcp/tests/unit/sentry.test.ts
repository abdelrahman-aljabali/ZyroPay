import * as Sentry from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";
import { sentryOptions } from "../../src/sentry";

const TOKEN = "zp_at_bWNwLWFjY2Vzcy10b2tlbi1mb3ItdGVzdHM";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudCJ9.Kxq6qD1l8n0sWJ0zN5fHk2cY6m1rQ7a2Z9pT3vU4wXy";

describe("Sentry in the MCP worker", () => {
  it("scrubs the OAuth bearer, query string and body from a captured failure", async () => {
    const envelopes: string[] = [];
    const worker = Sentry.withSentry(
      () =>
        sentryOptions(
          "https://publickey@o0.ingest.sentry.io/2",
          { ZYROPAY_MODE: "development" },
          {
            transport: (options) =>
              Sentry.createTransport(options, (request) => {
                const body = request.body;
                envelopes.push(typeof body === "string" ? body : new TextDecoder().decode(body));
                return Promise.resolve({ statusCode: 200 });
              }),
          },
        ),
      {
        fetch(_request: Request, _env: unknown, _ctx: ExecutionContext) {
          throw new Error(`tool call failed for Bearer ${JWT} (session ${TOKEN})`);
        },
      } satisfies ExportedHandler,
    );
    const request = new Request(`https://mcp.zyropay.example/mcp?code=${TOKEN}`, {
      method: "POST",
      headers: { authorization: `Bearer ${JWT}` },
      body: JSON.stringify({ params: { arguments: { to: "x" } } }),
    });
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    await expect(worker.fetch(request as never, {}, ctx)).rejects.toThrow();
    await Sentry.flush(2000);
    const sent = envelopes.join("\n");
    expect(sent).toContain("tool call failed");
    expect(sent).not.toContain(JWT);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toMatch(/"authorization"/i);
  });

  it("is disabled without SENTRY_DSN_MCP", () => {
    expect(sentryOptions(undefined, {}).enabled).toBe(false);
    expect(sentryOptions("", {}).dsn).toBeUndefined();
  });
});
