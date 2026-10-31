/*
 * Auto-pay on Cardano (docs/AUTOPAY.md): the agent's on-chain allowance.
 *
 *  - Owner actions (create, top-up, revoke) are passkey-signed exactly like an approval: the
 *    API builds the transaction, the app checks it on the device (checkCardanoAllowance*Tx in
 *    @zyropay/shared) and stamps SIGN_RAW_PAYLOAD_V2 over its body hash; `submitAllowance`
 *    re-runs the same checks on the stored bytes, verifies the stamp, claims the build once,
 *    attaches the witness and submits.
 *  - The agent key is an Ed25519 seed generated here per allowance and stored only as
 *    AES-256-GCM ciphertext under DELEGATED_KEY_ENCRYPTION_KEY, bound to the user and the
 *    allowance (AAD). It can only spend the allowance within the limits the Cardano ledger
 *    enforces (contracts/allowance) and its own fee float; revoking destroys it.
 *  - Payments (`executeAllowanceSpend`, run by the queue for a request the policy routed to
 *    the allowance): build the AgentPay spend (script evaluated by the chain provider), check
 *    it independently, sign with the agent key, then hand it to the x402 delivery path (pay_x402)
 *    or submit it (send). One payment per allowance at a time: requests serialize on the
 *    agent's policy row, and an unconfirmed spend makes the next request fall back to the
 *    passkey (ALLOWANCE_BUSY).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import type {
  AllowanceDatumView,
  AllowanceMoney,
  AllowancePayees,
  AllowanceReview,
  AllowanceSpend,
  AllowanceStatus,
  AutoPay,
  AutoPayAllowance,
  CardanoAllowance,
  CreateAllowanceBody,
  JsonObject,
  NetworkId,
  StampedTurnkeyRequest,
} from "@zyropay/shared";
import {
  ALLOWANCE_DEFAULT_FLOAT_LOVELACE,
  ALLOWANCE_MIN_FLOAT_LOVELACE,
  ALLOWANCE_MIN_RESIDUE_LOVELACE,
  allowancePayeeOf,
  allowancePeriodAt,
  allowanceScriptAddress,
  allowanceScriptHash,
  AllowanceDatumViewSchema,
  cardanoEnterpriseAddress,
  cardanoKeyHash,
  cardanoPaymentKeyHash,
  chainFamilyOf,
  checkCardanoAllowanceCreateTx,
  checkCardanoAllowanceOwnerSpendTx,
  decodeCardanoUnsignedTx,
  encodeAllowanceDatumHex,
  isValidAddressForNetwork,
  nativeAssetId,
} from "@zyropay/shared";
import { decryptSecret, encryptSecret } from "@zyropay/wallet";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { AllowanceChain, AllowanceOnChain } from "../chain";
import type { Db } from "../db/client";
import * as t from "../db/tables";
import type { AppDeps, Ctx } from "../deps";
import { AppError, notFound } from "../lib/errors";
import { loadOwnedAgent } from "./agents";
import { audit } from "./audit";
import { verifyCardanoStamp } from "./approvals";
import type { TxRequestRow } from "./mappers";
import { cardanoPublicKeyFor } from "./requests";
import { getOwnedWallet, addressFor } from "./wallets";

type AllowanceRow = typeof t.cardanoAllowances.$inferSelect;
type SpendRow = typeof t.cardanoAllowanceSpends.$inferSelect;

const DAY_MS = 86_400_000n;
const ADA = 1_000_000n;
const DESTROYED = "destroyed";
/** Fee cap for every allowance transaction (create, top-up, revoke, payment). */
const ALLOWANCE_MAX_FEE_LOVELACE = 2_000_000n;
/** Validity of an owner action shown to the user (the passkey must sign before it ends). */
const OWNER_VALIDITY_SLOTS = 900n;
/** Validity of an agent payment (x402 also caps it at maxTimeoutSeconds). */
const PAYMENT_VALIDITY_SLOTS = 540n;
const SUBMIT_MARGIN_MS = 30_000;
/** Request states in which a spend still holds the allowance UTxO. */
const IN_FLIGHT_STATES = ["CREATED", "POLICY_CHECK", "APPROVED", "SIGNING", "BROADCAST"] as const;
const LIVE_EXCLUDED = ["revoked", "failed"];

// ---------------------------------------------------------------------------
// Key custody
// ---------------------------------------------------------------------------

const keyAad = (row: Pick<AllowanceRow, "userId" | "id">) => `${row.userId}:allowance:${row.id}`;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function agentSeed(deps: AppDeps, row: AllowanceRow): Promise<Uint8Array> {
  const kek = deps.config.delegatedKeyEncryptionKey;
  if (kek === null || row.encryptedAgentKey === DESTROYED)
    throw new AppError("FORBIDDEN", "the agent key is not available");
  const seed = unhex(await decryptSecret(row.encryptedAgentKey, kek, keyAad(row)));
  if (seed.length !== 32 || hex(ed25519.getPublicKey(seed)) !== row.agentPublicKey)
    throw new Error("agent key does not match the allowance");
  return seed;
}

/** Sign the stored unsigned transaction with the agent key; returns the signed tx and id. */
async function signAsAgent(
  deps: AppDeps,
  row: AllowanceRow,
  unsigned: string,
): Promise<{ signedTransaction: string; txHash: string }> {
  const network = row.network;
  const bodyHash = deps.chain.cardanoSigningPayload({ network, unsigned });
  const seed = await agentSeed(deps, row);
  let signature: string;
  try {
    signature = hex(ed25519.sign(unhex(bodyHash), seed));
  } finally {
    seed.fill(0);
  }
  const witnessed = deps.chain.attachCardanoWitness({
    network,
    unsigned,
    publicKey: row.agentPublicKey,
    signature,
    expectedSigner: row.agentAddress,
  });
  await deps.chain.assertSignedMatchesUnsigned({
    network,
    encoding: "hex",
    signed: witnessed.signedTransaction,
    unsigned,
    expectedSigner: row.agentAddress,
  });
  return {
    signedTransaction: witnessed.signedTransaction,
    txHash: deps.chain.txHashOf({
      network,
      signedTransaction: witnessed.signedTransaction,
      encoding: "hex",
    }),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function datumOf(row: AllowanceRow): AllowanceDatumView {
  return AllowanceDatumViewSchema.parse(row.datum);
}

async function liveAllowance(db: Db, agentId: string): Promise<AllowanceRow | null> {
  const [row] = await db
    .select()
    .from(t.cardanoAllowances)
    .where(
      and(
        eq(t.cardanoAllowances.agentId, agentId),
        notInArray(t.cardanoAllowances.status, LIVE_EXCLUDED),
      ),
    );
  return row ?? null;
}

/** The request (if any) whose spend still holds the allowance. */
async function inFlightRequestId(db: Db, allowanceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: t.transactionRequests.id })
    .from(t.cardanoAllowanceSpends)
    .innerJoin(
      t.transactionRequests,
      eq(t.transactionRequests.id, t.cardanoAllowanceSpends.transactionRequestId),
    )
    .where(
      and(
        eq(t.cardanoAllowanceSpends.allowanceId, allowanceId),
        inArray(t.transactionRequests.state, [...IN_FLIGHT_STATES]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The allowance's current UTxO (the largest one ZyroPay's agent key can spend). */
function pickUtxo(utxos: readonly AllowanceOnChain[]): AllowanceOnChain | null {
  let best: AllowanceOnChain | null = null;
  for (const u of utxos) if (best === null || u.lovelace > best.lovelace) best = u;
  return best;
}

interface ChainView {
  readonly utxo: AllowanceOnChain | null;
  readonly floatLovelace: bigint | null;
  readonly readAt: Date;
}

async function readChain(deps: AppDeps, row: AllowanceRow): Promise<ChainView | null> {
  try {
    const chain = deps.chain.cardanoAllowance(row.network);
    const [utxos, float] = await Promise.all([
      chain.read(row.ownerKeyHash, row.agentKeyHash),
      chain.adaBalance(row.agentAddress),
    ]);
    return { utxo: pickUtxo(utxos), floatLovelace: float, readAt: deps.clock.now() };
  } catch (error) {
    deps.logger.warn("allowance.read_failed", { allowanceId: row.id, error });
    return null;
  }
}

interface Remaining {
  readonly spent: bigint;
  readonly start: bigint;
  readonly remainingToday: bigint;
  readonly availableNow: bigint;
}

function remainingOf(d: AllowanceDatumView, balance: bigint, nowMs: bigint): Remaining {
  const { start, spent } = allowancePeriodAt(d, nowMs);
  const capLeft = BigInt(d.periodCap) - spent;
  const holdLeft = balance - ALLOWANCE_MIN_RESIDUE_LOVELACE;
  const clamp = (v: bigint) => (v < 0n ? 0n : v);
  const remainingToday = clamp(capLeft < holdLeft ? capLeft : holdLeft);
  const perPayment = BigInt(d.perPaymentMax);
  const availableNow =
    nowMs >= BigInt(d.expiresAt) ? 0n : remainingToday < perPayment ? remainingToday : perPayment;
  return { spent, start, remainingToday, availableNow };
}

/** Persisted status transitions the chain proves (creating -> active, revoking -> revoked). */
async function reconcile(
  ctx: Ctx,
  row: AllowanceRow,
  view: ChainView | null,
): Promise<AllowanceRow> {
  const { deps } = ctx;
  if (view === null) return row;
  const now = deps.clock.now();
  let next: AllowanceStatus | null = null;
  if (row.status === "creating" && view.utxo !== null) next = "active";
  else if (
    row.status === "creating" &&
    view.utxo === null &&
    row.updatedAt.getTime() + 20 * 60_000 < now.getTime()
  )
    next = "failed";
  else if (row.status === "revoking" && view.utxo === null) next = "revoked";
  if (next === null) return row;
  const [updated] = await deps.db
    .update(t.cardanoAllowances)
    .set({
      status: next,
      updatedAt: now,
      ...(next === "revoked" ? { revokedAt: now, encryptedAgentKey: DESTROYED } : {}),
      ...(next === "failed" ? { encryptedAgentKey: DESTROYED, pendingAction: null } : {}),
    })
    .where(and(eq(t.cardanoAllowances.id, row.id), eq(t.cardanoAllowances.status, row.status)))
    .returning();
  if (updated === undefined) return row;
  await audit(ctx, {
    actorType: "system",
    userId: row.userId,
    action: `allowance.${next}`,
    targetType: "cardano_allowance",
    targetId: row.id,
  });
  return updated;
}

async function toAllowance(
  ctx: Ctx,
  row: AllowanceRow,
  view: ChainView | null,
): Promise<CardanoAllowance> {
  const now = ctx.deps.clock.now();
  const nowMs = BigInt(now.getTime());
  const d = datumOf(row);
  const utxo = view?.utxo ?? null;
  const live = utxo?.datum ?? d;
  let status = row.status as AllowanceStatus;
  let onChain: CardanoAllowance["onChain"] = null;
  if (utxo !== null && view !== null) {
    const r = remainingOf(live, utxo.lovelace, nowMs);
    onChain = {
      utxo: `${utxo.txHash}#${String(utxo.index)}`,
      balanceLovelace: utxo.lovelace.toString(),
      spentInPeriodLovelace: r.spent.toString(),
      periodStart: new Date(Number(r.start)).toISOString(),
      periodEndsAt: new Date(Number(r.start + BigInt(live.periodMs))).toISOString(),
      remainingTodayLovelace: r.remainingToday.toString(),
      availableNowLovelace: r.availableNow.toString(),
      readAt: view.readAt.toISOString(),
    };
    if (status === "active") {
      if (nowMs >= BigInt(live.expiresAt)) status = "expired";
      else if (utxo.lovelace - ALLOWANCE_MIN_RESIDUE_LOVELACE < ADA) status = "exhausted";
    }
  }
  const fiat = row.fiat as CardanoAllowance["limits"]["fiat"];
  return {
    id: row.id,
    agentId: row.agentId,
    walletId: row.walletId,
    network: row.network,
    status,
    ownerAddress: row.ownerAddress,
    scriptAddress: row.scriptAddress,
    agentAddress: row.agentAddress,
    limits: {
      perPaymentLovelace: live.perPaymentMax,
      perDayLovelace: live.periodCap,
      periodMs: live.periodMs,
      expiresAt: new Date(Number(live.expiresAt)).toISOString(),
      payees:
        row.payeeAddresses === null
          ? { mode: "any" }
          : { mode: "list", addresses: [...row.payeeAddresses] },
      fiat: fiat ?? null,
    },
    budgetLovelace: row.budgetLovelace,
    floatLovelace: row.floatLovelace,
    onChain,
    float:
      view?.floatLovelace == null
        ? null
        : {
            lovelace: view.floatLovelace.toString(),
            low: view.floatLovelace < ALLOWANCE_MIN_FLOAT_LOVELACE,
            readAt: view.readAt.toISOString(),
          },
    createTxHash: row.createTxHash,
    lastTxHash: row.lastTxHash,
    inFlightRequestId: await inFlightRequestId(ctx.deps.db, row.id),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAgentAllowance(
  ctx: Ctx,
  userId: string,
  agentId: string,
): Promise<CardanoAllowance | null> {
  const { agent } = await loadOwnedAgent(ctx, userId, agentId);
  let row = await liveAllowance(ctx.deps.db, agent.id);
  if (row === null) return null;
  const view = row.status === "pending_create" ? null : await readChain(ctx.deps, row);
  row = await reconcile(ctx, row, view);
  return toAllowance(ctx, row, view);
}

export async function listAllowanceSpends(
  ctx: Ctx,
  userId: string,
  agentId: string,
  limit = 20,
): Promise<AllowanceSpend[]> {
  const { agent } = await loadOwnedAgent(ctx, userId, agentId);
  const rows = await ctx.deps.db
    .select({ spend: t.cardanoAllowanceSpends, request: t.transactionRequests })
    .from(t.cardanoAllowanceSpends)
    .innerJoin(
      t.cardanoAllowances,
      eq(t.cardanoAllowances.id, t.cardanoAllowanceSpends.allowanceId),
    )
    .innerJoin(
      t.transactionRequests,
      eq(t.transactionRequests.id, t.cardanoAllowanceSpends.transactionRequestId),
    )
    .where(eq(t.cardanoAllowances.agentId, agent.id))
    .orderBy(desc(t.cardanoAllowanceSpends.createdAt), desc(t.cardanoAllowanceSpends.id))
    .limit(limit);
  return rows
    .filter((r) => r.spend.txHash !== null)
    .map(({ spend, request }) => ({
      id: spend.id,
      requestId: request.id,
      tool: request.payload.plugin === "x402" ? "pay_x402" : "send",
      payee: spend.payee,
      lovelace: spend.lovelace,
      txHash: spend.txHash ?? "",
      status:
        request.state === "CONFIRMED"
          ? "confirmed"
          : request.state === "BROADCAST"
            ? "submitted"
            : request.state === "SIGNING"
              ? "signed"
              : "failed",
      createdAt: spend.createdAt.toISOString(),
    }));
}

// ---------------------------------------------------------------------------
// Fiat conversion
// ---------------------------------------------------------------------------

function decimalParts(value: string): { int: bigint; scale: number } {
  const [whole = "0", fraction = ""] = value.split(".");
  return { int: BigInt(`${whole}${fraction}` || "0"), scale: fraction.length };
}

interface Priced {
  readonly lovelace: bigint;
  readonly fiat: { currency: "EUR" | "USD"; amount: string } | null;
}

async function adaPrice(
  ctx: Ctx,
  network: NetworkId,
  currency: "EUR" | "USD",
): Promise<{ price: string; asOf: string }> {
  const { deps } = ctx;
  const assetId = nativeAssetId(network);
  const { prices, simulated } = await deps.prices
    .getPrices({ assetIds: [assetId], currency })
    .catch((): Awaited<ReturnType<typeof deps.prices.getPrices>> => ({
      prices: {},
      simulated: false,
    }));
  const quote = prices[assetId];
  if (
    quote === undefined ||
    quote.price.currency !== currency ||
    (simulated && !deps.config.useMocks) ||
    !/^[0-9]+(\.[0-9]+)?$/.test(quote.price.value) ||
    decimalParts(quote.price.value).int === 0n
  )
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `no ${currency} price for ADA right now; give the limits in ADA`,
    );
  return { price: quote.price.value, asOf: quote.asOf };
}

async function priceMoney(
  ctx: Ctx,
  network: NetworkId,
  money: AllowanceMoney,
  cache: Map<string, { price: string; asOf: string }>,
): Promise<Priced> {
  if ("lovelace" in money) return { lovelace: BigInt(money.lovelace), fiat: null };
  const { currency, amount } = money.fiat;
  let quote = cache.get(currency);
  if (quote === undefined) {
    quote = await adaPrice(ctx, network, currency);
    cache.set(currency, quote);
  }
  // lovelace = floor(amount / price * 10^6), in integers.
  const a = decimalParts(amount);
  const p = decimalParts(quote.price);
  const lovelace = (a.int * 10n ** BigInt(6 + p.scale)) / (p.int * 10n ** BigInt(a.scale));
  return { lovelace, fiat: { currency, amount } };
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

interface PendingAction {
  readonly kind: "create" | "top_up" | "revoke";
  readonly status: "awaiting_signature" | "submitted";
  readonly unsigned: string;
  readonly bodyHash: string;
  readonly fee: string;
  readonly ttlSlot: string;
  readonly validUntil: string;
  readonly expect: AllowanceReview["expect"];
  readonly [key: string]: unknown;
}

function pendingOf(row: AllowanceRow): PendingAction | null {
  return (row.pendingAction as PendingAction | null) ?? null;
}

async function ownerContext(ctx: Ctx, userId: string, walletId: string) {
  const { wallet, addresses } = await getOwnedWallet(ctx, userId, walletId);
  const address = addressFor(addresses, "cardano")?.address;
  if (address === undefined) throw new AppError("BAD_REQUEST", "the wallet has no Cardano account");
  const keyHash = cardanoPaymentKeyHash(address);
  if (keyHash === null)
    throw new AppError("BAD_REQUEST", "the wallet is not a Cardano key address");
  const publicKey = await cardanoPublicKeyFor(ctx, wallet.id, address);
  return { wallet, address, keyHash, publicKey };
}

function chainOf(ctx: Ctx, network: NetworkId): AllowanceChain {
  try {
    return ctx.deps.chain.cardanoAllowance(network);
  } catch {
    throw new AppError("NETWORK_NOT_SUPPORTED", `auto-pay is not available on ${network}`);
  }
}

function reviewOf(row: AllowanceRow, pending: PendingAction): AllowanceReview {
  return {
    action: pending.kind,
    allowanceId: row.id,
    unsignedTransaction: { encoding: "hex", serialized: pending.unsigned },
    rawPayload: {
      kind: "cardano_tx_body_hash",
      payload: pending.bodyHash,
      signWith: row.ownerPublicKey,
    },
    estimatedFee: { lovelace: pending.fee },
    validUntil: pending.validUntil,
    expect: pending.expect,
  };
}

/** The same checks the device runs, on the bytes ZyroPay stored. */
function deviceCheck(row: AllowanceRow, pending: PendingAction, now: Date): string | null {
  const e = pending.expect;
  const network = row.network;
  const result =
    e.kind === "create"
      ? checkCardanoAllowanceCreateTx(pending.unsigned, {
          network,
          owner: e.owner,
          agentAddress: e.agentAddress,
          allowanceLovelace: BigInt(e.allowanceLovelace),
          floatLovelace: BigInt(e.floatLovelace),
          datum: e.datum,
          maxFee: BigInt(e.maxFeeLovelace),
          now,
        })
      : checkCardanoAllowanceOwnerSpendTx(pending.unsigned, {
          network,
          action: e.kind,
          owner: e.owner,
          utxo: e.utxo,
          ...(e.kind === "top_up" ? { newLovelace: BigInt(e.newLovelace), datum: e.datum } : {}),
          maxFee: BigInt(e.maxFeeLovelace),
          validFrom: e.validFrom,
          validUntil: e.validUntil,
          now,
        });
  return result.ok ? null : result.reason;
}

async function storePending(
  ctx: Ctx,
  row: AllowanceRow,
  pending: PendingAction,
  patch: Partial<typeof t.cardanoAllowances.$inferInsert> = {},
): Promise<AllowanceRow> {
  const reason = deviceCheck(row, pending, ctx.deps.clock.now());
  if (reason !== null) {
    ctx.deps.logger.error("allowance.build_check_failed", { allowanceId: row.id, reason });
    throw new AppError("INTERNAL_ERROR", "the allowance transaction failed its own check");
  }
  const [updated] = await ctx.deps.db
    .update(t.cardanoAllowances)
    .set({
      ...patch,
      pendingAction: pending as unknown as JsonObject,
      updatedAt: ctx.deps.clock.now(),
    })
    .where(eq(t.cardanoAllowances.id, row.id))
    .returning();
  if (updated === undefined) throw new Error("allowance update failed");
  return updated;
}

function payeesOf(
  network: NetworkId,
  payees: AllowancePayees,
  scriptHash: string,
): { addresses: string[] | null; credentials: AllowanceDatumView["allowedPayees"] } {
  if (payees.mode === "any") return { addresses: null, credentials: [] };
  const credentials: AllowanceDatumView["allowedPayees"] = [];
  const addresses: string[] = [];
  for (const address of payees.addresses) {
    if (!isValidAddressForNetwork(network, address))
      throw new AppError("BAD_REQUEST", `not a ${network} address: ${address}`);
    const cred = allowancePayeeOf(address);
    if (cred === null || cred.hash === scriptHash)
      throw new AppError("BAD_REQUEST", "a payee cannot be the allowance itself");
    if (!credentials.some((c) => c.kind === cred.kind && c.hash === cred.hash))
      credentials.push(cred);
    addresses.push(address);
  }
  return { addresses, credentials };
}

export async function createAllowance(
  ctx: Ctx,
  userId: string,
  agentId: string,
  body: CreateAllowanceBody,
): Promise<{ allowance: CardanoAllowance; review: AllowanceReview }> {
  const { deps } = ctx;
  const { agent, policy } = await loadOwnedAgent(ctx, userId, agentId);
  if (policy.revoked) throw new AppError("FORBIDDEN", "the agent was revoked");
  const network = body.network;
  if (chainFamilyOf(network) !== "cardano")
    throw new AppError("BAD_REQUEST", "auto-pay is Cardano only");
  if (!policy.allowedWalletIds.includes(body.walletId))
    throw new AppError("BAD_REQUEST", "share this wallet with the agent first");
  if (!policy.allowedNetworks.includes(network))
    throw new AppError("BAD_REQUEST", `allow ${network} for the agent first`);
  const kek = deps.config.delegatedKeyEncryptionKey;
  if (kek === null) throw new AppError("FORBIDDEN", "auto-pay is not available in this deployment");
  const chain = chainOf(ctx, network);
  const owner = await ownerContext(ctx, userId, body.walletId);

  const prices = new Map<string, { price: string; asOf: string }>();
  const [budget, perPayment, perDay] = [
    await priceMoney(ctx, network, body.budget, prices),
    await priceMoney(ctx, network, body.perPayment, prices),
    await priceMoney(ctx, network, body.perDay, prices),
  ];
  const float = BigInt(body.floatLovelace ?? ALLOWANCE_DEFAULT_FLOAT_LOVELACE.toString());
  if (float < 3n * ADA || float > 20n * ADA)
    throw new AppError("BAD_REQUEST", "the agent float must be between 3 and 20 ADA");
  if (perPayment.lovelace < ADA)
    throw new AppError("BAD_REQUEST", "per payment must be at least 1 ADA");
  if (perDay.lovelace < perPayment.lovelace)
    throw new AppError("BAD_REQUEST", "the daily limit must be at least the per-payment limit");
  if (budget.lovelace < perPayment.lovelace + ALLOWANCE_MIN_RESIDUE_LOVELACE)
    throw new AppError(
      "BAD_REQUEST",
      "the budget must cover one payment plus 2 ADA kept in the contract",
    );
  if (budget.lovelace > 10_000n * ADA) throw new AppError("BAD_REQUEST", "the budget is too large");

  const scriptHash = allowanceScriptHash(owner.keyHash);
  const scriptAddress = allowanceScriptAddress(network, owner.keyHash);
  const payees = payeesOf(network, body.payees, scriptHash);
  const now = deps.clock.now();
  const nowMs = BigInt(now.getTime());
  // Daily windows start at 00:00 UTC (windows are periodStart + k * 1 day).
  const periodStart = nowMs - (nowMs % DAY_MS);
  const expiresAt = nowMs + BigInt(body.expiresInDays) * DAY_MS;

  const fiatCurrency =
    [budget, perPayment, perDay].find((m) => m.fiat !== null)?.fiat?.currency ?? null;
  const fiat =
    fiatCurrency === null
      ? null
      : {
          currency: fiatCurrency,
          perPayment: perPayment.fiat?.amount ?? null,
          perDay: perDay.fiat?.amount ?? null,
          budget: budget.fiat?.amount ?? null,
          adaPrice: prices.get(fiatCurrency)?.price ?? "0",
          pricedAt: prices.get(fiatCurrency)?.asOf ?? now.toISOString(),
        };

  // One live allowance per agent; a pending (unsigned) one is rebuilt with its own key.
  let row = await liveAllowance(deps.db, agent.id);
  if (row !== null && row.status !== "pending_create")
    throw new AppError("CONFLICT", "this agent already has an allowance; top it up or revoke it");
  let agentPublicKey: string;
  if (row === null) {
    const seed = ed25519.utils.randomSecretKey();
    agentPublicKey = hex(ed25519.getPublicKey(seed));
    const id = deps.ids.newId();
    const encrypted = await encryptSecret(hex(seed), kek, keyAad({ userId, id }));
    seed.fill(0);
    const agentAddress = cardanoEnterpriseAddress(agentPublicKey, network);
    [row = null] = await deps.db
      .insert(t.cardanoAllowances)
      .values({
        id,
        userId,
        agentId: agent.id,
        walletId: owner.wallet.id,
        network,
        status: "pending_create",
        ownerAddress: owner.address,
        ownerKeyHash: owner.keyHash,
        ownerPublicKey: owner.publicKey,
        scriptAddress,
        agentAddress,
        agentKeyHash: cardanoKeyHash(agentPublicKey),
        agentPublicKey,
        encryptedAgentKey: encrypted,
        datum: {},
        budgetLovelace: "0",
        floatLovelace: "0",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (row === null) throw new AppError("CONFLICT", "this agent already has an allowance");
  }
  if (row.walletId !== owner.wallet.id) {
    // A pending allowance for another wallet: start over with this one.
    await deps.db
      .update(t.cardanoAllowances)
      .set({ status: "failed", encryptedAgentKey: DESTROYED, updatedAt: now })
      .where(eq(t.cardanoAllowances.id, row.id));
    return createAllowance(ctx, userId, agentId, body);
  }
  const datum: AllowanceDatumView = {
    agentKeyHash: row.agentKeyHash,
    perPaymentMax: perPayment.lovelace.toString(),
    periodMs: DAY_MS.toString(),
    periodCap: perDay.lovelace.toString(),
    periodStart: periodStart.toString(),
    spentInPeriod: "0",
    allowedPayees: payees.credentials,
    expiresAt: expiresAt.toString(),
  };
  const ttlSlot = (await chain.tipSlot()) + OWNER_VALIDITY_SLOTS;
  let built;
  try {
    built = await chain.buildCreate({
      owner: owner.address,
      lovelace: budget.lovelace,
      datum,
      float: { address: row.agentAddress, lovelace: float },
      ttlSlot,
    });
  } catch (error) {
    throw buildError(error, "the allowance could not be built");
  }
  const pending: PendingAction = {
    kind: "create",
    status: "awaiting_signature",
    unsigned: built.serialized,
    bodyHash: deps.chain.cardanoSigningPayload({ network, unsigned: built.serialized }),
    fee: built.fee.toString(),
    ttlSlot: ttlSlot.toString(),
    validUntil: new Date(Number(chain.posixOf(ttlSlot))).toISOString(),
    expect: {
      kind: "create",
      owner: owner.address,
      ownerKeyHash: owner.keyHash,
      agentAddress: row.agentAddress,
      allowanceLovelace: budget.lovelace.toString(),
      floatLovelace: float.toString(),
      datum,
      maxFeeLovelace: ALLOWANCE_MAX_FEE_LOVELACE.toString(),
    },
  };
  row = await storePending(ctx, row, pending, {
    datum: datum as unknown as JsonObject,
    payeeAddresses: payees.addresses,
    fiat: fiat as unknown as JsonObject | null,
    budgetLovelace: budget.lovelace.toString(),
    floatLovelace: float.toString(),
  });
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: "allowance.create_prepared",
    targetType: "cardano_allowance",
    targetId: row.id,
    metadata: {
      agentId: agent.id,
      budgetLovelace: budget.lovelace.toString(),
      perPaymentLovelace: perPayment.lovelace.toString(),
      perDayLovelace: perDay.lovelace.toString(),
      payees: payees.addresses?.length ?? "any",
    },
  });
  return { allowance: await toAllowance(ctx, row, null), review: reviewOf(row, pending) };
}

function buildError(error: unknown, fallback: string): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : fallback;
  if (code === "INSUFFICIENT_FUNDS") return new AppError("INSUFFICIENT_FUNDS", message);
  if (code === "VALIDATION_FAILED" || code === "INVALID_ADDRESS")
    return new AppError("BAD_REQUEST", message);
  return new AppError("UPSTREAM_UNAVAILABLE", fallback);
}

async function ownerSpend(
  ctx: Ctx,
  userId: string,
  agentId: string,
  kind: "top_up" | "revoke",
  addLovelace: bigint,
): Promise<{ allowance: CardanoAllowance; review: AllowanceReview }> {
  const { deps } = ctx;
  const { agent } = await loadOwnedAgent(ctx, userId, agentId);
  let row = await liveAllowance(deps.db, agent.id);
  if (row === null) throw notFound("allowance");
  const view = await readChain(deps, row);
  row = await reconcile(ctx, row, view);
  if (row.status !== "active")
    throw new AppError("CONFLICT", `the allowance is ${row.status.replace("_", " ")}`);
  if (view === null) throw new AppError("UPSTREAM_UNAVAILABLE", "the chain could not be read");
  const utxo = view.utxo;
  if (utxo === null) throw new AppError("CONFLICT", "the allowance is not on chain");
  if (kind === "top_up" && (await inFlightRequestId(deps.db, row.id)) !== null)
    throw new AppError("CONFLICT", "a payment from the allowance is confirming; try again shortly");
  const chain = chainOf(ctx, row.network);
  const start = await chain.tipSlot();
  const ttlSlot = start + OWNER_VALIDITY_SLOTS;
  const newLovelace = utxo.lovelace + addLovelace;
  let built;
  try {
    built = await chain.buildOwnerSpend({
      owner: row.ownerAddress,
      allowance: utxo,
      ...(kind === "top_up" ? { continuing: { lovelace: newLovelace, datum: utxo.datum } } : {}),
      validityStartSlot: start,
      ttlSlot,
    });
  } catch (error) {
    throw buildError(error, "the allowance transaction could not be built");
  }
  const validFrom = new Date(Number(chain.posixOf(start))).toISOString();
  const validUntil = new Date(Number(chain.posixOf(ttlSlot))).toISOString();
  const ref = `${utxo.txHash}#${String(utxo.index)}`;
  const common = {
    owner: row.ownerAddress,
    utxo: ref,
    maxFeeLovelace: ALLOWANCE_MAX_FEE_LOVELACE.toString(),
    validFrom,
    validUntil,
  };
  const pending: PendingAction = {
    kind,
    status: "awaiting_signature",
    unsigned: built.serialized,
    bodyHash: deps.chain.cardanoSigningPayload({
      network: row.network,
      unsigned: built.serialized,
    }),
    fee: built.fee.toString(),
    ttlSlot: ttlSlot.toString(),
    validUntil,
    addLovelace: addLovelace.toString(),
    expect:
      kind === "top_up"
        ? { kind, ...common, newLovelace: newLovelace.toString(), datum: utxo.datum }
        : { kind, ...common },
  };
  row = await storePending(ctx, row, pending);
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: `allowance.${kind}_prepared`,
    targetType: "cardano_allowance",
    targetId: row.id,
    metadata: { utxo: ref, addLovelace: addLovelace.toString() },
  });
  return { allowance: await toAllowance(ctx, row, view), review: reviewOf(row, pending) };
}

export async function topUpAllowance(
  ctx: Ctx,
  userId: string,
  agentId: string,
  budget: AllowanceMoney,
) {
  const { agent } = await loadOwnedAgent(ctx, userId, agentId);
  const row = await liveAllowance(ctx.deps.db, agent.id);
  if (row === null) throw notFound("allowance");
  const priced = await priceMoney(ctx, row.network, budget, new Map());
  if (priced.lovelace < ADA) throw new AppError("BAD_REQUEST", "a top-up must be at least 1 ADA");
  return ownerSpend(ctx, userId, agentId, "top_up", priced.lovelace);
}

export function revokeAllowance(ctx: Ctx, userId: string, agentId: string) {
  return ownerSpend(ctx, userId, agentId, "revoke", 0n);
}

export async function submitAllowance(
  ctx: Ctx,
  userId: string,
  agentId: string,
  body: { bodyHash: string; signRequest: StampedTurnkeyRequest },
): Promise<CardanoAllowance> {
  const { deps } = ctx;
  const { agent } = await loadOwnedAgent(ctx, userId, agentId);
  const row = await liveAllowance(deps.db, agent.id);
  if (row === null) throw notFound("allowance");
  const pending = pendingOf(row);
  if (pending === null || pending.status !== "awaiting_signature")
    throw new AppError("CONFLICT", "nothing to sign; prepare the allowance transaction again");
  const [user] = await deps.db.select().from(t.users).where(eq(t.users.id, userId));
  if (user === undefined) throw notFound("user");
  const reject = async (reason: string, message: string): Promise<never> => {
    await audit(ctx, {
      actorType: "user",
      actorId: userId,
      userId,
      action: "security.allowance_sign_rejected",
      targetType: "cardano_allowance",
      targetId: row.id,
      metadata: { reason, kind: pending.kind },
    });
    throw new AppError("PAYLOAD_HASH_MISMATCH", message, { reason });
  };
  if (body.bodyHash !== pending.bodyHash)
    return reject("body_hash", "the signed transaction is not the prepared one");
  const now = deps.clock.now();
  if (Date.parse(pending.validUntil) - now.getTime() <= SUBMIT_MARGIN_MS)
    throw new AppError("CONFLICT", "the prepared transaction expired; prepare it again");
  const recomputed = deps.chain.cardanoSigningPayload({
    network: row.network,
    unsigned: pending.unsigned,
  });
  const reason = deviceCheck(row, pending, now);
  if (recomputed !== pending.bodyHash || reason !== null)
    return reject("verification", "the prepared transaction failed verification");
  const chain = chainOf(ctx, row.network);
  if (pending.expect.kind !== "create") {
    const utxos = await chain.read(row.ownerKeyHash, row.agentKeyHash).catch(() => null);
    const ref = pending.expect.utxo;
    if (utxos === null || !utxos.some((u) => `${u.txHash}#${String(u.index)}` === ref))
      throw new AppError(
        "CONFLICT",
        "the allowance changed since it was prepared; prepare it again",
      );
  }
  const stamp = await verifyCardanoStamp(
    ctx,
    user,
    { walletId: row.walletId, from: row.ownerAddress, network: row.network },
    pending.unsigned,
    body.signRequest,
    now,
  );
  if (!stamp.ok)
    return reject(stamp.code, "the signed request does not match the prepared transaction");

  // Claim this build: one signature per prepared transaction.
  const claimed: PendingAction = { ...pending, status: "submitted" };
  const [won] = await deps.db
    .update(t.cardanoAllowances)
    .set({ pendingAction: claimed as unknown as JsonObject, updatedAt: now })
    .where(
      and(eq(t.cardanoAllowances.id, row.id), eq(t.cardanoAllowances.updatedAt, row.updatedAt)),
    )
    .returning();
  if (won === undefined) throw new AppError("CONFLICT", "this transaction is already being signed");
  const release = async () => {
    await deps.db
      .update(t.cardanoAllowances)
      .set({ pendingAction: null, updatedAt: deps.clock.now() })
      .where(eq(t.cardanoAllowances.id, row.id));
  };

  let signedTransaction: string;
  let txHash: string;
  try {
    const sig = await deps.turnkey.forwardStampedSignRawPayload(body.signRequest);
    if (sig.simulated && !deps.config.useMocks) throw new Error("simulated signature refused");
    const witnessed = deps.chain.attachCardanoWitness({
      network: row.network,
      unsigned: pending.unsigned,
      publicKey: row.ownerPublicKey,
      signature: `${sig.r}${sig.s}`,
      expectedSigner: row.ownerAddress,
    });
    await deps.chain.assertSignedMatchesUnsigned({
      network: row.network,
      encoding: "hex",
      signed: witnessed.signedTransaction,
      unsigned: pending.unsigned,
      expectedSigner: row.ownerAddress,
    });
    signedTransaction = witnessed.signedTransaction;
    txHash = deps.chain.txHashOf({ network: row.network, signedTransaction, encoding: "hex" });
  } catch (error) {
    deps.logger.error("allowance.sign_failed", { allowanceId: row.id, error });
    await release();
    throw new AppError("SIGNING_FAILED", "signing failed");
  }
  try {
    await chain.submit(signedTransaction);
  } catch (error) {
    deps.logger.warn("allowance.submit_failed", { allowanceId: row.id, error });
    const outcome = await deps.chain
      .track({ network: row.network, txHash, validUntilSlot: pending.ttlSlot })
      .catch(() => null);
    if (outcome === null || outcome.status !== "pending" || outcome.rebroadcastSuggested) {
      if (outcome?.status !== "confirmed") {
        await release();
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "the transaction could not be sent; prepare it again",
        );
      }
    }
  }
  const nextStatus: AllowanceStatus =
    pending.kind === "create" ? "creating" : pending.kind === "revoke" ? "revoking" : "active";
  const [updated] = await deps.db
    .update(t.cardanoAllowances)
    .set({
      status: nextStatus,
      pendingAction: null,
      lastTxHash: txHash,
      ...(pending.kind === "create" ? { createTxHash: txHash } : {}),
      ...(pending.kind === "top_up"
        ? {
            budgetLovelace: (
              BigInt(row.budgetLovelace) +
              BigInt(typeof pending.addLovelace === "string" ? pending.addLovelace : "0")
            ).toString(),
          }
        : {}),
      updatedAt: deps.clock.now(),
    })
    .where(eq(t.cardanoAllowances.id, row.id))
    .returning();
  await audit(ctx, {
    actorType: "user",
    actorId: userId,
    userId,
    action: `allowance.${pending.kind === "create" ? "created" : pending.kind === "revoke" ? "revoke_submitted" : "topped_up"}`,
    targetType: "cardano_allowance",
    targetId: row.id,
    metadata: { txHash, bodyHash: pending.bodyHash },
  });
  let current = updated ?? row;
  if (pending.kind === "revoke") current = await sweepFloat(ctx, current);
  return toAllowance(ctx, current, await readChain(deps, current));
}

/**
 * After a revoke: send the agent's whole float back to the owner (signed by the agent key; it
 * pays the owner only) and destroy the key. Best effort: a failed sweep leaves the key so the
 * next attempt (or support) can return the float; the allowance itself is already revoked.
 */
async function sweepFloat(ctx: Ctx, row: AllowanceRow): Promise<AllowanceRow> {
  const { deps } = ctx;
  const chain = chainOf(ctx, row.network);
  let sweptTx: string | null = null;
  try {
    const ttlSlot = (await chain.tipSlot()) + OWNER_VALIDITY_SLOTS;
    const built = await chain.buildFloatSweep({
      from: row.agentAddress,
      to: row.ownerAddress,
      ttlSlot,
    });
    if (built !== null) {
      // Independent check: every output goes to the owner.
      const tx = decodeCardanoUnsignedTx(built.serialized, row.network);
      if (tx.outputs.length !== 1 || tx.outputs[0]?.address !== row.ownerAddress)
        throw new Error("the float sweep does not pay the owner");
      const signed = await signAsAgent(deps, row, built.serialized);
      await chain.submit(signed.signedTransaction);
      sweptTx = signed.txHash;
    }
  } catch (error) {
    deps.logger.warn("allowance.float_sweep_failed", { allowanceId: row.id, error });
    return row;
  }
  const [updated] = await deps.db
    .update(t.cardanoAllowances)
    .set({ encryptedAgentKey: DESTROYED, updatedAt: deps.clock.now() })
    .where(eq(t.cardanoAllowances.id, row.id))
    .returning();
  await audit(ctx, {
    actorType: "system",
    userId: row.userId,
    action: "allowance.float_returned",
    targetType: "cardano_allowance",
    targetId: row.id,
    metadata: { txHash: sweptTx },
  });
  return updated ?? row;
}

// ---------------------------------------------------------------------------
// Auto-pay: decision inputs, spend execution, result
// ---------------------------------------------------------------------------

/** A request the allowance may pay, with the live chain state read BEFORE the policy lock. */
export interface AutoPayCandidate {
  readonly row: AllowanceRow;
  readonly utxo: AllowanceOnChain;
  readonly allowance: Omit<AutoPayAllowance, "busy">;
}

/**
 * Read the agent's active allowance and its chain state; null when there is none to use,
 * "unavailable" when there is one but the chain could not be read (or shows no allowance
 * UTxO): the request then falls back to the passkey with ALLOWANCE_UNAVAILABLE.
 */
export async function autoPayCandidate(
  ctx: Ctx,
  agentId: string,
  network: NetworkId,
): Promise<AutoPayCandidate | "unavailable" | null> {
  if (chainFamilyOf(network) !== "cardano") return null;
  const row = await liveAllowance(ctx.deps.db, agentId);
  if (row?.status !== "active" || row.network !== network || row.encryptedAgentKey === DESTROYED)
    return null;
  const view = await readChain(ctx.deps, row);
  if (view?.utxo == null || view.floatLovelace === null) return "unavailable";
  return {
    row,
    utxo: view.utxo,
    allowance: {
      walletId: row.walletId,
      network: row.network,
      datum: view.utxo.datum,
      balanceLovelace: view.utxo.lovelace,
      floatLovelace: view.floatLovelace,
    },
  };
}

/** Busy check under the agent's policy lock (`db` is the request transaction). */
export async function allowanceBusy(db: Db, allowanceId: string): Promise<boolean> {
  return (await inFlightRequestId(db, allowanceId)) !== null;
}

interface SpendState extends JsonObject {
  balanceAfterLovelace: string;
  remainingTodayLovelace: string;
  periodEndsAt: string;
}

/** Record the spend for a request the policy routed to the allowance (inside its transaction). */
export async function recordAllowanceSpend(
  db: Db,
  input: {
    id: string;
    candidate: AutoPayCandidate;
    requestId: string;
    payee: string;
    lovelace: bigint;
    now: Date;
  },
): Promise<void> {
  const { candidate, lovelace, now } = input;
  const d = candidate.utxo.datum;
  const nowMs = BigInt(now.getTime());
  const after = remainingOf(
    {
      ...d,
      spentInPeriod: (allowancePeriodAt(d, nowMs).spent + lovelace).toString(),
      periodStart: allowancePeriodAt(d, nowMs).start.toString(),
    },
    candidate.utxo.lovelace - lovelace,
    nowMs,
  );
  const state: SpendState = {
    balanceAfterLovelace: (candidate.utxo.lovelace - lovelace).toString(),
    remainingTodayLovelace: after.remainingToday.toString(),
    periodEndsAt: new Date(Number(after.start + BigInt(d.periodMs))).toISOString(),
  };
  await db.insert(t.cardanoAllowanceSpends).values({
    id: input.id,
    allowanceId: candidate.row.id,
    transactionRequestId: input.requestId,
    payee: input.payee,
    lovelace: lovelace.toString(),
    spentUtxo: `${candidate.utxo.txHash}#${String(candidate.utxo.index)}`,
    nextDatum: state,
    createdAt: now,
    updatedAt: now,
  });
}

async function spendFor(db: Db, requestId: string): Promise<SpendRow | null> {
  const [row] = await db
    .select()
    .from(t.cardanoAllowanceSpends)
    .where(eq(t.cardanoAllowanceSpends.transactionRequestId, requestId));
  return row ?? null;
}

export async function isAllowanceRequest(db: Db, requestId: string): Promise<boolean> {
  return (await spendFor(db, requestId)) !== null;
}

/** Lovelace as ADA for a sentence: "2", "2.5", "0.123456". */
function adaText(lovelace: string): string {
  const v = BigInt(lovelace);
  const whole = v / ADA;
  const frac = (v % ADA).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole.toString()}.${frac}`;
}

/** `TransactionRequestResult.autoPay` for a request paid (or being paid) from an allowance. */
export async function autoPayOf(db: Db, row: Pick<TxRequestRow, "id">): Promise<AutoPay | null> {
  const spend = await spendFor(db, row.id);
  if (spend === null) return null;
  const state = (spend.nextDatum ?? {}) as Partial<SpendState>;
  const left =
    state.remainingTodayLovelace === undefined
      ? "."
      : `; ${adaText(state.remainingTodayLovelace)} ADA left today.`;
  return {
    allowanceId: spend.allowanceId,
    txHash: spend.txHash,
    lovelace: spend.lovelace,
    remainingTodayLovelace: state.remainingTodayLovelace ?? null,
    balanceLovelace: state.balanceAfterLovelace ?? null,
    periodEndsAt: state.periodEndsAt ?? null,
    message: `Auto-paid ${adaText(spend.lovelace)} ADA from your on-chain allowance (no tap needed)${left}`,
  };
}

/**
 * Independent check of a built AgentPay spend before the agent key signs it: it spends the
 * expected allowance UTxO with one AgentPay redeemer and only the owner's allowance script;
 * output 0 continues to the allowance with (balance - amount) and the datum the validator
 * requires (spent + amount after roll-over, every other field unchanged); output 1 pays the
 * payee exactly the amount; the rest is plain change to the agent; the agent is the only
 * required signer, posts the collateral and gets it back; fee within the cap.
 */
function checkAgentPayTx(
  serialized: string,
  e: {
    network: NetworkId;
    ownerKeyHash: string;
    agentAddress: string;
    utxo: AllowanceOnChain;
    payee: string;
    lovelace: bigint;
    nextDatum: AllowanceDatumView;
    lowerMs: bigint;
  },
): string | null {
  let tx;
  try {
    tx = decodeCardanoUnsignedTx(serialized, e.network);
  } catch {
    return "undecodable";
  }
  const script = allowanceScriptAddress(e.network, e.ownerKeyHash);
  const agentKh = cardanoPaymentKeyHash(e.agentAddress);
  const at = tx.inputs.findIndex((i) => i.txHash === e.utxo.txHash && i.index === e.utxo.index);
  if (at < 0) return "does not spend the allowance";
  const [redeemer, ...more] = tx.redeemers;
  if (redeemer === undefined || more.length > 0 || redeemer.tag !== 0 || redeemer.index !== at)
    return "redeemer";
  if (redeemer.dataHex !== "d87980") return "not AgentPay";
  if (
    tx.plutusV3ScriptHashes.length !== 1 ||
    tx.plutusV3ScriptHashes[0] !== allowanceScriptHash(e.ownerKeyHash)
  )
    return "script";
  if (tx.requiredSigners.length !== 1 || tx.requiredSigners[0] !== agentKh) return "signer";
  if (tx.collateralReturn === null || tx.collateralReturn.address !== e.agentAddress)
    return "collateral";
  const [cont, pay, ...rest] = tx.outputs;
  if (
    cont?.address !== script ||
    cont.lovelace !== e.utxo.lovelace - e.lovelace ||
    cont.assets.size !== 0
  )
    return "continuing output";
  // The validator's next datum, computed here from the input datum.
  const d = e.utxo.datum;
  const period = allowancePeriodAt(d, e.lowerMs);
  const expected: AllowanceDatumView = {
    ...d,
    periodStart: period.start.toString(),
    spentInPeriod: (period.spent + e.lovelace).toString(),
  };
  if (cont.inlineDatumHex !== encodeAllowanceDatumHex(expected)) return "continuing datum";
  if (encodeAllowanceDatumHex(e.nextDatum) !== encodeAllowanceDatumHex(expected))
    return "next datum";
  if (pay?.address !== e.payee || pay.lovelace !== e.lovelace || pay.assets.size !== 0)
    return "payee output";
  if (rest.some((o) => o.address !== e.agentAddress || o.inlineDatumHex !== undefined))
    return "change";
  if (tx.fee > ALLOWANCE_MAX_FEE_LOVELACE) return "fee";
  return null;
}

/** Queue stage: build, check, sign (agent key) and hand off / submit an allowance payment. */
export async function executeAllowanceSpend(
  deps: AppDeps,
  requestId: string,
  hooks: {
    fail: (row: TxRequestRow, reason: string) => Promise<void>;
    markBroadcast: (row: TxRequestRow, txHash: string) => Promise<unknown>;
    applyEvent: (row: TxRequestRow, event: "START_SIGNING") => Promise<TxRequestRow>;
    updateData: (
      row: TxRequestRow,
      patch: { unsignedTransaction: string; unsignedTransactionEncoding: "hex" },
    ) => Promise<TxRequestRow>;
    upsertArtifacts: (patch: Record<string, unknown>) => Promise<void>;
    withdraw: (row: TxRequestRow, reason: string) => Promise<void>;
  },
): Promise<void> {
  const ctx: Ctx = { deps, requestId, ip: null };
  const [row] = await deps.db
    .select()
    .from(t.transactionRequests)
    .where(eq(t.transactionRequests.id, requestId));
  if (row?.state !== "APPROVED") return; // idempotent
  const spend = await spendFor(deps.db, requestId);
  if (spend === null) return;
  const now = deps.clock.now();
  if (row.expiresAt <= now) {
    await hooks.withdraw(row, "expired before signing");
    return;
  }
  const [allowance] = await deps.db
    .select()
    .from(t.cardanoAllowances)
    .where(eq(t.cardanoAllowances.id, spend.allowanceId));
  if (allowance?.status !== "active") {
    await hooks.fail(row, "the allowance is no longer active; ask again to pay with your passkey");
    return;
  }
  const chain = chainOf(ctx, allowance.network);
  let built;
  let utxo: AllowanceOnChain | null;
  let lowerMs: bigint;
  let ttlSlot: bigint;
  try {
    utxo = pickUtxo(await chain.read(allowance.ownerKeyHash, allowance.agentKeyHash));
    if (utxo === null) throw new Error("the allowance is not on chain");
    const start = await chain.tipSlot();
    lowerMs = chain.posixOf(start);
    const nowSlot = chain.slotOf(BigInt(now.getTime()), "floor");
    const maxTimeout = Number(
      (row.payload.pluginData as { accepted?: { maxTimeoutSeconds?: unknown } } | null)?.accepted
        ?.maxTimeoutSeconds ?? 600,
    );
    const windowSlots = BigInt(
      Math.max(60, Math.min(Number.isFinite(maxTimeout) ? maxTimeout : 600, 600) - 30),
    );
    const caps = [
      start + PAYMENT_VALIDITY_SLOTS,
      nowSlot + windowSlots,
      chain.slotOf(BigInt(utxo.datum.expiresAt), "floor"),
      chain.slotOf(BigInt(row.expiresAt.getTime()), "floor"),
    ];
    ttlSlot = caps.reduce((a, b) => (b < a ? b : a));
    if (ttlSlot <= nowSlot) throw new Error("no validity window left");
    built = await chain.buildAgentPay({
      ownerKeyHash: allowance.ownerKeyHash,
      allowance: utxo,
      agent: allowance.agentAddress,
      payee: row.payload.to,
      lovelace: BigInt(row.payload.amount),
      validityStartSlot: start,
      ttlSlot,
    });
  } catch (error) {
    deps.logger.warn("allowance.spend_build_failed", { requestId, error });
    await hooks.fail(
      row,
      `auto-pay could not be built (${error instanceof Error ? error.message.slice(0, 120) : "error"}); ask again to pay with your passkey`,
    );
    return;
  }
  const problem = checkAgentPayTx(built.serialized, {
    network: allowance.network,
    ownerKeyHash: allowance.ownerKeyHash,
    agentAddress: allowance.agentAddress,
    utxo,
    payee: row.payload.to,
    lovelace: BigInt(row.payload.amount),
    nextDatum: built.nextDatum,
    lowerMs,
  });
  if (problem !== null) {
    deps.logger.error("allowance.spend_check_failed", { requestId, problem });
    await audit(ctx, {
      actorType: "system",
      userId: row.userId,
      action: "security.allowance_spend_rejected",
      targetType: "transaction_request",
      targetId: row.id,
      metadata: { problem },
    });
    await hooks.fail(row, "auto-pay transaction failed verification");
    return;
  }
  let current: TxRequestRow;
  try {
    current = await hooks.updateData(row, {
      unsignedTransaction: built.serialized,
      unsignedTransactionEncoding: "hex",
    });
    current = await hooks.applyEvent(current, "START_SIGNING");
  } catch {
    return; // another worker won the race
  }
  await hooks.upsertArtifacts({
    signingKind: "transaction",
    unsignedMeta: { ttlSlot: ttlSlot.toString(), allowance: true },
    unsignedValidUntil: new Date(Number(chain.posixOf(ttlSlot))),
    unsignedBuiltAt: now,
    estimatedFee: built.fee.toString(),
  });
  let signed;
  try {
    signed = await signAsAgent(deps, allowance, built.serialized);
  } catch (error) {
    deps.logger.error("allowance.sign_failed", { requestId, error });
    await hooks.fail(current, "auto-pay signing failed");
    return;
  }
  await hooks.upsertArtifacts({
    signedTransaction: signed.signedTransaction,
    signedEncoding: "hex",
    expectedTxHash: signed.txHash,
    signedAt: deps.clock.now(),
  });
  await deps.db
    .update(t.cardanoAllowanceSpends)
    .set({ txHash: signed.txHash, updatedAt: deps.clock.now() })
    .where(eq(t.cardanoAllowanceSpends.id, spend.id));
  await deps.db
    .update(t.cardanoAllowances)
    .set({ lastTxHash: signed.txHash, updatedAt: deps.clock.now() })
    .where(eq(t.cardanoAllowances.id, allowance.id));
  await audit(ctx, {
    actorType: "system",
    userId: row.userId,
    action: "tx_request.auto_paid_from_allowance",
    targetType: "transaction_request",
    targetId: row.id,
    metadata: {
      agentId: row.agentId,
      allowanceId: allowance.id,
      txHash: signed.txHash,
      lovelace: row.payload.amount,
      payee: row.payload.to,
    },
  });
  // x402: the MCP worker hands the payment to the resource (services/x402.ts), whose
  // facilitator submits it. A plain send is submitted here.
  if (row.payload.plugin === "x402") return;
  try {
    await chain.submit(signed.signedTransaction);
  } catch (error) {
    deps.logger.warn("allowance.spend_submit_failed", { requestId, error });
    await deps.queue.send({ type: "broadcast", requestId }, { delaySeconds: 10 });
    return;
  }
  await hooks.markBroadcast(current, signed.txHash);
}
