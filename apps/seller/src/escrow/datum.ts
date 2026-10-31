/*
 * The Masumi `vested_pay` (payment-v2) escrow datum, as the seller reads and rewrites it.
 *
 * Datum = Constr 0 with 19 fields (masumi-payment-service smart-contracts/payment-v2
 * validators/vested_pay.ak:32-61; parsed by @x402/cardano's parseMasumiLockDatum):
 *   11 result_hash   16 seller_cooldown_time   17 buyer_cooldown_time   18 state
 * State constructors: FundsLocked 0, ResultSubmitted 1, RefundRequested 2, Disputed 3,
 * WithdrawAuthorized 4, RefundAuthorized 5.
 *
 * Seller actions (redeemer = Action constructor, no fields):
 *   Withdraw 0       no continuing output; ResultSubmitted after unlock_time, or WithdrawAuthorized
 *   SubmitResult 5   continuing datum: result_hash set, seller cooldown >= upper + 7 min,
 *                    buyer cooldown 0, state ResultSubmitted (from FundsLocked/ResultSubmitted)
 *                    or Disputed (from RefundRequested/Disputed)
 *   AuthorizeRefund 6 continuing datum: result_hash empty, seller cooldown >= upper + 7 min,
 *                    buyer cooldown 0, state RefundAuthorized
 */
import { Data } from "@evolution-sdk/evolution";
import type { MasumiDatumView } from "@x402/cardano";
import { encodeBlockchainIdentifier, parseMasumiLockDatum } from "@x402/cardano";

export const ESCROW_STATE = {
  FundsLocked: 0n,
  ResultSubmitted: 1n,
  RefundRequested: 2n,
  Disputed: 3n,
  WithdrawAuthorized: 4n,
  RefundAuthorized: 5n,
} as const;

export type EscrowStateName =
  | "locked"
  | "result_submitted"
  | "refund_requested"
  | "disputed"
  | "withdraw_authorized"
  | "refund_authorized";

const STATE_NAMES: readonly EscrowStateName[] = [
  "locked",
  "result_submitted",
  "refund_requested",
  "disputed",
  "withdraw_authorized",
  "refund_authorized",
];

export function stateName(state: bigint): EscrowStateName | null {
  return state >= 0n && state < BigInt(STATE_NAMES.length)
    ? (STATE_NAMES[Number(state)] ?? null)
    : null;
}

/** Seller-side redeemers (vested_pay `Action` constructor indexes). */
export const SELLER_REDEEMER = {
  Withdraw: 0n,
  SubmitResult: 5n,
  AuthorizeRefund: 6n,
} as const;
export type SellerAction = keyof typeof SELLER_REDEEMER;

export function sellerRedeemer(action: SellerAction): Data.Data {
  return Data.constr(SELLER_REDEEMER[action], []);
}

function fieldsOf(datum: Data.Data): Data.Data[] {
  if (!Data.isConstr(datum) || datum.index !== 0n || datum.fields.length !== 19)
    throw new Error("not a vested_pay v2 datum");
  return [...datum.fields];
}

/** The SubmitResult continuation datum (demo masumi.ts submitResultDatum, plus Disputed). */
export function submitResultDatum(
  lock: Data.Data,
  view: MasumiDatumView,
  resultHashHex: string,
  sellerCooldownTime: bigint,
): Data.Data {
  if (!/^(?:[0-9a-f]{2})+$/.test(resultHashHex)) throw new Error("result hash must be hex");
  const fields = fieldsOf(lock);
  const disputed =
    view.state === ESCROW_STATE.RefundRequested || view.state === ESCROW_STATE.Disputed;
  fields[11] = Data.bytearray(resultHashHex);
  fields[16] = Data.int(sellerCooldownTime);
  fields[17] = Data.int(0n);
  fields[18] = Data.constr(disputed ? ESCROW_STATE.Disputed : ESCROW_STATE.ResultSubmitted, []);
  return Data.constr(0n, fields);
}

/** The AuthorizeRefund continuation datum (vested_pay.ak:702-760). */
export function authorizeRefundDatum(lock: Data.Data, sellerCooldownTime: bigint): Data.Data {
  const fields = fieldsOf(lock);
  fields[11] = Data.bytearray("");
  fields[16] = Data.int(sellerCooldownTime);
  fields[17] = Data.int(0n);
  fields[18] = Data.constr(ESCROW_STATE.RefundAuthorized, []);
  return Data.constr(0n, fields);
}

/**
 * Cheap necessary condition for "this datum names `keyHash`": the CBOR carries the 28-byte
 * hash as a byte string (header 0x581c). The shared escrow address holds hundreds of other
 * sellers' escrows, and fully parsing each costs ~2 ms of CPU, so callers skip non-matches
 * before parseDatumHex (which still decides).
 */
export function datumMentionsKeyHash(hex: string | null | undefined, keyHash: string): boolean {
  return typeof hex === "string" && hex.toLowerCase().includes(`581c${keyHash.toLowerCase()}`);
}

export function parseDatumHex(hex: string | null | undefined): MasumiDatumView | null {
  if (typeof hex !== "string" || hex === "") return null;
  try {
    return parseMasumiLockDatum(hex);
  } catch {
    return null;
  }
}

/** The x402/Masumi `blockchainIdentifier` an escrow datum corresponds to. */
export function blockchainIdentifierOf(view: MasumiDatumView, escrowAddress: string): string {
  return encodeBlockchainIdentifier({
    sellerNonce: view.sellerNonce,
    agentIdentifier: view.agentIdentifier,
    buyerNonce: view.buyerNonce,
    referenceSignature: view.referenceSignature,
    referenceKey: view.referenceKey,
    contractAddress: escrowAddress,
  });
}
