import {
  AUTONOMY_ELIGIBLE_TOOLS,
  decimalToMinorUnits,
  isValidAddress,
  minorUnitsToDecimal,
  normalizeAddress,
  type AgentPolicy,
  type ChainFamily,
  type RecipientAllowlistEntry,
} from "@zyropay/shared";

/*
 * Pure helpers for the policy editor (unit-tested). Limits are edited as
 * dollar strings and stored as integer cent strings; conversion is bigint.
 */

export type PolicyDraft = Omit<AgentPolicy, "version" | "revoked">;

export function draftFromPolicy(policy: AgentPolicy): PolicyDraft {
  const { version: _v, revoked: _r, ...rest } = policy;
  return rest;
}

/** "12.5" -> "1250". Empty input is treated as zero. Throws on malformed input. */
export function dollarsToCents(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "0";
  return decimalToMinorUnits(trimmed, "floor").toString();
}

/** "1250" -> "12.50"; "0" -> "". */
export function centsToDollars(cents: string): string {
  return cents === "0" ? "" : minorUnitsToDecimal(cents);
}

export interface DraftIssue {
  readonly field: string;
  readonly message: string;
}

/** Client-side checks; the API re-validates everything and fails closed. */
export function validateDraft(d: PolicyDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (d.allowedWalletIds.length === 0)
    issues.push({ field: "wallets", message: "Choose at least one wallet." });
  if (d.allowedNetworks.length === 0)
    issues.push({ field: "networks", message: "Choose at least one network." });
  if (d.mode === "autonomous") {
    if (!d.spendingEnabled)
      issues.push({ field: "spending", message: "Autonomous mode needs spending turned on." });
    const per = BigInt(d.limits.perTransactionUsdMinor);
    const daily = BigInt(d.limits.dailyUsdMinor);
    const monthly = BigInt(d.limits.monthlyUsdMinor);
    if (per === 0n) issues.push({ field: "limits", message: "Set a per-payment limit above $0." });
    if (daily < per)
      issues.push({
        field: "limits",
        message: "The daily limit can't be below the per-payment limit.",
      });
    if (monthly < daily)
      issues.push({
        field: "limits",
        message: "The monthly limit can't be below the daily limit.",
      });
    const eligible = d.allowedTools.some((t) =>
      (AUTONOMY_ELIGIBLE_TOOLS as readonly string[]).includes(t),
    );
    if (!eligible)
      issues.push({ field: "tools", message: "None of the allowed tools can run autonomously." });
  }
  if (
    d.spendingEnabled &&
    d.restrictRecipients &&
    d.recipientAllowlist.length === 0 &&
    d.mode === "autonomous"
  ) {
    issues.push({
      field: "recipients",
      message: "Add at least one allowed recipient, or allow any address.",
    });
  }
  return issues;
}

export function makeAllowlistEntry(
  family: ChainFamily,
  address: string,
  label: string,
): RecipientAllowlistEntry | null {
  const trimmed = address.trim();
  if (!isValidAddress(family, trimmed)) return null;
  const cleanLabel = label.trim().slice(0, 64);
  return {
    family,
    address: normalizeAddress(family, trimmed),
    label: cleanLabel === "" ? null : cleanLabel,
  };
}

/**
 * x402 escrow threshold as edited: a switch plus a dollar amount. Off = null (no escrow
 * requirement); on with an empty amount = "0" (every x402 payment must be escrowed).
 */
export interface EscrowThresholdInput {
  readonly on: boolean;
  readonly dollars: string;
}

export function escrowThresholdToInput(minor: string | null | undefined): EscrowThresholdInput {
  if (minor === null || minor === undefined) return { on: false, dollars: "" };
  return { on: true, dollars: centsToDollars(minor) };
}

/** Throws on a malformed amount (like dollarsToCents). */
export function escrowThresholdFromInput(input: EscrowThresholdInput): string | null {
  return input.on ? dollarsToCents(input.dollars) : null;
}
