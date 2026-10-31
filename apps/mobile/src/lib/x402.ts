import {
  chainFamilyOf,
  explorerTxUrl,
  getNetwork,
  TERMINAL_STATES,
  type CanonicalTransactionPayload,
  type NetworkId,
  type TxRequestState,
  type X402Delivery,
  type X402ReceiptFailure,
} from "@zyropay/shared";

/*
 * Presentation helpers for x402 approvals and for following a request after approval
 * (unit-tested). They only read what the payload binds (pluginData = the x402 terms the
 * API stored, see @zyropay/integrations X402Terms) and never decide what gets signed.
 */

/** What an x402 approval is paying for, ready to show. */
export interface X402Purpose {
  /** The seller's own description of the resource (untrusted text), when it sent one. */
  readonly description: string | null;
  /** e.g. "address-intel.zyropay.online" (no scheme, no "www."). */
  readonly host: string;
  /** Path and query, long segments shortened; "/" when there is none. */
  readonly path: string;
  /** The full URL, for Details. */
  readonly url: string;
}

const MAX_DESCRIPTION = 140;
const MAX_PATH = 44;
const MAX_SEGMENT = 22;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Collapse whitespace and cap the length, so a seller can't flood the approval card. */
function cleanDescription(text: string | null): string | null {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : flat;
}

/** A long path segment (an address, an id) keeps its start and end: "addr_test1…k9x2". */
function shortenSegment(segment: string): string {
  return segment.length > MAX_SEGMENT ? `${segment.slice(0, 12)}…${segment.slice(-6)}` : segment;
}

/**
 * Split an http(s) URL into a readable host and path. A regex instead of `URL`, which React
 * Native's runtime does not fully implement. Returns null for anything else.
 */
export function readableUrl(url: string): { host: string; path: string } | null {
  const m = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)(?::\d+)?([^#]*)/i.exec(url.trim());
  if (!m?.[1]) return null;
  const host = m[1].toLowerCase().replace(/^www\./, "");
  const rest = m[2] ?? "";
  const q = rest.indexOf("?");
  const rawPath = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q);
  let path = rawPath
    .split("/")
    .map((s) => shortenSegment(s))
    .join("/");
  if (path === "") path = "/";
  if (query !== "") path += query.length > 16 ? "?…" : query;
  if (path.length > MAX_PATH) path = `${path.slice(0, 20)}…${path.slice(-(MAX_PATH - 21))}`;
  return { host, path };
}

/**
 * The resource an x402 payload pays for, or null if this is not an x402 payment. The
 * description comes from the v2 `resource` object, else the v1 requirement (`accepted`).
 */
export function x402Purpose(payload: CanonicalTransactionPayload): X402Purpose | null {
  if (payload.plugin !== "x402" || payload.pluginData === null) return null;
  const data = payload.pluginData;
  const resource = record(data.resource);
  const accepted = record(data.accepted);
  const url = str(data.resourceUrl) ?? str(resource?.url) ?? str(accepted?.resource);
  if (url === null) return null;
  const readable = readableUrl(url) ?? { host: url, path: "/" };
  return {
    description: cleanDescription(str(resource?.description) ?? str(accepted?.description)),
    host: readable.host,
    path: readable.path,
    url,
  };
}

/** "Cardano Preprod" -> "Cardano", "Base Sepolia" -> "Base". */
function chainName(network: NetworkId): string {
  return getNetwork(network).displayName.replace(/ (Devnet|Sepolia|Testnet|Preprod|Preview)$/, "");
}

export type ProgressTone = "neutral" | "success" | "danger";

/** What to say about a request after the user approved it. */
export interface RequestProgress {
  readonly title: string;
  readonly message: string;
  readonly tone: ProgressTone;
  /** Stop following: CONFIRMED, FAILED, or another state nothing moves on from. */
  readonly terminal: boolean;
  /** Timeline, in order. `done` steps are past, at most one is `active`. */
  readonly steps: readonly {
    readonly key: "signed" | "submitted" | "confirmed";
    readonly label: string;
    readonly status: "done" | "active" | "todo" | "failed";
  }[];
}

/** A failure reason as a short sentence ("broadcast failed" -> "Broadcast failed."). */
export function humanFailure(reason: string | null): string {
  const flat = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (flat === "") return "The network didn't accept it.";
  const sentence = flat.charAt(0).toUpperCase() + flat.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

const NOT_SIGNED_TITLE = {
  CREATED: "Waiting",
  POLICY_CHECK: "Waiting",
  PENDING_APPROVAL: "Waiting for approval",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
} as const;

const ORDER: Partial<Record<TxRequestState, number>> = {
  APPROVED: 0,
  SIGNING: 1,
  BROADCAST: 2,
  CONFIRMED: 3,
};

/**
 * Plain-language progress of an approved request. x402 says "Paid" and mentions the seller
 * (ZyroPay hands the signed payment to the seller, who submits it); other requests say
 * "Confirmed". A FAILED request with a transaction id failed after it was submitted.
 */
export function requestProgress(input: {
  readonly state: TxRequestState;
  readonly network: NetworkId;
  readonly x402: boolean;
  /** x402 paid into Masumi escrow: "Locked in escrow" instead of "Paid". */
  readonly escrow?: boolean;
  readonly failureReason: string | null;
  readonly txHash: string | null;
}): RequestProgress {
  const chain = chainName(input.network);
  const failed = input.state === "FAILED";
  const at = failed ? (input.txHash ? 2 : 1) : (ORDER[input.state] ?? 0);
  const step = (
    key: "signed" | "submitted" | "confirmed",
    label: string,
    n: number,
  ): RequestProgress["steps"][number] => {
    if (n < at || (n === at && input.state === "CONFIRMED")) return { key, label, status: "done" };
    if (n === at) return { key, label, status: failed ? "failed" : "active" };
    return { key, label, status: "todo" };
  };
  const steps = [
    step("signed", input.x402 ? "Signed and handed to the seller" : "Signed", 1),
    step("submitted", `Submitted to ${chain}`, 2),
    step(
      "confirmed",
      input.escrow === true ? "Locked in escrow" : input.x402 ? "Paid" : "Confirmed",
      3,
    ),
  ];
  const terminal = TERMINAL_STATES.includes(input.state);
  switch (input.state) {
    case "APPROVED":
      return {
        title: "Approved",
        message: "Approved with your passkey. Signing…",
        tone: "neutral",
        terminal,
        steps,
      };
    case "SIGNING":
      return {
        title: input.x402 ? "Signed" : "Signing",
        message: input.x402
          ? "Signed. Handing the payment to the seller…"
          : `Signing and sending it to ${chain}…`,
        tone: "neutral",
        terminal,
        steps,
      };
    case "BROADCAST":
      return {
        title: `Submitted to ${chain}`,
        message: `Submitted to ${chain}. Waiting for confirmation…`,
        tone: "neutral",
        terminal,
        steps,
      };
    case "CONFIRMED":
      return {
        title: input.escrow === true ? "Locked in escrow" : input.x402 ? "Paid" : "Confirmed",
        message:
          input.escrow === true
            ? `Confirmed on ${chain}. The payment is locked in escrow until the seller delivers.`
            : input.x402
              ? `Confirmed on ${chain}. The seller has the payment.`
              : `Confirmed on ${chain}.`,
        tone: "success",
        terminal,
        steps,
      };
    case "FAILED":
      return {
        title: input.x402 ? "Payment failed" : "Failed",
        message: humanFailure(input.failureReason),
        tone: "danger",
        terminal,
        steps,
      };
    case "CREATED":
    case "POLICY_CHECK":
    case "PENDING_APPROVAL":
    case "REJECTED":
    case "EXPIRED":
    case "CANCELLED":
      // Not approved (yet), or withdrawn before signing: nothing was signed.
      return {
        title: NOT_SIGNED_TITLE[input.state],
        message: input.failureReason ? humanFailure(input.failureReason) : "Nothing was signed.",
        tone: "neutral",
        terminal,
        steps,
      };
  }
}

/** Explorer link for a transaction id on this network. */
export function explorerLink(network: NetworkId, txHash: string | null): string | null {
  return txHash === null || txHash === "" ? null : explorerTxUrl(network, txHash);
}

/** Cardano payments always need the passkey (ADR-002: Turnkey policies can't parse them). */
export function alwaysNeedsPasskey(network: NetworkId): boolean {
  return chainFamilyOf(network) === "cardano";
}

/** What to say about the seller's delivery receipt once the resource answered. */
export interface DeliveryNotice {
  /** success: verified; danger: a receipt that does not check out; neutral: not checkable. */
  readonly tone: "success" | "danger" | "neutral";
  readonly title: string;
  readonly message: string;
  /** How the delivery is (or isn't) tied to the chain: proof before release. */
  readonly proof?: string;
}

const RECEIPT_PROBLEM: Record<
  Exclude<X402ReceiptFailure, "missing" | "unsupported_network" | "body_unavailable">,
  string
> = {
  wrong_signer: "It was signed by someone other than the seller you paid.",
  wrong_resource: "The receipt is for a different resource than the one you paid for.",
  wrong_payment: "The receipt is for a different payment.",
  content_mismatch: "What your agent received is not what the seller signed.",
  bad_signature: "The seller's signature does not check out.",
  malformed: "The seller's receipt could not be read.",
};

/**
 * The verdict ZyroPay's API reached on the seller's signed delivery receipt (it checks the
 * signature, that the key is the paid address's, and that the signed hash is the hash of
 * what the agent received). Null until the resource has answered.
 */
export function deliveryNotice(x402: X402Delivery | null | undefined): DeliveryNotice | null {
  const notice = receiptNotice(x402);
  if (notice === null) return null;
  const proof = proofLine(x402?.proof ?? null);
  return proof === null ? notice : { ...notice, proof };
}

/** One line on the proof verdict, for the delivery card (the escrow panel says more). */
function proofLine(proof: X402Delivery["proof"]): string | null {
  switch (proof?.state) {
    case "receipt_only":
      return "Direct payment: no result is recorded on Cardano, only the seller's receipt.";
    case "verified":
      return "Verified on Cardano: matches the result the seller recorded on chain.";
    case "mismatch":
      return "Does not match the result the seller recorded on Cardano: you can request a refund.";
    case "not_delivered":
      return "The seller recorded no result on Cardano before the deadline: you can get a refund.";
    case "pending":
    case "unverifiable":
    case undefined:
      return null;
  }
}

function receiptNotice(x402: X402Delivery | null | undefined): DeliveryNotice | null {
  if (x402?.status !== "delivered" || x402.receipt == null) return null;
  const { receipt } = x402;
  if (receipt.verified)
    return {
      tone: "success",
      title: "Delivery verified",
      message: "Signed by the seller you paid, over exactly what your agent received.",
    };
  switch (receipt.reason) {
    case null:
    case "missing":
      return {
        tone: "neutral",
        title: "Delivered, not verified",
        message: "This seller doesn't sign its responses, so the delivery can't be verified.",
      };
    case "unsupported_network":
    case "body_unavailable":
      return {
        tone: "neutral",
        title: "Delivered, not verified",
        message: "ZyroPay couldn't check this delivery's receipt.",
      };
    case "wrong_signer":
    case "wrong_resource":
    case "wrong_payment":
    case "content_mismatch":
    case "bad_signature":
    case "malformed":
      return {
        tone: "danger",
        title: "Delivery not verified",
        message: `${RECEIPT_PROBLEM[receipt.reason]} Treat what your agent received with caution.`,
      };
  }
}
