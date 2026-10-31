/*
 * Hand-off of signed x402 payments to the resource server. The MCP worker (which never
 * signs) fetches the payment header for its agent's request, retries the resource with it,
 * and reports what the resource answered.
 *
 * Cardano is the only family handed off today: the signed transaction is complete and its
 * id (the body hash) is known before settlement, so the request moves to BROADCAST under
 * that id at hand-off and the confirmation tracker follows it on chain exactly like any
 * broadcast transfer (CONFIRMED settles the reservation; a TTL that passes without the
 * transaction landing fails it and releases the reservation). Handing the same bytes over
 * twice cannot pay twice: the transaction's inputs can be spent once. The reported receipt
 * is recorded for display and audit only; a different transaction id is flagged, never
 * adopted.
 *
 * Verified delivery (docs/CARDANO_X402.md): the seller may sign the paid body with the key
 * behind payTo (X-Delivery-Receipt). The MCP worker forwards that header with ITS OWN
 * SHA-256 of the bytes it received; this service checks, independently of both, that the
 * key hashes to payTo's payment credential, the signature is valid, the receipt names the
 * bound resource URL (and the signed transaction), and the hashes agree.
 */
import type {
  JsonObject,
  TransactionRequestResult,
  X402Delivery,
  X402Escrow,
  X402DeliveryStatus,
  X402Proof,
  X402ReceiptSummary,
  X402SellerIdentity,
} from "@zyropay/shared";
import type { EndpointBody } from "@zyropay/shared";
import {
  chainFamilyOf,
  decodeX402Receipt,
  isTerminalState,
  verifyX402Receipt,
  X402ReceiptSummarySchema,
} from "@zyropay/shared";
import { x402PaymentHeader } from "@zyropay/integrations";
import { and, eq } from "drizzle-orm";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import { loadActiveAgent } from "./agents";
import { audit } from "./audit";
import { markBroadcast } from "./execution";
import type { TxRequestRow } from "./mappers";
import { toRequestResult } from "./mappers";
import { approvalFor } from "./requests";
import { autoPayOf } from "./allowances";
import type { Artifacts } from "./build";
import { escrowTermsOf, refreshEscrow } from "./escrow-view";
import { getArtifacts, upsertArtifacts } from "./tx-state";

const HANDED_OFF_STATES = new Set(["SIGNING", "BROADCAST", "CONFIRMED"]);

function resourceUrlOf(row: TxRequestRow): string | null {
  const url = row.payload.pluginData?.resourceUrl;
  return typeof url === "string" ? url : null;
}

function methodOf(row: TxRequestRow): "GET" | "POST" {
  return row.payload.pluginData?.method === "POST" ? "POST" : "GET";
}

/** The receipt verdict recorded with the delivery report, if any. */
function storedReceipt(artifacts: Artifacts | null): X402ReceiptSummary | null {
  const parsed = X402ReceiptSummarySchema.safeParse(artifacts?.x402Report?.receipt);
  return parsed.success ? parsed.data : null;
}

/**
 * Proof verdict of a delivery: the escrow's (on-chain result vs received body) or, for a
 * direct payment, `receipt_only` once delivered (no result hash is recorded on chain).
 */
function proofOf(
  row: TxRequestRow,
  receipt: X402ReceiptSummary | null,
  deliveredAt: Date | null,
  escrow: X402Escrow | undefined,
): X402Proof | null {
  if (escrow !== undefined) return escrow.proof;
  if (escrowTermsOf(row) !== null || deliveredAt === null) return null;
  return {
    state: "receipt_only",
    receivedHash: receipt?.contentSha256 ?? null,
    onChainHash: null,
    resultTx: null,
    checkedAt: deliveredAt.toISOString(),
    message:
      receipt?.verified === true
        ? "Direct payment: no result is recorded on chain; the seller's signed delivery receipt matches what your agent received."
        : "Direct payment: no result is recorded on chain, and the delivery has no valid signed receipt.",
  };
}

/**
 * The seller identity bound into an escrow payment when it was quoted: a registry claim is
 * bound only after it verified on chain (integrations/masumi.ts), so a bound identifier is a
 * registered agent. Null for a direct payment (no identity claim exists there).
 */
function sellerIdentityOf(row: TxRequestRow): X402SellerIdentity | null {
  const terms = escrowTermsOf(row);
  if (terms === null) return null;
  const agentIdentifier = terms.agentIdentifier ?? null;
  return agentIdentifier !== null
    ? { registered: true, agentIdentifier, name: terms.agentName ?? null, reasons: [] }
    : { registered: false, agentIdentifier: null, name: null, reasons: ["not_claimed"] };
}

/**
 * Delivery state of a pay_x402 request (undefined for any other request), with the Masumi
 * escrow view when the payment is an escrow lock (services/escrow-view.ts).
 */
export function x402DeliveryOf(
  row: TxRequestRow,
  artifacts: Artifacts | null,
  escrow?: X402Escrow,
): X402Delivery | undefined {
  if (row.payload.plugin !== "x402") return undefined;
  const resourceUrl = resourceUrlOf(row);
  if (resourceUrl === null) return undefined;
  const deliveredAt = artifacts?.x402DeliveredAt ?? null;
  let status: X402DeliveryStatus;
  if (deliveredAt !== null) status = "delivered";
  else if (isTerminalState(row.state) && row.state !== "CONFIRMED") status = "closed";
  else if (!HANDED_OFF_STATES.has(row.state)) status = "awaiting_signature";
  else if (chainFamilyOf(row.network) !== "cardano") status = "unsupported";
  else if (artifacts?.signedTransaction == null || artifacts.expectedTxHash === null)
    status = "awaiting_signature";
  else status = "ready";
  const receipt = deliveredAt === null ? null : storedReceipt(artifacts);
  return {
    status,
    resourceUrl,
    httpStatus: artifacts?.x402HttpStatus ?? null,
    deliveredAt: deliveredAt?.toISOString() ?? null,
    receipt,
    proof: proofOf(row, receipt, deliveredAt, escrow),
    ...(escrow !== undefined ? { escrow } : {}),
    sellerIdentity: sellerIdentityOf(row),
  };
}

/** Same URL after WHATWG normalisation (what the API bound and what the seller signed). */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** Independent check of the seller's delivery receipt against what ZyroPay bound. */
function checkReceipt(
  row: TxRequestRow,
  artifacts: Artifacts,
  reported: NonNullable<EndpointBody<"internalReportX402Delivery">["receipt"]> | undefined,
): X402ReceiptSummary {
  const contentSha256 = reported?.contentSha256 ?? null;
  const verdict = (reason: X402ReceiptSummary["reason"]): X402ReceiptSummary => ({
    verified: false,
    contentSha256,
    signedBy: null,
    signedAt: null,
    reason,
  });
  if (reported?.header == null) return verdict("missing");
  if (chainFamilyOf(row.network) !== "cardano") return verdict("unsupported_network");
  const receipt = decodeX402Receipt(reported.header);
  if (receipt === null) return verdict("malformed");
  const boundUrl = resourceUrlOf(row);
  // An escrow payment pays the script; the seller (who signs receipts) is in the terms.
  const payTo = escrowTermsOf(row)?.sellerAddress ?? row.payload.to;
  const check = verifyX402Receipt(receipt, {
    payTo,
    sameResource: (url) => boundUrl !== null && sameUrl(url, boundUrl),
    contentSha256,
    paymentTx: artifacts.expectedTxHash,
  });
  if (!check.ok) return verdict(check.reason);
  return {
    verified: true,
    contentSha256,
    signedBy: receipt.payTo,
    signedAt: receipt.signedAt,
    reason: null,
  };
}

/** toRequestResult plus the x402 delivery state, for the agent-facing internal endpoints. */
export async function agentRequestResult(
  ctx: Ctx,
  row: TxRequestRow,
): Promise<TransactionRequestResult> {
  const { deps } = ctx;
  const base = toRequestResult(row, await approvalFor(deps.db, row.id), deps.config.deepLinkScheme);
  const autoPay = await autoPayOf(deps.db, row);
  const result = autoPay === null ? base : { ...base, autoPay };
  if (row.payload.plugin !== "x402") return result;
  const artifacts = await getArtifacts(deps.db, row.id);
  const escrow = await refreshEscrow(ctx, row, artifacts);
  const x402 = x402DeliveryOf(row, artifacts, escrow);
  return x402 === undefined ? result : { ...result, x402 };
}

async function loadAgentRequest(
  ctx: Ctx,
  agentId: string,
  requestId: string,
): Promise<{ row: TxRequestRow; agentId: string }> {
  const { agent, policy } = await loadActiveAgent(ctx, agentId);
  if (!policy.allowedTools.includes("get_approval_status"))
    throw new AppError("FORBIDDEN", "tool get_approval_status is not allowed");
  const [row] = await ctx.deps.db
    .select()
    .from(t.transactionRequests)
    .where(
      and(eq(t.transactionRequests.id, requestId), eq(t.transactionRequests.agentId, agent.id)),
    );
  if (row === undefined) throw notFound("transaction request");
  if (row.payload.plugin !== "x402") throw new AppError("BAD_REQUEST", "not an x402 payment");
  return { row, agentId: agent.id };
}

export async function getX402Payment(
  ctx: Ctx,
  agentId: string,
  requestId: string,
): Promise<{
  resourceUrl: string;
  method: "GET" | "POST";
  header: { name: "PAYMENT-SIGNATURE" | "X-PAYMENT"; value: string };
  txHash: string | null;
}> {
  const { deps } = ctx;
  const { row } = await loadAgentRequest(ctx, agentId, requestId);
  const artifacts = await getArtifacts(deps.db, row.id);
  const delivery = x402DeliveryOf(row, artifacts);
  if (delivery?.status === "unsupported")
    throw new AppError("CONFLICT", "x402 payments on this network cannot be delivered yet");
  if (delivery?.status === "closed")
    throw new AppError("CONFLICT", "this payment did not go through");
  if (
    delivery === undefined ||
    artifacts?.signedTransaction == null ||
    artifacts.expectedTxHash === null ||
    !HANDED_OFF_STATES.has(row.state)
  )
    throw new AppError("CONFLICT", "the payment is not signed yet");
  const txHash = artifacts.expectedTxHash;
  let inner: { transaction: string; nonce: string };
  try {
    inner = deps.chain.cardanoX402Payment({
      network: row.network,
      signedTransaction: artifacts.signedTransaction,
    });
  } catch (error) {
    deps.logger.error("x402.payment_unreadable", { requestId: row.id, error });
    throw new AppError("SIGNING_FAILED", "the stored payment is malformed");
  }
  const header = x402PaymentHeader(row.payload, inner);
  if (row.state === "SIGNING") {
    await markBroadcast(deps, row, txHash, artifacts.turnkeyActivityId);
    await audit(ctx, {
      actorType: "agent",
      actorId: agentId,
      userId: row.userId,
      action: "x402.payment_handed_off",
      targetType: "transaction_request",
      targetId: row.id,
    });
  }
  return { resourceUrl: delivery.resourceUrl, method: methodOf(row), header, txHash };
}

export async function reportX402Delivery(
  ctx: Ctx,
  agentId: string,
  requestId: string,
  body: EndpointBody<"internalReportX402Delivery">,
): Promise<TransactionRequestResult> {
  const { deps } = ctx;
  const { row } = await loadAgentRequest(ctx, agentId, requestId);
  const artifacts = await getArtifacts(deps.db, row.id);
  if (artifacts?.signedTransaction == null)
    throw new AppError("CONFLICT", "the payment is not signed yet");
  const reported = body.transaction?.toLowerCase() ?? null;
  const expected = artifacts.expectedTxHash;
  if (reported !== null && expected !== null && reported !== expected) {
    deps.logger.warn("x402.receipt_mismatch", { requestId: row.id });
    await audit(ctx, {
      actorType: "agent",
      actorId: agentId,
      userId: row.userId,
      action: "security.x402_receipt_mismatch",
      targetType: "transaction_request",
      targetId: row.id,
    });
  }
  // Only a successful answer counts as delivered; a 402 (payment refused) or an error
  // leaves the request deliverable again while the payment is still valid.
  const delivered = body.httpStatus >= 200 && body.httpStatus < 300;
  // A failed retry after a delivery keeps the delivery's verdict.
  const receipt = delivered ? checkReceipt(row, artifacts, body.receipt) : storedReceipt(artifacts);
  const report: JsonObject = {
    httpStatus: body.httpStatus,
    settled: body.settled,
    transaction: reported,
    errorReason: body.errorReason,
    reportedAt: deps.clock.now().toISOString(),
    receipt,
  };
  await upsertArtifacts(deps.db, row.id, deps.clock.now(), {
    x402HttpStatus: body.httpStatus,
    x402Report: report,
    ...(delivered && artifacts.x402DeliveredAt === null
      ? { x402DeliveredAt: deps.clock.now() }
      : {}),
  });
  await audit(ctx, {
    actorType: "agent",
    actorId: agentId,
    userId: row.userId,
    action: delivered ? "x402.resource_delivered" : "x402.resource_refused",
    targetType: "transaction_request",
    targetId: row.id,
    metadata: { httpStatus: body.httpStatus },
  });
  if (delivered && receipt !== null && receipt.reason !== "missing") {
    if (!receipt.verified)
      deps.logger.warn("x402.receipt_invalid", { requestId: row.id, reason: receipt.reason });
    await audit(ctx, {
      actorType: "agent",
      actorId: agentId,
      userId: row.userId,
      action: receipt.verified ? "x402.delivery_verified" : "security.x402_receipt_invalid",
      targetType: "transaction_request",
      targetId: row.id,
      metadata: receipt.verified
        ? { contentSha256: receipt.contentSha256, payTo: receipt.signedBy }
        : { reason: receipt.reason, contentSha256: receipt.contentSha256 },
    });
  }
  const [fresh] = await deps.db
    .select()
    .from(t.transactionRequests)
    .where(eq(t.transactionRequests.id, row.id));
  return agentRequestResult(ctx, fresh ?? row);
}
