import { AutoPaySchema } from "../cardano-allowance";
import { z } from "zod";
import { IsoDateTimeSchema } from "../common";
import { BaseUnitAmountSchema, FiatValueSchema, UsdMinorSchema } from "../money";
import { CanonicalTransactionPayloadSchema, PayloadHashSchema } from "../payload";
import { PolicyDecisionSchema, PolicyReasonSchema } from "../policy";
import { TxRequestStateSchema } from "../state-machine";
import { RequestSourceSchema } from "../tools";
import { X402ReceiptSummarySchema } from "../x402-receipt";
import { X402SellerIdentitySchema } from "./masumi";

export const RequesterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.uuid() }),
  z.object({ type: z.literal("agent"), agentId: z.uuid(), userId: z.uuid() }),
]);
export type Requester = z.infer<typeof RequesterSchema>;

export const TransactionRequestSchema = z.object({
  id: z.uuid(),
  walletId: z.uuid(),
  requester: RequesterSchema,
  source: RequestSourceSchema,
  state: TxRequestStateSchema,
  payload: CanonicalTransactionPayloadSchema,
  payloadHash: PayloadHashSchema,
  /** USD valuation at creation (cents); null if no price was available. */
  valuationUsdMinor: UsdMinorSchema.nullable(),
  value: FiatValueSchema.nullable(),
  policyDecision: PolicyDecisionSchema.nullable(),
  policyReasons: z.array(PolicyReasonSchema),
  txHash: z.string().nullable(),
  failureReason: z.string().nullable(),
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  simulated: z.boolean(),
});
export type TransactionRequest = z.infer<typeof TransactionRequestSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.uuid(),
  transactionRequestId: z.uuid(),
  userId: z.uuid(),
  agentId: z.uuid().nullable(),
  status: ApprovalStatusSchema,
  /** The approval is valid only for this exact payload. */
  payloadHash: PayloadHashSchema,
  expiresAt: IsoDateTimeSchema,
  decidedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Hand-off of a signed x402 payment to the resource server (the MCP worker retries the
 * resource with the payment header):
 *  - `awaiting_signature`: not signed yet (pending approval, signing).
 *  - `ready`: signed; the payment header can be fetched and delivered.
 *  - `delivered`: the resource answered the paid retry (see `httpStatus`).
 *  - `closed`: the request ended (rejected, expired, failed, cancelled) before delivery.
 *  - `unsupported`: this network's payments cannot be handed off yet.
 */
export const X402DeliveryStatusSchema = z.enum([
  "awaiting_signature",
  "ready",
  "delivered",
  "closed",
  "unsupported",
]);
export type X402DeliveryStatus = z.infer<typeof X402DeliveryStatusSchema>;

/**
 * Masumi escrow (x402 `assetTransferMethod: "masumi"`, docs/CARDANO_X402.md) of a pay_x402
 * request: the payment is locked at the escrow script and released to the seller only after
 * it submits a result and the unlock time passes; until then the buyer can ask for a refund.
 * `state` is read from the chain (the escrow UTxO's inline datum):
 *  - `locking`: the lock is not on chain yet (not signed, not delivered or not confirmed);
 *  - datum states `funds_locked`, `result_submitted`, `refund_requested`, `disputed`,
 *    `withdraw_authorized`, `refund_authorized`;
 *  - `refunded`: ZyroPay's refund withdrawal confirmed; `withdrawn`: the escrow was spent by
 *    another transaction (the seller collected, or the admins settled a dispute);
 *  - `failed`: the lock never landed; `unknown`: the chain could not be read just now.
 */
export const X402EscrowStateSchema = z.enum([
  "locking",
  "funds_locked",
  "result_submitted",
  "refund_requested",
  "disputed",
  "withdraw_authorized",
  "refund_authorized",
  "refunded",
  "withdrawn",
  "failed",
  "unknown",
]);
export type X402EscrowState = z.infer<typeof X402EscrowStateSchema>;

/**
 * Buyer actions on an escrow: `request_refund` (Masumi SetRefundRequested) and
 * `withdraw_refund` (WithdrawRefund: after the seller authorized the refund, or once
 * submitResultTime passed without a result).
 */
export const X402EscrowActionSchema = z.enum(["request_refund", "withdraw_refund"]);
export type X402EscrowAction = z.infer<typeof X402EscrowActionSchema>;

const TxIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * "Proof before release" (docs/CARDANO_X402.md): ZyroPay's verdict on whether what the agent
 * received is the result the seller was paid for.
 *  - `pending`: nothing to compare yet (no on-chain result, or no delivery report yet);
 *  - `verified`: SHA-256 of the body the agent received equals the escrow's on-chain
 *    `result_hash` (the seller's SubmitResult);
 *  - `mismatch`: the two differ: the seller recorded another result than it delivered;
 *  - `not_delivered`: the submitResult deadline passed without an on-chain result;
 *  - `unverifiable`: the seller recorded a result but the agent's body could not be hashed
 *    (truncated or not textual);
 *  - `receipt_only`: a direct (non-escrow) payment: nothing is recorded on chain, only the
 *    signed delivery receipt (`receipt`) speaks for the delivery.
 */
export const X402ProofStateSchema = z.enum([
  "pending",
  "verified",
  "mismatch",
  "not_delivered",
  "unverifiable",
  "receipt_only",
]);
export type X402ProofState = z.infer<typeof X402ProofStateSchema>;

export const X402ProofSchema = z.object({
  state: X402ProofStateSchema,
  /** SHA-256 (hex) of the body the agent received, computed by ZyroPay's MCP worker. */
  receivedHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** The escrow datum's `result_hash` recorded by the seller (null: none / direct payment). */
  onChainHash: z
    .string()
    .regex(/^(?:[0-9a-f]{2}){1,64}$/)
    .nullable(),
  /** The seller's SubmitResult transaction, when ZyroPay saw it. */
  resultTx: TxIdSchema.nullable(),
  /** When the verdict was last evaluated (the chain read, or the delivery). */
  checkedAt: IsoDateTimeSchema.nullable(),
  /** One sentence for the user (and the agent to relay). */
  message: z.string().max(400),
});
export type X402Proof = z.infer<typeof X402ProofSchema>;

export const X402EscrowSchema = z.object({
  method: z.literal("masumi"),
  state: X402EscrowStateSchema,
  /** The Masumi escrow script address the payment is locked at. */
  escrowAddress: z.string(),
  /** The seller (datum `seller`): who receives the payment when the escrow releases. */
  sellerAddress: z.string(),
  /** Transaction id of the lock (known once signed). */
  lockTx: TxIdSchema.nullable(),
  /** The escrow UTxO as `<txHash>#<index>` (moves when a refund is requested). */
  utxo: z.string().nullable(),
  /** Lovelace locked: the price (ADA payments) plus `collateralLovelace`. */
  lockedLovelace: BaseUnitAmountSchema,
  /** Extra lovelace locked for the min-UTxO; it returns to the buyer in every outcome. */
  collateralLovelace: BaseUnitAmountSchema,
  /** Seller-signed deadlines (ISO). */
  deadlines: z.object({
    payBy: IsoDateTimeSchema,
    submitResult: IsoDateTimeSchema,
    unlock: IsoDateTimeSchema,
    externalDisputeUnlock: IsoDateTimeSchema,
  }),
  /** Hash of the seller's submitted result (datum `result_hash`), null while none. */
  resultHash: z.string().nullable(),
  /** Received body vs on-chain result (never `receipt_only` here); null once the lock failed. */
  proof: X402ProofSchema.nullable(),
  refund: z.object({
    /** Buyer actions possible right now (empty while none is). */
    available: z.array(X402EscrowActionSchema),
    /**
     * The action ZyroPay recommends (the proof failed: `mismatch` or `not_delivered`), one of
     * `available`; null when none is recommended.
     */
    recommended: X402EscrowActionSchema.nullable(),
    /** Why `recommended` is recommended (shown to the user). */
    reason: z.string().max(400).nullable(),
    /** When `withdraw_refund` becomes possible without the seller (submitResult deadline). */
    withdrawableAt: IsoDateTimeSchema.nullable(),
    /** The buyer action in flight, if any. */
    pending: z
      .object({
        action: X402EscrowActionSchema,
        status: z.enum(["awaiting_signature", "submitted", "confirmed", "failed"]),
        txHash: TxIdSchema.nullable(),
        updatedAt: IsoDateTimeSchema,
      })
      .nullable(),
    /** Confirmed buyer transactions. */
    requestTx: TxIdSchema.nullable(),
    withdrawTx: TxIdSchema.nullable(),
  }),
  /** When the chain was last read for `state` (null: never). */
  checkedAt: IsoDateTimeSchema.nullable(),
});
export type X402Escrow = z.infer<typeof X402EscrowSchema>;

export const X402DeliverySchema = z.object({
  status: X402DeliveryStatusSchema,
  resourceUrl: z.url(),
  /** HTTP status of the paid retry, once delivered. */
  httpStatus: z.number().int().min(100).max(599).nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  /**
   * Verified delivery receipt (docs/CARDANO_X402.md): whether the delivered body was signed
   * by the key behind the paid address. Null until a successful delivery is reported.
   */
  receipt: X402ReceiptSummarySchema.nullable(),
  /**
   * Proof before release: the escrow's verdict (`escrow.proof`), or `receipt_only` for a
   * delivered direct payment; null while there is nothing to judge.
   */
  proof: X402ProofSchema.nullable(),
  /** Present when the payment is a Masumi escrow lock. */
  escrow: X402EscrowSchema.optional(),
  /**
   * The seller's Masumi registry identity verified when quoting ("Registered Masumi agent ·
   * <name>" / "Unregistered seller"); null for direct payments. Absent from older servers.
   */
  sellerIdentity: X402SellerIdentitySchema.nullable().optional(),
});
export type X402Delivery = z.infer<typeof X402DeliverySchema>;

/** What a requester (MCP tool, app) gets back after creating or polling a request. */
export const TransactionRequestResultSchema = z.object({
  requestId: z.uuid(),
  state: TxRequestStateSchema,
  decision: PolicyDecisionSchema.nullable(),
  reasons: z.array(PolicyReasonSchema),
  payloadHash: PayloadHashSchema,
  /** Deep link the agent can show the human, e.g. zyropay://approvals/<id>. */
  approvalUrl: z.string().nullable(),
  txHash: z.string().nullable(),
  explorerUrl: z.url().nullable(),
  expiresAt: IsoDateTimeSchema,
  simulated: z.boolean(),
  /**
   * Why a FAILED / CANCELLED / EXPIRED request ended, in words an agent can relay (null
   * otherwise). A reason starting "could not build the transaction" means nothing was
   * signed: retrying with the same idempotencyKey makes a new attempt.
   */
  failureReason: z.string().nullable().optional(),
  /** Present for pay_x402 requests only. */
  x402: X402DeliverySchema.optional(),
  /**
   * Present when the request was (or is being) auto-paid from the agent's on-chain Cardano
   * allowance, without a passkey tap (docs/AUTOPAY.md).
   */
  autoPay: AutoPaySchema.optional(),
});
export type TransactionRequestResult = z.infer<typeof TransactionRequestResultSchema>;
