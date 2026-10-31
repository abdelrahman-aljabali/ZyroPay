/*
 * What gets signed, how it is built, stored, re-verified and (Solana) rebuilt.
 *
 *  - Plain transfers: the network's TransactionBuilder. EVM transfers get a nonce the API
 *    allocates under an advisory lock (lowest free nonce >= the chain's pending nonce among
 *    this address's in-flight requests), so concurrent requests never share a nonce and a
 *    request that dies before broadcast frees its nonce for the next one.
 *  - Plugin transactions: the adapter's buildTransaction, verified by the adapter's OWN
 *    verifier (a swap would never pass the transfer verifier). No verifier => not signable.
 *  - x402 on EVM: EIP-712 typed data (EIP-3009 authorization); the user signs its digest
 *    with Turnkey SIGN_RAW_PAYLOAD. Stored as unsigned_transaction = digest (hex) and
 *    artifacts.typed_data, re-derived and verified by the adapter before signing.
 *  - x402 on Cardano: a plain transfer to payTo built by the network's builder, valid no
 *    longer than the requirement's maxTimeoutSeconds (the facilitator refuses a later TTL),
 *    verified by the x402 adapter (transfer verifier + binding to the x402 terms). A Masumi
 *    escrow payment (pluginData.escrow) is instead a lock built by the network's escrow
 *    builder (TTL = payByTime's slot, floored, and within maxTimeoutSeconds), verified by the
 *    adapter with verifyCardanoEscrowLock against the bound datum.
 */
import type {
  CanonicalTransactionPayload,
  JsonObject,
  NetworkId,
  PluginQuote,
  UnsignedTransaction,
  UnsignedTypedData,
  VerificationResult,
} from "@zyropay/shared";
import { chainFamilyOf, payloadHash } from "@zyropay/shared";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { NetworkBuilder } from "../chain";
import * as t from "../db/tables";
import type { AppDeps, Ctx } from "../deps";
import { AppError } from "../lib/errors";
import type { TxRequestRow } from "./mappers";
import { getArtifacts, updateRequestData, upsertArtifacts } from "./tx-state";

export type Artifacts = NonNullable<Awaited<ReturnType<typeof getArtifacts>>>;

export type BuiltArtifact =
  | {
      readonly kind: "transaction";
      readonly unsigned: UnsignedTransaction;
      /** Builder metadata (blockhash, lastValidBlockHeight, nonce, fees) as JSON. */
      readonly meta: JsonObject;
      readonly evmNonce: number | null;
    }
  | { readonly kind: "typed_data"; readonly typed: UnsignedTypedData };

/** Requests in these states hold their EVM nonce. */
const NONCE_HOLDING_STATES = [
  "CREATED",
  "POLICY_CHECK",
  "PENDING_APPROVAL",
  "APPROVED",
  "SIGNING",
  "BROADCAST",
] as const;

function isTypedDataPayload(payload: CanonicalTransactionPayload): boolean {
  return payload.plugin === "x402" && chainFamilyOf(payload.network) === "evm";
}

function isCardanoX402Payload(payload: CanonicalTransactionPayload): boolean {
  return payload.plugin === "x402" && chainFamilyOf(payload.network) === "cardano";
}

/** The x402 requirement's maxTimeoutSeconds, from the payload's bound terms. */
function x402MaxTimeoutSeconds(payload: CanonicalTransactionPayload): number {
  const value = payload.pluginData?.maxTimeoutSeconds;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error("x402 payload without maxTimeoutSeconds");
  return value;
}

function toJsonObject(value: object): JsonObject {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as JsonObject;
}

/**
 * Allocate the EVM nonce for a request: the lowest nonce >= the chain's pending nonce that no
 * other in-flight request of the same (network, from) holds. Serialized per address with a
 * transaction-scoped advisory lock; the choice is stored in the request's artifacts in the
 * same transaction, so the next allocation sees it.
 */
export async function allocateEvmNonce(
  ctx: Ctx,
  requestId: string,
  network: NetworkId,
  from: string,
  builder: NetworkBuilder,
): Promise<number> {
  const { deps } = ctx;
  if (builder.getNonceState === undefined) throw new Error("builder has no nonce state");
  const state = await builder.getNonceState(from);
  const lockKey = `evm-nonce:${network}:${from.toLowerCase()}`;
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const held = await tx
      .select({ nonce: t.transactionRequestArtifacts.evmNonce })
      .from(t.transactionRequestArtifacts)
      .innerJoin(
        t.transactionRequests,
        eq(t.transactionRequests.id, t.transactionRequestArtifacts.transactionRequestId),
      )
      .where(
        and(
          eq(t.transactionRequests.network, network),
          sql`lower(${t.transactionRequests.payload}->>'from') = ${from.toLowerCase()}`,
          inArray(t.transactionRequests.state, [...NONCE_HOLDING_STATES]),
          gte(t.transactionRequestArtifacts.evmNonce, state.pending),
          ne(t.transactionRequests.id, requestId),
        ),
      );
    const taken = new Set(held.map((h) => h.nonce));
    let nonce = state.pending;
    while (taken.has(nonce)) nonce++;
    await upsertArtifacts(tx, requestId, deps.clock.now(), { evmNonce: nonce });
    return nonce;
  });
}

/** Build what the user (or the delegated key) will sign for a stored request. */
export async function buildArtifact(
  ctx: Ctx,
  row: Pick<TxRequestRow, "id" | "payload">,
  quote: PluginQuote | null,
): Promise<BuiltArtifact> {
  const { deps } = ctx;
  const payload = row.payload;
  const expectedHash = payloadHash(payload);
  if (payload.plugin === null) {
    const builder = deps.chain.builder(payload.network);
    let nonce: number | null = null;
    if (builder.family === "evm" && builder.getNonceState !== undefined) {
      const existing = await getArtifacts(deps.db, row.id);
      nonce =
        existing?.evmNonce ??
        (await allocateEvmNonce(ctx, row.id, payload.network, payload.from, builder));
    }
    const unsigned = await builder.buildTransfer(payload, nonce === null ? {} : { nonce });
    return checked(deps, payload, expectedHash, {
      kind: "transaction",
      unsigned,
      meta: metaOf(unsigned),
      evmNonce: nonce,
    });
  }
  const adapter = deps.plugins[payload.plugin];
  if (adapter === undefined)
    throw new AppError("PLUGIN_DISABLED", `${payload.plugin} is not available`);
  const q: PluginQuote = quote ?? {
    pluginId: payload.plugin,
    pluginData: payload.pluginData ?? {},
    inputAmount: payload.amount,
    expectedOutputAmount: null,
    expiresAt: payload.expiresAt,
    simulated: deps.config.useMocks,
  };
  if (isCardanoX402Payload(payload)) {
    const maxValiditySeconds = x402MaxTimeoutSeconds(payload);
    const unsigned =
      payload.pluginData?.escrow != null
        ? await deps.chain.cardanoEscrow(payload.network).buildLock(payload, { maxValiditySeconds })
        : await deps.chain.builder(payload.network).buildTransfer(payload, { maxValiditySeconds });
    return checked(deps, payload, expectedHash, {
      kind: "transaction",
      unsigned,
      meta: metaOf(unsigned),
      evmNonce: null,
    });
  }
  if (isTypedDataPayload(payload)) {
    if (adapter.buildTypedData === undefined)
      throw new AppError("PLUGIN_DISABLED", `${payload.plugin} cannot build typed data`);
    const typed = await adapter.buildTypedData({ payload, quote: q });
    if (typed.payloadHash !== expectedHash || typed.network !== payload.network)
      throw new Error("adapter returned typed data for a different payload");
    if (!/^0x[0-9a-f]{64}$/.test(typed.digest)) throw new Error("malformed EIP-712 digest");
    if (typed.simulated && !deps.config.useMocks) throw new Error("simulated typed data refused");
    return { kind: "typed_data", typed };
  }
  const unsigned = await adapter.buildTransaction({ payload, quote: q });
  return checked(deps, payload, expectedHash, {
    kind: "transaction",
    unsigned,
    meta: metaOf(unsigned),
    evmNonce: null,
  });
}

function metaOf(unsigned: UnsignedTransaction): JsonObject {
  const { serialized: _serialized, ...rest } = unsigned as UnsignedTransaction &
    Record<string, unknown>;
  return toJsonObject(rest);
}

function checked(
  deps: AppDeps,
  payload: CanonicalTransactionPayload,
  expectedHash: string,
  built: Extract<BuiltArtifact, { kind: "transaction" }>,
): BuiltArtifact {
  const { unsigned } = built;
  if (unsigned.payloadHash !== expectedHash || unsigned.network !== payload.network) {
    throw new Error("builder returned a transaction for a different payload");
  }
  if (unsigned.simulated && !deps.config.useMocks) throw new Error("simulated transaction refused");
  return built;
}

/** Persist a built artifact on the request (optimistic lock) and its artifacts row. */
export async function persistArtifact(
  ctx: Ctx,
  row: TxRequestRow,
  built: BuiltArtifact,
): Promise<TxRequestRow> {
  const now = ctx.deps.clock.now();
  return ctx.deps.db.transaction(async (tx) => {
    if (built.kind === "typed_data") {
      const updated = await updateRequestData(tx, row, now, {
        unsignedTransaction: built.typed.digest,
        unsignedTransactionEncoding: "hex",
        simulated: row.simulated || built.typed.simulated,
      });
      await upsertArtifacts(tx, row.id, now, {
        signingKind: "typed_data",
        typedData: built.typed.typedData,
        unsignedMeta: null,
        unsignedValidUntil:
          built.typed.validUntil === null ? null : new Date(built.typed.validUntil),
        unsignedBuiltAt: now,
        estimatedFee: "0",
      });
      return updated;
    }
    const { unsigned } = built;
    const updated = await updateRequestData(tx, row, now, {
      unsignedTransaction: unsigned.serialized,
      unsignedTransactionEncoding: unsigned.encoding,
      simulated: row.simulated || unsigned.simulated,
    });
    await upsertArtifacts(tx, row.id, now, {
      signingKind: "transaction",
      unsignedMeta: built.meta,
      ...(built.evmNonce !== null ? { evmNonce: built.evmNonce } : {}),
      unsignedValidUntil: unsigned.validUntil === null ? null : new Date(unsigned.validUntil),
      unsignedBuiltAt: now,
      estimatedFee: unsigned.estimatedFee,
    });
    return updated;
  });
}

/** The stored unsigned transaction with its builder metadata (for rebuildIfExpiring). */
function restoreUnsigned(row: TxRequestRow, artifacts: Artifacts): UnsignedTransaction {
  if (row.unsignedTransaction === null || row.unsignedTransactionEncoding === null) {
    throw new Error("transaction is not built");
  }
  return {
    ...(artifacts.unsignedMeta ?? {}),
    family: chainFamilyOf(row.network),
    network: row.network,
    payloadHash: row.payloadHash,
    encoding: row.unsignedTransactionEncoding,
    serialized: row.unsignedTransaction,
    estimatedFee: artifacts.estimatedFee ?? row.payload.feeCap,
    validUntil: artifacts.unsignedValidUntil?.toISOString() ?? null,
    simulated: row.simulated,
  };
}

/**
 * ADR-001 D4. A plain Solana transfer whose blockhash is about to expire is rebuilt from
 * the same payload with the builder's rebuildIfExpiring (same payloadHash, asserted by the
 * builder). Other stored transactions with a `validUntil` (plugin transactions, mocks) are
 * rebuilt when less than `marginMs` is left. Returns the (possibly updated) request.
 */
export async function rebuildIfExpiring(
  ctx: Ctx,
  row: TxRequestRow,
  marginMs: number,
): Promise<TxRequestRow> {
  const { deps } = ctx;
  const artifacts = await getArtifacts(deps.db, row.id);
  if (artifacts === null || artifacts.signingKind !== "transaction") return row;
  if (row.unsignedTransaction === null) return row;
  const builder = row.payload.plugin === null ? deps.chain.builder(row.network) : null;
  const meta = artifacts.unsignedMeta;
  if (
    builder?.rebuildIfExpiring !== undefined &&
    builder.family === "solana" &&
    meta !== null &&
    typeof meta.lastValidBlockHeight === "string"
  ) {
    const { rebuilt, transaction } = await builder.rebuildIfExpiring(
      restoreUnsigned(row, artifacts),
      row.payload,
    );
    if (!rebuilt) return row;
    return persistArtifact(ctx, row, {
      kind: "transaction",
      unsigned: transaction,
      meta: metaOf(transaction),
      evmNonce: null,
    });
  }
  const validUntil = artifacts.unsignedValidUntil;
  if (validUntil === null || validUntil.getTime() - deps.clock.now().getTime() >= marginMs) {
    return row;
  }
  return persistArtifact(ctx, row, await buildArtifact(ctx, row, null));
}

/**
 * Independent decode of what is about to be signed, against the payload. Fails closed:
 * a plugin without its own verifier, or any verifier error, is a failure.
 */
export async function verifyStored(
  deps: AppDeps,
  row: TxRequestRow,
  artifacts: Artifacts | null,
): Promise<VerificationResult> {
  try {
    if (row.unsignedTransaction === null || row.unsignedTransactionEncoding === null) {
      return { ok: false, reason: "transaction is not built" };
    }
    const payload = row.payload;
    if (artifacts?.signingKind === "typed_data") {
      const adapter = payload.plugin === null ? undefined : deps.plugins[payload.plugin];
      if (adapter?.verifyTypedData === undefined || artifacts.typedData === null) {
        return { ok: false, reason: "no typed-data verifier" };
      }
      return await adapter.verifyTypedData(
        {
          kind: "eip712",
          network: row.network,
          payloadHash: row.payloadHash,
          typedData: artifacts.typedData,
          digest: row.unsignedTransaction,
          validUntil: artifacts.unsignedValidUntil?.toISOString() ?? null,
          simulated: row.simulated,
        },
        payload,
      );
    }
    if (payload.plugin === null) {
      return await deps.chain
        .builder(row.network)
        .verifyMatchesPayload(row.unsignedTransaction, row.unsignedTransactionEncoding, payload);
    }
    const adapter = deps.plugins[payload.plugin];
    if (adapter?.verifyTransaction === undefined) {
      return { ok: false, reason: `no verifier for plugin ${payload.plugin}` };
    }
    return await adapter.verifyTransaction(
      row.unsignedTransaction,
      row.unsignedTransactionEncoding,
      payload,
    );
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "verifier failed" };
  }
}
