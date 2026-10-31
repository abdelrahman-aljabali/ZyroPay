/*
 * The seller's escrow sweeper (cron) and the post-delivery SubmitResult.
 *
 * Escrows are rediscovered from chain on every run: unspent outputs at the Masumi escrow
 * address (newest first, ESCROW_SCAN_PAGES pages) whose datum names this seller, plus the
 * lock of every KV record still waiting for its SubmitResult. For each one `decide` picks
 * at most one action from the datum state and chain time:
 *
 *   FundsLocked        SubmitResult if we delivered (KV record for this exact lock) and the
 *                      submit window is open; otherwise nothing (the buyer refunds after
 *                      submit_result_time).
 *   RefundRequested    AuthorizeRefund when AUTO_AUTHORIZE_REFUNDS (demo policy); else
 *                      SubmitResult if we delivered (the escrow becomes Disputed).
 *   Disputed           AuthorizeRefund when AUTO_AUTHORIZE_REFUNDS (after our 7-min
 *                      cooldown from the SubmitResult); else wait for the admins.
 *   ResultSubmitted    Withdraw once chain time >= unlock_time.
 *   WithdrawAuthorized Withdraw.
 *   RefundAuthorized   nothing (the buyer withdraws).
 *
 * Anyone can create an output at the escrow address with any datum, so before paying a
 * fee the sweeper requires: our payment key as seller AND in the COSE reference key, no
 * seller_return_address, at least MIN_ESCROW_PRICE_LOVELACE locked, no reference script.
 * At most MAX_ACTIONS_PER_RUN transactions per run, chained so they never share an input.
 */
import type { MasumiDatumView } from "@x402/cardano";
import type { Client, UTxO } from "@evolution-sdk/evolution";
import type { EscrowConfig } from "./config";
import { MIN_ESCROW_PRICE_LOVELACE } from "./config";
import type { EscrowChain } from "./chain";
import { loadEscrowUtxo, lovelaceOf, walletUtxos } from "./chain";
import type { SellerAction } from "./datum";
import { ESCROW_STATE, datumMentionsKeyHash, parseDatumHex, stateName } from "./datum";
import type { SpendSeller } from "./spend";
import { buildSellerSpend, spendWindow } from "./spend";
import type { EscrowRecord, EscrowStore } from "./store";

const MAX_ACTIONS_PER_RUN = 3;

export interface EscrowCandidate {
  readonly txHash: string;
  readonly index: number;
  readonly lovelace: bigint;
  readonly hasReferenceScript: boolean;
  readonly view: MasumiDatumView;
}

export type Decision =
  | { readonly action: SellerAction; readonly resultHash?: string }
  | { readonly action: null; readonly reason: string };

export interface DecideContext {
  readonly sellerKeyHash: string;
  readonly sellerPublicKey: string;
  readonly tipMs: bigint;
  readonly autoAuthorizeRefunds: boolean;
  /** Our delivery record for this escrow's quote, if any. */
  readonly record: EscrowRecord | null;
}

/** Why an escrow output is not one this seller should spend, or null. */
function rejectCandidate(c: EscrowCandidate, ctx: DecideContext): string | null {
  const v = c.view;
  if (v.seller.payment.isScript || v.seller.payment.hash !== ctx.sellerKeyHash)
    return "not our escrow";
  if (!v.referenceKey.includes(ctx.sellerPublicKey)) return "reference key is not ours";
  if (v.sellerReturnAddress !== null) return "has a seller_return_address";
  if (c.hasReferenceScript) return "carries a reference script";
  if (c.lovelace < MIN_ESCROW_PRICE_LOVELACE) return "locks less than the minimum price";
  if (v.collateralReturnLovelace > c.lovelace) return "collateral exceeds the locked value";
  return null;
}

/** The one action to take on an escrow now (pure; see the table above). */
export function decide(c: EscrowCandidate, ctx: DecideContext): Decision {
  const rejected = rejectCandidate(c, ctx);
  if (rejected !== null) return { action: null, reason: rejected };
  const v = c.view;
  // A result is only ours to submit for the exact lock we were paid with (FundsLocked
  // means the original lock output is still unspent) or its RefundRequested successor.
  const r = ctx.record;
  const delivered = r !== null && r.resultTx === undefined && r.sellerNonce === v.sellerNonce;
  const submit: Decision | null =
    delivered && (v.state !== ESCROW_STATE.FundsLocked || r.lockTx === c.txHash)
      ? { action: "SubmitResult", resultHash: r.resultHash }
      : null;
  let decision: Decision;
  switch (v.state) {
    case ESCROW_STATE.FundsLocked:
      decision = submit ?? { action: null, reason: "no delivered result to submit" };
      break;
    case ESCROW_STATE.RefundRequested:
      decision = ctx.autoAuthorizeRefunds
        ? { action: "AuthorizeRefund" }
        : (submit ?? { action: null, reason: "refund requested; auto-authorize is off" });
      break;
    case ESCROW_STATE.Disputed:
      decision = ctx.autoAuthorizeRefunds
        ? { action: "AuthorizeRefund" }
        : { action: null, reason: "disputed; waiting for the admins" };
      break;
    case ESCROW_STATE.ResultSubmitted:
    case ESCROW_STATE.WithdrawAuthorized:
      decision = { action: "Withdraw" };
      break;
    case ESCROW_STATE.RefundAuthorized:
      return { action: null, reason: "refund authorized; the buyer withdraws" };
    default:
      return { action: null, reason: "unknown state" };
  }
  if (decision.action === null) return decision;
  const window = spendWindow(decision.action, v, ctx.tipMs);
  if (typeof window === "string") return { action: null, reason: `${decision.action}: ${window}` };
  return decision;
}

export interface SweepDeps {
  readonly chain: EscrowChain;
  readonly client: Client.SigningClient;
  readonly seller: SpendSeller;
  readonly store: EscrowStore;
  readonly config: EscrowConfig;
  readonly escrowAddress: string;
}

export interface SweepEntry {
  readonly escrow: string;
  readonly state: string | null;
  readonly action: SellerAction | null;
  readonly reason?: string;
  readonly txHash?: string;
  readonly error?: string;
}

function candidateFrom(
  txHash: string,
  index: number,
  amount: readonly { unit: string; quantity: string }[],
  inlineDatum: string | null,
  referenceScriptHash: string | null,
): EscrowCandidate | null {
  const view = parseDatumHex(inlineDatum);
  if (view === null) return null;
  return {
    txHash,
    index,
    lovelace: lovelaceOf(amount),
    hasReferenceScript: referenceScriptHash !== null,
    view,
  };
}

/** Our escrows on chain: scanned pages plus the locks of pending KV records. */
async function discover(deps: SweepDeps, pending: readonly EscrowRecord[]) {
  const found = new Map<string, EscrowCandidate>();
  for (let page = 1; page <= deps.config.scanPages; page++) {
    const rows = await deps.chain.addressUtxos(deps.escrowAddress, page);
    for (const r of rows) {
      // Skip other sellers' escrows without decoding them (CPU: Workers limits).
      if (!datumMentionsKeyHash(r.inline_datum, deps.seller.keyHash)) continue;
      const c = candidateFrom(
        r.tx_hash,
        r.output_index,
        r.amount,
        r.inline_datum,
        r.reference_script_hash,
      );
      if (c !== null && c.view.seller.payment.hash === deps.seller.keyHash)
        found.set(`${c.txHash}#${c.index}`, c);
    }
    if (rows.length < 100) break;
  }
  for (const record of pending) {
    if ([...found.values()].some((c) => c.view.sellerNonce === record.sellerNonce)) continue;
    const outputs = await deps.chain.txOutputs(record.lockTx);
    for (const o of outputs ?? []) {
      if (o.address !== deps.escrowAddress || o.collateral || o.consumed_by_tx) continue;
      const c = candidateFrom(record.lockTx, o.output_index, o.amount, o.inline_datum, null);
      if (c !== null && c.view.sellerNonce === record.sellerNonce)
        found.set(`${c.txHash}#${c.index}`, c);
    }
  }
  return [...found.values()];
}

/** Builds, signs and submits one decided action; records a submitted result in KV. */
async function execute(
  deps: SweepDeps,
  c: EscrowCandidate,
  decision: Extract<Decision, { action: SellerAction }>,
  tipMs: bigint,
  wallet: readonly UTxO.UTxO[],
  record: EscrowRecord | null,
) {
  const escrow = await loadEscrowUtxo(deps.client, c.txHash, c.index);
  const spend = await buildSellerSpend({
    client: deps.client,
    seller: deps.seller,
    action: decision.action,
    escrow,
    view: c.view,
    walletUtxos: wallet,
    tipMs,
    ...(decision.resultHash !== undefined ? { resultHash: decision.resultHash } : {}),
  });
  const txHash = await deps.chain.submit(spend.cbor);
  if (decision.action === "SubmitResult" && record !== null)
    await deps.store.put({ ...record, resultTx: txHash });
  return { txHash, available: spend.available };
}

/** One sweep: discover, decide, act (bounded). Never throws; returns what it did. */
export async function sweep(deps: SweepDeps): Promise<SweepEntry[]> {
  const out: SweepEntry[] = [];
  try {
    const tipMs = await deps.chain.tipMs();
    const pending = await deps.store.pending();
    const candidates = await discover(deps, pending);
    let wallet: readonly UTxO.UTxO[] | null = null;
    let actions = 0;
    for (const c of candidates) {
      const record = (await deps.store.get(c.view.sellerNonce)) ?? null;
      const decision = decide(c, {
        sellerKeyHash: deps.seller.keyHash,
        sellerPublicKey: deps.seller.publicKey,
        tipMs,
        autoAuthorizeRefunds: deps.config.autoAuthorizeRefunds,
        record,
      });
      const base = { escrow: `${c.txHash}#${c.index}`, state: stateName(c.view.state) };
      if (decision.action === null) {
        out.push({ ...base, action: null, reason: decision.reason });
        continue;
      }
      if (actions >= MAX_ACTIONS_PER_RUN) {
        out.push({ ...base, action: decision.action, reason: "deferred to the next run" });
        continue;
      }
      actions++;
      try {
        wallet ??= await walletUtxos(deps.client, deps.seller.address);
        const done = await execute(deps, c, decision, tipMs, wallet, record);
        wallet = done.available;
        out.push({ ...base, action: decision.action, txHash: done.txHash });
      } catch (err) {
        out.push({ ...base, action: decision.action, error: errorText(err) });
      }
    }
  } catch (err) {
    out.push({ escrow: "-", state: null, action: null, error: errorText(err) });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Right after a paid escrow delivery: wait (briefly) for the lock to be on chain, then submit
 * the result. Best effort inside ctx.waitUntil; the cron sweeper retries from the KV record.
 */
export async function submitResultSoon(
  deps: SweepDeps,
  record: EscrowRecord,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<SweepEntry> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 6_000;
  const base = { escrow: `${record.lockTx}#?`, state: null, action: "SubmitResult" as const };
  try {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(delayMs);
      const outputs = await deps.chain.txOutputs(record.lockTx);
      const row = outputs?.find((o) => o.address === deps.escrowAddress && !o.collateral);
      if (row === undefined) continue;
      const c = candidateFrom(record.lockTx, row.output_index, row.amount, row.inline_datum, null);
      if (c === null) return { ...base, error: "lock output has no escrow datum" };
      const tipMs = await deps.chain.tipMs();
      const decision = decide(c, {
        sellerKeyHash: deps.seller.keyHash,
        sellerPublicKey: deps.seller.publicKey,
        tipMs,
        autoAuthorizeRefunds: deps.config.autoAuthorizeRefunds,
        record,
      });
      const entry = { escrow: `${c.txHash}#${c.index}`, state: stateName(c.view.state) };
      if (decision.action !== "SubmitResult")
        return {
          ...entry,
          action: decision.action,
          reason: decision.action === null ? decision.reason : "not a SubmitResult",
        };
      const wallet = await walletUtxos(deps.client, deps.seller.address);
      const done = await execute(deps, c, decision, tipMs, wallet, record);
      return { ...entry, action: "SubmitResult", txHash: done.txHash };
    }
    return { ...base, reason: "lock not on chain yet; the sweeper will retry" };
  } catch (err) {
    return { ...base, error: errorText(err) };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "unknown error";
}
