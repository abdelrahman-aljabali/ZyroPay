/*
 * Seller-signed Masumi quotes (x402 `assetTransferMethod: "masumi"`).
 *
 * @x402/cardano's resource-server scheme issues a fresh quote for every 402 when it is given
 * `masumi: { seller }`: terms (deadlines, a 32-byte seller nonce, the input commitment =
 * the exact resource URL) signed CIP-8/COSE over termsDigest with the payTo payment key.
 * The signer here is that key (SELLER_SIGNING_KEY), the same one the receipts use.
 *
 * Quotes are stateless across isolates: the scheme remembers issued quotes in process memory
 * only, and a Worker's paid retry may land on another isolate. `admitPaidQuote` lets a paid
 * retry back in when the quote it carries is provably ours: the COSE signature verifies
 * under a key whose hash is SELLER_ADDRESS's payment credential (only this seller can make
 * one), the commitment names exactly the requested URL, the price/payTo/timeout are what
 * the route serves, and payByTime has not passed. Then the quote is put in the scheme's
 * store, and @x402/cardano's own binding (one quote, one transaction, per isolate) applies.
 */
import { Address, COSE } from "@evolution-sdk/evolution";
import type {
  CardanoExtraMasumi,
  MasumiRegistryValidator,
  MasumiTermsStorage,
} from "@x402/cardano";
import {
  computeTermsDigest,
  buildSignedTerms,
  validateMasumiExtra,
  verifyMasumiAuthorization,
} from "@x402/cardano";
import type { MasumiSellerSigner } from "@x402/cardano/exact/server";
import type { PaymentRequirements } from "@x402/core/types";
import type { SellerKey } from "../receipt";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** CIP-8 signer over termsDigest with the seller's payment key (as toMasumiSellerSigner). */
export function masumiSellerSigner(key: SellerKey, sellerAddress: string): MasumiSellerSigner {
  return {
    sellerAddress,
    signTerms: (address, termsDigestHex) => {
      const signed = COSE.SignData.signData(
        Address.toHex(Address.fromBech32(address)),
        fromHex(termsDigestHex),
        key.privateKey,
      );
      return { key: toHex(signed.key), signature: toHex(signed.signature) };
    },
  };
}

/**
 * The seller-side check of its OWN registry claim (MASUMI_AGENT_IDENTIFIER). @x402/cardano
 * refuses any quote whose terms carry an agentIdentifier unless a validator vouches for it
 * (the scheme's paid-retry check, the embedded facilitator). Here the seller vouches only for
 * the identity it was configured with, signed by its own key, at the escrow route's price:
 * it never accepts another agent's identifier. Buyers check the claim on chain themselves
 * (ZyroPay: the SELLER_ADDRESS key holds the live registry NFT whose metadata names this
 * endpoint and price).
 */
export function ownRegistryClaim(claim: {
  readonly agentIdentifier: string;
  readonly sellerAddress: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
}): MasumiRegistryValidator {
  return (c) =>
    Promise.resolve(
      c.agentIdentifier === claim.agentIdentifier &&
        c.sellerAddress === claim.sellerAddress &&
        c.network === claim.network &&
        c.asset === claim.asset &&
        c.amount === claim.amount,
    );
}

export interface QuoteExpectation {
  readonly sellerAddress: string;
  readonly payTo: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  /** The exact request URL (path and query) the quote must commit to. */
  readonly resourceUrl: string;
  readonly nowMs: number;
  /** The configured registry identity (MASUMI_AGENT_IDENTIFIER); null: none claimed. */
  readonly agentIdentifier: string | null;
}

/** Why a presented quote is not ours/usable, or null when it is. */
export async function checkPaidQuote(
  accepted: PaymentRequirements,
  expected: QuoteExpectation,
): Promise<string | null> {
  if (
    accepted.scheme !== "exact" ||
    accepted.network !== expected.network ||
    accepted.payTo !== expected.payTo ||
    accepted.asset !== expected.asset ||
    accepted.amount !== expected.amount ||
    accepted.maxTimeoutSeconds !== expected.maxTimeoutSeconds
  )
    return "quote does not match this route";
  const schema = validateMasumiExtra(accepted.extra, accepted.network);
  if (!schema.ok) return "quote extra is invalid";
  const extra = accepted.extra as unknown as CardanoExtraMasumi;
  if (extra.terms.sellerAddress !== expected.sellerAddress) return "quote names another seller";
  const parts = extra.inputCommitment.parts;
  const resource = parts.length === 1 ? parts[0] : undefined;
  const url =
    resource?.name === "resource" &&
    resource.canonicalization === "jcs" &&
    typeof resource.content === "object" &&
    resource.content !== null
      ? (resource.content as { url?: unknown }).url
      : undefined;
  if (url !== expected.resourceUrl) return "quote commits to another resource";
  if (!(Number(extra.terms.payByTime) > expected.nowMs)) return "quote has expired";
  if ((extra.terms.agentIdentifier ?? "") !== (expected.agentIdentifier ?? ""))
    return "quote claims another registry identity";
  const auth = await verifyMasumiAuthorization(extra, accepted, {
    requireAllPartContent: true,
    ...(expected.agentIdentifier !== null
      ? {
          resource: { url: expected.resourceUrl },
          validateRegistryClaim: ownRegistryClaim({
            agentIdentifier: expected.agentIdentifier,
            sellerAddress: expected.sellerAddress,
            network: expected.network,
            asset: expected.asset,
            amount: expected.amount,
          }),
        }
      : {}),
  });
  if (!auth.ok) return "quote signature does not verify";
  return null;
}

/** Puts a verified paid quote into the scheme's quote store (no-op if already there). */
export async function admitPaidQuote(
  storage: MasumiTermsStorage,
  accepted: PaymentRequirements,
): Promise<void> {
  const termsDigest = computeTermsDigest(
    buildSignedTerms(accepted.extra as unknown as CardanoExtraMasumi, accepted),
  );
  const requirements = structuredClone(accepted);
  await storage.updateTerms(termsDigest, (current) => current ?? { termsDigest, requirements });
}
