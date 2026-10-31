import { StamperType, type TurnkeySDKClientBase } from "@turnkey/core";
import type { StampedTurnkeyRequest, TurnkeyPolicyIntent } from "@zyropay/shared";
import { requirePasskeyStamp, toStamped } from "./bridge-common";
import {
  turnkeySignBody,
  turnkeySignRawPayloadBody,
  turnkeyTransactionType,
  unsignedHex,
  type SignRawPayloadInput,
  type SignTransactionInput,
} from "./signer";

/*
 * The stamped requests the web bridge hands to the ZyroPay API, built with @turnkey/core's
 * HTTP client. Kept apart from TurnkeyBridge.web.tsx so a unit test can run them through
 * the real @turnkey/webauthn-stamper and @zyropay/wallet's verifiers
 * (web-requests.test.ts): the API checks X-Stamp-Webauthn with challenge = sha256(body).
 */

type Http = Pick<
  TurnkeySDKClientBase,
  "stampGetWhoami" | "stampSignTransaction" | "stampSignRawPayload" | "stampCreatePolicies"
>;

/** Login: get_whoami stamped with the session key (read-only, ADR-001 D2). */
export async function stampWhoami(
  http: Http,
  stampWith: StamperType = StamperType.ApiKey,
): Promise<StampedTurnkeyRequest> {
  return toStamped(await http.stampGetWhoami({}, stampWith));
}

/** SIGN_TRANSACTION_V2 over exactly the reviewed bytes, passkey only. */
export async function stampSignTransaction(
  http: Http,
  input: SignTransactionInput,
  now = Date.now(),
): Promise<StampedTurnkeyRequest> {
  const body = turnkeySignBody(input, String(now));
  const signed = await http.stampSignTransaction(
    {
      organizationId: input.organizationId,
      signWith: input.signWith,
      unsignedTransaction: unsignedHex(input.unsignedTransaction),
      type: turnkeyTransactionType(input.network),
      timestampMs: body.timestampMs,
    },
    StamperType.Passkey,
  );
  return requirePasskeyStamp(toStamped(signed));
}

/** SIGN_RAW_PAYLOAD_V2 (Cardano body hash, ADR-002; x402 EIP-712 digest), passkey only. */
export async function stampSignRawPayload(
  http: Http,
  input: SignRawPayloadInput,
  now = Date.now(),
): Promise<StampedTurnkeyRequest> {
  const body = turnkeySignRawPayloadBody(input, String(now));
  const signed = await http.stampSignRawPayload(
    {
      organizationId: input.organizationId,
      signWith: body.parameters.signWith,
      payload: body.parameters.payload,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: body.parameters.hashFunction,
      timestampMs: body.timestampMs,
    },
    StamperType.Passkey,
  );
  return requirePasskeyStamp(toStamped(signed));
}

/** ADR-001 D6: the autonomous-mode policy envelope, stamped (not submitted) by the passkey. */
export async function stampCreatePolicies(
  http: Http,
  input: { organizationId: string; policies: readonly TurnkeyPolicyIntent[] },
  now = Date.now(),
): Promise<StampedTurnkeyRequest> {
  const signed = await http.stampCreatePolicies(
    {
      organizationId: input.organizationId,
      timestampMs: String(now),
      policies: input.policies.map((p) => ({ ...p })),
    },
    StamperType.Passkey,
  );
  return requirePasskeyStamp(toStamped(signed), "The policy envelope");
}
