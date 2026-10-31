/*
 * Verified delivery receipt (ZyroPay x402 extension, v1; see docs/CARDANO_X402.md).
 *
 * Every successful PAID response carries an `X-Delivery-Receipt` header: base64 of
 *   { v:1, resourceUrl, payTo, paymentTx, contentSha256, signedAt, publicKey, signature }
 * where `signature` is Ed25519, made with the payment key behind `payTo`, over
 *   "zyropay-x402-receipt-v1\n" + resourceUrl + "\n" + payTo + "\n" + (paymentTx ?? "")
 *     + "\n" + contentSha256 + "\n" + signedAt
 * and `contentSha256` is the SHA-256 (hex) of the exact response body bytes. A buyer that
 * hashes what it received and checks blake2b-224(publicKey) against payTo's payment
 * credential knows the bytes came from the party it paid.
 *
 * The key is optional (SELLER_SIGNING_KEY). Without it, or when it is not payTo's key, the
 * seller serves without receipts: a receipt problem never fails a paid request.
 */
import { Address, KeyHash, PrivateKey, VKey } from "@evolution-sdk/evolution";
import type { MiddlewareHandler } from "hono";

export const RECEIPT_HEADER = "X-Delivery-Receipt";
const RECEIPT_DOMAIN = "zyropay-x402-receipt-v1";
const TX_ID = /^[0-9a-f]{64}$/;

export interface ReceiptSigner {
  readonly payTo: string;
  /** Ed25519 verification key (32 bytes, hex). */
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array;
}

export type SignerResult =
  | { readonly ok: true; readonly signer: ReceiptSigner }
  | { readonly ok: false; readonly problem: string };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The payment signing key of `payTo` (SELLER_SIGNING_KEY), checked against payTo. */
export interface SellerKey {
  readonly privateKey: PrivateKey.PrivateKey;
  /** Ed25519 verification key (32 bytes, hex). */
  readonly publicKey: string;
  /** blake2b-224 of the verification key: payTo's payment credential (hex). */
  readonly keyHash: string;
}

export type SellerKeyResult =
  { readonly ok: true; readonly key: SellerKey } | { readonly ok: false; readonly problem: string };

/**
 * `raw` is the payment signing key as hex: 32 bytes (a plain Ed25519 seed) or 64 bytes (a
 * Cardano BIP32-Ed25519 extended key, kL||kR, which is what `pnpm receipt-key` writes).
 * Problems name the rule, never the value.
 */
export function loadSellerKey(raw: string | undefined, payTo: string): SellerKeyResult {
  const hex = raw?.trim().toLowerCase() ?? "";
  if (hex === "") return { ok: false, problem: "SELLER_SIGNING_KEY is not set" };
  if (!/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/.test(hex))
    return { ok: false, problem: "SELLER_SIGNING_KEY must be 32 or 64 bytes of hex" };
  let key: PrivateKey.PrivateKey;
  let vkey: VKey.VKey;
  let paymentKeyHash: string | null;
  try {
    key = PrivateKey.fromHex(hex);
    vkey = VKey.fromPrivateKey(key);
    const credential = Address.fromBech32(payTo).paymentCredential;
    paymentKeyHash = credential instanceof KeyHash.KeyHash ? KeyHash.toHex(credential) : null;
  } catch {
    return { ok: false, problem: "SELLER_SIGNING_KEY is not a usable Ed25519 key" };
  }
  if (paymentKeyHash === null || KeyHash.toHex(KeyHash.fromVKey(vkey)) !== paymentKeyHash)
    return { ok: false, problem: "SELLER_SIGNING_KEY is not the payment key of SELLER_ADDRESS" };
  return {
    ok: true,
    key: { privateKey: key, publicKey: VKey.toHex(vkey), keyHash: paymentKeyHash },
  };
}

/** The receipt signer for `payTo` (see loadSellerKey for the key format). */
export function loadReceiptSigner(raw: string | undefined, payTo: string): SignerResult {
  const loaded = loadSellerKey(raw, payTo);
  if (!loaded.ok) return loaded;
  const { privateKey, publicKey } = loaded.key;
  return {
    ok: true,
    signer: {
      payTo,
      publicKey,
      sign: (message) => PrivateKey.sign(privateKey, message).bytes,
    },
  };
}

interface ReceiptFields {
  readonly resourceUrl: string;
  readonly payTo: string;
  readonly paymentTx: string | null;
  readonly contentSha256: string;
  readonly signedAt: string;
}

/** The canonical message (UTF-8, "\n"-separated, no trailing newline). */
function receiptMessage(r: ReceiptFields): string {
  return [
    RECEIPT_DOMAIN,
    r.resourceUrl,
    r.payTo,
    r.paymentTx ?? "",
    r.contentSha256,
    r.signedAt,
  ].join("\n");
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Header value (base64 of ASCII JSON) for `body` served at `resourceUrl`. */
async function signReceipt(
  signer: ReceiptSigner,
  fields: Omit<ReceiptFields, "payTo" | "contentSha256">,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const unsigned: ReceiptFields = {
    resourceUrl: fields.resourceUrl,
    payTo: signer.payTo,
    paymentTx: fields.paymentTx,
    contentSha256: await sha256Hex(body),
    signedAt: fields.signedAt,
  };
  const signature = toHex(signer.sign(new TextEncoder().encode(receiptMessage(unsigned))));
  return btoa(JSON.stringify({ v: 1, ...unsigned, publicKey: signer.publicKey, signature }));
}

/** `transaction` of a successful PAYMENT-RESPONSE, or undefined when it is not one. */
export function settledTransaction(header: string | null): string | null | undefined {
  if (header === null) return undefined;
  try {
    const decoded = JSON.parse(atob(header)) as { success?: unknown; transaction?: unknown };
    if (decoded.success !== true) return undefined;
    const tx = typeof decoded.transaction === "string" ? decoded.transaction.toLowerCase() : "";
    return TX_ID.test(tx) ? tx : null;
  } catch {
    return undefined;
  }
}

/**
 * Wraps the x402 middleware: once a paid request has settled (200 + successful
 * PAYMENT-RESPONSE), it signs the exact body bytes and adds the receipt header. Any
 * failure here serves the response unchanged (without a receipt).
 */
export function receiptMiddleware(signer: ReceiptSigner, now: () => Date): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status !== 200) return;
    const paymentTx = settledTransaction(res.headers.get("PAYMENT-RESPONSE"));
    if (paymentTx === undefined) return;
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    try {
      headers.set(
        RECEIPT_HEADER,
        await signReceipt(
          signer,
          { resourceUrl: c.req.url, paymentTx, signedAt: now().toISOString() },
          body,
        ),
      );
    } catch (err) {
      console.error(
        "[seller] receipt signing failed:",
        err instanceof Error ? err.name : "unknown",
      );
    }
    c.res = undefined;
    c.res = new Response(body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** A decoded v1 receipt (the header's JSON). */
export interface DeliveryReceipt extends ReceiptFields {
  readonly v: 1;
  readonly publicKey: string;
  readonly signature: string;
}

export type ReceiptCheck =
  | { readonly ok: true; readonly receipt: DeliveryReceipt }
  | { readonly ok: false; readonly problem: string; readonly receipt: DeliveryReceipt | null };

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function decodeReceipt(header: string): DeliveryReceipt | null {
  if (header.length > 4096) return null;
  try {
    const r = JSON.parse(atob(header)) as Partial<Record<keyof DeliveryReceipt, unknown>>;
    const str = (v: unknown): v is string => typeof v === "string";
    if (
      r.v !== 1 ||
      !str(r.resourceUrl) ||
      !str(r.payTo) ||
      !(r.paymentTx === null || (str(r.paymentTx) && TX_ID.test(r.paymentTx))) ||
      !str(r.contentSha256) ||
      !/^[0-9a-f]{64}$/.test(r.contentSha256) ||
      !str(r.signedAt) ||
      !str(r.publicKey) ||
      !/^[0-9a-f]{64}$/.test(r.publicKey) ||
      !str(r.signature) ||
      !/^[0-9a-f]{128}$/.test(r.signature)
    )
      return null;
    return {
      v: 1,
      resourceUrl: r.resourceUrl,
      payTo: r.payTo,
      paymentTx: r.paymentTx,
      contentSha256: r.contentSha256,
      signedAt: r.signedAt,
      publicKey: r.publicKey,
      signature: r.signature,
    };
  } catch {
    return null;
  }
}

/**
 * The buyer-side check of another seller's X-Delivery-Receipt (the same rules as
 * packages/shared verifyX402Receipt, without zod): the key hashes to `payTo`'s payment
 * credential, the signature is valid, and the receipt names the URL we paid for, the payTo
 * we paid, our payment transaction and the SHA-256 of the bytes we actually received.
 */
export async function verifyDeliveryReceipt(
  header: string | null,
  expected: {
    readonly resourceUrl: string;
    readonly payTo: string;
    readonly paymentTx: string | null;
    readonly body: Uint8Array<ArrayBuffer>;
  },
): Promise<ReceiptCheck> {
  if (header === null || header === "")
    return { ok: false, problem: "no X-Delivery-Receipt", receipt: null };
  const receipt = decodeReceipt(header);
  if (receipt === null) return { ok: false, problem: "malformed receipt", receipt: null };
  const fail = (problem: string): ReceiptCheck => ({ ok: false, problem, receipt });
  if (receipt.resourceUrl !== expected.resourceUrl) return fail("receipt is for another URL");
  if (receipt.payTo !== expected.payTo) return fail("receipt names another payTo");
  if (expected.paymentTx !== null && receipt.paymentTx !== expected.paymentTx)
    return fail("receipt names another payment transaction");
  if (receipt.contentSha256 !== (await sha256Hex(expected.body)))
    return fail("receipt hash does not match the delivered bytes");
  try {
    const vkey = VKey.fromHex(receipt.publicKey);
    const credential = Address.fromBech32(receipt.payTo).paymentCredential;
    if (
      !(credential instanceof KeyHash.KeyHash) ||
      KeyHash.toHex(KeyHash.fromVKey(vkey)) !== KeyHash.toHex(credential)
    )
      return fail("receipt key is not payTo's payment key");
    const message = new TextEncoder().encode(receiptMessage(receipt));
    if (!VKey.verify(vkey, message, fromHex(receipt.signature)))
      return fail("receipt signature is invalid");
  } catch {
    return fail("receipt key or payTo is unusable");
  }
  return { ok: true, receipt };
}
