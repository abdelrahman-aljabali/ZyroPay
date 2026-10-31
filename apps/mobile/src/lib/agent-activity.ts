import {
  formatBaseUnits,
  getNetwork,
  isMasumiEscrowLock,
  type AgentActivityItem,
  type TxRequestState,
} from "@zyropay/shared";
import { formatDateTime } from "@zyropay/ui/format";
import { AUTO_PAID_LABEL, isAutoPaid } from "./allowance";
import { x402Purpose } from "./x402";

/* How an agent's requests read in the app (activity list and the agent's recent activity). */

type Tone = "success" | "danger" | "neutral" | "caution";

export const ACTIVITY_STATE: Readonly<Record<TxRequestState, { label: string; tone: Tone }>> = {
  CREATED: { label: "Checking", tone: "neutral" },
  POLICY_CHECK: { label: "Checking", tone: "neutral" },
  PENDING_APPROVAL: { label: "Waiting for you", tone: "caution" },
  APPROVED: { label: "Approved", tone: "success" },
  SIGNING: { label: "Sending", tone: "neutral" },
  BROADCAST: { label: "Sent", tone: "neutral" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  REJECTED: { label: "Rejected", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function activityTitle(
  item: AgentActivityItem,
  symbols: ReadonlyMap<string, string>,
): string {
  const { payload } = item.request;
  const amount = formatBaseUnits(payload.amount, payload.asset.decimals, { maxFractionDigits: 6 });
  const symbol =
    symbols.get(payload.asset.id) ??
    (payload.asset.kind === "native"
      ? getNetwork(payload.network).nativeCurrency.symbol
      : "tokens");
  // x402 payments say what kind they are: locked in Masumi escrow, or paid to the seller.
  if (payload.tool === "pay_x402" || payload.plugin === "x402")
    return `${isMasumiEscrowLock(payload) ? "Escrow lock" : "x402 payment"} · ${amount} ${symbol}`;
  const verb = payload.tool === "swap" ? "Swap" : "Send";
  return `${verb} ${amount} ${symbol}`;
}

/** "Needed you · Cardano Preprod · <date>"; x402 payments name the seller's host instead. */
export function activitySubtitle(item: AgentActivityItem): string {
  const how = isAutoPaid(item.request)
    ? AUTO_PAID_LABEL
    : item.autonomous
      ? "Autonomous"
      : item.approvalId !== null
        ? "Needed you"
        : "Policy";
  const { payload } = item.request;
  const where = x402Purpose(payload)?.host ?? getNetwork(payload.network).displayName;
  return `${how} · ${where} · ${formatDateTime(item.request.createdAt)}`;
}
