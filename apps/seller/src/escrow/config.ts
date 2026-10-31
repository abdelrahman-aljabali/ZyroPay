/*
 * Escrow route settings (x402 `assetTransferMethod: "masumi"`). Every value is optional; the
 * defaults give a demo-friendly preprod timeline measured from the 402:
 *   payBy  = now + ESCROW_MAX_TIMEOUT_SECONDS          (default +5 min)
 *   submit = payBy + ESCROW_SUBMIT_AFTER_PAYBY_MIN     (default +10 -> +15 min)
 *   unlock = submit + ESCROW_UNLOCK_AFTER_SUBMIT_MIN   (default +15 -> +30 min)
 *   dispute= unlock + ESCROW_DISPUTE_AFTER_UNLOCK_MIN  (default +15 -> +45 min)
 * vested_pay itself enforces no minimum gaps, but @x402/cardano's issuer, client and
 * facilitator all require payBy->submit >= 5 min, submit->unlock >= 15 min and
 * unlock->dispute >= 15 min, and the issuer requires submit >= now + 15 min
 * (MASUMI_MIN_* constants). The bounds below are those rules, so a bad value is refused at
 * startup instead of producing a 402 nobody can pay.
 */
import {
  MASUMI_REGISTRY_POLICY_ID,
  MASUMI_MIN_PAY_TO_SUBMIT_MS,
  MASUMI_MIN_SUBMIT_RESULT_LEAD_MS,
  MASUMI_MIN_SUBMIT_TO_UNLOCK_MS,
  MASUMI_MIN_UNLOCK_TO_DISPUTE_MS,
} from "@x402/cardano";

export interface EscrowEnv {
  readonly ESCROW_PRICE_LOVELACE?: string;
  readonly ESCROW_MAX_TIMEOUT_SECONDS?: string;
  readonly ESCROW_SUBMIT_AFTER_PAYBY_MIN?: string;
  readonly ESCROW_UNLOCK_AFTER_SUBMIT_MIN?: string;
  readonly ESCROW_DISPUTE_AFTER_UNLOCK_MIN?: string;
  /** "true" (default) | "false": authorize every refund request the sweeper finds. */
  readonly AUTO_AUTHORIZE_REFUNDS?: string;
  /** Pages of 100 escrow UTxOs (newest first) the sweeper scans. Default 3. */
  readonly ESCROW_SCAN_PAGES?: string;
  /**
   * Optional: this seller's Masumi registry identity (agentIdentifier, 120 hex: the V2
   * registry policy id + asset name). Set, every escrow 402 claims it (terms
   * `agentIdentifier`, datum `agent_identifier`); buyers verify the claim on chain (the
   * SELLER_ADDRESS key must hold that NFT, its metadata must name this endpoint and price).
   * Absent: the seller claims no registry identity.
   */
  readonly MASUMI_AGENT_IDENTIFIER?: string;
}

export interface EscrowConfig {
  readonly priceLovelace: string;
  readonly maxTimeoutSeconds: number;
  readonly submitAfterPayByMs: number;
  readonly unlockAfterSubmitMs: number;
  readonly disputeAfterUnlockMs: number;
  readonly autoAuthorizeRefunds: boolean;
  readonly scanPages: number;
  /** The claimed Masumi registry identity, or null (unregistered). */
  readonly agentIdentifier: string | null;
}

/**
 * >= 4 tADA: with a ~480-byte datum and coinsPerUtxoByte 4310 the escrow min-UTxO is ~3.7 tADA,
 * so the buyer's collateral_return_lovelace is 0 and the lock is exactly the price
 * (test/escrow-terms.test.ts checks this with masumiCollateralLovelace).
 */
export const MIN_ESCROW_PRICE_LOVELACE = 4_000_000n;
const MAX_ESCROW_PRICE_LOVELACE = 100_000_000n;
const DEFAULT_ESCROW_PRICE_LOVELACE = "5000000";
const MINUTE = 60_000;
const DAY_MIN = 24 * 60;

function minutes(
  raw: string | undefined,
  fallback: number,
  minMinutes: number,
  name: string,
  problems: string[],
): number {
  const value = raw?.trim() || String(fallback);
  const n = /^[0-9]{1,4}$/.test(value) ? Number(value) : NaN;
  if (!(n >= minMinutes && n <= DAY_MIN)) {
    problems.push(`${name} must be an integer number of minutes from ${minMinutes} to ${DAY_MIN}`);
    return fallback * MINUTE;
  }
  return n * MINUTE;
}

const minMinutes = (ms: bigint) => Number(ms / 60_000n);

/** Problems name the variable and the rule, never the value. */
export function loadEscrowConfig(
  env: EscrowEnv,
): { ok: true; config: EscrowConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];

  const priceRaw = env.ESCROW_PRICE_LOVELACE?.trim() || DEFAULT_ESCROW_PRICE_LOVELACE;
  let priceLovelace = "";
  if (!/^[1-9][0-9]{0,15}$/.test(priceRaw)) {
    problems.push("ESCROW_PRICE_LOVELACE must be a positive integer number of lovelace");
  } else if (
    BigInt(priceRaw) < MIN_ESCROW_PRICE_LOVELACE ||
    BigInt(priceRaw) > MAX_ESCROW_PRICE_LOVELACE
  ) {
    problems.push("ESCROW_PRICE_LOVELACE must be from 4000000 (collateral-free lock) to 100000000");
  } else {
    priceLovelace = priceRaw;
  }

  const timeoutRaw = env.ESCROW_MAX_TIMEOUT_SECONDS?.trim() || "300";
  const maxTimeoutSeconds = /^[0-9]{1,4}$/.test(timeoutRaw) ? Number(timeoutRaw) : NaN;
  if (!(maxTimeoutSeconds >= 60 && maxTimeoutSeconds <= 900))
    problems.push("ESCROW_MAX_TIMEOUT_SECONDS must be an integer from 60 to 900");

  const submitAfterPayByMs = minutes(
    env.ESCROW_SUBMIT_AFTER_PAYBY_MIN,
    10,
    minMinutes(MASUMI_MIN_PAY_TO_SUBMIT_MS),
    "ESCROW_SUBMIT_AFTER_PAYBY_MIN",
    problems,
  );
  const unlockAfterSubmitMs = minutes(
    env.ESCROW_UNLOCK_AFTER_SUBMIT_MIN,
    15,
    minMinutes(MASUMI_MIN_SUBMIT_TO_UNLOCK_MS),
    "ESCROW_UNLOCK_AFTER_SUBMIT_MIN",
    problems,
  );
  const disputeAfterUnlockMs = minutes(
    env.ESCROW_DISPUTE_AFTER_UNLOCK_MIN,
    15,
    minMinutes(MASUMI_MIN_UNLOCK_TO_DISPUTE_MS),
    "ESCROW_DISPUTE_AFTER_UNLOCK_MIN",
    problems,
  );
  if (
    Number.isFinite(maxTimeoutSeconds) &&
    maxTimeoutSeconds * 1000 + submitAfterPayByMs < Number(MASUMI_MIN_SUBMIT_RESULT_LEAD_MS)
  )
    problems.push(
      "ESCROW_MAX_TIMEOUT_SECONDS + ESCROW_SUBMIT_AFTER_PAYBY_MIN must put submitResultTime >= 15 min after the 402",
    );

  const autoRaw = env.AUTO_AUTHORIZE_REFUNDS?.trim().toLowerCase() || "true";
  if (autoRaw !== "true" && autoRaw !== "false")
    problems.push('AUTO_AUTHORIZE_REFUNDS must be "true" or "false"');

  const pagesRaw = env.ESCROW_SCAN_PAGES?.trim() || "3";
  const scanPages = /^[0-9]{1,2}$/.test(pagesRaw) ? Number(pagesRaw) : NaN;
  if (!(scanPages >= 1 && scanPages <= 10))
    problems.push("ESCROW_SCAN_PAGES must be an integer from 1 to 10");

  const agentRaw = env.MASUMI_AGENT_IDENTIFIER?.trim() ?? "";
  if (
    agentRaw !== "" &&
    !(/^[0-9a-f]{120}$/.test(agentRaw) && agentRaw.startsWith(MASUMI_REGISTRY_POLICY_ID))
  )
    problems.push(
      "MASUMI_AGENT_IDENTIFIER must be 120 lowercase hex characters under the Masumi V2 registry policy",
    );

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      priceLovelace,
      maxTimeoutSeconds,
      submitAfterPayByMs,
      unlockAfterSubmitMs,
      disputeAfterUnlockMs,
      autoAuthorizeRefunds: autoRaw === "true",
      scanPages,
      agentIdentifier: agentRaw === "" ? null : agentRaw,
    },
  };
}
