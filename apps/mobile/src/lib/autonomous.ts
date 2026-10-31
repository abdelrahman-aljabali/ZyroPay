import {
  buildDelegatedPolicyEnvelope,
  chainFamilyOf,
  EnvelopeError,
  type PortfolioSnapshot,
  type StampedTurnkeyRequest,
} from "@zyropay/shared";
import type { ApiClient } from "@/api/client";
import type { PolicyDraft } from "@/lib/policy-draft";
import type { PasskeySigner } from "@/lib/turnkey/signer";

/*
 * Turning on autonomous mode (ADR-001 D6), the way the app performs it:
 *
 *  1. GET /v1/delegated-signer, or POST it: the API generates the P-256 key and returns ONLY
 *     the public key (the private key never leaves the API, encrypted at rest).
 *  2. While the signer is pending, the user's passkey session creates the non-root API-key
 *     user holding that public key (fetchOrCreateP256ApiKeyUser), then
 *     POST /v1/delegated-signer/activate lets the API verify it in Turnkey.
 *  3. If no envelope is recorded yet, the passkey first deletes what a revoked earlier setup
 *     left in the sub-org (its delegated user and `zyropay-delegated-*` policies), then the
 *     app builds the CREATE_POLICIES envelope from the
 *     policy the user is saving (shared, deterministic builder) and the passkey stamps it.
 *     The API verifies (consensus bound to the delegated user) and forwards it unmodified.
 *  4. The caller saves the policy with `turnkeyPolicyRequest`.
 *
 * Fails closed: without a real or simulated passkey signer (Turnkey unconfigured, Expo Go),
 * or without the prices needed for the per-payment cap, nothing is created.
 */

export class AutonomousSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutonomousSetupError";
  }
}

type Call = ApiClient["call"];

/** USD price of one whole native unit per family, from the portfolio's own valuation. */
export function nativeUsdPrices(portfolio: PortfolioSnapshot | undefined): {
  solana?: string;
  evm?: string;
} {
  const out: { solana?: string; evm?: string } = {};
  for (const b of portfolio?.balances ?? []) {
    if (b.asset.kind !== "native" || b.price === null || b.price.currency !== "USD") continue;
    const family = chainFamilyOf(b.asset.network);
    // Cardano is never autonomous (ADR-002): it has no place in the Turnkey envelope.
    if (family === "cardano") continue;
    out[family] ??= b.price.value;
  }
  return out;
}

export interface PrepareAutonomousInput {
  readonly call: Call;
  readonly signer: PasskeySigner;
  /** The user's Turnkey sub-organization. */
  readonly organizationId: string;
  readonly policy: PolicyDraft;
  readonly nativeUsdPrice: { readonly solana?: string; readonly evm?: string };
}

/** Run steps 1-3; returns the stamped envelope to send with the policy (if one is needed). */
export async function prepareAutonomous(
  input: PrepareAutonomousInput,
): Promise<{ turnkeyPolicyRequest?: StampedTurnkeyRequest }> {
  const { call, signer } = input;
  if (signer.kind === "unavailable")
    throw new AutonomousSetupError(
      signer.unavailableReason ?? "Autonomous mode needs your passkey, which isn't available.",
    );
  if (input.organizationId === "") throw new AutonomousSetupError("Sign in again to continue.");

  let { signer: delegated } = await call("getDelegatedSigner", {});
  delegated ??= (await call("createDelegatedSigner", {})).signer;

  if (delegated.status === "pending") {
    const turnkeyUserId = await signer.createDelegatedUser({
      organizationId: input.organizationId,
      publicKey: delegated.apiPublicKey,
    });
    delegated = (await call("activateDelegatedSigner", { body: { turnkeyUserId } })).signer;
  }
  if (delegated.status !== "active" || delegated.turnkeyUserId === null)
    throw new AutonomousSetupError("The delegated signer could not be activated.");

  // One envelope per sub-organization (one delegated user serves every autonomous agent).
  if (delegated.turnkeyPolicyIds.length > 0) return {};

  // ADR-001 D8: a revoked earlier setup leaves its Turnkey user and policies behind (the key
  // itself is destroyed). They count against Turnkey's 5-policy limit, so remove them first.
  await signer.removeStaleDelegatedAccess({
    organizationId: input.organizationId,
    keepUserId: delegated.turnkeyUserId,
  });

  let policies;
  try {
    policies = buildDelegatedPolicyEnvelope({
      delegatedUserId: delegated.turnkeyUserId,
      allowedNetworks: input.policy.allowedNetworks,
      restrictRecipients: input.policy.restrictRecipients,
      recipientAllowlist: input.policy.recipientAllowlist,
      perTransactionUsdMinor: input.policy.limits.perTransactionUsdMinor,
      nativeUsdPrice: input.nativeUsdPrice,
    });
  } catch (e) {
    if (e instanceof EnvelopeError)
      throw new AutonomousSetupError(
        `Can't set the signing limits yet: ${e.message}. Prices for the networks you allow are needed to cap each payment.`,
      );
    throw e;
  }
  const turnkeyPolicyRequest = await signer.stampCreatePolicies({
    organizationId: input.organizationId,
    policies,
  });
  return { turnkeyPolicyRequest };
}
