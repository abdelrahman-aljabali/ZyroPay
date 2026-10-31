import { MASUMI_ESCROW_ADDRESSES, type Transaction } from "@zyropay/shared";
import { AUTO_PAID_LABEL } from "./allowance";

/*
 * What a wallet-history transfer is, beyond "Sent" / "Received": Cardano transfers into or
 * out of the network's canonical Masumi escrow script are x402 escrow locks and refunds, and
 * transfers into or out of the user's own auto-pay allowance contract (its address is derived
 * on the device from the wallet's key, useAllowanceAddresses) fund it, pay a seller from it
 * without a tap, or come back from it. The history row carries no request data, so this reads
 * the addresses only.
 */

const NONE: ReadonlySet<string> = new Set();

export type TransactionKind =
  | "transfer"
  | "escrow_lock"
  | "escrow_refund_request"
  | "escrow_refund"
  | "allowance_fund"
  | "auto_pay"
  | "allowance_return";

export function transactionKind(
  tx: Pick<Transaction, "network" | "from" | "to" | "direction">,
  allowances: ReadonlySet<string> = NONE,
): TransactionKind {
  if (allowances.size > 0) {
    const fromAllowance = allowances.has(tx.from);
    const toAllowance = allowances.has(tx.to);
    // A top-up continues the allowance (allowance to allowance, plus the wallet's input).
    if (toAllowance && tx.direction !== "in") return "allowance_fund";
    if (fromAllowance && !toAllowance)
      return tx.direction === "in" ? "allowance_return" : "auto_pay";
  }
  const escrow = MASUMI_ESCROW_ADDRESSES[tx.network];
  if (escrow === undefined) return "transfer";
  const fromEscrow = tx.from === escrow;
  const toEscrow = tx.to === escrow;
  // The refund request re-locks the escrow output with a new datum: escrow to escrow.
  if (fromEscrow && toEscrow) return "escrow_refund_request";
  if (toEscrow && tx.direction !== "in") return "escrow_lock";
  if (fromEscrow && tx.direction !== "out") return "escrow_refund";
  return "transfer";
}

export interface TransactionKindCopy {
  /** Replaces "Sent" / "Received" as the headline. */
  readonly label: string;
  /** One plain sentence under the amount. */
  readonly note: string;
  /** Row label for the counterparty. */
  readonly counterparty: string;
}

const TRANSACTION_KIND_COPY: Readonly<
  Record<Exclude<TransactionKind, "transfer">, TransactionKindCopy>
> = {
  escrow_lock: {
    label: "Escrow lock",
    note: "An x402 payment locked in Masumi Escrow on Cardano. The seller is paid only after delivering; until then you can ask for a Refund.",
    counterparty: "Escrow",
  },
  escrow_refund_request: {
    label: "Refund request",
    note: "You asked the Escrow for your payment back. Nothing left the Escrow yet.",
    counterparty: "Escrow",
  },
  escrow_refund: {
    label: "Refund",
    note: "Your payment came back from Masumi Escrow on Cardano.",
    counterparty: "Escrow",
  },
  allowance_fund: {
    label: "Locked in allowance",
    note: "ADA moved into your auto-pay allowance on Cardano. It stays yours: revoke it any time to get the rest back.",
    counterparty: "Allowance",
  },
  auto_pay: {
    label: AUTO_PAID_LABEL,
    note: "Your agent paid this from your on-chain allowance, within the limits Cardano enforces — no approval needed.",
    counterparty: "Paid to",
  },
  allowance_return: {
    label: "Back from allowance",
    note: "What was left in your auto-pay allowance came back to your wallet.",
    counterparty: "Allowance",
  },
};

/** The Escrow / allowance copy of a transfer, or null for a plain transfer. */
export function transactionKindCopy(
  tx: Pick<Transaction, "network" | "from" | "to" | "direction">,
  allowances: ReadonlySet<string> = NONE,
): TransactionKindCopy | null {
  const kind = transactionKind(tx, allowances);
  return kind === "transfer" ? null : TRANSACTION_KIND_COPY[kind];
}
