/*
 * Buyer actions on a Masumi escrow (x402 `masumi`, docs/CARDANO_X402.md): request a refund
 * (vested_pay SetRefundRequested) and withdraw it (WithdrawRefund). Two steps each, like an
 * approval:
 *
 *  1. prepare: the escrow is re-read from the chain; the action must be allowed by the
 *     datum's state and deadlines (fail closed otherwise); the spend is built by the escrow
 *     builder (Blockfrost evaluates the script; a failing script never gets this far), with
 *     validity bounds computed for the validator (lower bounds rounded UP to a slot, TTL
 *     rounded DOWN), and stored with its body hash. The user gets a SigningReview whose
 *     rawPayload is that body hash, signed with SIGN_RAW_PAYLOAD_V2 exactly like a Cardano
 *     approval.
 *  2. submit: the quoted payloadHash and body hash must be the stored ones, the stored spend
 *     is re-verified against FRESH protocol parameters (verifyCardanoEscrowSpend), the
 *     escrow must still be the UTxO it spends, the stamp is checked by the same code as an
 *     approval (verifyCardanoStamp), the pending spend is claimed by compare-and-set (one
 *     signature per build), the witness is attached and checked (C7), and the transaction
 *     is submitted and tracked by its id. Every refusal is audited.
 */
import type { EndpointBody, SigningReview, X402Escrow, X402EscrowAction } from "@zyropay/shared";
import { isTestnet, nativeAsset, payloadHash } from "@zyropay/shared";
import type { MasumiEscrowTerms } from "@zyropay/integrations";
import { masumiEscrowView, masumiRefundRequestDatum } from "@zyropay/integrations";
import type { EscrowChain, EscrowSpendInput } from "../chain";
import type { Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import { FEE_CAPS, valueUsdMinor } from "./assets";
import { audit } from "./audit";
import { loadOwnedRequest, loadUser, verifyCardanoStamp } from "./approvals";
import type { PendingSpend, StoredEscrow } from "./escrow-view";
import {
  availableActions,
  casEscrow,
  escrowSummary,
  escrowTermsOf,
  refreshEscrow,
  REFUND_REQUEST_MARGIN_MS,
  storedEscrow,
} from "./escrow-view";
import type { TxRequestRow } from "./mappers";
import { toTransactionRequest, usdValue } from "./mappers";
import { cardanoPublicKeyFor } from "./requests";
import type { UserPrincipal } from "./sessions";
import { getArtifacts } from "./tx-state";

/** Validity of a built spend: time for the passkey and the submit. */
const SPEND_VALIDITY_SLOTS = 600n;
/** Lower bound slack (the spend must be valid as soon as it is submitted). */
const LOWER_SLACK_SLOTS = 60n;
/** A spend this close to its TTL is not signed anymore. */
const SUBMIT_MARGIN_MS = 30_000;

const ACTIONS = {
  request_refund: "SetRefundRequested",
  withdraw_refund: "WithdrawRefund",
} as const;

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

async function loadEscrowRequest(
  ctx: Ctx,
  userId: string,
  requestId: string,
): Promise<{ row: TxRequestRow; terms: MasumiEscrowTerms }> {
  const row = await loadOwnedRequest(ctx, userId, requestId);
  const terms = escrowTermsOf(row);
  if (terms === null) throw notFound("escrow");
  return { row, terms };
}

export async function getX402Escrow(
  ctx: Ctx,
  userId: string,
  requestId: string,
): Promise<X402Escrow> {
  const { row } = await loadEscrowRequest(ctx, userId, requestId);
  const escrow = await refreshEscrow(ctx, row, await getArtifacts(ctx.deps.db, row.id));
  if (escrow === undefined) throw notFound("escrow");
  return escrow;
}

function spendInputOf(pending: PendingSpend, from: string, feeCap: bigint): EscrowSpendInput {
  return {
    action: ACTIONS[pending.action],
    from,
    utxo: pending.utxo,
    ...(pending.continuingDatumCbor !== null
      ? { continuingDatumCbor: pending.continuingDatumCbor }
      : {}),
    validityStartSlot: BigInt(pending.validityStartSlot),
    ttlSlot: BigInt(pending.ttlSlot),
    feeCap,
  };
}

/** A chain provider whose tip trails the clock by more than this is too stale to build on. */
const MAX_TIP_LAG_SLOTS = 600n;

/**
 * Validity bounds for an action, or a CONFLICT saying why it is not possible yet.
 *
 * The node judges the interval against its ledger tip, not the wall clock: a lower bound the
 * clock has reached but the tip has not is rejected (OutsideValidityIntervalUTxO), even though
 * Blockfrost's script evaluation accepted the transaction. So every lower bound is checked
 * against `min(now, tip)`; the TTL (upper bound) is counted from the clock.
 */
function boundsFor(
  chain: EscrowChain,
  action: X402EscrowAction,
  state: string,
  terms: MasumiEscrowTerms,
  buyerCooldownMs: bigint,
  nowMs: bigint,
  tipSlot: bigint,
): { lower: bigint; ttl: bigint } {
  const nowSlot = chain.slotOf(nowMs, "floor");
  if (nowSlot - tipSlot > MAX_TIP_LAG_SLOTS)
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "the Cardano chain provider is behind; try again in a few minutes",
    );
  const reached = min(nowSlot, tipSlot);
  const lag = nowSlot - reached;
  const upper = nowSlot + SPEND_VALIDITY_SLOTS;
  const base = reached - LOWER_SLACK_SLOTS;
  /** Lower bound >= `ms` (rounded UP to a slot); a time already behind `base` binds nothing. */
  const atLeast = (ms: bigint): bigint =>
    ms <= chain.posixOf(base) ? base : max(base, chain.slotOf(ms, "ceil"));
  /** When the tip should have reached `lower` (the clock time plus the current lag). */
  const retryAfter = (lower: bigint) => ({
    retryAfter: new Date(Number(chain.posixOf(lower + lag))).toISOString(),
  });
  if (action === "request_refund") {
    // vested_pay: lower >= buyer_cooldown_time (0 before any request), upper < unlock_time.
    const lower = atLeast(buyerCooldownMs);
    if (lower > reached)
      throw new AppError(
        "CONFLICT",
        "a refund was requested recently; try again later",
        retryAfter(lower),
      );
    const ttl = min(upper, chain.slotOf(BigInt(terms.unlockTime) - 1n, "floor"));
    if (ttl < nowSlot + 120n)
      throw new AppError("CONFLICT", "it is too late to request a refund (the escrow unlocks)");
    return { lower, ttl };
  }
  if (state === "refund_authorized") return { lower: base, ttl: upper };
  // Without the seller: lower >= submit_result_time.
  const lower = atLeast(BigInt(terms.submitResultTime));
  if (lower > reached)
    throw new AppError(
      "CONFLICT",
      "the refund can be withdrawn shortly after the result deadline; try again in a minute",
      retryAfter(lower),
    );
  return { lower, ttl: upper };
}

/** Build the spend for `action`, store it, and return the review to sign. */
export async function prepareEscrowSpend(
  ctx: Ctx,
  principal: UserPrincipal,
  requestId: string,
  action: X402EscrowAction,
): Promise<{ review: SigningReview; escrow: X402Escrow }> {
  const { deps } = ctx;
  const { row, terms } = await loadEscrowRequest(ctx, principal.userId, requestId);
  if (row.state !== "CONFIRMED")
    throw new AppError("CONFLICT", "the escrow payment is not confirmed on chain yet");
  const artifacts = await getArtifacts(deps.db, row.id);
  const chain = deps.chain.cardanoEscrow(row.network);
  // The tip is read alongside the escrow (independent Blockfrost calls).
  const [before, tipSlot] = await Promise.all([
    refreshEscrow(ctx, row, artifacts, { maxAgeMs: 0 }),
    chain.tipSlot().catch(() => null),
  ]);
  const fresh = await getArtifacts(deps.db, row.id);
  const stored = storedEscrow(fresh);
  const snapshot = stored.snapshot;
  const utxo = snapshot?.utxo ?? null;
  if (before === undefined || snapshot === null || snapshot.state === "unknown")
    throw new AppError("UPSTREAM_UNAVAILABLE", "the escrow could not be read from the chain");
  if (utxo === null)
    throw new AppError("CONFLICT", `the escrow is closed (${snapshot.state})`, {
      state: snapshot.state,
    });
  if (stored.pending?.status === "submitted")
    throw new AppError("CONFLICT", "an escrow transaction is already in flight");
  const now = deps.clock.now();
  if (!availableActions(snapshot.state, terms, snapshot, now).includes(action)) {
    // Say why, with the deadlines that apply.
    const detail = { state: snapshot.state, resultHash: snapshot.resultHash };
    if (
      action === "request_refund" &&
      now.getTime() >= Number(terms.unlockTime) - REFUND_REQUEST_MARGIN_MS
    )
      throw new AppError(
        "CONFLICT",
        "it is too late to request a refund (the escrow unlocks)",
        detail,
      );
    if (action === "withdraw_refund" && snapshot.resultHash !== null)
      throw new AppError(
        "CONFLICT",
        "the seller submitted a result: the refund needs the seller's authorization",
        detail,
      );
    throw new AppError(
      "CONFLICT",
      `${action} is not possible while the escrow is ${snapshot.state}`,
      detail,
    );
  }
  const view = masumiEscrowView(utxo.inlineDatum);
  if (view === null) throw new AppError("CONFLICT", "the escrow datum is unreadable");
  if (tipSlot === null)
    throw new AppError("UPSTREAM_UNAVAILABLE", "the Cardano chain tip could not be read");
  const { lower, ttl } = boundsFor(
    chain,
    action,
    snapshot.state,
    terms,
    view.buyerCooldownTime,
    BigInt(now.getTime()),
    tipSlot,
  );
  let continuingDatumCbor: string | null = null;
  if (action === "request_refund") {
    try {
      continuingDatumCbor = masumiRefundRequestDatum(
        utxo.inlineDatum,
        chain.posixOf(ttl),
        BigInt(terms.cooldownPeriodMs),
      );
    } catch (error) {
      throw new AppError("CONFLICT", error instanceof Error ? error.message : "refund datum");
    }
  }
  const feeCap = BigInt(FEE_CAPS[row.network]);
  const input: EscrowSpendInput = {
    action: ACTIONS[action],
    from: row.payload.from,
    utxo,
    ...(continuingDatumCbor !== null ? { continuingDatumCbor } : {}),
    validityStartSlot: lower,
    ttlSlot: ttl,
    feeCap,
  };
  let built;
  try {
    built = await chain.buildSpend(input);
  } catch (error) {
    deps.logger.warn("x402.escrow_spend_build_failed", { requestId: row.id, action, error });
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "INSUFFICIENT_FUNDS")
      throw new AppError(
        "INSUFFICIENT_FUNDS",
        "the wallet needs a pure-ADA UTxO for the network fee and Plutus collateral",
      );
    if (code === "VALIDATION_FAILED")
      throw new AppError("CONFLICT", "the escrow script refused this action right now");
    throw new AppError("UPSTREAM_UNAVAILABLE", "the escrow transaction could not be built");
  }
  // Defence in depth: the stored bytes are what will be verified, signed and sent.
  const check = await chain.verifySpend(built.serialized, input);
  const signingPayload = deps.chain.cardanoSigningPayload({
    network: row.network,
    unsigned: built.serialized,
  });
  if (!check.ok || signingPayload !== built.bodyHash) {
    deps.logger.error("x402.escrow_spend_verify_failed", {
      requestId: row.id,
      reason: check.ok ? "body hash" : check.reason,
    });
    throw new AppError("SIGNING_FAILED", "the escrow transaction failed verification");
  }
  const pending: PendingSpend = {
    action,
    status: "awaiting_signature",
    unsigned: built.serialized,
    bodyHash: built.bodyHash,
    fee: built.fee,
    continuingDatumCbor,
    validityStartSlot: lower.toString(),
    ttlSlot: ttl.toString(),
    validFrom: new Date(Number(chain.posixOf(lower))).toISOString(),
    validUntil: new Date(Number(chain.posixOf(ttl))).toISOString(),
    utxo,
    txHash: null,
    signedTransaction: null,
    failureReason: null,
    updatedAt: now.toISOString(),
  };
  const next: StoredEscrow = { ...stored, pending };
  if (!(await casEscrow(ctx, row.id, fresh?.x402Escrow ?? null, next)))
    throw new AppError("VERSION_CONFLICT", "the escrow changed concurrently; retry");
  await audit(ctx, {
    actorType: "user",
    actorId: principal.userId,
    userId: principal.userId,
    action: "x402.escrow_spend_prepared",
    targetType: "transaction_request",
    targetId: row.id,
    metadata: { action, bodyHash: built.bodyHash, fee: built.fee },
  });
  const latest = await getArtifacts(deps.db, row.id);
  const escrow = escrowSummary(row, latest, now);
  if (escrow === undefined) throw notFound("escrow");
  return { review: await spendReview(ctx, row, terms, pending), escrow };
}

async function spendReview(
  ctx: Ctx,
  row: TxRequestRow,
  terms: MasumiEscrowTerms,
  pending: PendingSpend,
): Promise<SigningReview> {
  const feeValue = await valueUsdMinor(ctx, nativeAsset(row.network), pending.fee);
  const lockedValue = await valueUsdMinor(ctx, nativeAsset(row.network), pending.utxo.lovelace);
  const warnings: SigningReview["warnings"] = [];
  if (isTestnet(row.network))
    warnings.push({ code: "TESTNET", message: "Testnet: these funds have no value." });
  if (row.simulated)
    warnings.push({ code: "SIMULATED", message: "Simulated: no real transaction will be sent." });
  return {
    request: toTransactionRequest(row),
    payload: row.payload,
    payloadHash: row.payloadHash,
    unsignedTransaction: { encoding: "hex", serialized: pending.unsigned },
    rawPayload: {
      kind: "cardano_tx_body_hash",
      payload: pending.bodyHash,
      signWith: await cardanoPublicKeyFor(ctx, row.walletId, row.payload.from),
    },
    escrowSpend: {
      action: pending.action,
      escrowUtxo: `${pending.utxo.txHash}#${String(pending.utxo.index)}`,
      lockedLovelace: pending.utxo.lovelace || terms.lockedLovelace,
      refundTo: row.payload.from,
      validFrom: pending.validFrom,
      validUntil: pending.validUntil,
    },
    estimatedFee: { amount: pending.fee, value: usdValue(feeValue) },
    value: usdValue(lockedValue),
    priceBasis: lockedValue === null && feeValue === null ? null : "market",
    warnings,
  };
}

/** Verify, sign (forward the stamp), attach the witness, submit. */
export async function submitEscrowSpend(
  ctx: Ctx,
  principal: UserPrincipal,
  requestId: string,
  action: X402EscrowAction,
  body: EndpointBody<"submitX402RefundRequest">,
): Promise<X402Escrow> {
  const { deps } = ctx;
  const { row } = await loadEscrowRequest(ctx, principal.userId, requestId);
  const user = await loadUser(ctx, principal.userId);
  const reject = async (
    event: string,
    reason: string,
    code: "PAYLOAD_HASH_MISMATCH" | "CONFLICT" | "SIGNING_FAILED",
    message: string,
  ): Promise<never> => {
    await audit(ctx, {
      actorType: "user",
      actorId: user.id,
      userId: user.id,
      action: event,
      targetType: "transaction_request",
      targetId: row.id,
      metadata: { action, reason },
    });
    throw new AppError(code, message, { reason });
  };
  let recomputed: string;
  try {
    recomputed = payloadHash(row.payload);
  } catch {
    recomputed = "";
  }
  if (body.payloadHash !== row.payloadHash || recomputed !== row.payloadHash)
    return reject(
      "security.payload_hash_mismatch",
      "payload_hash",
      "PAYLOAD_HASH_MISMATCH",
      "the signature does not match this request",
    );
  const artifacts = await getArtifacts(deps.db, row.id);
  const stored = storedEscrow(artifacts);
  const pending = stored.pending;
  if (pending?.action !== action || pending.status !== "awaiting_signature")
    throw new AppError("CONFLICT", "no prepared escrow transaction to sign; prepare it again");
  if (body.bodyHash !== pending.bodyHash)
    return reject(
      "security.sign_request_rejected",
      "body_hash",
      "PAYLOAD_HASH_MISMATCH",
      "the signed transaction is not the prepared one",
    );
  const now = deps.clock.now();
  if (Date.parse(pending.validUntil) - now.getTime() <= SUBMIT_MARGIN_MS)
    throw new AppError("CONFLICT", "the prepared escrow transaction expired; prepare it again");

  // (1) the stored spend, independently, against fresh parameters; (2) the escrow is still
  // the UTxO it spends; (3) the stamp signs exactly its body hash.
  const chain = deps.chain.cardanoEscrow(row.network);
  const input = spendInputOf(pending, row.payload.from, BigInt(FEE_CAPS[row.network]));
  const verdict = await chain.verifySpend(pending.unsigned, input).catch((error: unknown) => ({
    ok: false as const,
    reason: error instanceof Error ? error.message : "verifier failed",
  }));
  if (!verdict.ok) {
    deps.logger.error("x402.escrow_spend_verify_failed", {
      requestId: row.id,
      reason: verdict.reason,
    });
    return reject(
      "security.escrow_spend_rejected",
      "verification",
      "SIGNING_FAILED",
      "the escrow transaction failed verification; prepare it again",
    );
  }
  const terms = escrowTermsOf(row);
  const lock = terms === null ? null : masumiEscrowView(terms.datumCbor);
  if (terms === null || lock === null) throw new AppError("CONFLICT", "this request has no escrow");
  const read = await chain
    .read(
      { txHash: pending.utxo.txHash, index: pending.utxo.index },
      {
        referenceSignature: lock.referenceSignature,
        lockDatumCbor: terms.datumCbor,
        lockLovelace: terms.lockedLovelace,
      },
    )
    .catch(() => null);
  if (
    read?.status !== "unspent" ||
    read.utxo.txHash !== pending.utxo.txHash ||
    read.utxo.index !== pending.utxo.index ||
    read.utxo.inlineDatum !== pending.utxo.inlineDatum
  )
    throw new AppError(
      "CONFLICT",
      "the escrow changed since the transaction was prepared; prepare it again",
    );
  const stamp = await verifyCardanoStamp(
    ctx,
    user,
    { walletId: row.walletId, from: row.payload.from, network: row.network },
    pending.unsigned,
    body.signRequest,
    now,
  );
  if (!stamp.ok)
    return reject(
      "security.sign_request_rejected",
      stamp.code,
      "PAYLOAD_HASH_MISMATCH",
      "the signed request does not match the prepared transaction",
    );

  // Claim this build: one signature per prepared spend.
  const claimed: StoredEscrow = {
    ...stored,
    pending: { ...pending, status: "submitted", updatedAt: now.toISOString() },
  };
  if (!(await casEscrow(ctx, row.id, artifacts?.x402Escrow ?? null, claimed)))
    throw new AppError("CONFLICT", "this escrow transaction is already being signed");

  const fail = async (reason: string): Promise<never> => {
    const failed: StoredEscrow = {
      ...claimed,
      pending: {
        ...pending,
        status: "failed",
        failureReason: reason,
        updatedAt: deps.clock.now().toISOString(),
      },
    };
    await casEscrow(ctx, row.id, claimed, failed).catch(() => false);
    throw new AppError("SIGNING_FAILED", reason);
  };
  let signedTransaction: string;
  let txHash: string;
  try {
    const sig = await deps.turnkey.forwardStampedSignRawPayload(body.signRequest);
    if (sig.simulated && !deps.config.useMocks) throw new Error("simulated signature refused");
    const publicKey = await cardanoPublicKeyFor(ctx, row.walletId, row.payload.from);
    const witnessed = deps.chain.attachCardanoWitness({
      network: row.network,
      unsigned: pending.unsigned,
      publicKey,
      signature: `${sig.r}${sig.s}`,
      expectedSigner: row.payload.from,
    });
    await deps.chain.assertSignedMatchesUnsigned({
      network: row.network,
      encoding: "hex",
      signed: witnessed.signedTransaction,
      unsigned: pending.unsigned,
      expectedSigner: row.payload.from,
    });
    signedTransaction = witnessed.signedTransaction;
    txHash = deps.chain.txHashOf({ network: row.network, signedTransaction, encoding: "hex" });
  } catch (error) {
    deps.logger.error("x402.escrow_sign_failed", { requestId: row.id, error });
    return fail("signing failed");
  }
  // Record the id derived from the signed bytes BEFORE sending, so it can be reconciled.
  const submitted: StoredEscrow = {
    ...claimed,
    pending: {
      ...pending,
      status: "submitted",
      txHash,
      signedTransaction,
      updatedAt: deps.clock.now().toISOString(),
    },
  };
  if (!(await casEscrow(ctx, row.id, claimed, submitted)))
    throw new AppError("CONFLICT", "the escrow changed concurrently");
  try {
    const sent = await chain.submit(signedTransaction);
    if (sent.txHash !== txHash)
      deps.logger.warn("x402.escrow_hash_mismatch", { requestId: row.id });
  } catch (error) {
    // The send may have reached the network anyway: the tracker decides (refreshEscrow).
    deps.logger.warn("x402.escrow_submit_failed", { requestId: row.id, error });
    const outcome = await deps.chain
      .track({ network: row.network, txHash, validUntilSlot: pending.ttlSlot })
      .catch(() => null);
    if (outcome === null || (outcome.status === "pending" && outcome.rebroadcastSuggested)) {
      const failed: StoredEscrow = {
        ...submitted,
        pending: {
          ...pending,
          status: "failed",
          txHash,
          failureReason: "broadcast failed",
          updatedAt: deps.clock.now().toISOString(),
        },
      };
      await casEscrow(ctx, row.id, submitted, failed).catch(() => false);
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "the escrow transaction could not be sent; prepare it again",
      );
    }
  }
  await audit(ctx, {
    actorType: "user",
    actorId: user.id,
    userId: user.id,
    action:
      action === "request_refund" ? "x402.escrow_refund_requested" : "x402.escrow_refund_withdrawn",
    targetType: "transaction_request",
    targetId: row.id,
    metadata: { txHash, bodyHash: pending.bodyHash },
  });
  const latest = await getArtifacts(deps.db, row.id);
  const escrow = escrowSummary(row, latest, deps.clock.now());
  if (escrow === undefined) throw notFound("escrow");
  return escrow;
}
