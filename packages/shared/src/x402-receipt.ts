import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { cardanoKeyHash, cardanoPaymentKeyHash } from "./cardano";
import { IsoDateTimeSchema } from "./common";

/*
 * Verified delivery receipt for x402 (ZyroPay extension, v1).
 *
 * A seller signs every successful paid response with the Ed25519 key behind its `payTo`
 * address and sends the receipt in the `X-Delivery-Receipt` header (base64 of the JSON
 * below). Anyone can then check, offline, that the exact bytes delivered came from the
 * party that was paid:
 *
 *  1. blake2b-224(publicKey) equals the payment key hash of `payTo` (CIP-19), so only the
 *     holder of the payTo key could have signed;
 *  2. the Ed25519 signature over the canonical message (x402ReceiptMessage) is valid;
 *  3. `contentSha256` equals SHA-256 of the body the buyer actually received (computed by
 *     the buyer, never taken from the receipt), `resourceUrl` is the URL that was paid for,
 *     and `paymentTx`, when present, is the transaction the buyer signed.
 *
 * Canonical message (UTF-8, "\n"-separated, no trailing newline):
 *   zyropay-x402-receipt-v1
 *   <resourceUrl>
 *   <payTo>
 *   <paymentTx or empty>
 *   <contentSha256>
 *   <signedAt>
 */

export const X402_RECEIPT_HEADER = "X-Delivery-Receipt";
/** Cap on the header the buyer accepts (a v1 receipt is well under 2 KiB). */
export const X402_RECEIPT_MAX_HEADER_BYTES = 4096;
const RECEIPT_DOMAIN = "zyropay-x402-receipt-v1";

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const X402ReceiptSchema = z.strictObject({
  v: z.literal(1),
  resourceUrl: z.url().max(2048),
  payTo: z.string().min(1).max(256),
  paymentTx: Hex64.nullable(),
  contentSha256: Hex64,
  signedAt: IsoDateTimeSchema,
  publicKey: Hex64,
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});
export type X402Receipt = z.infer<typeof X402ReceiptSchema>;

export const X402ReceiptFailureSchema = z.enum([
  /** The resource sent no receipt. */
  "missing",
  /** The header is not a v1 receipt. */
  "malformed",
  /** The buyer could not hash the full body (truncated or not textual). */
  "body_unavailable",
  /** Receipts are verified for Cardano payments only. */
  "unsupported_network",
  /** The signing key or `payTo` is not the address that was paid. */
  "wrong_signer",
  /** Signed for another resource URL. */
  "wrong_resource",
  /** Signed for another payment transaction. */
  "wrong_payment",
  /** The delivered bytes are not the ones the seller signed. */
  "content_mismatch",
  /** The signature does not verify. */
  "bad_signature",
]);
export type X402ReceiptFailure = z.infer<typeof X402ReceiptFailureSchema>;

/** What ZyroPay concluded about a delivery receipt (shown to the agent and in the app). */
export const X402ReceiptSummarySchema = z.object({
  verified: z.boolean(),
  /** SHA-256 of the body the MCP worker received (its own hash), when it could compute it. */
  contentSha256: Hex64.nullable(),
  /** The paid `payTo` address, when it signed the receipt; null otherwise. */
  signedBy: z.string().max(256).nullable(),
  signedAt: IsoDateTimeSchema.nullable(),
  reason: X402ReceiptFailureSchema.nullable(),
});
export type X402ReceiptSummary = z.infer<typeof X402ReceiptSummarySchema>;

export function x402ReceiptMessage(
  r: Pick<X402Receipt, "resourceUrl" | "payTo" | "paymentTx" | "contentSha256" | "signedAt">,
): string {
  return [
    RECEIPT_DOMAIN,
    r.resourceUrl,
    r.payTo,
    r.paymentTx ?? "",
    r.contentSha256,
    r.signedAt,
  ].join("\n");
}

/** A v1 receipt is ASCII JSON (WHATWG-serialised URLs, bech32, hex, ISO time). */
function base64ToAscii(value: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  // atob exists on Workers, Node >= 16 and Hermes; `types: []` hides it from the lib check.
  const decode = (globalThis as { atob?: (s: string) => string }).atob;
  if (decode === undefined) return null;
  try {
    const text = decode(value);
    return /^[\x20-\x7e]*$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Decode the header value; null when it is not a well-formed v1 receipt. */
export function decodeX402Receipt(header: string): X402Receipt | null {
  if (header.length === 0 || header.length > X402_RECEIPT_MAX_HEADER_BYTES) return null;
  const json = base64ToAscii(header.trim());
  if (json === null) return null;
  try {
    const parsed = X402ReceiptSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface X402ReceiptExpectation {
  /** The address that was paid (the request's payload.to). */
  readonly payTo: string;
  /** Whether the receipt's URL is the paid resource (callers normalise both sides). */
  readonly sameResource: (receiptUrl: string) => boolean;
  /** The buyer's own SHA-256 of the delivered body; null when it could not compute one. */
  readonly contentSha256: string | null;
  /** The transaction the buyer signed, when known. */
  readonly paymentTx: string | null;
}

export type X402ReceiptCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: X402ReceiptFailure };

/** Verify a decoded receipt against what the buyer knows independently. Pure, offline. */
export function verifyX402Receipt(
  receipt: X402Receipt,
  expected: X402ReceiptExpectation,
): X402ReceiptCheck {
  const paidKeyHash = cardanoPaymentKeyHash(expected.payTo);
  if (
    paidKeyHash === null ||
    receipt.payTo !== expected.payTo ||
    cardanoKeyHash(receipt.publicKey) !== paidKeyHash
  )
    return { ok: false, reason: "wrong_signer" };
  if (!expected.sameResource(receipt.resourceUrl)) return { ok: false, reason: "wrong_resource" };
  if (
    receipt.paymentTx !== null &&
    expected.paymentTx !== null &&
    receipt.paymentTx !== expected.paymentTx.toLowerCase()
  )
    return { ok: false, reason: "wrong_payment" };
  if (expected.contentSha256 === null) return { ok: false, reason: "body_unavailable" };
  if (receipt.contentSha256 !== expected.contentSha256)
    return { ok: false, reason: "content_mismatch" };
  let valid: boolean;
  try {
    valid = ed25519.verify(
      hexToBytes(receipt.signature),
      utf8ToBytes(x402ReceiptMessage(receipt)),
      hexToBytes(receipt.publicKey),
    );
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
