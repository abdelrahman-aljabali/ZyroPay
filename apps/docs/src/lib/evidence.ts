import data from "../data/evidence.json";

/** One row of src/data/evidence.json. A null txHash means the run has not happened yet. */
export interface EvidenceItem {
  readonly id: string;
  readonly title: string;
  readonly network: string;
  readonly txHash: string | null;
  readonly block?: number;
  readonly time?: string;
  readonly feeLovelace?: string;
  readonly amount?: string;
  readonly latency?: string | null;
  readonly what: string;
  readonly page: string;
  readonly checks?: readonly (readonly [string, string])[];
  readonly proof?: { readonly state: string; readonly onChainHash: string };
}

const TX_HASH = /^[0-9a-f]{64}$/;

export const items: readonly EvidenceItem[] = (data.items as unknown as EvidenceItem[]).map(
  (item) => {
    // A malformed hash is a data error: fail the build rather than link to nothing.
    if (item.txHash !== null && !TX_HASH.test(item.txHash)) {
      throw new Error(`evidence.json: ${item.id} has a malformed txHash`);
    }
    return item;
  },
);

export const isLive = (item: EvidenceItem): item is EvidenceItem & { txHash: string } =>
  item.txHash !== null;

export function evidence(id: string): EvidenceItem {
  const item = items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`evidence.json has no item "${id}"`);
  return item;
}

export function explorerUrl(item: EvidenceItem): string | null {
  if (item.txHash === null) return null;
  const base = (data.explorer as Record<string, string>)[item.network];
  if (base === undefined) throw new Error(`evidence.json: no explorer for ${item.network}`);
  return `${base}${item.txHash}`;
}

/** Lovelace (integer string) to "0.167349 ADA", exact (bigint, no floating point). */
export function ada(lovelace: string): string {
  const v = BigInt(lovelace);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}${frac ? `.${frac}` : ""} ADA`;
}

export const shortHash = (hash: string): string => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

export const blockUrl = (block: number): string =>
  `https://preprod.cardanoscan.io/block/${block.toString()}`;
