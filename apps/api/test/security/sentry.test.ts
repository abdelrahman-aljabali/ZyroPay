/*
 * Error monitoring: what actually leaves the worker. A real @sentry/cloudflare client with a
 * capturing transport (no network) wraps a handler that fails with secrets everywhere.
 */
import * as Sentry from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";
import { sentryOptions } from "../../src/lib/sentry";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const SESSION = "zp_at_c2Vzc2lvbi10b2tlbi1mb3ItdGVzdHM";
const PRIVATE_KEY = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const DSN = "https://publickey@o0.ingest.sentry.io/1";

function capture() {
  const envelopes: string[] = [];
  const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
    Sentry.createTransport(options, (request) => {
      const body = request.body;
      envelopes.push(typeof body === "string" ? body : new TextDecoder().decode(body));
      return Promise.resolve({ statusCode: 200 });
    });
  return { envelopes, transport };
}

const ctx = (): ExecutionContext =>
  ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  }) as unknown as ExecutionContext;

function dirtyRequest(): Request {
  return new Request(`https://api.zyropay.example/v1/wallets/import?token=${SESSION}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${JWT}`,
      cookie: `sid=${SESSION}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ mnemonic: PHRASE, privateKey: PRIVATE_KEY }),
  });
}

describe("Sentry in the API worker", () => {
  it("sends an event for an unhandled error, with every secret scrubbed", async () => {
    const { envelopes, transport } = capture();
    const worker = Sentry.withSentry(
      () => sentryOptions(DSN, { ZYROPAY_MODE: "development" }, { transport }),
      {
        fetch(_request: Request, _env: unknown, _ctx: ExecutionContext) {
          throw new Error(`import failed: ${PHRASE} key=${PRIVATE_KEY} auth=Bearer ${JWT}`);
        },
      } satisfies ExportedHandler,
    );
    await expect(worker.fetch(dirtyRequest() as never, {}, ctx())).rejects.toThrow();
    await Sentry.flush(2000);
    const sent = envelopes.join("\n");
    expect(sent).toContain('"type":"event"');
    expect(sent).toContain("import failed");
    for (const secret of [PHRASE, "abandon", PRIVATE_KEY, JWT, SESSION, "sid="]) {
      expect(sent, `leaked ${secret.slice(0, 12)}`).not.toContain(secret);
    }
    expect(sent).not.toMatch(/"authorization"|"cookie"/i);
    expect(sent).not.toContain("token=");
  });

  it("is off without a DSN: nothing is sent", async () => {
    const { envelopes, transport } = capture();
    const worker = Sentry.withSentry(() => sentryOptions(undefined, {}, { transport }), {
      fetch(_request: Request, _env: unknown, _ctx: ExecutionContext) {
        throw new Error("boom");
      },
    } satisfies ExportedHandler);
    await expect(worker.fetch(dirtyRequest() as never, {}, ctx())).rejects.toThrow("boom");
    await Sentry.flush(500);
    expect(envelopes).toEqual([]);
  });

  it("options: environment from the mode, no traces, no data collection", () => {
    const o = sentryOptions(" ", { ZYROPAY_MODE: "production" });
    expect(o.enabled).toBe(false);
    expect(o.dsn).toBeUndefined();
    expect(o.environment).toBe("production");
    expect(o.tracesSampleRate).toBe(0);
    expect(o.dataCollection).toMatchObject({ userInfo: false, httpBodies: [], cookies: false });
  });
});
