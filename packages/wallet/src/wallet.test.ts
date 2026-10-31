import { describe, expect, it } from "vitest";
import { IMPORTED_KEY_DERIVATION_PATH } from "@zyropay/shared";
import { decryptSecret, encryptSecret, generateP256ApiKeyPair } from "./crypto";
import { bytesToHex } from "./encoding";
import { MockTurnkey, mockPasskeyStamp } from "./mock";
import {
  consensusIsOnlyUser,
  verifyCreatePoliciesRequest,
  verifySignRawPayloadRequest,
  verifySignTransactionRequest,
  verifyWhoamiRequest,
} from "./stamped";
import { TurnkeyClient, TurnkeyError } from "./turnkey-client";

const KEK = Buffer.alloc(32, 7).toString("base64");
const BASE = "https://api.turnkey.com";
const NOW = new Date("2026-10-30T12:00:00Z");

describe("delegated key crypto", () => {
  it("generates Turnkey-format P-256 keys", async () => {
    const pair = await generateP256ApiKeyPair();
    expect(pair.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(pair.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AES-256-GCM round-trips, is randomized, owner-bound and tamper-evident", async () => {
    const a = await encryptSecret("secret", KEK, "user-1");
    const b = await encryptSecret("secret", KEK, "user-1");
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEK, "user-1")).toBe("secret");
    await expect(decryptSecret(a, KEK, "user-2")).rejects.toThrow();
    const raw = Buffer.from(a, "base64");
    raw.writeUInt8((raw.at(-1) ?? 0) ^ 1, raw.length - 1);
    await expect(decryptSecret(raw.toString("base64"), KEK, "user-1")).rejects.toThrow();
    await expect(encryptSecret("x", Buffer.alloc(16).toString("base64"), "u")).rejects.toThrow(
      /32 bytes/,
    );
  });
});

function signBody(overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    timestampMs: String(NOW.getTime()),
    organizationId: "org-1",
    parameters: {
      signWith: "0x52908400098527886E0F7030069857D2E4169EE7",
      unsignedTransaction: "0xdeadbeef",
      type: "TRANSACTION_TYPE_ETHEREUM",
      ...params,
    },
    ...overrides,
  });
}

const expected = {
  turnkeyApiBaseUrl: BASE,
  organizationId: "org-1",
  signWith: "0x52908400098527886e0f7030069857d2e4169ee7",
  family: "evm" as const,
  unsigned: { encoding: "hex" as const, serialized: "0xDEADBEEF" },
  now: NOW,
};

function req(body: string, url = `${BASE}/public/v1/submit/sign_transaction`) {
  return { url, body, stamp: mockPasskeyStamp("cred", body) };
}

describe("verifySignTransactionRequest (ADR-001 D2)", () => {
  it("accepts the exact reviewed transaction (byte equality, case-insensitive EVM signWith)", () => {
    expect(verifySignTransactionRequest(req(signBody()), expected).ok).toBe(true);
  });

  it.each([
    [
      "URL_NOT_ALLOWED",
      req(signBody(), "https://api.turnkey.com/public/v1/submit/sign_raw_payload"),
    ],
    [
      "URL_NOT_ALLOWED",
      req(signBody(), "https://api.turnkey.com/public/v1/submit/sign_transaction?x=1"),
    ],
    ["ORGANIZATION_MISMATCH", req(signBody({ organizationId: "org-2" }))],
    [
      "SIGN_WITH_MISMATCH",
      req(signBody({}, { signWith: "0x0000000000000000000000000000000000000001" })),
    ],
    ["TRANSACTION_TYPE_MISMATCH", req(signBody({}, { type: "TRANSACTION_TYPE_SOLANA" }))],
    ["UNSIGNED_TRANSACTION_MISMATCH", req(signBody({}, { unsignedTransaction: "0xdeadbeee" }))],
    ["STAMP_STALE", req(signBody({ timestampMs: String(NOW.getTime() - 6 * 60_000) }))],
    ["STAMP_STALE", req(signBody({ timestampMs: String(NOW.getTime() + 5 * 60_000) }))],
    ["BODY_MALFORMED", req(signBody({ extra: true }))],
    ["BODY_MALFORMED", req(signBody({ type: "ACTIVITY_TYPE_SIGN_TRANSACTION" }))],
  ])("rejects %s", (code, request) => {
    const result = verifySignTransactionRequest(request, expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("rejects API-key stamps and stamps over a different body", () => {
    const body = signBody();
    const apiKey = verifySignTransactionRequest(
      {
        url: `${BASE}/public/v1/submit/sign_transaction`,
        body,
        stamp: { stampHeaderName: "X-Stamp", stampHeaderValue: "x" },
      },
      expected,
    );
    expect(apiKey.ok ? null : apiKey.code).toBe("STAMP_NOT_PASSKEY");
    const other = verifySignTransactionRequest(
      {
        url: `${BASE}/public/v1/submit/sign_transaction`,
        body,
        stamp: mockPasskeyStamp("cred", `${body} `),
      },
      expected,
    );
    expect(other.ok ? null : other.code).toBe("STAMP_BODY_MISMATCH");
  });

  it("compares base64-stored Solana transactions by bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const body = signBody(
      {},
      {
        signWith: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        unsignedTransaction: bytesToHex(bytes),
        type: "TRANSACTION_TYPE_SOLANA",
      },
    );
    const result = verifySignTransactionRequest(req(body), {
      ...expected,
      family: "solana",
      signWith: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      unsigned: { encoding: "base64", serialized: Buffer.from(bytes).toString("base64") },
    });
    expect(result.ok).toBe(true);
  });
});

const DIGEST = `0x${"ab".repeat(32)}`;
const RAW_URL = `${BASE}/public/v1/submit/sign_raw_payload`;

function rawBody(overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(NOW.getTime()),
    organizationId: "org-1",
    parameters: {
      signWith: "0x52908400098527886E0F7030069857D2E4169EE7",
      payload: DIGEST,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
      ...params,
    },
    ...overrides,
  });
}

const expectedRaw = {
  turnkeyApiBaseUrl: BASE,
  organizationId: "org-1",
  signWith: "0x52908400098527886e0f7030069857d2e4169ee7",
  digest: DIGEST,
  now: NOW,
};

describe("verifySignRawPayloadRequest (typed data, x402 on EVM)", () => {
  it("accepts a passkey stamp over exactly the reviewed digest (0x optional)", () => {
    expect(verifySignRawPayloadRequest(req(rawBody(), RAW_URL), expectedRaw).ok).toBe(true);
    const noPrefix = rawBody({}, { payload: "AB".repeat(32) });
    expect(verifySignRawPayloadRequest(req(noPrefix, RAW_URL), expectedRaw).ok).toBe(true);
  });

  it.each([
    ["URL_NOT_ALLOWED", req(rawBody(), `${BASE}/public/v1/submit/sign_transaction`)],
    ["PAYLOAD_MISMATCH", req(rawBody({}, { payload: `0x${"cd".repeat(32)}` }), RAW_URL)],
    ["PAYLOAD_MISMATCH", req(rawBody({}, { payload: `0x${"ab".repeat(31)}` }), RAW_URL)],
    ["BODY_MALFORMED", req(rawBody({}, { hashFunction: "HASH_FUNCTION_KECCAK256" }), RAW_URL)],
    ["BODY_MALFORMED", req(rawBody({}, { encoding: "PAYLOAD_ENCODING_EIP712" }), RAW_URL)],
    ["BODY_MALFORMED", req(rawBody({ type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" }), RAW_URL)],
    ["BODY_MALFORMED", req(rawBody({ extra: 1 }), RAW_URL)],
    ["ORGANIZATION_MISMATCH", req(rawBody({ organizationId: "org-2" }), RAW_URL)],
    [
      "SIGN_WITH_MISMATCH",
      req(rawBody({}, { signWith: "0x0000000000000000000000000000000000000001" }), RAW_URL),
    ],
    ["STAMP_STALE", req(rawBody({ timestampMs: String(NOW.getTime() - 10 * 60_000) }), RAW_URL)],
  ])("rejects %s", (code, request) => {
    const result = verifySignRawPayloadRequest(request, expectedRaw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("requires a passkey stamp", () => {
    const body = rawBody();
    const apiKey = {
      url: RAW_URL,
      body,
      stamp: { stampHeaderName: "X-Stamp" as const, stampHeaderValue: "{}" },
    };
    const result = verifySignRawPayloadRequest(apiKey, expectedRaw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("STAMP_NOT_PASSKEY");
  });
});

describe("whoami and policy checks", () => {
  it("whoami: strict body, Turnkey URL only", () => {
    const body = JSON.stringify({ organizationId: "org-1" });
    expect(
      verifyWhoamiRequest(
        { url: `${BASE}/public/v1/query/whoami`, body, stamp: mockPasskeyStamp("c", body) },
        BASE,
      ).ok,
    ).toBe(true);
    const extra = JSON.stringify({ organizationId: "org-1", x: 1 });
    expect(
      verifyWhoamiRequest(
        { url: `${BASE}/public/v1/query/whoami`, body: extra, stamp: mockPasskeyStamp("c", extra) },
        BASE,
      ).ok,
    ).toBe(false);
    expect(
      verifyWhoamiRequest(
        {
          url: "http://api.turnkey.com/public/v1/query/whoami",
          body,
          stamp: mockPasskeyStamp("c", body),
        },
        BASE,
      ).ok,
    ).toBe(false);
  });

  it("policy envelope must bind ALLOW policies to the delegated user only", () => {
    expect(consensusIsOnlyUser("approvers.any(u, u.id == 'abc')", "abc")).toBe(true);
    expect(consensusIsOnlyUser("approvers.any(u, u.id == 'abc') || true", "abc")).toBe(false);
    expect(consensusIsOnlyUser("approvers.any(u, v.id == 'abc')", "abc")).toBe(false);
    const body = JSON.stringify({
      type: "ACTIVITY_TYPE_CREATE_POLICIES",
      timestampMs: String(NOW.getTime()),
      organizationId: "org-1",
      parameters: {
        policies: [
          {
            policyName: "p",
            effect: "EFFECT_ALLOW",
            consensus: "approvers.any(u, u.id == 'someone-else')",
            condition: "true",
            notes: "",
          },
        ],
      },
    });
    const res = verifyCreatePoliciesRequest(
      { url: `${BASE}/public/v1/submit/create_policies`, body, stamp: mockPasskeyStamp("c", body) },
      { turnkeyApiBaseUrl: BASE, organizationId: "org-1", delegatedTurnkeyUserId: "abc", now: NOW },
    );
    expect(res.ok).toBe(false);
  });
});

describe("TurnkeyClient (fetch mocked)", () => {
  const pairPromise = generateP256ApiKeyPair();

  async function client(
    responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    const pair = await pairPromise;
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const c = new TurnkeyClient({
      apiBaseUrl: BASE,
      parentOrganizationId: "parent",
      parentApiPublicKey: pair.publicKey,
      parentApiPrivateKey: pair.privateKey,
      resolveDelegatedKey: () => Promise.resolve(pair),
      now: () => NOW,
      fetch: (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        });
        return Promise.resolve(responder(url, init ?? {}));
      },
    });
    return { c, calls };
  }

  it("forwards the stamped body byte-for-byte with the passkey header", async () => {
    const body = signBody();
    const { c, calls } = await client(() =>
      Response.json({
        activity: {
          id: "act-1",
          organizationId: "org-1",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
          result: { signTransactionResult: { signedTransaction: "abcd" } },
        },
      }),
    );
    const signed = await c.forwardStampedSignRequest(req(body));
    expect(signed).toEqual({
      signedTransaction: "abcd",
      encoding: "hex",
      activityId: "act-1",
      simulated: false,
    });
    expect(calls[0]?.body).toBe(body);
    expect(calls[0]?.headers["X-Stamp-Webauthn"]).toBeDefined();
  });

  it("never follows redirects, with a mode Cloudflare Workers accepts", async () => {
    // Workers throw on redirect: "error"; "manual" + refusing 3xx keeps the stamped body
    // from ever being replayed to another host.
    const seen: (RequestRedirect | undefined)[] = [];
    const { c } = await client((_url, init) => {
      seen.push(init.redirect);
      return new Response(null, { status: 307, headers: { Location: "https://evil.example/" } });
    });
    await expect(c.forwardStampedSignRequest(req(signBody()))).rejects.toMatchObject({
      kind: "http",
      status: 307,
    });
    expect(seen).toEqual(["manual"]);
  });

  it("fails closed on non-completed activities, HTTP errors and foreign URLs", async () => {
    const { c } = await client(() =>
      Response.json({
        activity: {
          id: "a",
          organizationId: "o",
          status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
          type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        },
      }),
    );
    await expect(c.forwardStampedSignRequest(req(signBody()))).rejects.toBeInstanceOf(TurnkeyError);
    const { c: c2 } = await client(() => new Response("nope", { status: 401 }));
    await expect(c2.forwardStampedSignRequest(req(signBody()))).rejects.toMatchObject({
      kind: "http",
      status: 401,
    });
    await expect(
      c2.forwardStampedSignRequest(
        req(signBody(), "https://evil.example/public/v1/submit/sign_transaction"),
      ),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(
      c2.forwardStampedQuery(req(signBody(), `${BASE}/public/v1/submit/sign_transaction`)),
    ).rejects.toMatchObject({ kind: "refused" });
  });

  it("forwards a stamped SIGN_RAW_PAYLOAD_V2 and normalizes r/s/v", async () => {
    const body = rawBody();
    const { c, calls } = await client(() =>
      Response.json({
        activity: {
          id: "act-raw",
          organizationId: "org-1",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
          result: { signRawPayloadResult: { r: "0xAB", s: "cd", v: "01" } },
        },
      }),
    );
    const sig = await c.forwardStampedSignRawPayload(req(body, RAW_URL));
    expect(sig).toEqual({
      r: "ab".padStart(64, "0"),
      s: "cd".padStart(64, "0"),
      v: "01",
      activityId: "act-raw",
      simulated: false,
    });
    expect(calls[0]?.url).toBe(RAW_URL);
    expect(calls[0]?.body).toBe(body);
    await expect(
      c.forwardStampedSignRawPayload(req(body, `${BASE}/public/v1/submit/sign_transaction`)),
    ).rejects.toMatchObject({ kind: "refused" });
    const { c: wrongType } = await client(() =>
      Response.json({
        activity: {
          id: "x",
          organizationId: "org-1",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
          result: { signTransactionResult: { signedTransaction: "ab" } },
        },
      }),
    );
    await expect(wrongType.forwardStampedSignRawPayload(req(body, RAW_URL))).rejects.toMatchObject({
      kind: "response",
    });
  });

  it("stamps parent-org reads with the API key and parses the root quorum", async () => {
    const { c, calls } = await client(() =>
      Response.json({ configs: { quorum: { threshold: 1, userIds: ["u1"] } } }),
    );
    expect(await c.getRootQuorum("sub-1")).toEqual({ threshold: 1, userIds: ["u1"] });
    expect(calls[0]?.url).toBe(`${BASE}/public/v1/query/get_organization_configs`);
    expect(JSON.parse(calls[0]!.body)).toEqual({ organizationId: "sub-1" });
    expect(calls[0]?.headers["X-Stamp"]).toBeDefined();
  });

  it("lists imported private keys as Solana/EVM accounts (ADR-003), skipping other formats", async () => {
    const { c, calls } = await client(() =>
      Response.json({
        privateKeys: [
          {
            privateKeyId: "pk-evm",
            privateKeyName: "Old MetaMask key",
            addresses: [
              {
                format: "ADDRESS_FORMAT_ETHEREUM",
                address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              },
              { format: "ADDRESS_FORMAT_UNCOMPRESSED", address: "04ab" },
            ],
          },
          {
            privateKeyId: "pk-sol",
            privateKeyName: "Phantom key",
            addresses: [
              {
                format: "ADDRESS_FORMAT_SOLANA",
                address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
              },
            ],
          },
          {
            privateKeyId: "pk-btc",
            privateKeyName: "btc",
            addresses: [{ format: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH", address: "bc1q" }],
          },
        ],
      }),
    );
    const accounts = await c.listPrivateKeyAccounts("sub-1");
    expect(calls[0]?.url).toBe(`${BASE}/public/v1/query/list_private_keys`);
    expect(JSON.parse(calls[0]!.body)).toEqual({ organizationId: "sub-1" });
    expect(accounts).toEqual([
      {
        turnkeyWalletId: "pk-evm",
        walletName: "Old MetaMask key",
        family: "evm",
        address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        derivationPath: IMPORTED_KEY_DERIVATION_PATH,
      },
      {
        turnkeyWalletId: "pk-sol",
        walletName: "Phantom key",
        family: "solana",
        address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        derivationPath: IMPORTED_KEY_DERIVATION_PATH,
      },
    ]);
  });

  it("fails closed on a malformed list_private_keys response", async () => {
    const { c } = await client(() => Response.json({ privateKeys: [{ privateKeyId: 1 }] }));
    await expect(c.listPrivateKeyAccounts("sub-1")).rejects.toMatchObject({ kind: "response" });
  });

  it("delegated signing builds a SIGN_TRANSACTION_V2 body for the sub-org, hex-encoded", async () => {
    const { c, calls } = await client(() =>
      Response.json({
        activity: {
          id: "act-2",
          organizationId: "sub-1",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
          result: { signTransactionResult: { signedTransaction: "ff" } },
        },
      }),
    );
    await c.signWithDelegatedKey({
      subOrganizationId: "sub-1",
      signWith: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      unsigned: {
        family: "solana",
        network: "solana-devnet",
        payloadHash: "0".repeat(64),
        encoding: "base64",
        serialized: Buffer.from([1, 2]).toString("base64"),
        estimatedFee: "5000",
        validUntil: null,
        simulated: false,
      },
    });
    const sent = JSON.parse(calls[0]!.body) as unknown;
    expect(sent).toMatchObject({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      organizationId: "sub-1",
      parameters: { unsignedTransaction: "0102", type: "TRANSACTION_TYPE_SOLANA" },
    });
  });
});

describe("MockTurnkey.importPrivateKey (ADR-003)", () => {
  it("adds one imported-key account to that sub-org only, never to the wallet list", async () => {
    const tk = new MockTurnkey();
    const a = tk.createSubOrg({ credentialId: "cred-a" });
    const b = tk.createSubOrg({ credentialId: "cred-b" });
    const key = tk.importPrivateKey(a.organizationId, { family: "evm", name: "Old key" });
    expect(await tk.listPrivateKeyAccounts(a.organizationId)).toEqual([
      {
        turnkeyWalletId: key.privateKeyId,
        walletName: "Old key",
        family: "evm",
        address: key.address,
        derivationPath: IMPORTED_KEY_DERIVATION_PATH,
      },
    ]);
    expect(await tk.listPrivateKeyAccounts(b.organizationId)).toEqual([]);
    const wallets = await tk.listWalletAccounts(a.organizationId);
    expect(wallets.some((w) => w.turnkeyWalletId === key.privateKeyId)).toBe(false);
  });
});

describe("MockTurnkey.createWallet (passkey-created wallet in a sub-org)", () => {
  it("adds accounts for the requested families to that sub-org only", async () => {
    const tk = new MockTurnkey();
    const a = tk.createSubOrg({ credentialId: "cred-a" });
    const b = tk.createSubOrg({ credentialId: "cred-b" });
    const both = tk.createWallet(a.organizationId, { name: "Savings" });
    expect(both.solana).not.toBeNull();
    expect(both.evm).not.toBeNull();
    const solOnly = tk.createWallet(a.organizationId, { families: ["solana"] });
    expect(solOnly.evm).toBeNull();
    expect(solOnly.turnkeyWalletId).not.toBe(both.turnkeyWalletId);

    const accountsA = await tk.listWalletAccounts(a.organizationId);
    const ofBoth = accountsA.filter((x) => x.turnkeyWalletId === both.turnkeyWalletId);
    expect(ofBoth.map((x) => x.family)).toEqual(["solana", "evm"]);
    expect(ofBoth.map((x) => x.walletName)).toEqual(["Savings", "Savings"]);
    expect(
      accountsA.filter((x) => x.turnkeyWalletId === solOnly.turnkeyWalletId).map((x) => x.family),
    ).toEqual(["solana"]);
    const accountsB = await tk.listWalletAccounts(b.organizationId);
    expect(accountsB.some((x) => x.turnkeyWalletId === both.turnkeyWalletId)).toBe(false);
  });

  it("refuses an unknown sub-org", () => {
    expect(() => new MockTurnkey().createWallet("mock-org-missing")).toThrow(TurnkeyError);
  });
});
