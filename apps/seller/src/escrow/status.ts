/*
 * GET /v1/escrow/:id — an escrow's state, read from chain (free).
 *
 * `id` is the lock transaction id (`<txHash>` or `<txHash>#<index>`) or the x402/Masumi
 * `blockchainIdentifier` (resolved to its lock through the KV record when there is one,
 * otherwise matched against the live escrow UTxOs).
 *
 * From the lock, the escrow is followed through every spend (Blockfrost consumed_by_tx): a
 * spend that leaves a continuing output with the same reference_signature moves the state
 * on; a spend that leaves none ends it, and the validator rules say how:
 *   result_hash set (ResultSubmitted / WithdrawAuthorized) -> "withdrawn" (seller Withdraw)
 *   Disputed                                               -> "dispute_settled" (admins)
 *   otherwise (result_hash empty)                          -> "refunded" (buyer WithdrawRefund)
 */
import type { MasumiDatumView } from "@x402/cardano";
import { decodeBlockchainIdentifier } from "@x402/cardano";
import type { BfTxOutputRow, EscrowChain } from "./chain";
import { lovelaceOf } from "./chain";
import { blockchainIdentifierOf, ESCROW_STATE, parseDatumHex, stateName } from "./datum";
import type { EscrowStore } from "./store";

const MAX_HOPS = 12;
const TX = /^[0-9a-f]{64}$/;

export type EscrowStatusName =
  | "pending"
  | "locked"
  | "result_submitted"
  | "refund_requested"
  | "disputed"
  | "withdraw_authorized"
  | "refund_authorized"
  | "withdrawn"
  | "refunded"
  | "dispute_settled";

export interface EscrowStatus {
  readonly status: EscrowStatusName;
  readonly lockTx: string | null;
  /** The live escrow output, while there is one. */
  readonly utxo: { readonly txHash: string; readonly index: number } | null;
  readonly blockchainIdentifier: string | null;
  readonly lockedLovelace: string | null;
  readonly resultHash: string | null;
  readonly deadlines: Record<
    "payBy" | "submitResult" | "unlock" | "externalDisputeUnlock",
    string
  > | null;
  readonly sellerCooldownUntil: string | null;
  readonly buyerCooldownUntil: string | null;
  readonly history: readonly { readonly txHash: string; readonly status: EscrowStatusName }[];
  /** The transaction that ended the escrow (withdrawn / refunded / dispute_settled). */
  readonly closedBy: string | null;
}

const iso = (ms: bigint) => new Date(Number(ms)).toISOString();

function terminalStatus(last: MasumiDatumView): EscrowStatusName {
  if (last.state === ESCROW_STATE.Disputed) return "dispute_settled";
  return last.resultHash !== "" ? "withdrawn" : "refunded";
}

function escrowOutput(
  outputs: readonly BfTxOutputRow[],
  escrowAddress: string,
  match: (v: MasumiDatumView) => boolean,
  index?: number,
): { row: BfTxOutputRow; view: MasumiDatumView } | null {
  for (const row of outputs) {
    if (row.address !== escrowAddress || row.collateral) continue;
    if (index !== undefined && row.output_index !== index) continue;
    const view = parseDatumHex(row.inline_datum);
    if (view !== null && match(view)) return { row, view };
  }
  return null;
}

/** Follows an escrow from its lock transaction. null: the id is not an escrow lock. */
async function escrowStatusFromLock(
  chain: EscrowChain,
  escrowAddress: string,
  lockTx: string,
  index?: number,
): Promise<EscrowStatus | null> {
  const lockOutputs = await chain.txOutputs(lockTx);
  if (lockOutputs === null) return pendingStatus(lockTx);
  const first = escrowOutput(lockOutputs, escrowAddress, () => true, index);
  if (first === null) return null;
  const refSig = first.view.referenceSignature;
  const history: { txHash: string; status: EscrowStatusName }[] = [];
  let current = { txHash: lockTx, ...first };
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    history.push({ txHash: current.txHash, status: stateName(current.view.state) ?? "locked" });
    const spentBy = current.row.consumed_by_tx ?? null;
    if (spentBy === null) return describe(lockTx, escrowAddress, current, history, null, null);
    const outputs = await chain.txOutputs(spentBy);
    const next =
      outputs === null
        ? null
        : escrowOutput(outputs, escrowAddress, (v) => v.referenceSignature === refSig);
    if (next === null) {
      const status = terminalStatus(current.view);
      history.push({ txHash: spentBy, status });
      return describe(lockTx, escrowAddress, current, history, status, spentBy);
    }
    current = { txHash: spentBy, ...next };
  }
  return describe(lockTx, escrowAddress, current, history, null, null);
}

function pendingStatus(lockTx: string): EscrowStatus {
  return {
    status: "pending",
    lockTx,
    utxo: null,
    blockchainIdentifier: null,
    lockedLovelace: null,
    resultHash: null,
    deadlines: null,
    sellerCooldownUntil: null,
    buyerCooldownUntil: null,
    history: [],
    closedBy: null,
  };
}

function describe(
  lockTx: string | null,
  escrowAddress: string,
  current: {
    txHash: string;
    row: BfTxOutputRow | { output_index: number; amount: BfTxOutputRow["amount"] };
    view: MasumiDatumView;
  },
  history: { txHash: string; status: EscrowStatusName }[],
  terminal: EscrowStatusName | null,
  closedBy: string | null,
): EscrowStatus {
  const v = current.view;
  return {
    status: terminal ?? stateName(v.state) ?? "locked",
    lockTx,
    utxo: terminal === null ? { txHash: current.txHash, index: current.row.output_index } : null,
    blockchainIdentifier: blockchainIdentifierOf(v, escrowAddress),
    lockedLovelace: lovelaceOf(current.row.amount).toString(),
    resultHash: v.resultHash === "" ? null : v.resultHash,
    deadlines: {
      payBy: iso(v.payByTime),
      submitResult: iso(v.submitResultTime),
      unlock: iso(v.unlockTime),
      externalDisputeUnlock: iso(v.externalDisputeUnlockTime),
    },
    sellerCooldownUntil: v.sellerCooldownTime > 0n ? iso(v.sellerCooldownTime) : null,
    buyerCooldownUntil: v.buyerCooldownTime > 0n ? iso(v.buyerCooldownTime) : null,
    history,
    closedBy,
  };
}

export type StatusLookup =
  | { readonly ok: true; readonly status: EscrowStatus }
  | { readonly ok: false; readonly code: 400 | 404; readonly error: string };

/** Resolves `id` (lock tx[#ix] or blockchainIdentifier) to a status. */
export async function lookupEscrow(
  chain: EscrowChain,
  store: EscrowStore,
  escrowAddress: string,
  scanPages: number,
  rawId: string,
): Promise<StatusLookup> {
  const id = rawId.trim().toLowerCase();
  const [txHash, ix] = id.split("#");
  if (txHash !== undefined && TX.test(txHash) && (ix === undefined || /^[0-9]{1,4}$/.test(ix))) {
    const status = await escrowStatusFromLock(
      chain,
      escrowAddress,
      txHash,
      ix === undefined ? undefined : Number(ix),
    );
    return status === null
      ? { ok: false, code: 404, error: "that transaction has no escrow output" }
      : { ok: true, status };
  }
  const parts = /^[0-9a-f]+$/.test(id) ? decodeBlockchainIdentifier(id) : null;
  if (parts === null)
    return { ok: false, code: 400, error: "pass a lock transaction id or a blockchainIdentifier" };
  if (parts.contractAddress !== escrowAddress)
    return { ok: false, code: 404, error: "not an escrow of this contract" };
  const record = await store.get(parts.sellerNonce);
  if (record !== null && TX.test(record.lockTx)) {
    const status = await escrowStatusFromLock(chain, escrowAddress, record.lockTx);
    if (status !== null) return { ok: true, status };
  }
  for (let page = 1; page <= scanPages; page++) {
    const rows = await chain.addressUtxos(escrowAddress, page);
    for (const r of rows) {
      const view = parseDatumHex(r.inline_datum);
      if (view === null || view.sellerNonce !== parts.sellerNonce) continue;
      if (view.referenceSignature !== parts.referenceSignature) continue;
      return {
        ok: true,
        status: describe(
          null,
          escrowAddress,
          { txHash: r.tx_hash, row: r, view },
          [{ txHash: r.tx_hash, status: stateName(view.state) ?? "locked" }],
          null,
          null,
        ),
      };
    }
    if (rows.length < 100) break;
  }
  return {
    ok: false,
    code: 404,
    error: "no live escrow with that identifier (it may be settled; query by lock transaction)",
  };
}
