/*
 * Turnkey policy envelope for the delegated signer (ADR-001 D6, step 4).
 *
 * Pure and deterministic, so the app (which stamps the CREATE_POLICIES activity with the
 * user's passkey) and the API (which verifies what it forwards) derive the same intents
 * from the same inputs. The envelope is a coarse second line of defence: the precise USD,
 * daily/monthly and per-agent limits stay in the API's policy engine.
 *
 *  - P1 EVM ALLOW: chain in the allowed chains AND native transfer (empty calldata) to an
 *    allowed recipient within the native cap.
 *  - P2 Solana ALLOW: only System + ComputeBudget programs, every SOL transfer to an allowed
 *    recipient within the native cap. (Only those two programs means no SPL transfers.)
 *  - P3 DENY: any Solana transaction that resolves accounts through an address lookup table.
 *
 * Token transfers (ERC-20 / SPL) are NOT in the v1 envelope, so an autonomous token payment
 * is refused by Turnkey (fails closed) and has to be approved with the passkey. The exact
 * policy-language spelling below follows Turnkey's docs and still has to be exercised
 * against a live Turnkey org (see docs/IMPLEMENTATION_STATUS.md).
 */
import { z } from "zod";
import type { RecipientAllowlistEntry } from "./domain/agents";
import { NETWORKS, type NetworkId } from "./networks";
import { DecimalStringSchema, type UsdMinor } from "./money";

export const TURNKEY_POLICY_NAME_PREFIX = "zyropay-delegated";

/** Margin over the USD per-transaction limit when it is turned into a native cap. */
export const ENVELOPE_PRICE_MARGIN_BPS = 12_500n; // 125 %

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

export interface TurnkeyPolicyIntent {
  readonly policyName: string;
  readonly effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  readonly consensus: string;
  readonly condition: string;
  readonly notes: string;
}

export interface EnvelopeInput {
  /** Turnkey user id of the delegated non-root API-key user. */
  readonly delegatedUserId: string;
  readonly allowedNetworks: readonly NetworkId[];
  /** Empty with `restrictRecipients: false` = any recipient (amount cap still applies). */
  readonly restrictRecipients: boolean;
  readonly recipientAllowlist: readonly RecipientAllowlistEntry[];
  readonly perTransactionUsdMinor: UsdMinor;
  /** USD price of ONE whole native unit per family ("150.12"); missing = family not allowed. */
  readonly nativeUsdPrice: {
    readonly solana?: string | undefined;
    readonly evm?: string | undefined;
  };
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

const TURNKEY_ID = /^[A-Za-z0-9-]{1,128}$/;

function quote(value: string): string {
  // Addresses are base58 / 0x-hex: nothing that could break out of a policy string literal.
  if (!/^[A-Za-z0-9]+$/.test(value)) throw new EnvelopeError(`unsafe policy literal: ${value}`);
  return `'${value}'`;
}

/**
 * Native cap in base units for a USD limit: floor(usd * margin / price * 10^decimals).
 * bigint only; a missing or zero price is an error (no cap can be derived = fail closed).
 */
export function nativeCapForUsd(
  usdMinor: UsdMinor,
  unitPriceUsd: string,
  decimals: number,
  marginBps: bigint = ENVELOPE_PRICE_MARGIN_BPS,
): bigint {
  const price = DecimalStringSchema.parse(unitPriceUsd);
  const [whole = "0", fraction = ""] = price.split(".");
  const priceInt = BigInt(whole + fraction);
  if (priceInt === 0n) throw new EnvelopeError("price is zero");
  // usd = usdMinor / 100; native = usd / (priceInt / 10^scale)
  const numerator = BigInt(usdMinor) * marginBps * 10n ** BigInt(decimals + fraction.length);
  const denominator = priceInt * 100n * 10_000n;
  return numerator / denominator;
}

export function buildDelegatedPolicyEnvelope(input: EnvelopeInput): TurnkeyPolicyIntent[] {
  if (!TURNKEY_ID.test(input.delegatedUserId)) throw new EnvelopeError("invalid delegated user id");
  if (BigInt(input.perTransactionUsdMinor) <= 0n)
    throw new EnvelopeError("autonomous mode needs a per-transaction limit above zero");
  const consensus = `approvers.any(user, user.id == '${input.delegatedUserId}')`;
  const recipients = (family: "solana" | "evm") =>
    input.recipientAllowlist
      .filter((r) => r.family === family)
      .map((r) => quote(family === "evm" ? r.address.toLowerCase() : r.address));
  const intents: TurnkeyPolicyIntent[] = [];

  const evmChains = input.allowedNetworks
    .map((n) => NETWORKS[n])
    .filter((n) => n.family === "evm" && n.evmChainId !== null)
    .map((n) => n.evmChainId as number);
  if (evmChains.length > 0) {
    const price = input.nativeUsdPrice.evm;
    if (price === undefined) throw new EnvelopeError("no ETH price: cannot derive the EVM cap");
    const cap = nativeCapForUsd(input.perTransactionUsdMinor, price, 18);
    const to = recipients("evm");
    if (input.restrictRecipients && to.length === 0)
      throw new EnvelopeError("no EVM recipients in the allowlist");
    const clauses = [
      `eth.tx.chain_id in [${[...new Set(evmChains)].sort((a, b) => a - b).join(", ")}]`,
      "eth.tx.data == '0x'",
      `eth.tx.value <= ${cap.toString()}`,
      ...(input.restrictRecipients ? [`eth.tx.to in [${to.join(", ")}]`] : []),
    ];
    intents.push({
      policyName: `${TURNKEY_POLICY_NAME_PREFIX}-evm`,
      effect: "EFFECT_ALLOW",
      consensus,
      condition: clauses.join(" && "),
      notes: "ZyroPay autonomous mode: EVM native transfers within the per-payment cap.",
    });
  }

  const solana = input.allowedNetworks.some((n) => NETWORKS[n].family === "solana");
  if (solana) {
    const price = input.nativeUsdPrice.solana;
    if (price === undefined) throw new EnvelopeError("no SOL price: cannot derive the Solana cap");
    const cap = nativeCapForUsd(input.perTransactionUsdMinor, price, 9);
    const to = recipients("solana");
    if (input.restrictRecipients && to.length === 0)
      throw new EnvelopeError("no Solana recipients in the allowlist");
    const transfer = input.restrictRecipients
      ? `t.to in [${to.join(", ")}] && t.amount <= ${cap.toString()}`
      : `t.amount <= ${cap.toString()}`;
    intents.push({
      policyName: `${TURNKEY_POLICY_NAME_PREFIX}-solana`,
      effect: "EFFECT_ALLOW",
      consensus,
      condition: [
        `solana.tx.program_keys.all(p, p in [${quote(SYSTEM_PROGRAM)}, ${quote(COMPUTE_BUDGET_PROGRAM)}])`,
        `solana.tx.transfers.all(t, ${transfer})`,
      ].join(" && "),
      notes: "ZyroPay autonomous mode: SOL transfers within the per-payment cap.",
    });
    intents.push({
      policyName: `${TURNKEY_POLICY_NAME_PREFIX}-deny-alt`,
      effect: "EFFECT_DENY",
      consensus,
      condition: "solana.tx.account_keys.any(k, k == 'ADDRESS_TABLE_LOOKUP')",
      notes: "ZyroPay circuit breaker: never sign Solana transactions that use lookup tables.",
    });
  }
  if (intents.length === 0) throw new EnvelopeError("no allowed network for autonomous mode");
  return intents;
}

export const TurnkeyPolicyIntentSchema = z.strictObject({
  policyName: z.string().min(1).max(256),
  effect: z.enum(["EFFECT_ALLOW", "EFFECT_DENY"]),
  consensus: z.string().max(4096),
  condition: z.string().max(8192),
  notes: z.string().max(1024),
});
