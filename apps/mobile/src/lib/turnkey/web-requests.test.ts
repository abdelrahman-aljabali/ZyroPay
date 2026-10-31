import { sha256 } from "@noble/hashes/sha2.js";
import { p256 } from "@noble/curves/nist.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { StamperType, WebauthnStamper } from "@turnkey/core";
import { TurnkeySDKClientBase } from "@turnkey/core/dist/__generated__/sdk-client-base";
import {
  buildDelegatedPolicyEnvelope,
  cardanoKeyHash,
  type StampedTurnkeyRequest,
} from "@zyropay/shared";
import {
  parseWebauthnStamp,
  verifyCreatePoliciesRequest,
  verifySignCardanoRequest,
  verifySignRawPayloadRequest,
  verifySignTransactionRequest,
  verifyWhoamiRequest,
} from "@zyropay/wallet";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  stampCreatePolicies,
  stampSignRawPayload,
  stampSignTransaction,
  stampWhoami,
} from "./web-requests";

/*
 * Proves that what the WEB bridge sends to the ZyroPay API is exactly what the API accepts
 * (ADR-001 D2), without a browser: @turnkey/core's own HTTP client builds the bodies and the
 * real @turnkey/webauthn-stamper (the one @turnkey/core uses in browsers) stamps them, against
 * a software WebAuthn authenticator standing in for navigator.credentials. Then
 *   1. @zyropay/wallet's verifiers (the API's checks, unchanged) accept every request:
 *      header X-Stamp-Webauthn, challenge = UTF-8 bytes of sha256hex(body);
 *   2. the assertion signature verifies over authenticatorData || sha256(clientDataJSON)
 *      with the credential's P-256 key, as Turnkey verifies it;
 *   3. changing one byte of a body is refused (STAMP_BODY_MISMATCH).
 * The real browser path (Chrome, CDP virtual authenticator, real Turnkey) is exercised by
 * scripts/web-e2e.mjs.
 */

const API = "https://api.turnkey.com";
const RP_ID = "localhost";
const ORIGIN = "http://localhost:8081";
const SUB_ORG = "4b1f8a0e-2a43-4bde-9a51-3f7a0e2c9d11";

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const ab = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** A minimal platform authenticator: one P-256 credential, user present + verified. */
const credentialSecret = p256.utils.randomSecretKey();
const credentialPublic = p256.getPublicKey(credentialSecret, false);
const credentialId = new Uint8Array(16).map((_, i) => i * 7 + 3);
const seenRpIds: string[] = [];
let counter = 0;

async function softwareGet(options: CredentialRequestOptions) {
  const pk = options.publicKey;
  if (!pk) throw new Error("expected a publicKey request");
  seenRpIds.push(pk.rpId ?? "");
  const challenge = new Uint8Array(pk.challenge as ArrayBuffer | Uint8Array as ArrayBuffer);
  const clientData = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: ORIGIN }),
  );
  counter += 1;
  const authData = new Uint8Array(37);
  authData.set(sha256(new TextEncoder().encode(pk.rpId ?? "")), 0);
  authData[32] = 0x05; // UP | UV
  new DataView(authData.buffer).setUint32(33, counter);
  const signed = new Uint8Array([...authData, ...sha256(clientData)]);
  const signature = p256.sign(signed, credentialSecret, { format: "der" });
  return Promise.resolve({
    type: "public-key",
    id: b64url(credentialId),
    rawId: ab(credentialId),
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: ab(clientData),
      authenticatorData: ab(authData),
      signature: ab(signature),
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  });
}

/** What Turnkey checks on a passkey stamp: the assertion signature over this body. */
function assertionVerifies(req: StampedTurnkeyRequest): boolean {
  const stamp = parseWebauthnStamp(req.stamp.stampHeaderValue);
  if (!stamp) return false;
  const authData = fromB64url(stamp.authenticatorData);
  const clientData = fromB64url(stamp.clientDataJson);
  const signed = new Uint8Array([...authData, ...sha256(clientData)]);
  return (
    b64url(authData.slice(0, 32)) === b64url(sha256(new TextEncoder().encode(RP_ID))) &&
    p256.verify(fromB64url(stamp.signature), signed, credentialPublic, { format: "der" })
  );
}

function http() {
  return new TurnkeySDKClientBase({
    apiBaseUrl: API,
    organizationId: SUB_ORG,
    passkeyStamper: new WebauthnStamper({ rpId: RP_ID }),
    defaultStamperType: StamperType.Passkey,
  });
}

beforeAll(() => {
  vi.stubGlobal("navigator", { credentials: { get: softwareGet } });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("web passkey stamps (@turnkey/core + @turnkey/webauthn-stamper) pass the API's checks", () => {
  it("runs on the webauthn-stamper version @zyropay/wallet's verifier documents (0.6.0)", () => {
    // stamped.ts pins the stamp format to @turnkey/webauthn-stamper 0.6.0; @turnkey/core
    // (the web bridge's SDK) must still depend on exactly that version.
    const corePkgPath = createRequire(import.meta.url).resolve("@turnkey/core/package.json");
    const corePkg = JSON.parse(readFileSync(corePkgPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    // The copy @turnkey/core itself loads (resolved from core's own directory).
    const stamperEntry = createRequire(corePkgPath).resolve("@turnkey/webauthn-stamper");
    const stamperPkg = JSON.parse(
      readFileSync(join(dirname(stamperEntry), "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(corePkg.dependencies["@turnkey/webauthn-stamper"]).toBe("0.6.0");
    expect(stamperPkg.version).toBe("0.6.0");
  });

  it("whoami (POST /v1/auth/session) stamped with the passkey", async () => {
    const req = await stampWhoami(http(), StamperType.Passkey);
    expect(req.url).toBe(`${API}/public/v1/query/whoami`);
    expect(req.stamp.stampHeaderName).toBe("X-Stamp-Webauthn");
    expect(JSON.parse(req.body)).toEqual({ organizationId: SUB_ORG });
    const check = verifyWhoamiRequest(req, API);
    expect(check).toMatchObject({
      ok: true,
      value: { stamp: { kind: "passkey", credentialId: b64url(credentialId) } },
    });
    expect(assertionVerifies(req)).toBe(true);
    expect(seenRpIds.at(-1)).toBe(RP_ID);
  });

  it("SIGN_TRANSACTION_V2 (EVM send / approval)", async () => {
    const now = Date.now();
    const unsigned = { encoding: "hex" as const, serialized: "0x02ef83014a3480843b9aca00" };
    const req = await stampSignTransaction(
      http(),
      {
        organizationId: SUB_ORG,
        signWith: "0x52908400098527886E0F7030069857D2E4169EE7",
        unsignedTransaction: unsigned,
        network: "base-sepolia",
      },
      now,
    );
    const check = verifySignTransactionRequest(req, {
      turnkeyApiBaseUrl: API,
      organizationId: SUB_ORG,
      signWith: "0x52908400098527886E0F7030069857D2E4169EE7",
      family: "evm",
      unsigned,
      now: new Date(now),
    });
    expect(check.ok).toBe(true);
    expect(assertionVerifies(req)).toBe(true);

    const tampered = { ...req, body: req.body.replace("02ef83", "02ef84") };
    expect(tampered.body).not.toBe(req.body);
    expect(
      verifySignTransactionRequest(tampered, {
        turnkeyApiBaseUrl: API,
        organizationId: SUB_ORG,
        signWith: "0x52908400098527886E0F7030069857D2E4169EE7",
        family: "evm",
        unsigned,
        now: new Date(now),
      }),
    ).toMatchObject({ ok: false, code: "STAMP_BODY_MISMATCH" });
  });

  it("SIGN_TRANSACTION_V2 (Solana, base64 message)", async () => {
    const now = Date.now();
    const unsigned = { encoding: "base64" as const, serialized: "AQIDBAUGBwgJ" };
    const signWith = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    const req = await stampSignTransaction(
      http(),
      {
        organizationId: SUB_ORG,
        signWith,
        unsignedTransaction: unsigned,
        network: "solana-devnet",
      },
      now,
    );
    expect(
      verifySignTransactionRequest(req, {
        turnkeyApiBaseUrl: API,
        organizationId: SUB_ORG,
        signWith,
        family: "solana",
        unsigned,
        now: new Date(now),
      }).ok,
    ).toBe(true);
    expect(assertionVerifies(req)).toBe(true);
  });

  it("SIGN_RAW_PAYLOAD_V2 (Cardano body hash, ADR-002)", async () => {
    const now = Date.now();
    const publicKey = Buffer.from(ed25519.getPublicKey(ed25519.utils.randomSecretKey())).toString(
      "hex",
    );
    const bodyHash = Buffer.from(sha256(new TextEncoder().encode("tx body"))).toString("hex");
    const req = await stampSignRawPayload(
      http(),
      { organizationId: SUB_ORG, signWith: publicKey, payload: bodyHash },
      now,
    );
    expect(
      verifySignCardanoRequest(req, {
        turnkeyApiBaseUrl: API,
        organizationId: SUB_ORG,
        publicKey,
        paymentKeyHash: cardanoKeyHash(publicKey),
        bodyHash,
        now: new Date(now),
      }).ok,
    ).toBe(true);
    expect(assertionVerifies(req)).toBe(true);
  });

  it("SIGN_RAW_PAYLOAD_V2 (x402 on EVM: EIP-712 digest, HASH_FUNCTION_NO_OP)", async () => {
    const now = Date.now();
    const signWith = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
    const digest = `0x${Buffer.from(sha256(new TextEncoder().encode("eip712"))).toString("hex")}`;
    const req = await stampSignRawPayload(
      http(),
      { organizationId: SUB_ORG, signWith, payload: digest, hashFunction: "HASH_FUNCTION_NO_OP" },
      now,
    );
    expect(
      verifySignRawPayloadRequest(req, {
        turnkeyApiBaseUrl: API,
        organizationId: SUB_ORG,
        signWith,
        digest,
        now: new Date(now),
      }).ok,
    ).toBe(true);
    expect(assertionVerifies(req)).toBe(true);
  });

  it("CREATE_POLICIES envelope (autonomous mode, ADR-001 D6)", async () => {
    const now = Date.now();
    const delegated = "8f0f6b9e-1c55-4f0b-9a63-2d1e5c7b4a90";
    const policies = buildDelegatedPolicyEnvelope({
      delegatedUserId: delegated,
      allowedNetworks: ["base-sepolia"],
      restrictRecipients: false,
      recipientAllowlist: [],
      perTransactionUsdMinor: "2500",
      nativeUsdPrice: { evm: "2500.00" },
    });
    const req = await stampCreatePolicies(http(), { organizationId: SUB_ORG, policies }, now);
    expect(
      verifyCreatePoliciesRequest(req, {
        turnkeyApiBaseUrl: API,
        organizationId: SUB_ORG,
        delegatedTurnkeyUserId: delegated,
        now: new Date(now),
      }).ok,
    ).toBe(true);
    expect(assertionVerifies(req)).toBe(true);
  });
});
