import { ed25519 } from "@noble/curves/ed25519.js";
import {
  CARDANO_TURNKEY_ACCOUNT,
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { generateP256ApiKeyPair } from "./crypto";
import { bytesToHex, hexToBytes } from "./encoding";
import { MockTurnkey, mockPasskeyStamp } from "./mock";
import {
  turnkeyTransactionType,
  verifySignCardanoRequest,
  verifySignTransactionRequest,
} from "./stamped";
import { TurnkeyClient } from "./turnkey-client";

const BASE = "https://api.turnkey.com";
const NOW = new Date("2026-10-30T12:00:00Z");
const RAW_URL = `${BASE}/public/v1/submit/sign_raw_payload`;
const PK = bytesToHex(ed25519.getPublicKey(hexToBytes("11".repeat(32))));
const FROM = cardanoEnterpriseAddress(PK, "cardano-preprod");
const BODY_HASH = "ab".repeat(32);

function body(params: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(NOW.getTime()),
    organizationId: "org-1",
    parameters: {
      signWith: PK,
      payload: BODY_HASH,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      ...params,
    },
    ...overrides,
  });
}

const req = (b: string, url = RAW_URL) => ({ url, body: b, stamp: mockPasskeyStamp("cred-1", b) });
const expected = {
  turnkeyApiBaseUrl: BASE,
  organizationId: "org-1",
  publicKey: PK,
  paymentKeyHash: cardanoPaymentKeyHash(FROM) ?? "",
  bodyHash: BODY_HASH,
  now: NOW,
};

describe("verifySignCardanoRequest (ADR-002)", () => {
  it("accepts a passkey stamp over exactly the body hash with the account's key", () => {
    const check = verifySignCardanoRequest(req(body()), expected);
    expect(check.ok).toBe(true);
    expect(
      verifySignCardanoRequest(req(body({ payload: `0x${BODY_HASH.toUpperCase()}` })), expected).ok,
    ).toBe(true);
  });

  it.each([
    [{ payload: "cd".repeat(32) }, {}, "PAYLOAD_MISMATCH"],
    [{ signWith: "22".repeat(32) }, {}, "SIGN_WITH_MISMATCH"],
    [{ hashFunction: "HASH_FUNCTION_NO_OP" }, {}, "BODY_MALFORMED"],
    [{ hashFunction: "HASH_FUNCTION_SHA256" }, {}, "BODY_MALFORMED"],
    [{ encoding: "PAYLOAD_ENCODING_TEXT_UTF8" }, {}, "BODY_MALFORMED"],
    [{}, { organizationId: "org-2" }, "ORGANIZATION_MISMATCH"],
    [{}, { timestampMs: String(NOW.getTime() - 10 * 60_000) }, "STAMP_STALE"],
    [{}, { type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" }, "BODY_MALFORMED"],
    [{ extra: true }, {}, "BODY_MALFORMED"],
  ])("rejects %j %j as %s", (params, overrides, code) => {
    const check = verifySignCardanoRequest(req(body(params, overrides)), expected);
    expect(check.ok ? "ok" : check.code).toBe(code);
  });

  it("requires the public key to own the sending address and a passkey stamp", () => {
    const otherAddress = cardanoEnterpriseAddress("33".repeat(32), "cardano-preprod");
    const check = verifySignCardanoRequest(req(body()), {
      ...expected,
      paymentKeyHash: cardanoPaymentKeyHash(otherAddress) ?? "",
    });
    expect(check.ok ? "ok" : check.code).toBe("SIGN_WITH_MISMATCH");
    const b = body();
    const apiKey = verifySignCardanoRequest(
      { url: RAW_URL, body: b, stamp: { stampHeaderName: "X-Stamp", stampHeaderValue: "x" } },
      expected,
    );
    expect(apiKey.ok ? "ok" : apiKey.code).toBe("STAMP_NOT_PASSKEY");
    const wrongUrl = verifySignCardanoRequest(
      req(b, `${BASE}/public/v1/submit/sign_transaction`),
      expected,
    );
    expect(wrongUrl.ok ? "ok" : wrongUrl.code).toBe("URL_NOT_ALLOWED");
  });

  it("never treats Cardano as a SIGN_TRANSACTION family", () => {
    expect(() => turnkeyTransactionType("cardano")).toThrow(/SIGN_RAW_PAYLOAD/);
    const b = JSON.stringify({});
    const check = verifySignTransactionRequest(
      req(b, `${BASE}/public/v1/submit/sign_transaction`),
      {
        turnkeyApiBaseUrl: BASE,
        organizationId: "org-1",
        signWith: FROM,
        family: "cardano",
        unsigned: { encoding: "hex", serialized: "00" },
        now: NOW,
      },
    );
    expect(check.ok ? "ok" : check.code).toBe("TRANSACTION_TYPE_MISMATCH");
  });
});

describe("TurnkeyClient and MockTurnkey (Cardano)", () => {
  it("maps compressed Ed25519 accounts at the CIP-1852 path to Cardano", async () => {
    const pair = await generateP256ApiKeyPair();
    const responses: Record<string, unknown> = {
      "/public/v1/query/list_wallets": { wallets: [{ walletId: "w1", walletName: "Main" }] },
      "/public/v1/query/list_wallet_accounts": {
        accounts: [
          {
            walletId: "w1",
            address: PK.toUpperCase(),
            addressFormat: "ADDRESS_FORMAT_COMPRESSED",
            path: CARDANO_TURNKEY_ACCOUNT.path,
            curve: "CURVE_ED25519",
            publicKey: PK,
          },
          // A compressed key at another path (another chain) is ignored.
          {
            walletId: "w1",
            address: "44".repeat(32),
            addressFormat: "ADDRESS_FORMAT_COMPRESSED",
            path: "m/44'/784'/0'/0'/0'",
            curve: "CURVE_ED25519",
          },
          {
            walletId: "w1",
            address: "So11111111111111111111111111111111111111112",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
            path: "m/44'/501'/0'/0'",
          },
        ],
      },
    };
    const c = new TurnkeyClient({
      apiBaseUrl: BASE,
      parentOrganizationId: "parent",
      parentApiPublicKey: pair.publicKey,
      parentApiPrivateKey: pair.privateKey,
      resolveDelegatedKey: () => Promise.resolve(pair),
      fetch: (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(Response.json(responses[new URL(url).pathname]));
      },
    });
    const accounts = await c.listWalletAccounts("sub-1");
    expect(accounts.map((a) => a.family)).toEqual(["cardano", "solana"]);
    expect(accounts[0]).toMatchObject({
      address: PK,
      publicKey: PK,
      derivationPath: CARDANO_TURNKEY_ACCOUNT.path,
    });
    await expect(
      c.signWithDelegatedKey({
        subOrganizationId: "sub-1",
        signWith: FROM,
        unsigned: {
          family: "cardano",
          network: "cardano-preprod",
          payloadHash: "0".repeat(64),
          encoding: "hex",
          serialized: "84a0a0f5f6",
          estimatedFee: "0",
          validUntil: null,
          simulated: false,
        },
      }),
    ).rejects.toMatchObject({ kind: "refused" });
  });

  it("MockTurnkey signs Cardano body hashes with a real Ed25519 key (r || s, no v)", async () => {
    const tk = new MockTurnkey();
    const org = tk.createSubOrg({ credentialId: "cred-ada" });
    const [account] = (await tk.listWalletAccounts(org.organizationId)).filter(
      (a) => a.family === "cardano",
    );
    expect(account?.publicKey).toBe(org.cardanoPublicKey);
    const b = JSON.stringify({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      timestampMs: String(NOW.getTime()),
      organizationId: org.organizationId,
      parameters: {
        signWith: org.cardanoPublicKey,
        payload: BODY_HASH,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      },
    });
    const sig = await tk.forwardStampedSignRawPayload({
      url: RAW_URL,
      body: b,
      stamp: mockPasskeyStamp("cred-ada", b),
    });
    expect(sig.v).toBe("");
    expect(
      ed25519.verify(
        hexToBytes(sig.r + sig.s),
        hexToBytes(BODY_HASH),
        hexToBytes(org.cardanoPublicKey),
      ),
    ).toBe(true);
    expect(cardanoKeyHash(org.cardanoPublicKey)).toMatch(/^[0-9a-f]{56}$/);
  });
});
