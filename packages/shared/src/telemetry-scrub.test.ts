import { describe, expect, it } from "vitest";
import {
  FILTERED,
  scrubBreadcrumb,
  scrubString,
  scrubTelemetryEvent,
  scrubUrl,
} from "./telemetry-scrub";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/** Valid-looking words, wrong checksum: still a phrase someone typed. */
const PHRASE_BAD_CHECKSUM =
  "legal winner thank year wave sausage worth useful legal winner thank yellow wave";
const EVM_PRIVATE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const SOLANA_SECRET =
  "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviUkauRiTMD8DrESdrNjN8zd9mTmVhRvBJeg5vhyvgrAhG";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const HELIUS_KEY = "11111111-aaaa-4aaa-8aaa-111111111111";
const SESSION = "zp_at_Q2hhbmdlIG1lIHRvIGEgcmFuZG9tIHRva2Vu";

const SECRETS = [
  "abandon",
  "sausage",
  EVM_PRIVATE_KEY.slice(2),
  SOLANA_SECRET,
  JWT,
  HELIUS_KEY,
  SESSION,
  "alice@example.com",
  "203.0.113.7",
  "hunter2",
  "cookie-value",
];

function expectClean(value: unknown): void {
  const text = JSON.stringify(value);
  for (const s of SECRETS) expect(text, `leaked ${s.slice(0, 12)}`).not.toContain(s);
}

/** A realistic Sentry event with secrets in every place they could hide. */
function dirtyEvent() {
  return {
    event_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    message: `import failed for "${PHRASE}"`,
    level: "error",
    user: { id: "u1", email: "alice@example.com", ip_address: "203.0.113.7" },
    server_name: "isolate-42",
    request: {
      url: `https://api.zyropay.example/v1/session?token=${SESSION}#frag`,
      method: "POST",
      headers: { Authorization: `Bearer ${JWT}`, Cookie: "sid=cookie-value" },
      cookies: { sid: "cookie-value" },
      query_string: `api-key=${HELIUS_KEY}`,
      data: { mnemonic: PHRASE, password: "hunter2" },
    },
    exception: {
      values: [
        {
          type: "Error",
          value: `rpc failed: https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
          stacktrace: { frames: [{ filename: "app:///entry-2f2e1996.js", lineno: 1 }] },
        },
        { type: "Error", value: `bad key ${EVM_PRIVATE_KEY} and ${SOLANA_SECRET}` },
      ],
    },
    extra: {
      privateKey: EVM_PRIVATE_KEY,
      note: `user typed ${PHRASE_BAD_CHECKSUM} into search`,
      nested: { deeper: { token: SESSION, jwt: JWT } },
      contact: "mail alice@example.com from 203.0.113.7",
    },
    contexts: { app: { app_name: "ZyroPay" } },
    breadcrumbs: [
      {
        category: "fetch",
        data: {
          url: `https://api.zyropay.example/v1/portfolio?cursor=abc&api-key=${HELIUS_KEY}`,
          method: "GET",
          status_code: 200,
          body: { seedPhrase: PHRASE },
        },
      },
      { category: "console", message: `Authorization: Bearer ${JWT}` },
    ],
    tags: { route: "/wallets/add/import" },
  };
}

describe("telemetry scrubbing", () => {
  it("removes request body, headers, cookies and query string, and the user", () => {
    const out = scrubTelemetryEvent(dirtyEvent()) as Record<string, unknown>;
    const request = out.request as Record<string, unknown>;
    expect(request.data).toBeUndefined();
    expect(request.headers).toBeUndefined();
    expect(request.cookies).toBeUndefined();
    expect(request.query_string).toBeUndefined();
    expect(request.url).toBe("https://api.zyropay.example/v1/session");
    expect(request.method).toBe("POST");
    expect(out.user).toBeUndefined();
    expect(out.server_name).toBeUndefined();
  });

  it("leaves no key material, token, e-mail or IP anywhere in the event", () => {
    const out = scrubTelemetryEvent(dirtyEvent());
    expectClean(out);
  });

  it("keeps what debugging needs", () => {
    const out = scrubTelemetryEvent(dirtyEvent());
    expect(out.event_id).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(out.level).toBe("error");
    expect(out.exception.values[0]?.type).toBe("Error");
    expect(out.exception.values[0]?.value).toContain("rpc failed: https://devnet.helius-rpc.com/");
    expect(out.exception.values[0]?.stacktrace?.frames[0]?.filename).toBe(
      "app:///entry-2f2e1996.js",
    );
    expect(out.tags.route).toBe("/wallets/add/import");
    expect(out.contexts.app.app_name).toBe("ZyroPay");
    expect(out.breadcrumbs[0]?.data?.url).toBe("https://api.zyropay.example/v1/portfolio");
    expect(out.breadcrumbs[0]?.data?.status_code).toBe(200);
  });

  it("filters credential-named keys whatever their value", () => {
    const out = scrubTelemetryEvent({
      extra: { apiKey: "x", api_key: "x", stampHeader: "x", refreshToken: "x", seed: "x" },
    }) as { extra: Record<string, unknown> };
    expect(Object.values(out.extra).every((v) => v === FILTERED)).toBe(true);
  });

  it("scrubs breadcrumbs on their own (beforeBreadcrumb)", () => {
    const b = scrubBreadcrumb({
      category: "xhr",
      data: { url: `https://x.example/a?token=${SESSION}`, request_body: PHRASE },
      message: `phrase: ${PHRASE}`,
    });
    expectClean(b);
    expect((b.data as { url: string }).url).toBe("https://x.example/a");
  });

  it("strings: phrases with or without checksum, keys, tokens", () => {
    expect(scrubString(PHRASE)).toBe(FILTERED);
    expect(scrubString(`my words: ${PHRASE_BAD_CHECKSUM}.`)).not.toContain("sausage");
    expect(scrubString("Cannot read properties of undefined (reading 'amount')")).toBe(
      "Cannot read properties of undefined (reading 'amount')",
    );
    // Ordinary English sentences are not phrases (fewer than 12 wordlist words in a row).
    expect(scrubString("The approval expired before you could open it again")).toBe(
      "The approval expired before you could open it again",
    );
    expect(scrubUrl(`https://eth-sepolia.g.alchemy.com/v2/${HELIUS_KEY}`)).not.toContain(
      HELIUS_KEY,
    );
  });
});
