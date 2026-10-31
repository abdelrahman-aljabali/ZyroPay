/*
 * Transaction request engine: creation, validation, valuation, policy + reservation.
 *
 * Concurrency (SECURITY.md C4 / T6): the policy decision and the reservation insert run
 * in ONE database transaction that first locks the agent's agent_policies row with
 * SELECT … FOR UPDATE. All requests of an agent therefore serialize on that row, and the
 * limit check counts spent (ledger) + reserved (active reservations) + this request, so
 * N concurrent requests can never jointly exceed a window.
 *
 * Idempotency (C11 / T7): (user_id, idempotency_key) is UNIQUE. A retry with the same key
 * and the same material parameters returns the original request; different parameters
 * => IDEMPOTENCY_CONFLICT. A racing duplicate insert hits the unique index and is
 * answered with the winner's request.
 */
import type {
  AgentTransactionRequestBody,
  Asset,
  CanonicalTransactionPayload,
  JsonObject,
  NetworkId,
  PluginQuote,
  PolicyEvaluation,
  PolicyRequest,
  RequestSource,
  SigningReview,
  SpentWindows,
  TransactionRequestResult,
  UsdMinor,
} from "@zyropay/shared";
import {
  addressesEqual,
  assertNetworkAllowedInMode,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  chainFamilyOf,
  createCanonicalPayload,
  evaluateAutoPay,
  evaluatePolicy,
  isSwapAvailableOn,
  isTestnet,
  isValidAddressForNetwork,
  MASUMI_ESCROW_ADDRESSES,
  nativeAsset,
  normalizeAddress,
  parseAssetId,
  parseBaseUnits,
  payloadHash,
  swapUnavailableMessage,
} from "@zyropay/shared";
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { X402CardanoMethod, X402Requirement } from "@zyropay/integrations";
import {
  masumiEscrowTermsOf,
  normalizePaymentRequired,
  normalizeResourceUrl,
  x402AssetMatches,
  x402TransferMethodOf,
} from "@zyropay/integrations";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import type { Ctx } from "../deps";
import { randomHex } from "../lib/crypto";
import { AppError, isUniqueViolation } from "../lib/errors";
import { FEE_CAPS, resolveSpendableAsset, valueUsdMinor } from "./assets";
import { audit } from "./audit";
import type { AgentRow, ApprovalRow, TxRequestRow, UserRow } from "./mappers";
import { toPolicy, toRequestResult, toTransactionRequest, usdValue } from "./mappers";
import { enqueueNotification } from "./notifications";
import { requireEnabledPlugin } from "./plugins";
import { buildArtifact, persistArtifact } from "./build";
import { allowanceBusy, autoPayCandidate, autoPayOf, recordAllowanceSpend } from "./allowances";
import { applyEvent, getArtifacts, withdrawRequest } from "./tx-state";
import { addressFor, getOwnedWallet } from "./wallets";

// ---------------------------------------------------------------------------
// Drafts: validated, server-resolved request parameters
// ---------------------------------------------------------------------------

type DraftInput =
  | {
      kind: "transfer";
      source: "app_send" | "send";
      walletId: string;
      network: NetworkId;
      to: string;
      assetId: string;
      amount: string;
      decimals: number;
      idempotencyKey: string;
    }
  | {
      kind: "swap";
      walletId: string;
      network: NetworkId;
      inputAssetId: string;
      outputAssetId: string;
      amount: string;
      decimals: number;
      slippageBps: number;
      idempotencyKey: string;
    }
  | {
      kind: "x402";
      walletId: string;
      network: NetworkId;
      resourceUrl: string;
      method: "GET" | "POST";
      maxAmount: string;
      assetId: string;
      decimals: number;
      paymentRequirements: Record<string, unknown>;
      idempotencyKey: string;
      /** Cardano: pay into Masumi escrow (true), directly (false), or decide (absent). */
      escrow?: boolean | undefined;
      /** The agent's policy has an escrow threshold: prefer escrow when offered. */
      preferEscrow?: boolean;
    };

interface Draft {
  readonly walletId: string;
  readonly source: RequestSource;
  readonly payload: CanonicalTransactionPayload;
  readonly hash: string;
  readonly asset: Asset;
  readonly policyRequest: Omit<PolicyRequest, "tool"> & { tool: PolicyRequest["tool"] | null };
  readonly quote: PluginQuote | null;
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Solana mint of an asset id (native SOL swaps through wrapped SOL). */
function mintOf(assetId: string): string {
  return parseAssetId(assetId).tokenAddress ?? WSOL_MINT;
}

/**
 * The resource's 402 response as MCP passed it: a full PaymentRequired object
 * ({x402Version, accepts}) or, for convenience, a single requirement (wrapped as v1).
 */
function paymentRequiredOf(raw: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(raw.accepts) ? raw : { x402Version: 1, accepts: [raw] };
}

/**
 * Cheapest exact-scheme requirement for this network and asset (parsed by the x402 adapter's
 * parser). Cardano: of the chosen transfer method only. Masumi escrow is used when asked
 * for (`escrow: true`; refused if not offered), or, when the agent did not say, when the
 * resource offers it and the policy has an escrow threshold. Otherwise `default`.
 */
function selectX402Requirement(
  paymentRequired: Record<string, unknown>,
  network: NetworkId,
  assetId: string,
  escrow: { requested: boolean | undefined; preferred: boolean },
): { req: X402Requirement; method: X402CardanoMethod | null } {
  let parsed;
  try {
    parsed = normalizePaymentRequired(paymentRequired);
  } catch {
    throw new AppError("BAD_REQUEST", "invalid x402 payment requirements");
  }
  const candidates = parsed.accepts
    .filter(
      (r) =>
        r.scheme === "exact" &&
        r.network === network &&
        x402AssetMatches(network, r.asset, assetId),
    )
    .sort((a, b) => (parseBaseUnits(a.amount) < parseBaseUnits(b.amount) ? -1 : 1));
  if (chainFamilyOf(network) !== "cardano") {
    if (escrow.requested === true)
      throw new AppError("BAD_REQUEST", "x402 escrow is available on Cardano only");
    const [req] = candidates;
    if (req === undefined)
      throw new AppError("BAD_REQUEST", "no x402 requirement for this network and asset");
    return { req, method: null };
  }
  const offered = candidates.some((r) => x402TransferMethodOf(r) === "masumi");
  if (escrow.requested === true && !offered)
    throw new AppError("BAD_REQUEST", "the resource does not offer escrow (Masumi) for this asset");
  const method: X402CardanoMethod =
    escrow.requested === true || (escrow.requested === undefined && escrow.preferred && offered)
      ? "masumi"
      : "default";
  const [req] = candidates.filter((r) => x402TransferMethodOf(r) === method);
  if (req === undefined)
    throw new AppError("BAD_REQUEST", "no x402 requirement for this network and asset");
  return { req, method };
}

/** Map a plugin adapter failure: caller mistakes keep their code, the rest is upstream. */
function pluginError(error: unknown, fallback: string): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const passthrough = new Set([
    "BAD_REQUEST",
    "VALIDATION_FAILED",
    "POLICY_DENIED",
    "INVALID_ADDRESS",
    "NETWORK_NOT_SUPPORTED",
    "NETWORK_MODE_MISMATCH",
    "DECIMALS_MISMATCH",
    "INSUFFICIENT_FUNDS",
    "PLUGIN_DISABLED",
  ]);
  if (typeof code === "string" && passthrough.has(code)) {
    return new AppError(code as "BAD_REQUEST", fallback);
  }
  return new AppError("UPSTREAM_UNAVAILABLE", fallback);
}

/**
 * The payload's feeCap. A plain transfer asks its builder for `recommendedFeeCap` BEFORE the
 * payload is hashed; the static per-network ceiling still applies (fail closed when the
 * network is more expensive than that). Plugin transactions fit their fees under the ceiling.
 */
async function feeCapFor(
  ctx: Ctx,
  input: Omit<CanonicalTransactionPayload, "feeCap" | "nonce" | "idempotencyKey" | "expiresAt">,
): Promise<string> {
  const ceiling = FEE_CAPS[input.network];
  if (input.plugin !== null) return ceiling;
  const builder = ctx.deps.chain.builder(input.network);
  if (builder.estimateTransferFee === undefined) return ceiling;
  let recommended: string;
  try {
    recommended = (await builder.estimateTransferFee(input)).recommendedFeeCap;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "INSUFFICIENT_FUNDS" || code === "DECIMALS_MISMATCH" || code === "INVALID_ADDRESS")
      throw pluginError(error, "the transfer cannot be built");
    ctx.deps.logger.warn("fee.estimate_failed", { network: input.network, error });
    throw new AppError("UPSTREAM_UNAVAILABLE", "network fee estimate unavailable");
  }
  if (parseBaseUnits(recommended) > parseBaseUnits(ceiling)) {
    throw new AppError("UPSTREAM_UNAVAILABLE", "network fees are above ZyroPay's limit right now");
  }
  return recommended;
}

async function buildDraft(ctx: Ctx, userId: string, input: DraftInput): Promise<Draft> {
  const { deps } = ctx;
  assertNetworkAllowedInMode(input.network, deps.config.mode);
  const { addresses } = await getOwnedWallet(ctx, userId, input.walletId);
  const family = chainFamilyOf(input.network);
  const fromRow = addressFor(addresses, family);
  if (fromRow === undefined) throw new AppError("BAD_REQUEST", `wallet has no ${family} address`);
  const from = fromRow.address;
  const watched = { walletId: input.walletId, network: input.network, address: from };
  const now = deps.clock.now();
  let expiresAt = new Date(
    now.getTime() +
      (input.kind === "transfer" && input.source === "app_send"
        ? deps.config.appSendTtlSeconds
        : deps.config.agentRequestTtlSeconds) *
        1000,
  );

  let to: string;
  let assetId: string;
  let amount: string;
  let decimals: number;
  let plugin: string | null = null;
  let pluginData: CanonicalTransactionPayload["pluginData"] = null;
  let quote: PluginQuote | null = null;
  let recipient: string | null;
  let tool: PolicyRequest["tool"] | null;
  let source: RequestSource;
  let x402Escrow = false;
  let x402RegisteredAgent: { agentIdentifier: string } | null = null;

  switch (input.kind) {
    case "transfer": {
      if (!isValidAddressForNetwork(input.network, input.to)) {
        throw new AppError("INVALID_ADDRESS", `invalid ${family} address for ${input.network}`);
      }
      to = normalizeAddress(family, input.to);
      assetId = input.assetId;
      amount = input.amount;
      decimals = input.decimals;
      recipient = to;
      source = input.source;
      tool = input.source === "send" ? "send" : null;
      break;
    }
    case "swap": {
      // Jupiter routes on Solana mainnet only: say so instead of failing on a plugin lookup.
      if (!isSwapAvailableOn(input.network)) {
        throw new AppError("SWAP_UNAVAILABLE_ON_NETWORK", swapUnavailableMessage(input.network), {
          network: input.network,
        });
      }
      if (parseAssetId(input.outputAssetId).network !== input.network) {
        throw new AppError("BAD_REQUEST", "output asset is on a different network");
      }
      if (input.outputAssetId === input.inputAssetId)
        throw new AppError("BAD_REQUEST", "cannot swap an asset for itself");
      const adapter = await requireEnabledPlugin(ctx, userId, "jupiter");
      await resolveSpendableAsset(ctx, watched, input.inputAssetId, input.decimals, input.amount);
      try {
        quote = await adapter.quote({
          action: "swap",
          network: input.network,
          params: {
            inputMint: mintOf(input.inputAssetId),
            outputMint: mintOf(input.outputAssetId),
            amount: input.amount,
            slippageBps: input.slippageBps,
            userPublicKey: from,
          },
        });
      } catch (error) {
        throw pluginError(error, "swap quote unavailable");
      }
      if (quote.simulated && !deps.config.useMocks)
        throw new AppError("UPSTREAM_UNAVAILABLE", "simulated quote refused");
      if (quote.inputAmount !== input.amount)
        throw new AppError("UPSTREAM_UNAVAILABLE", "quote does not match the requested amount");
      const quoteExpiry = Date.parse(quote.expiresAt);
      if (!Number.isFinite(quoteExpiry) || quoteExpiry <= now.getTime())
        throw new AppError("UPSTREAM_UNAVAILABLE", "quote already expired");
      expiresAt = new Date(Math.min(expiresAt.getTime(), quoteExpiry));
      to = from;
      assetId = input.inputAssetId;
      amount = input.amount;
      decimals = input.decimals;
      plugin = "jupiter";
      // Exactly the quote's material terms: the adapter refuses any other pluginData.
      pluginData = quote.pluginData;
      recipient = null;
      tool = "swap";
      source = "swap";
      break;
    }
    case "x402": {
      // x402 pays in tokens; on Cardano also in ADA (the scheme's "lovelace").
      if (parseAssetId(input.assetId).tokenAddress === null && family !== "cardano")
        throw new AppError("BAD_REQUEST", "x402 pays in a token, not native");
      // Servers report resource.url in normalized form (lowercase host, canonical escapes).
      const resourceUrl = normalizeResourceUrl(input.resourceUrl);
      const paymentRequired = paymentRequiredOf(input.paymentRequirements);
      const { req, method } = selectX402Requirement(paymentRequired, input.network, input.assetId, {
        requested: input.escrow,
        preferred: input.preferEscrow === true,
      });
      const masumi = method === "masumi";
      if (req.resourceUrl !== null && normalizeResourceUrl(req.resourceUrl) !== resourceUrl) {
        throw new AppError("BAD_REQUEST", "x402 resource does not match");
      }
      if (parseBaseUnits(req.amount) > parseBaseUnits(input.maxAmount)) {
        throw new AppError("BAD_REQUEST", "x402 price exceeds maxAmount");
      }
      // A masumi payTo is the escrow SCRIPT address; the adapter checks it is the canonical one.
      if (
        masumi
          ? req.payTo !== MASUMI_ESCROW_ADDRESSES[input.network]
          : !isValidAddressForNetwork(input.network, req.payTo)
      )
        throw new AppError("INVALID_ADDRESS", "invalid x402 payTo");
      const adapter = await requireEnabledPlugin(ctx, userId, "x402");
      await resolveSpendableAsset(ctx, watched, input.assetId, input.decimals, req.amount);
      try {
        quote = await adapter.quote({
          action: "pay",
          network: input.network,
          params: {
            paymentRequired: paymentRequired as JsonObject,
            resourceUrl,
            method: input.method,
            maxAmount: input.maxAmount,
            assetId: input.assetId,
            payer: from,
            ...(method !== null ? { transferMethod: method } : {}),
          },
        });
      } catch (error) {
        throw pluginError(
          error,
          masumi && error instanceof Error && error.message.startsWith("x402 masumi:")
            ? error.message.slice(0, 200)
            : "x402 quote unavailable",
        );
      }
      if (quote.simulated && !deps.config.useMocks)
        throw new AppError("UPSTREAM_UNAVAILABLE", "simulated quote refused");
      const payTo = quote.pluginData.payTo;
      let escrowTerms: ReturnType<typeof masumiEscrowTermsOf>;
      try {
        escrowTerms = masumiEscrowTermsOf(quote.pluginData);
      } catch {
        throw new AppError("UPSTREAM_UNAVAILABLE", "x402 quote does not match the request");
      }
      if (
        typeof payTo !== "string" ||
        (masumi
          ? escrowTerms === null ||
            payTo !== MASUMI_ESCROW_ADDRESSES[input.network] ||
            escrowTerms.escrowAddress !== payTo
          : escrowTerms !== null || !isValidAddressForNetwork(input.network, payTo)) ||
        parseBaseUnits(quote.inputAmount) > parseBaseUnits(input.maxAmount) ||
        quote.pluginData.resourceUrl !== resourceUrl
      ) {
        throw new AppError("UPSTREAM_UNAVAILABLE", "x402 quote does not match the request");
      }
      to = masumi ? payTo : normalizeAddress(family, payTo);
      assetId = input.assetId;
      amount = quote.inputAmount;
      decimals = input.decimals;
      plugin = "x402";
      pluginData = quote.pluginData;
      // Escrow: the policy's recipient is the seller the escrow releases to, not the script.
      recipient = escrowTerms !== null ? escrowTerms.sellerAddress : to;
      x402Escrow = escrowTerms !== null;
      // Bound into the payload only after the registry check passed (integrations/masumi.ts).
      const agentIdentifier = escrowTerms?.agentIdentifier ?? null;
      x402RegisteredAgent = agentIdentifier !== null ? { agentIdentifier } : null;
      if (escrowTerms !== null) {
        // The lock is void after the seller's payByTime: so is the request.
        const quoteExpiry = Date.parse(quote.expiresAt);
        if (!Number.isFinite(quoteExpiry) || quoteExpiry <= now.getTime())
          throw new AppError("UPSTREAM_UNAVAILABLE", "x402 escrow quote already expired");
        expiresAt = new Date(Math.min(expiresAt.getTime(), quoteExpiry));
      }
      tool = "pay_x402";
      source = "pay_x402";
      break;
    }
  }

  const { asset } = await resolveSpendableAsset(ctx, watched, assetId, decimals, amount);
  const terms = {
    version: 1 as const,
    network: input.network,
    from,
    to,
    asset: { id: asset.id, kind: asset.kind, decimals: asset.decimals },
    amount,
    plugin,
    tool: source,
    pluginData,
  };
  const payload = createCanonicalPayload({
    ...terms,
    feeCap: await feeCapFor(ctx, terms),
    nonce: randomHex(16),
    expiresAt: expiresAt.toISOString(),
    idempotencyKey: input.idempotencyKey,
  });
  return {
    walletId: input.walletId,
    source,
    payload,
    hash: payloadHash(payload),
    asset,
    policyRequest: {
      tool,
      walletId: input.walletId,
      network: input.network,
      recipient,
      protocol: plugin,
      ...(plugin === "x402" ? { x402Escrow, x402RegisteredAgent } : {}),
    },
    quote,
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

async function findByIdempotencyKey(
  db: Db,
  userId: string,
  key: string,
): Promise<TxRequestRow | null> {
  const [row] = await db
    .select()
    .from(t.transactionRequests)
    .where(
      and(eq(t.transactionRequests.userId, userId), eq(t.transactionRequests.idempotencyKey, key)),
    );
  return row ?? null;
}

/** failureReason prefix of a request withdrawn because its transaction could not be built. */
const BUILD_FAILED = "could not build the transaction";

/** The failureReason for a build error: what went wrong and that a retry tries again. */
function buildFailureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "INSUFFICIENT_FUNDS")
    return `${BUILD_FAILED}: the wallet cannot cover the amount plus the network fee`;
  if (code === "REQUEST_EXPIRED")
    return `${BUILD_FAILED}: the seller's payment window closed; get a new quote`;
  return `${BUILD_FAILED}: a network service was unavailable; retrying the same request tries again`;
}

/**
 * A request withdrawn because its transaction could not be built (a chain provider was down,
 * a quote went stale) never reached the user or a key. A retry with the same idempotency key
 * is then a new attempt, not a replay of that failure: the failed row keeps its history
 * under a retired key, and the caller creates the request again. Two racing retries both
 * get here; the unique index lets one of them insert, the other replays the winner.
 */
async function retireFailedBuild(db: Db, row: TxRequestRow): Promise<boolean> {
  if (
    (row.state !== "CANCELLED" && row.state !== "FAILED") ||
    row.failureReason?.startsWith(BUILD_FAILED) !== true ||
    row.txHash !== null ||
    row.unsignedTransaction !== null
  )
    return false;
  await db
    .update(t.transactionRequests)
    .set({ idempotencyKey: `${row.idempotencyKey}~retired~${row.id}` })
    .where(
      and(
        eq(t.transactionRequests.id, row.id),
        eq(t.transactionRequests.idempotencyKey, row.idempotencyKey),
      ),
    );
  return true;
}

function sameAddress(network: NetworkId, a: string, b: string): boolean {
  return addressesEqual(chainFamilyOf(network), a, b);
}

/** Does a retry carry the same material parameters as the stored request? */
function materialMatches(row: TxRequestRow, input: DraftInput): boolean {
  const p = row.payload;
  const data = p.pluginData ?? {};
  if (row.walletId !== input.walletId || row.network !== input.network) return false;
  switch (input.kind) {
    case "transfer":
      return (
        row.source === input.source &&
        sameAddress(input.network, p.to, input.to) &&
        p.asset.id === input.assetId &&
        p.amount === input.amount
      );
    case "swap":
      return (
        row.source === "swap" &&
        p.asset.id === input.inputAssetId &&
        p.amount === input.amount &&
        data.outputMint === mintOf(input.outputAssetId) &&
        data.slippageBps === input.slippageBps
      );
    case "x402":
      return (
        row.source === "pay_x402" &&
        p.asset.id === input.assetId &&
        data.resourceUrl === normalizeResourceUrl(input.resourceUrl) &&
        parseBaseUnits(p.amount) <= parseBaseUnits(input.maxAmount)
      );
  }
}

async function approvalFor(db: Db, requestId: string): Promise<ApprovalRow | null> {
  const [row] = await db
    .select()
    .from(t.approvalRequests)
    .where(eq(t.approvalRequests.transactionRequestId, requestId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Spend windows
// ---------------------------------------------------------------------------

async function spentWindows(db: Db, agentId: string, now: Date): Promise<SpentWindows> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sumLedger = async (since: Date) => {
    const [r] = await db
      .select({ total: sql<string>`coalesce(sum(${t.spendingLedger.amountUsdMinor}), 0)::text` })
      .from(t.spendingLedger)
      .where(and(eq(t.spendingLedger.agentId, agentId), gte(t.spendingLedger.occurredAt, since)));
    return r?.total ?? "0";
  };
  // Active reservations count against both windows (conservative).
  const [reserved] = await db
    .select({
      total: sql<string>`coalesce(sum(${t.spendingReservations.amountUsdMinor}), 0)::text`,
    })
    .from(t.spendingReservations)
    .where(
      and(eq(t.spendingReservations.agentId, agentId), eq(t.spendingReservations.status, "active")),
    );
  const reservedUsdMinor = reserved?.total ?? "0";
  return {
    daily: { spentUsdMinor: await sumLedger(dayStart), reservedUsdMinor },
    monthly: { spentUsdMinor: await sumLedger(monthStart), reservedUsdMinor },
  };
}

// ---------------------------------------------------------------------------
// Agent requests (MCP -> API)
// ---------------------------------------------------------------------------

function agentDraftInput(body: AgentTransactionRequestBody): DraftInput {
  switch (body.tool) {
    case "send":
      return { kind: "transfer", source: "send", ...body.input };
    case "swap":
      return { kind: "swap", ...body.input };
    case "pay_x402":
      return { kind: "x402", ...body.input, paymentRequirements: body.paymentRequirements };
  }
}

export async function createAgentRequest(
  ctx: Ctx,
  agent: AgentRow,
  user: UserRow,
  body: AgentTransactionRequestBody,
): Promise<TransactionRequestResult> {
  const { deps } = ctx;
  const input = agentDraftInput(body);
  const replay = async (row: TxRequestRow) => {
    if (row.agentId !== agent.id || !materialMatches(row, input)) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key was used for a different request",
      );
    }
    const result = toRequestResult(
      row,
      await approvalFor(deps.db, row.id),
      deps.config.deepLinkScheme,
    );
    const autoPay = await autoPayOf(deps.db, row);
    return autoPay === null ? result : { ...result, autoPay };
  };
  const existing = await findByIdempotencyKey(deps.db, user.id, input.idempotencyKey);
  if (
    existing !== null &&
    !(
      existing.agentId === agent.id &&
      materialMatches(existing, input) &&
      (await retireFailedBuild(deps.db, existing))
    )
  )
    return replay(existing);

  if (input.kind === "x402") {
    // Only a preference for picking the requirement; the policy is re-read under the lock.
    const [policy] = await deps.db
      .select({
        threshold: t.agentPolicies.x402EscrowAboveUsdMinor,
        registeredOnly: t.agentPolicies.requireRegisteredAgent,
      })
      .from(t.agentPolicies)
      .where(eq(t.agentPolicies.agentId, agent.id));
    // A registry identity is only ever verified for escrow payments: prefer escrow then too.
    input.preferEscrow = policy?.threshold != null || policy?.registeredOnly === true;
  }
  const draft = await buildDraft(ctx, user.id, input);
  const valuation = await valueUsdMinor(ctx, draft.asset, draft.payload.amount);
  const tool = draft.policyRequest.tool;
  if (tool === null) throw new Error("agent request without a tool");
  const policyRequest: PolicyRequest = { ...draft.policyRequest, tool };
  // Auto-pay on Cardano (docs/AUTOPAY.md): the allowance's chain state is read before the
  // policy lock; the decision itself (and the busy check) runs under the lock.
  const found =
    tool === "swap" ? null : await autoPayCandidate(ctx, agent.id, draft.payload.network);
  const candidate = found === "unavailable" ? null : found;
  // Set inside the transaction below (an object, so control-flow narrowing keeps it boolean).
  const auto = { paid: false };

  let created: { row: TxRequestRow; approval: ApprovalRow | null };
  try {
    created = await deps.db.transaction(async (tx) => {
      const now = deps.clock.now();
      // Serialize all requests of this agent (T6). Fresh policy, read under the lock.
      const [policyRow] = await tx
        .select()
        .from(t.agentPolicies)
        .where(eq(t.agentPolicies.agentId, agent.id))
        .for("update");
      if (policyRow === undefined) throw new AppError("FORBIDDEN", "agent has no policy");
      let evaluation: PolicyEvaluation;
      try {
        evaluation = evaluatePolicy(
          toPolicy(policyRow),
          policyRequest,
          valuation,
          await spentWindows(tx, agent.id, now),
          { now },
        );
      } catch {
        evaluation = {
          decision: "deny",
          reasons: [
            { code: "VALUATION_UNAVAILABLE", message: "policy evaluation failed (fail closed)" },
          ],
          policyVersion: policyRow.version,
        };
      }
      if (
        evaluation.decision === "allow" &&
        draft.payload.plugin === "x402" &&
        chainFamilyOf(draft.payload.network) === "evm"
      ) {
        // x402 on EVM signs an EIP-712 digest (SIGN_RAW_PAYLOAD). Turnkey policies cannot
        // bound a raw digest, so the delegated key never signs one: the passkey must.
        evaluation = {
          ...evaluation,
          decision: "require_approval",
          reasons: [
            {
              code: "AUTONOMY_NOT_SUPPORTED",
              message: "x402 payments on EVM networks always need your passkey",
            },
          ],
        };
      }
      auto.paid = false;
      if (candidate !== null && (tool === "send" || tool === "pay_x402")) {
        const decision = evaluateAutoPay(
          evaluation,
          {
            tool,
            network: draft.payload.network,
            walletId: draft.walletId,
            native: draft.asset.kind === "native",
            escrow: policyRequest.x402Escrow === true,
            payee: draft.payload.to,
            lovelace: BigInt(draft.payload.amount),
          },
          { ...candidate.allowance, busy: await allowanceBusy(tx, candidate.row.id) },
          BigInt(now.getTime()),
        );
        evaluation = decision.evaluation;
        auto.paid = decision.route === "allowance";
      } else if (
        found === "unavailable" &&
        evaluation.decision === "require_approval" &&
        (tool === "send" || tool === "pay_x402")
      ) {
        // The agent has an allowance, but its chain state could not be read: the passkey pays.
        evaluation = {
          ...evaluation,
          reasons: [
            ...evaluation.reasons,
            {
              code: "ALLOWANCE_UNAVAILABLE",
              message: "the auto-pay allowance could not be read from the chain right now",
            },
          ],
        };
      }
      if (evaluation.decision === "allow" && valuation === null) {
        // Defensive: evaluatePolicy never allows without a valuation; never reserve nothing.
        evaluation = {
          ...evaluation,
          decision: "deny",
          reasons: [{ code: "VALUATION_UNAVAILABLE", message: "no valuation" }],
        };
      }
      const [inserted] = await tx
        .insert(t.transactionRequests)
        .values({
          id: deps.ids.newId(),
          userId: user.id,
          walletId: draft.walletId,
          agentId: agent.id,
          requesterType: "agent",
          source: draft.source,
          network: draft.payload.network,
          state: "CREATED",
          payload: draft.payload,
          payloadHash: draft.hash,
          idempotencyKey: input.idempotencyKey,
          valuationUsdMinor: valuation,
          simulated: deps.config.useMocks,
          expiresAt: new Date(draft.payload.expiresAt),
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (inserted === undefined) throw new Error("insert failed");
      let row = await applyEvent(tx, inserted, "START_POLICY_CHECK", now);
      const decisionPatch = {
        policyDecision: evaluation.decision,
        policyReasons: evaluation.reasons,
        policyVersion: evaluation.policyVersion,
      };
      let approval: ApprovalRow | null = null;
      const reserve = async (amount: UsdMinor) => {
        await tx.insert(t.spendingReservations).values({
          id: deps.ids.newId(),
          agentId: agent.id,
          userId: user.id,
          transactionRequestId: row.id,
          amountUsdMinor: amount,
          status: "active",
          createdAt: now,
          expiresAt: row.expiresAt,
        });
      };
      switch (evaluation.decision) {
        case "allow":
          row = await applyEvent(tx, row, "POLICY_ALLOWED", now, decisionPatch);
          if (valuation !== null) await reserve(valuation);
          if (auto.paid && candidate !== null)
            await recordAllowanceSpend(tx, {
              id: deps.ids.newId(),
              candidate,
              requestId: row.id,
              payee: draft.payload.to,
              lovelace: BigInt(draft.payload.amount),
              now,
            });
          break;
        case "require_approval":
          row = await applyEvent(tx, row, "POLICY_REQUIRES_APPROVAL", now, decisionPatch);
          if (valuation !== null) await reserve(valuation);
          [approval = null] = await tx
            .insert(t.approvalRequests)
            .values({
              id: deps.ids.newId(),
              transactionRequestId: row.id,
              userId: user.id,
              agentId: agent.id,
              status: "pending",
              payloadHash: row.payloadHash,
              expiresAt: row.expiresAt,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          break;
        case "deny":
          row = await applyEvent(tx, row, "POLICY_DENIED", now, decisionPatch);
          break;
      }
      await tx.update(t.agents).set({ lastUsedAt: now }).where(eq(t.agents.id, agent.id));
      await audit(
        ctx,
        {
          actorType: "agent",
          actorId: agent.id,
          userId: user.id,
          action: `tx_request.${evaluation.decision === "allow" ? "allowed" : evaluation.decision === "deny" ? "denied" : "approval_required"}`,
          targetType: "transaction_request",
          targetId: row.id,
          metadata: {
            tool,
            network: row.network,
            payloadHash: row.payloadHash,
            valuationUsdMinor: valuation,
            reasons: evaluation.reasons.map((r) => r.code),
          },
        },
        tx,
      );
      return { row, approval };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findByIdempotencyKey(deps.db, user.id, input.idempotencyKey);
      if (winner !== null) return replay(winner);
    }
    throw error;
  }

  let { row } = created;
  const { approval } = created;
  // An auto-paid request is built (from the allowance) by the executor, not from the wallet.
  if ((row.state === "APPROVED" && !auto.paid) || row.state === "PENDING_APPROVAL") {
    try {
      row = await persistArtifact(ctx, row, await buildArtifact(ctx, row, draft.quote));
    } catch (error) {
      deps.logger.error("tx_request.build_failed", { requestId: row.id, error });
      row = await deps.db.transaction((tx) =>
        withdrawRequest(
          tx,
          row,
          row.state === "APPROVED" ? "FAIL" : "CANCEL",
          deps.clock.now(),
          buildFailureReason(error),
        ),
      );
      return toRequestResult(row, await approvalFor(deps.db, row.id), deps.config.deepLinkScheme);
    }
  }
  if (row.state === "APPROVED") {
    await deps.queue.send({ type: "execute", requestId: row.id });
    if (auto.paid) {
      await audit(ctx, {
        actorType: "agent",
        actorId: agent.id,
        userId: user.id,
        action: "tx_request.auto_pay_scheduled",
        targetType: "transaction_request",
        targetId: row.id,
        metadata: { allowanceId: candidate?.row.id ?? null },
      });
      const autoPay = await autoPayOf(deps.db, row);
      const result = toRequestResult(row, approval, deps.config.deepLinkScheme);
      return autoPay === null ? result : { ...result, autoPay };
    }
  } else if (row.state === "PENDING_APPROVAL" && approval !== null) {
    await enqueueNotification(ctx, {
      userId: user.id,
      event: "approval_requested",
      dedupeKey: `approval:${approval.id}`,
      title: "Approval needed",
      body: `${agent.name} wants to make a payment. Review it in ZyroPay.`,
      data: { approvalId: approval.id, requestId: row.id },
    });
  }
  return toRequestResult(row, approval, deps.config.deepLinkScheme);
}

// ---------------------------------------------------------------------------
// In-app send: quote
// ---------------------------------------------------------------------------

export async function quoteSend(
  ctx: Ctx,
  userId: string,
  body: {
    walletId: string;
    network: NetworkId;
    to: string;
    assetId: string;
    amount: string;
    decimals: number;
    idempotencyKey: string;
  },
): Promise<SigningReview> {
  const { deps } = ctx;
  const input: DraftInput = { kind: "transfer", source: "app_send", ...body };
  const replay = async (row: TxRequestRow) => {
    if (row.agentId !== null || !materialMatches(row, input)) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key was used for a different request",
      );
    }
    return buildReview(ctx, row, null);
  };
  const existing = await findByIdempotencyKey(deps.db, userId, body.idempotencyKey);
  if (
    existing !== null &&
    !(
      existing.agentId === null &&
      materialMatches(existing, input) &&
      (await retireFailedBuild(deps.db, existing))
    )
  )
    return replay(existing);

  const draft = await buildDraft(ctx, userId, input);
  const valuation = await valueUsdMinor(ctx, draft.asset, draft.payload.amount);
  const now = deps.clock.now();
  let row: TxRequestRow;
  try {
    // Insert first: the idempotency key is decided by the unique index before anything is
    // built, and an EVM nonce can be allocated to this request id.
    row = await deps.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(t.transactionRequests)
        .values({
          id: deps.ids.newId(),
          userId,
          walletId: draft.walletId,
          agentId: null,
          requesterType: "user",
          source: "app_send",
          network: draft.payload.network,
          state: "CREATED",
          payload: draft.payload,
          payloadHash: draft.hash,
          idempotencyKey: body.idempotencyKey,
          valuationUsdMinor: valuation,
          simulated: deps.config.useMocks,
          expiresAt: new Date(draft.payload.expiresAt),
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (inserted === undefined) throw new Error("insert failed");
      await audit(
        ctx,
        {
          actorType: "user",
          actorId: userId,
          userId,
          action: "send.quoted",
          targetType: "transaction_request",
          targetId: inserted.id,
          metadata: { network: inserted.network, payloadHash: inserted.payloadHash },
        },
        tx,
      );
      return inserted;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findByIdempotencyKey(deps.db, userId, body.idempotencyKey);
      if (winner !== null) return replay(winner);
    }
    throw error;
  }
  try {
    row = await persistArtifact(ctx, row, await buildArtifact(ctx, row, null));
  } catch (error) {
    const created = row;
    await deps.db
      .transaction((tx) =>
        withdrawRequest(tx, created, "CANCEL", deps.clock.now(), buildFailureReason(error)),
      )
      .catch(() => undefined);
    if (error instanceof AppError) throw error;
    deps.logger.error("send.build_failed", { requestId: created.id, error });
    throw new AppError("UPSTREAM_UNAVAILABLE", "could not build the transaction");
  }
  return buildReview(ctx, row, draft.asset);
}

/**
 * The Ed25519 public key behind a wallet's Cardano address (stored at wallet sync). It must
 * hash to the address's payment credential; anything else fails closed.
 */
export async function cardanoPublicKeyFor(
  ctx: Ctx,
  walletId: string,
  address: string,
): Promise<string> {
  const [row] = await ctx.deps.db
    .select({ publicKey: t.walletAddresses.publicKey })
    .from(t.walletAddresses)
    // A removed (archived) wallet is unusable everywhere, Cardano signing included.
    .innerJoin(t.wallets, eq(t.wallets.id, t.walletAddresses.walletId))
    .where(
      and(
        eq(t.walletAddresses.walletId, walletId),
        eq(t.walletAddresses.family, "cardano"),
        eq(t.walletAddresses.address, address),
        isNull(t.wallets.archivedAt),
      ),
    );
  const publicKey = row?.publicKey ?? null;
  if (publicKey === null || cardanoKeyHash(publicKey) !== cardanoPaymentKeyHash(address)) {
    throw new AppError("CONFLICT", "the wallet's Cardano key is unknown; sync the wallet");
  }
  return publicKey;
}

/** What the user must see before signing (request, payload, exact unsigned tx, warnings). */
export async function buildReview(
  ctx: Ctx,
  row: TxRequestRow,
  asset: Asset | null,
): Promise<SigningReview> {
  const { deps } = ctx;
  if (row.unsignedTransaction === null || row.unsignedTransactionEncoding === null) {
    throw new AppError("CONFLICT", "transaction is not built yet");
  }
  const artifacts = await getArtifacts(deps.db, row.id);
  const fee = artifacts?.estimatedFee ?? row.payload.feeCap;
  const feeValue = await valueUsdMinor(ctx, nativeAsset(row.network), fee);
  const warnings: SigningReview["warnings"] = [];
  // Real adapters on a testnet can only value through the development mainnet-price proxy.
  const proxied =
    isTestnet(row.network) && !deps.config.useMocks && deps.config.adapters.priceTestnetProxy;
  if (isTestnet(row.network))
    warnings.push({
      code: "TESTNET",
      message: proxied
        ? "Testnet: these funds have no real value. Dollar amounts use mainnet prices."
        : "Testnet: these funds have no value.",
    });
  if (row.payload.to !== row.payload.from) {
    const [prior] = await deps.db
      .select({ id: t.transactionRequests.id })
      .from(t.transactionRequests)
      .where(
        and(
          eq(t.transactionRequests.userId, row.userId),
          ne(t.transactionRequests.id, row.id),
          inArray(t.transactionRequests.state, ["BROADCAST", "CONFIRMED"]),
          sql`${t.transactionRequests.payload}->>'to' = ${row.payload.to}`,
        ),
      )
      .limit(1);
    if (prior === undefined)
      warnings.push({
        code: "FIRST_TIME_RECIPIENT",
        message: "You have not sent to this address before.",
      });
  }
  if (asset !== null && !asset.verified)
    warnings.push({ code: "UNVERIFIED_TOKEN", message: "This token is not on the verified list." });
  if (row.valuationUsdMinor === null)
    warnings.push({ code: "PRICE_UNAVAILABLE", message: "No current price is available." });
  if (row.simulated)
    warnings.push({ code: "SIMULATED", message: "Simulated: no real transaction will be sent." });
  return {
    request: toTransactionRequest(row),
    payload: row.payload,
    payloadHash: row.payloadHash,
    unsignedTransaction: {
      encoding: row.unsignedTransactionEncoding,
      serialized: row.unsignedTransaction,
    },
    ...(artifacts?.signingKind === "typed_data" && artifacts.typedData !== null
      ? {
          typedData: {
            kind: "eip712" as const,
            digest: row.unsignedTransaction,
            typedData: artifacts.typedData,
          },
        }
      : {}),
    ...(chainFamilyOf(row.network) === "cardano"
      ? {
          rawPayload: {
            kind: "cardano_tx_body_hash" as const,
            payload: deps.chain.cardanoSigningPayload({
              network: row.network,
              unsigned: row.unsignedTransaction,
            }),
            signWith: await cardanoPublicKeyFor(ctx, row.walletId, row.payload.from),
          },
        }
      : {}),
    estimatedFee: { amount: fee, value: usdValue(feeValue) },
    value: usdValue(row.valuationUsdMinor),
    priceBasis:
      row.valuationUsdMinor === null && feeValue === null
        ? null
        : proxied
          ? "mainnet_proxy"
          : "market",
    warnings,
  };
}

export { approvalFor };
