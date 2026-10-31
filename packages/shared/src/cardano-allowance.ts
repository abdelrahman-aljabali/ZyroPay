/*
 * Auto-pay on Cardano (docs/AUTOPAY.md): the agent allowance contract as the app and the API
 * both see it. Pure and dependency-light so the device can check, without trusting the API:
 *
 *  - the owner's allowance script address (the validator parameterized by the owner's payment
 *    key hash, applied exactly like @zyropay/blockchain's `allowanceScript`);
 *  - the inline datum, encoded from the limits the review shows, byte for byte;
 *  - whether a payment may be auto-paid (`evaluateAutoPay`), the pure decision the API runs
 *    after the agent policy, against the allowance as read from the chain.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { cardanoAddressFromBytes, parseShelleyAddress } from "./cardano";
import { ALLOWANCE_UNAPPLIED_SCRIPT_HEX } from "./cardano-allowance-script";
import { IsoDateTimeSchema } from "./common";
import { BaseUnitAmountSchema, DecimalStringSchema } from "./money";
import type { NetworkId } from "./networks";
import { cardanoNetworkId } from "./networks";
import type { PolicyEvaluation, PolicyReason } from "./policy";

export { ALLOWANCE_UNAPPLIED_SCRIPT_HEX } from "./cardano-allowance-script";

// --- minimal CBOR (definite lengths only) -------------------------------------------------

function head(major: number, n: bigint): number[] {
  const m = major << 5;
  if (n < 24n) return [m | Number(n)];
  const widths: [number, number][] = [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ];
  for (const [ai, len] of widths) {
    if (n < 1n << BigInt(8 * len)) {
      const out = [m | ai];
      for (let i = len - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
      return out;
    }
  }
  throw new Error("CBOR integer out of range");
}
const cborUint = (n: bigint): number[] => {
  if (n < 0n) throw new Error("negative integer");
  return head(0, n);
};
const cborBytes = (b: Uint8Array): number[] => [...head(2, BigInt(b.length)), ...b];
const cborArray = (items: number[][]): number[] => [
  ...head(4, BigInt(items.length)),
  ...items.flat(),
];
/** Plutus Data constructor 0..6 (tag 121 + i). */
const constr = (i: number, fields: number[][]): number[] => [
  ...head(6, BigInt(121 + i)),
  ...cborArray(fields),
];

// --- the owner-applied script ----------------------------------------------------------

/** Flat bits of `[[(lam a (lam f [f a])) (con data <owner>)] T]` up to the data constant. */
const APPLY_HEAD = [0x33, 0x22, 0x30, 0x01, 0x00, 0x24, 0xc1];
const HASH28 = /^[0-9a-f]{56}$/;

function unwrapBytes(cbor: Uint8Array): Uint8Array {
  const ai = (cbor[0] ?? 0) & 0x1f;
  if ((cbor[0] ?? 0) >> 5 !== 2) throw new Error("script is not a bytestring");
  const lenBytes = ai < 24 ? 0 : ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : -1;
  if (lenBytes < 0) throw new Error("unsupported script length");
  return cbor.subarray(1 + lenBytes);
}

/**
 * The owner-applied validator as its witness-set bytes (a CBOR bytestring), equal to
 * @zyropay/blockchain `allowanceScript(network, owner).script`.
 */
export function allowanceAppliedScript(ownerKeyHash: string): Uint8Array {
  if (!HASH28.test(ownerKeyHash)) throw new Error("owner key hash must be 28 bytes (hex)");
  const flat = unwrapBytes(hexToBytes(ALLOWANCE_UNAPPLIED_SCRIPT_HEX));
  if (flat[0] !== 1 || flat[1] !== 1 || flat[2] !== 0) throw new Error("expected UPLC 1.1.0");
  const data = cborBytes(hexToBytes(ownerKeyHash));
  const applied = Uint8Array.from([
    1,
    1,
    0,
    ...APPLY_HEAD,
    data.length,
    ...data,
    0,
    ...flat.subarray(3),
  ]);
  return Uint8Array.from(cborBytes(applied));
}

const scriptHashCache = new Map<string, string>();

/** PlutusV3 script hash (blake2b-224 of 0x03 || script) of the owner's allowance. */
export function allowanceScriptHash(ownerKeyHash: string): string {
  const cached = scriptHashCache.get(ownerKeyHash);
  if (cached !== undefined) return cached;
  const script = allowanceAppliedScript(ownerKeyHash);
  const tagged = new Uint8Array(script.length + 1);
  tagged[0] = 0x03;
  tagged.set(script, 1);
  const hash = bytesToHex(blake2b(tagged, { dkLen: 28 }));
  if (scriptHashCache.size > 256) scriptHashCache.clear();
  scriptHashCache.set(ownerKeyHash, hash);
  return hash;
}

/** Enterprise script address of the owner's allowance on `network`. */
export function allowanceScriptAddress(network: NetworkId, ownerKeyHash: string): string {
  const bytes = new Uint8Array(29);
  bytes[0] = 0x70 | cardanoNetworkId(network);
  bytes.set(hexToBytes(allowanceScriptHash(ownerKeyHash)), 1);
  const address = cardanoAddressFromBytes(bytes);
  if (address === null) throw new Error("allowance address encoding failed");
  return address;
}

// --- datum ---------------------------------------------------------------------------

const UintStringSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);

export const AllowancePayeeViewSchema = z.object({
  kind: z.enum(["key", "script"]),
  hash: z.string().regex(HASH28),
});
export type AllowancePayeeView = z.infer<typeof AllowancePayeeViewSchema>;

/** The allowance datum with every integer as a decimal string (JSON-safe). */
export const AllowanceDatumViewSchema = z.object({
  agentKeyHash: z.string().regex(HASH28),
  perPaymentMax: UintStringSchema,
  periodMs: UintStringSchema,
  periodCap: UintStringSchema,
  /** POSIX ms. */
  periodStart: UintStringSchema,
  spentInPeriod: UintStringSchema,
  allowedPayees: z.array(AllowancePayeeViewSchema).max(16),
  /** POSIX ms. */
  expiresAt: UintStringSchema,
});
export type AllowanceDatumView = z.infer<typeof AllowanceDatumViewSchema>;

/** Plutus Data CBOR (hex) of the datum; equals @zyropay/blockchain `encodeAllowanceDatum`. */
export function encodeAllowanceDatumHex(d: AllowanceDatumView): string {
  const parsed = AllowanceDatumViewSchema.parse(d);
  return bytesToHex(
    Uint8Array.from(
      constr(0, [
        cborBytes(hexToBytes(parsed.agentKeyHash)),
        cborUint(BigInt(parsed.perPaymentMax)),
        cborUint(BigInt(parsed.periodMs)),
        cborUint(BigInt(parsed.periodCap)),
        cborUint(BigInt(parsed.periodStart)),
        cborUint(BigInt(parsed.spentInPeriod)),
        cborArray(
          parsed.allowedPayees.map((p) =>
            constr(p.kind === "key" ? 0 : 1, [cborBytes(hexToBytes(p.hash))]),
          ),
        ),
        cborUint(BigInt(parsed.expiresAt)),
      ]),
    ),
  );
}

/** The payment credential of an address as an allowance payee; null if it has none. */
export function allowancePayeeOf(address: string): AllowancePayeeView | null {
  const payment = parseShelleyAddress(address)?.payment ?? null;
  return payment === null ? null : { kind: payment.kind, hash: payment.hash };
}

/** Window start and spent amount the validator would use for a spend at `lowerMs`. */
export function allowancePeriodAt(
  d: Pick<AllowanceDatumView, "periodStart" | "periodMs" | "spentInPeriod">,
  lowerMs: bigint,
): { start: bigint; spent: bigint } {
  const start = BigInt(d.periodStart);
  const period = BigInt(d.periodMs);
  if (period <= 0n || lowerMs < start + period) return { start, spent: BigInt(d.spentInPeriod) };
  return { start: start + ((lowerMs - start) / period) * period, spent: 0n };
}

// --- API shapes ------------------------------------------------------------------------

export const ALLOWANCE_FIAT_CURRENCIES = ["EUR", "USD"] as const;

/** An amount given in lovelace, or in fiat to convert at creation with the price service. */
export const AllowanceMoneySchema = z.union([
  z.strictObject({ lovelace: BaseUnitAmountSchema }),
  z.strictObject({
    fiat: z.strictObject({
      currency: z.enum(ALLOWANCE_FIAT_CURRENCIES),
      amount: DecimalStringSchema,
    }),
  }),
]);
export type AllowanceMoney = z.infer<typeof AllowanceMoneySchema>;

export const AllowancePayeesSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("any") }),
  z.strictObject({
    mode: z.literal("list"),
    addresses: z.array(z.string().min(1).max(200)).min(1).max(16),
  }),
]);
export type AllowancePayees = z.infer<typeof AllowancePayeesSchema>;

export const ALLOWANCE_STATUSES = [
  "pending_create",
  "creating",
  "active",
  "exhausted",
  "expired",
  "revoking",
  "revoked",
  "failed",
] as const;
export const AllowanceStatusSchema = z.enum(ALLOWANCE_STATUSES);
export type AllowanceStatus = z.infer<typeof AllowanceStatusSchema>;

export const CardanoAllowanceSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  walletId: z.uuid(),
  network: z.string(),
  status: AllowanceStatusSchema,
  ownerAddress: z.string(),
  scriptAddress: z.string(),
  agentAddress: z.string(),
  limits: z.object({
    perPaymentLovelace: BaseUnitAmountSchema,
    perDayLovelace: BaseUnitAmountSchema,
    periodMs: BaseUnitAmountSchema,
    expiresAt: IsoDateTimeSchema,
    payees: AllowancePayeesSchema,
    fiat: z
      .object({
        currency: z.enum(ALLOWANCE_FIAT_CURRENCIES),
        perPayment: DecimalStringSchema.nullable(),
        perDay: DecimalStringSchema.nullable(),
        budget: DecimalStringSchema.nullable(),
        adaPrice: DecimalStringSchema,
        pricedAt: IsoDateTimeSchema,
      })
      .nullable(),
  }),
  budgetLovelace: BaseUnitAmountSchema,
  floatLovelace: BaseUnitAmountSchema,
  onChain: z
    .object({
      utxo: z.string(),
      balanceLovelace: BaseUnitAmountSchema,
      spentInPeriodLovelace: BaseUnitAmountSchema,
      periodStart: IsoDateTimeSchema,
      periodEndsAt: IsoDateTimeSchema,
      remainingTodayLovelace: BaseUnitAmountSchema,
      availableNowLovelace: BaseUnitAmountSchema,
      readAt: IsoDateTimeSchema,
    })
    .nullable(),
  float: z
    .object({ lovelace: BaseUnitAmountSchema, low: z.boolean(), readAt: IsoDateTimeSchema })
    .nullable(),
  createTxHash: z.string().nullable(),
  lastTxHash: z.string().nullable(),
  inFlightRequestId: z.uuid().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CardanoAllowance = z.infer<typeof CardanoAllowanceSchema>;

const HexTxSchema = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const BodyHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const AllowanceReviewExpectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    owner: z.string(),
    ownerKeyHash: z.string().regex(HASH28),
    agentAddress: z.string(),
    allowanceLovelace: BaseUnitAmountSchema,
    floatLovelace: BaseUnitAmountSchema,
    datum: AllowanceDatumViewSchema,
    maxFeeLovelace: BaseUnitAmountSchema,
  }),
  z.object({
    kind: z.literal("top_up"),
    owner: z.string(),
    utxo: z.string(),
    newLovelace: BaseUnitAmountSchema,
    datum: AllowanceDatumViewSchema,
    maxFeeLovelace: BaseUnitAmountSchema,
    validFrom: IsoDateTimeSchema,
    validUntil: IsoDateTimeSchema,
  }),
  z.object({
    kind: z.literal("revoke"),
    owner: z.string(),
    utxo: z.string(),
    maxFeeLovelace: BaseUnitAmountSchema,
    validFrom: IsoDateTimeSchema,
    validUntil: IsoDateTimeSchema,
  }),
]);
export type AllowanceReviewExpect = z.infer<typeof AllowanceReviewExpectSchema>;

export const AllowanceReviewSchema = z.object({
  action: z.enum(["create", "top_up", "revoke"]),
  allowanceId: z.uuid(),
  unsignedTransaction: z.object({ encoding: z.literal("hex"), serialized: HexTxSchema }),
  rawPayload: z.object({
    kind: z.literal("cardano_tx_body_hash"),
    payload: BodyHashSchema,
    signWith: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  estimatedFee: z.object({ lovelace: BaseUnitAmountSchema }),
  validUntil: IsoDateTimeSchema,
  expect: AllowanceReviewExpectSchema,
});
export type AllowanceReview = z.infer<typeof AllowanceReviewSchema>;

export const AllowanceSpendSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  tool: z.enum(["send", "pay_x402"]),
  payee: z.string(),
  lovelace: BaseUnitAmountSchema,
  txHash: z.string(),
  status: z.enum(["signed", "submitted", "confirmed", "failed"]),
  createdAt: IsoDateTimeSchema,
});
export type AllowanceSpend = z.infer<typeof AllowanceSpendSchema>;

export const CreateAllowanceBodySchema = z.strictObject({
  walletId: z.uuid(),
  network: z.literal("cardano-preprod"),
  budget: AllowanceMoneySchema,
  perPayment: AllowanceMoneySchema,
  perDay: AllowanceMoneySchema,
  payees: AllowancePayeesSchema,
  expiresInDays: z.number().int().min(1).max(90),
  floatLovelace: BaseUnitAmountSchema.optional(),
});
export type CreateAllowanceBody = z.infer<typeof CreateAllowanceBodySchema>;

export const TopUpAllowanceBodySchema = z.strictObject({ budget: AllowanceMoneySchema });

/** Shown on a request result when the request was (or is being) auto-paid. */
export const AutoPaySchema = z.object({
  allowanceId: z.uuid(),
  txHash: z.string().nullable(),
  lovelace: BaseUnitAmountSchema,
  remainingTodayLovelace: BaseUnitAmountSchema.nullable(),
  balanceLovelace: BaseUnitAmountSchema.nullable(),
  periodEndsAt: IsoDateTimeSchema.nullable(),
  /** A sentence the agent can relay to the user as is. */
  message: z.string().max(400).optional(),
});
export type AutoPay = z.infer<typeof AutoPaySchema>;

// --- auto-pay decision -------------------------------------------------------------------

/** Float (agent ADA) a payment needs: fee (~0.3 ADA) + a pure-ADA collateral and change. */
export const ALLOWANCE_MIN_FLOAT_LOVELACE = 2_000_000n;
/** Lovelace the continuing allowance output keeps (min-UTxO with the inline datum, rounded up). */
export const ALLOWANCE_MIN_RESIDUE_LOVELACE = 2_000_000n;
/** Float the create sends when none is given (~15 payments). */
export const ALLOWANCE_DEFAULT_FLOAT_LOVELACE = 5_000_000n;
/** How far behind the wall clock a spend's validity lower bound may start. */
export const ALLOWANCE_LOWER_BOUND_SLACK_MS = 120_000n;

/** The live allowance an auto-pay decision is made against (read from the chain). */
export interface AutoPayAllowance {
  readonly walletId: string;
  readonly network: NetworkId;
  readonly datum: AllowanceDatumView;
  readonly balanceLovelace: bigint;
  readonly floatLovelace: bigint;
  /** Another spend of this allowance is signed but not confirmed yet. */
  readonly busy: boolean;
}

export interface AutoPayRequest {
  readonly tool: "send" | "pay_x402" | "swap";
  readonly network: NetworkId;
  readonly walletId: string;
  /** Native ADA (no token). */
  readonly native: boolean;
  /** pay_x402 into Masumi escrow. */
  readonly escrow: boolean;
  readonly payee: string;
  readonly lovelace: bigint;
}

export type AutoPayDecision =
  | { readonly route: "allowance"; readonly evaluation: PolicyEvaluation }
  | { readonly route: "policy"; readonly evaluation: PolicyEvaluation };

/** Agent-policy reasons an allowance answers for (its limits are enforced on chain). */
const COVERED: ReadonlySet<string> = new Set(["ALWAYS_ASK", "AUTONOMY_NOT_SUPPORTED"]);

/**
 * Whether a request the agent policy sends to approval may be auto-paid from the allowance.
 * Never weakens a deny or an allow, and never turns an approval into a deny: when the
 * allowance does not cover the request, the evaluation comes back unchanged except for one
 * added ALLOWANCE_* reason saying why the passkey is needed. `nowMs` is the wall clock; the
 * window is checked at `nowMs - ALLOWANCE_LOWER_BOUND_SLACK_MS` and at `nowMs`, so the
 * spend's actual lower bound cannot fall on the other side of a roll-over.
 */
export function evaluateAutoPay(
  evaluation: PolicyEvaluation,
  request: AutoPayRequest,
  allowance: AutoPayAllowance | null,
  nowMs: bigint,
): AutoPayDecision {
  const policy = (reason?: PolicyReason): AutoPayDecision => ({
    route: "policy",
    evaluation:
      reason === undefined
        ? evaluation
        : { ...evaluation, reasons: [...evaluation.reasons, reason] },
  });
  if (allowance === null || evaluation.decision !== "require_approval") return policy();
  if (request.tool === "swap" || request.network !== allowance.network) return policy();
  if (!evaluation.reasons.every((r) => COVERED.has(r.code))) return policy();
  const fallback = (
    code:
      | "ALLOWANCE_PAYEE_NOT_LISTED"
      | "ALLOWANCE_LIMIT_EXCEEDED"
      | "ALLOWANCE_INSUFFICIENT"
      | "ALLOWANCE_EXPIRED"
      | "ALLOWANCE_BUSY"
      | "ALLOWANCE_UNAVAILABLE",
    message: string,
  ) => policy({ code, message });
  if (request.walletId !== allowance.walletId)
    return fallback("ALLOWANCE_UNAVAILABLE", "the allowance belongs to another wallet");
  if (!request.native || request.escrow)
    return fallback("ALLOWANCE_UNAVAILABLE", "only direct ADA payments are auto-paid");
  const d = allowance.datum;
  const payee = allowancePayeeOf(request.payee);
  if (payee === null) return fallback("ALLOWANCE_PAYEE_NOT_LISTED", "the payee has no credential");
  if (
    d.allowedPayees.length > 0 &&
    !d.allowedPayees.some((p) => p.kind === payee.kind && p.hash === payee.hash)
  )
    return fallback("ALLOWANCE_PAYEE_NOT_LISTED", "the payee is not on the allowance's list");
  // The validity upper bound must stay <= expiresAt: leave room for a 10-minute window.
  if (nowMs + 600_000n > BigInt(d.expiresAt))
    return fallback("ALLOWANCE_EXPIRED", "the allowance has expired");
  if (nowMs - ALLOWANCE_LOWER_BOUND_SLACK_MS < BigInt(d.periodStart))
    return fallback("ALLOWANCE_UNAVAILABLE", "the allowance's first window has not started");
  if (request.lovelace <= 0n) return fallback("ALLOWANCE_LIMIT_EXCEEDED", "nothing to pay");
  if (request.lovelace > BigInt(d.perPaymentMax))
    return fallback("ALLOWANCE_LIMIT_EXCEEDED", "over the allowance's per-payment limit");
  const cap = BigInt(d.periodCap);
  for (const at of [nowMs - ALLOWANCE_LOWER_BOUND_SLACK_MS, nowMs]) {
    if (allowancePeriodAt(d, at).spent + request.lovelace > cap)
      return fallback("ALLOWANCE_LIMIT_EXCEEDED", "over the allowance's daily limit");
  }
  if (allowance.balanceLovelace - request.lovelace < ALLOWANCE_MIN_RESIDUE_LOVELACE)
    return fallback("ALLOWANCE_INSUFFICIENT", "the allowance holds too little");
  if (allowance.floatLovelace < ALLOWANCE_MIN_FLOAT_LOVELACE)
    return fallback("ALLOWANCE_INSUFFICIENT", "the agent's ADA for fees is too low; top it up");
  if (allowance.busy)
    return fallback("ALLOWANCE_BUSY", "another payment from the allowance is still confirming");
  return {
    route: "allowance",
    evaluation: {
      decision: "allow",
      reasons: [
        {
          code: "AUTO_PAY_ALLOWANCE",
          message: "paid from your on-chain allowance (limits enforced by the Cardano ledger)",
        },
      ],
      policyVersion: evaluation.policyVersion,
    },
  };
}
