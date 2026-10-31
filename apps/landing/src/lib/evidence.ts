/**
 * Live evidence, read from evidence.json at build time. Only well-formed hashes become links;
 * anything else renders as a pending slot, so an empty file is always safe to ship.
 */
import data from "./evidence.json";

export type EvidenceNetwork = "cardano-preprod";

export interface Tx {
  readonly hash: string;
  readonly short: string;
  readonly url: string;
}

export interface Evidence {
  readonly id: string;
  readonly network: EvidenceNetwork;
  readonly networkLabel: string;
  readonly label: string;
  /** "30 Oct 2026, 16:25 UTC", or null when not recorded. */
  readonly when: string | null;
  /** Null until a live run fills it in. */
  readonly tx: Tx | null;
}

const LABELS: Record<EvidenceNetwork, string> = {
  "cardano-preprod": "Cardano Preprod",
};

const VALID: Record<EvidenceNetwork, RegExp> = {
  "cardano-preprod": /^[0-9a-f]{64}$/,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isNetwork(n: string): n is EvidenceNetwork {
  return n in LABELS;
}

function link(network: EvidenceNetwork, hash: string): string {
  const base = (data.explorers as Record<string, string>)[network] ?? "";
  return base.includes("{hash}") ? base.replace("{hash}", hash) : `${base}${hash}`;
}

/** Deterministic (UTC, no locale) so the build output never depends on the build machine. */
function when(iso: string): string | null {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const EVIDENCE: readonly Evidence[] = data.items.flatMap((item) => {
  if (!isNetwork(item.network)) return [];
  const hash = item.txHash.trim();
  const ok = VALID[item.network].test(hash);
  return [
    {
      id: item.id,
      network: item.network,
      networkLabel: LABELS[item.network],
      label: item.label,
      when: ok ? when(item.at) : null,
      tx: ok
        ? { hash, short: `${hash.slice(0, 8)}…${hash.slice(-6)}`, url: link(item.network, hash) }
        : null,
    },
  ];
});

const byId = (id: string) => EVIDENCE.find((e) => e.id === id) ?? null;

/** "d80a 4d02 … bfbf bfce": a hash shortened the way the receipt prints it. */
function groups(hex: string): string {
  const g = (s: string) => s.match(/.{4}/g)?.join(" ") ?? s;
  return `${g(hex.slice(0, 8))} … ${g(hex.slice(-8))}`;
}

function shortAddr(a: string): string {
  return a.length > 24 ? `${a.slice(0, 16)}…${a.slice(-6)}` : a;
}

export interface LiveReceipt {
  readonly item: string;
  readonly amount: string;
  readonly seller: string;
  readonly resultHash: string;
  readonly lock: Tx;
  readonly result: Tx;
  /** Seconds between the lock and the recorded result, when both times are known. */
  readonly seconds: number | null;
}

function liveReceipt(): LiveReceipt | null {
  const r = data.receipt;
  const lock = byId(r.lock);
  const result = byId(r.result);
  if (!lock?.tx || !result?.tx || !/^[0-9a-f]{64}$/.test(r.resultHash)) return null;
  const at = (id: string) => Date.parse(data.items.find((i) => i.id === id)?.at ?? "");
  const gap = (at(r.result) - at(r.lock)) / 1000;
  return {
    item: r.item,
    amount: r.amount,
    seller: shortAddr(r.seller),
    resultHash: groups(r.resultHash),
    lock: lock.tx,
    result: result.tx,
    seconds: Number.isFinite(gap) && gap > 0 ? Math.round(gap) : null,
  };
}

/**
 * The real escrow run the receipt shows: the lock, the seller's on-chain result and the proof
 * verdict. Null until both transactions are filled in, and the receipt then says "Example".
 */
export const LIVE_RECEIPT = liveReceipt();

export const CARDANO_LIVE = EVIDENCE.filter((e) => e.tx);
export const CARDANO_PENDING = EVIDENCE.filter((e) => !e.tx);
