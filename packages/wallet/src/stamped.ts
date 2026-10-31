/*
 * Checks on passkey-stamped Turnkey requests BEFORE the API forwards them (ADR-001 D2).
 *
 * The stamp covers the exact body, so the API cannot alter it; these checks make sure the
 * body is exactly what the user reviewed. Every check fails closed: anything unexpected,
 * including fields we do not know, is rejected.
 *
 * Request shapes follow @turnkey/sdk-server 8.6.0 type definitions
 * (`TurnkeyApiTypes["v1SignTransactionRequest"]`, `["v1GetWhoamiRequest"]`) and the
 * stamp format of @turnkey/webauthn-stamper 0.6.0 (header `X-Stamp-Webauthn`, value =
 * JSON {authenticatorData, clientDataJson, credentialId, signature}; the WebAuthn
 * challenge is the UTF-8 bytes of sha256hex(body)).
 */
import type { TurnkeyApiTypes } from "@turnkey/sdk-server";
import type { ChainFamily, StampedTurnkeyRequest } from "@zyropay/shared";
import { addressesEqual, cardanoKeyHash, sha256Hex } from "@zyropay/shared";
import { z } from "zod";
import { base64UrlToBytes, bytesEqual, decodeTransaction, hexToBytes, isHex } from "./encoding";

export const TURNKEY_PATHS = {
  whoami: "/public/v1/query/whoami",
  getOrganizationConfigs: "/public/v1/query/get_organization_configs",
  listUsers: "/public/v1/query/list_users",
  listPolicies: "/public/v1/query/list_policies",
  listWallets: "/public/v1/query/list_wallets",
  listWalletAccounts: "/public/v1/query/list_wallet_accounts",
  listPrivateKeys: "/public/v1/query/list_private_keys",
  getActivity: "/public/v1/query/get_activity",
  signTransaction: "/public/v1/submit/sign_transaction",
  signRawPayload: "/public/v1/submit/sign_raw_payload",
  createPolicies: "/public/v1/submit/create_policies",
} as const;

export const WEBAUTHN_STAMP_HEADER = "X-Stamp-Webauthn";
export const API_KEY_STAMP_HEADER = "X-Stamp";

/** Freshness window for approval stamps. Turnkey allows 1 hour; the ADR uses 5 minutes. */
export const DEFAULT_MAX_STAMP_AGE_MS = 5 * 60_000;
/** Tolerated clock skew for stamps dated in the future. */
const MAX_FUTURE_SKEW_MS = 60_000;

export type StampCheckCode =
  | "STAMP_NOT_PASSKEY"
  | "STAMP_MALFORMED"
  | "STAMP_BODY_MISMATCH"
  | "URL_NOT_ALLOWED"
  | "BODY_MALFORMED"
  | "ORGANIZATION_MISMATCH"
  | "SIGN_WITH_MISMATCH"
  | "TRANSACTION_TYPE_MISMATCH"
  | "UNSIGNED_TRANSACTION_MISMATCH"
  | "PAYLOAD_MISMATCH"
  | "STAMP_STALE";

export type StampCheck<T> =
  { ok: true; value: T } | { ok: false; code: StampCheckCode; reason: string };

function fail<T>(code: StampCheckCode, reason: string): StampCheck<T> {
  return { ok: false, code, reason };
}

/** The URL must be exactly `<turnkey base><path>`: same origin, no query, no fragment. */
export function isTurnkeyUrl(url: string, baseUrl: string, path: string): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.origin !== base.origin) return false;
  if (
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return false;
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  return parsed.pathname === `${basePath}${path}`;
}

const WebauthnStampSchema = z.object({
  authenticatorData: z.string().min(1),
  clientDataJson: z.string().min(1),
  credentialId: z.string().min(1).max(1024),
  signature: z.string().min(1),
});
export type WebauthnStamp = z.infer<typeof WebauthnStampSchema>;

export function parseWebauthnStamp(headerValue: string): WebauthnStamp | null {
  try {
    const parsed = WebauthnStampSchema.safeParse(JSON.parse(headerValue));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * True when the passkey assertion's challenge is sha256hex(body): i.e. the passkey signed
 * exactly this body. (Turnkey verifies the signature itself; this is an independent check
 * that the body we inspected is the one that was signed.)
 */
export function webauthnStampCoversBody(stamp: WebauthnStamp, body: string): boolean {
  try {
    const clientData = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(stamp.clientDataJson)),
    ) as unknown;
    if (typeof clientData !== "object" || clientData === null) return false;
    const { type, challenge } = clientData as { type?: unknown; challenge?: unknown };
    if (type !== "webauthn.get" || typeof challenge !== "string") return false;
    const signed = new TextDecoder().decode(base64UrlToBytes(challenge));
    return signed === sha256Hex(body);
  } catch {
    return false;
  }
}

export interface StampIdentity {
  readonly kind: "passkey" | "api_key";
  /** WebAuthn credential id for passkey stamps; null for API-key (session) stamps. */
  readonly credentialId: string | null;
}

function checkStamp(
  request: StampedTurnkeyRequest,
  requirePasskey: boolean,
): StampCheck<StampIdentity> {
  const { stampHeaderName, stampHeaderValue } = request.stamp;
  if (stampHeaderName === WEBAUTHN_STAMP_HEADER) {
    const stamp = parseWebauthnStamp(stampHeaderValue);
    if (stamp === null) return fail("STAMP_MALFORMED", "passkey stamp is not well-formed");
    if (!webauthnStampCoversBody(stamp, request.body)) {
      return fail("STAMP_BODY_MISMATCH", "passkey stamp does not cover this body");
    }
    return { ok: true, value: { kind: "passkey", credentialId: stamp.credentialId } };
  }
  if (requirePasskey) return fail("STAMP_NOT_PASSKEY", "a passkey stamp is required");
  return { ok: true, value: { kind: "api_key", credentialId: null } };
}

const WhoamiBodySchema = z.strictObject({ organizationId: z.string().min(1).max(128) });
export type WhoamiBody = TurnkeyApiTypes["v1GetWhoamiRequest"];

/** Login: a stamped `get_whoami` query (passkey or device session key, ADR-001 D2). */
export function verifyWhoamiRequest(
  request: StampedTurnkeyRequest,
  turnkeyApiBaseUrl: string,
): StampCheck<{ body: WhoamiBody; stamp: StampIdentity }> {
  if (!isTurnkeyUrl(request.url, turnkeyApiBaseUrl, TURNKEY_PATHS.whoami)) {
    return fail("URL_NOT_ALLOWED", "not a Turnkey whoami URL");
  }
  const body = parseJson(request.body, WhoamiBodySchema);
  if (body === null) return fail("BODY_MALFORMED", "whoami body is malformed");
  const stamp = checkStamp(request, false);
  if (!stamp.ok) return stamp;
  return { ok: true, value: { body, stamp: stamp.value } };
}

const SignTransactionBodySchema = z.strictObject({
  type: z.literal("ACTIVITY_TYPE_SIGN_TRANSACTION_V2"),
  timestampMs: z.string().regex(/^\d{1,16}$/),
  organizationId: z.string().min(1).max(128),
  parameters: z.strictObject({
    signWith: z.string().min(1).max(128),
    unsignedTransaction: z.string().min(2).max(65_536),
    type: z.enum(["TRANSACTION_TYPE_ETHEREUM", "TRANSACTION_TYPE_SOLANA"]),
  }),
  generateAppProofs: z.boolean().optional(),
});
export type SignTransactionBody = z.infer<typeof SignTransactionBodySchema>;
/** Compile-time guard: our strict schema stays assignable to Turnkey's request type. */
type AssertAssignable<A extends B, B> = A;
export type SignTransactionBodyIsTurnkeyRequest = AssertAssignable<
  SignTransactionBody,
  TurnkeyApiTypes["v1SignTransactionRequest"]
>;

export function turnkeyTransactionType(
  family: ChainFamily,
): SignTransactionBody["parameters"]["type"] {
  if (family === "cardano") {
    // Turnkey has no Cardano transaction type: Cardano is signed with SIGN_RAW_PAYLOAD.
    throw new Error("Cardano transactions are signed with SIGN_RAW_PAYLOAD (ADR-002)");
  }
  return family === "solana" ? "TRANSACTION_TYPE_SOLANA" : "TRANSACTION_TYPE_ETHEREUM";
}

/** Turnkey takes the unsigned transaction as hex (with or without 0x); we compare bytes. */
export function unsignedTransactionMatches(
  stampedHex: string,
  stored: { encoding: "base64" | "hex"; serialized: string },
): boolean {
  if (!isHex(stampedHex)) return false;
  try {
    return bytesEqual(
      hexToBytes(stampedHex),
      decodeTransaction(stored.serialized, stored.encoding),
    );
  } catch {
    return false;
  }
}

export interface ExpectedSignTransaction {
  readonly turnkeyApiBaseUrl: string;
  /** The user's sub-organization. */
  readonly organizationId: string;
  /** Wallet address that must sign (payload.from). */
  readonly signWith: string;
  readonly family: ChainFamily;
  /** The unsigned transaction the API built and the user reviewed. */
  readonly unsigned: { encoding: "base64" | "hex"; serialized: string };
  readonly now: Date;
  readonly maxStampAgeMs?: number;
}

/**
 * ADR-001 D2 checks for a user approval / in-app send:
 * passkey stamp over this body, Turnkey sign_transaction URL, SIGN_TRANSACTION_V2 body,
 * organizationId = the user's sub-org, signWith = the wallet address, transaction type =
 * the network family, unsignedTransaction byte-equal to the stored one, and a fresh stamp.
 */
export function verifySignTransactionRequest(
  request: StampedTurnkeyRequest,
  expected: ExpectedSignTransaction,
): StampCheck<{ body: SignTransactionBody; stamp: StampIdentity }> {
  if (!isTurnkeyUrl(request.url, expected.turnkeyApiBaseUrl, TURNKEY_PATHS.signTransaction)) {
    return fail("URL_NOT_ALLOWED", "not a Turnkey sign_transaction URL");
  }
  if (expected.family === "cardano") {
    return fail("TRANSACTION_TYPE_MISMATCH", "Cardano is signed with SIGN_RAW_PAYLOAD");
  }
  const stamp = checkStamp(request, true);
  if (!stamp.ok) return stamp;
  const body = parseJson(request.body, SignTransactionBodySchema);
  if (body === null) return fail("BODY_MALFORMED", "sign_transaction body is malformed");
  if (body.organizationId !== expected.organizationId) {
    return fail("ORGANIZATION_MISMATCH", "organizationId is not the user's sub-organization");
  }
  if (!addressesEqual(expected.family, body.parameters.signWith, expected.signWith)) {
    return fail("SIGN_WITH_MISMATCH", "signWith is not the wallet address");
  }
  if (body.parameters.type !== turnkeyTransactionType(expected.family)) {
    return fail("TRANSACTION_TYPE_MISMATCH", "transaction type does not match the network");
  }
  if (!unsignedTransactionMatches(body.parameters.unsignedTransaction, expected.unsigned)) {
    return fail(
      "UNSIGNED_TRANSACTION_MISMATCH",
      "stamped transaction differs from the reviewed one",
    );
  }
  const ts = Number(body.timestampMs);
  const age = expected.now.getTime() - ts;
  if (
    !Number.isSafeInteger(ts) ||
    age > (expected.maxStampAgeMs ?? DEFAULT_MAX_STAMP_AGE_MS) ||
    age < -MAX_FUTURE_SKEW_MS
  ) {
    return fail("STAMP_STALE", "stamp timestamp is outside the freshness window");
  }
  return { ok: true, value: { body, stamp: stamp.value } };
}

const SignRawPayloadBodySchema = z.strictObject({
  type: z.literal("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2"),
  timestampMs: z.string().regex(/^\d{1,16}$/),
  organizationId: z.string().min(1).max(128),
  parameters: z.strictObject({
    signWith: z.string().min(1).max(128),
    payload: z.string().min(2).max(130),
    encoding: z.literal("PAYLOAD_ENCODING_HEXADECIMAL"),
    hashFunction: z.literal("HASH_FUNCTION_NO_OP"),
  }),
  generateAppProofs: z.boolean().optional(),
});
export type SignRawPayloadBody = z.infer<typeof SignRawPayloadBodySchema>;
export type SignRawPayloadBodyIsTurnkeyRequest = AssertAssignable<
  SignRawPayloadBody,
  TurnkeyApiTypes["v1SignRawPayloadRequest"]
>;

export interface ExpectedSignRawPayload {
  readonly turnkeyApiBaseUrl: string;
  /** The user's sub-organization. */
  readonly organizationId: string;
  /** EVM wallet address that must sign (payload.from). */
  readonly signWith: string;
  /** 0x-prefixed 32-byte digest the API derived and independently verified. */
  readonly digest: string;
  readonly now: Date;
  readonly maxStampAgeMs?: number;
}

/**
 * Typed-data approval (x402 on EVM): passkey stamp over this body, Turnkey
 * sign_raw_payload URL, SIGN_RAW_PAYLOAD_V2 with a hexadecimal payload and NO hashing
 * (the payload already is the EIP-712 digest), organizationId = the user's sub-org,
 * signWith = the EVM wallet address, payload byte-equal to the expected digest, fresh stamp.
 */
export function verifySignRawPayloadRequest(
  request: StampedTurnkeyRequest,
  expected: ExpectedSignRawPayload,
): StampCheck<{ body: SignRawPayloadBody; stamp: StampIdentity }> {
  if (!isTurnkeyUrl(request.url, expected.turnkeyApiBaseUrl, TURNKEY_PATHS.signRawPayload)) {
    return fail("URL_NOT_ALLOWED", "not a Turnkey sign_raw_payload URL");
  }
  const stamp = checkStamp(request, true);
  if (!stamp.ok) return stamp;
  const body = parseJson(request.body, SignRawPayloadBodySchema);
  if (body === null) return fail("BODY_MALFORMED", "sign_raw_payload body is malformed");
  if (body.organizationId !== expected.organizationId) {
    return fail("ORGANIZATION_MISMATCH", "organizationId is not the user's sub-organization");
  }
  if (!addressesEqual("evm", body.parameters.signWith, expected.signWith)) {
    return fail("SIGN_WITH_MISMATCH", "signWith is not the wallet address");
  }
  const stampedPayload = body.parameters.payload;
  if (
    !isHex(stampedPayload) ||
    !isHex(expected.digest) ||
    hexToBytes(expected.digest).length !== 32 ||
    !bytesEqual(hexToBytes(stampedPayload), hexToBytes(expected.digest))
  ) {
    return fail("PAYLOAD_MISMATCH", "stamped payload is not the reviewed digest");
  }
  const ts = Number(body.timestampMs);
  const age = expected.now.getTime() - ts;
  if (
    !Number.isSafeInteger(ts) ||
    age > (expected.maxStampAgeMs ?? DEFAULT_MAX_STAMP_AGE_MS) ||
    age < -MAX_FUTURE_SKEW_MS
  ) {
    return fail("STAMP_STALE", "stamp timestamp is outside the freshness window");
  }
  return { ok: true, value: { body, stamp: stamp.value } };
}

const SignCardanoBodySchema = z.strictObject({
  type: z.literal("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2"),
  timestampMs: z.string().regex(/^\d{1,16}$/),
  organizationId: z.string().min(1).max(128),
  parameters: z.strictObject({
    signWith: z.string().regex(/^[0-9a-fA-F]{64}$/),
    payload: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
    encoding: z.literal("PAYLOAD_ENCODING_HEXADECIMAL"),
    // Turnkey: "must be set to HASH_FUNCTION_NOT_APPLICABLE for EdDSA/ed25519".
    hashFunction: z.literal("HASH_FUNCTION_NOT_APPLICABLE"),
  }),
  generateAppProofs: z.boolean().optional(),
});
export type SignCardanoBody = z.infer<typeof SignCardanoBodySchema>;
export type SignCardanoBodyIsTurnkeyRequest = AssertAssignable<
  SignCardanoBody,
  TurnkeyApiTypes["v1SignRawPayloadRequest"]
>;

export interface ExpectedSignCardano {
  readonly turnkeyApiBaseUrl: string;
  /** The user's sub-organization. */
  readonly organizationId: string;
  /** The account's Ed25519 public key (hex), as stored at wallet sync. */
  readonly publicKey: string;
  /** Payment key hash of payload.from; blake2b-224(publicKey) must equal it. */
  readonly paymentKeyHash: string;
  /** blake2b-256 of the reviewed transaction body (hex), recomputed by the API. */
  readonly bodyHash: string;
  readonly now: Date;
  readonly maxStampAgeMs?: number;
}

/**
 * Cardano approval (ADR-002): passkey stamp over this body, Turnkey sign_raw_payload URL,
 * SIGN_RAW_PAYLOAD_V2 with a hexadecimal payload and HASH_FUNCTION_NOT_APPLICABLE (Ed25519
 * signs the message itself), organizationId = the user's sub-org, signWith = the account's
 * public key whose blake2b-224 is the payment credential of payload.from, payload
 * byte-equal to the body hash of the reviewed transaction, and a fresh stamp.
 */
export function verifySignCardanoRequest(
  request: StampedTurnkeyRequest,
  expected: ExpectedSignCardano,
): StampCheck<{ body: SignCardanoBody; stamp: StampIdentity }> {
  if (!isTurnkeyUrl(request.url, expected.turnkeyApiBaseUrl, TURNKEY_PATHS.signRawPayload)) {
    return fail("URL_NOT_ALLOWED", "not a Turnkey sign_raw_payload URL");
  }
  const stamp = checkStamp(request, true);
  if (!stamp.ok) return stamp;
  const body = parseJson(request.body, SignCardanoBodySchema);
  if (body === null) return fail("BODY_MALFORMED", "sign_raw_payload body is malformed");
  if (body.organizationId !== expected.organizationId) {
    return fail("ORGANIZATION_MISMATCH", "organizationId is not the user's sub-organization");
  }
  const signWith = body.parameters.signWith.toLowerCase();
  let keyHash: string;
  try {
    keyHash = cardanoKeyHash(signWith);
  } catch {
    return fail("SIGN_WITH_MISMATCH", "signWith is not an Ed25519 public key");
  }
  if (signWith !== expected.publicKey.toLowerCase() || keyHash !== expected.paymentKeyHash) {
    return fail("SIGN_WITH_MISMATCH", "signWith is not the wallet's Cardano payment key");
  }
  const stampedPayload = body.parameters.payload.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected.bodyHash) || stampedPayload !== expected.bodyHash) {
    return fail("PAYLOAD_MISMATCH", "stamped payload is not the reviewed transaction body hash");
  }
  const ts = Number(body.timestampMs);
  const age = expected.now.getTime() - ts;
  if (
    !Number.isSafeInteger(ts) ||
    age > (expected.maxStampAgeMs ?? DEFAULT_MAX_STAMP_AGE_MS) ||
    age < -MAX_FUTURE_SKEW_MS
  ) {
    return fail("STAMP_STALE", "stamp timestamp is outside the freshness window");
  }
  return { ok: true, value: { body, stamp: stamp.value } };
}

const CreatePoliciesBodySchema = z.strictObject({
  type: z.literal("ACTIVITY_TYPE_CREATE_POLICIES"),
  timestampMs: z.string().regex(/^\d{1,16}$/),
  organizationId: z.string().min(1).max(128),
  parameters: z.strictObject({
    policies: z
      .array(
        z.strictObject({
          policyName: z.string().min(1).max(256),
          effect: z.enum(["EFFECT_ALLOW", "EFFECT_DENY"]),
          condition: z.string().max(8192).optional(),
          consensus: z.string().max(4096).optional(),
          notes: z.string().max(1024),
          time: z.string().max(256).optional(),
        }),
      )
      .min(1)
      .max(5),
  }),
  generateAppProofs: z.boolean().optional(),
});
export type CreatePoliciesBody = z.infer<typeof CreatePoliciesBodySchema>;

/**
 * Autonomous mode (ADR-001 D6): the user's passkey creates the Turnkey policy envelope for
 * the delegated user. We forward it only if it is a CREATE_POLICIES activity in the user's
 * own sub-org, every ALLOW policy's consensus names ONLY the delegated user (so the
 * envelope can never widen anyone else), and the stamp is a fresh passkey stamp.
 */
export function verifyCreatePoliciesRequest(
  request: StampedTurnkeyRequest,
  expected: {
    turnkeyApiBaseUrl: string;
    organizationId: string;
    delegatedTurnkeyUserId: string;
    now: Date;
    maxStampAgeMs?: number;
  },
): StampCheck<{ body: CreatePoliciesBody }> {
  if (!isTurnkeyUrl(request.url, expected.turnkeyApiBaseUrl, TURNKEY_PATHS.createPolicies)) {
    return fail("URL_NOT_ALLOWED", "not a Turnkey create_policies URL");
  }
  const stamp = checkStamp(request, true);
  if (!stamp.ok) return stamp;
  const body = parseJson(request.body, CreatePoliciesBodySchema);
  if (body === null) return fail("BODY_MALFORMED", "create_policies body is malformed");
  if (body.organizationId !== expected.organizationId) {
    return fail("ORGANIZATION_MISMATCH", "organizationId is not the user's sub-organization");
  }
  for (const policy of body.parameters.policies) {
    if (
      policy.effect === "EFFECT_ALLOW" &&
      !consensusIsOnlyUser(policy.consensus, expected.delegatedTurnkeyUserId)
    ) {
      return fail("BODY_MALFORMED", "ALLOW policies must be bound to the delegated user only");
    }
  }
  const ts = Number(body.timestampMs);
  const age = expected.now.getTime() - ts;
  if (
    !Number.isSafeInteger(ts) ||
    age > (expected.maxStampAgeMs ?? DEFAULT_MAX_STAMP_AGE_MS) ||
    age < -MAX_FUTURE_SKEW_MS
  ) {
    return fail("STAMP_STALE", "stamp timestamp is outside the freshness window");
  }
  return { ok: true, value: { body } };
}

/** `approvers.any(u, u.id == '<id>')` with any bound variable name, nothing else. */
export function consensusIsOnlyUser(consensus: string | undefined, turnkeyUserId: string): boolean {
  if (consensus === undefined || !/^[A-Za-z0-9-]{1,128}$/.test(turnkeyUserId)) return false;
  const match =
    /^approvers\.any\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\.id\s*==\s*'([^']+)'\s*\)$/.exec(
      consensus.trim(),
    );
  return match !== null && match[1] === match[2] && match[3] === turnkeyUserId;
}

function parseJson<S extends z.ZodType>(raw: string, schema: S): z.infer<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
