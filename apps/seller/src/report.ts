import type { ShelleyAddress } from "./address";
import type { AddressData, BfAmount } from "./blockfrost";
import { RECENT_TX_COUNT, UTXO_PAGE_SIZE } from "./blockfrost";
import { NETWORK } from "./config";

/*
 * The paid job: a deterministic counterparty report computed from Blockfrost data.
 * Same chain state in -> same report out (except generatedAt), so running the handler
 * twice for one payment (the x402 middleware may) is harmless.
 *
 * riskScore = min(100, sum of the weights of the raised flags). Weights:
 *   NO_HISTORY          30  never seen on chain
 *   NEW_ADDRESS         20  first transaction < 7 days ago
 *   LOW_ACTIVITY        10  fewer than 5 transactions in total
 *   DORMANT             10  no transaction for > 90 days
 *   SCRIPT_ADDRESS      15  payment credential is a script
 *   MANY_TOKENS         15  >= 50 distinct native tokens (possible airdrop spam)
 *   DRAINED             15  received >= 10 ADA but now holds < 1 ADA
 *   BURST_ACTIVITY      10  the last 20 transactions all fall within 24 hours
 * The score says "how much caution before paying or trusting this address", not fraud.
 */

const DAY_MS = 86_400_000;
const NEW_ADDRESS_DAYS = 7;
const DORMANT_DAYS = 90;
const LOW_ACTIVITY_TXS = 5;
const MANY_TOKENS = 50;
const DRAINED_RECEIVED_LOVELACE = 10_000_000n;
const DRAINED_BALANCE_LOVELACE = 1_000_000n;
const RECENT_LISTED = 5;

export type Severity = "low" | "medium" | "high";

export interface RiskFlag {
  readonly code: string;
  readonly severity: Severity;
  readonly weight: number;
  readonly message: string;
}

export interface AddressReport {
  readonly address: string;
  readonly network: typeof NETWORK;
  readonly addressKind: ShelleyAddress["kind"];
  readonly paymentCredential: ShelleyAddress["paymentCredential"];
  readonly isScript: boolean;
  readonly seenOnChain: boolean;
  readonly balanceLovelace: string;
  readonly balanceAda: string;
  readonly tokenCount: number;
  readonly utxoCount: number;
  /** True when the address has more UTxOs than one Blockfrost page (utxoCount is a floor). */
  readonly utxoCountIsLowerBound: boolean;
  readonly txCount: number;
  readonly receivedLovelace: string;
  readonly sentLovelace: string;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  /** Counted over the most recent 20 transactions. */
  readonly recentActivity: {
    readonly last24h: number;
    readonly last7d: number;
    readonly last30d: number;
  };
  readonly recentTxs: readonly { readonly txHash: string; readonly time: string }[];
  readonly stake: {
    readonly stakeAddress: string;
    readonly registered: boolean;
    readonly delegatedToPool: string | null;
    readonly delegatedToDrep: string | null;
  } | null;
  readonly riskFlags: readonly RiskFlag[];
  readonly riskScore: number;
  readonly generatedAt: string;
  readonly dataSource: "blockfrost-preprod";
}

function lovelaceOf(amounts: readonly BfAmount[] | undefined): bigint {
  const q = amounts?.find((x) => x.unit === "lovelace")?.quantity;
  return q !== undefined && /^[0-9]+$/.test(q) ? BigInt(q) : 0n;
}

/** 1234567 -> "1.234567"; integer math only. */
export function formatAda(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole.toString()}.${frac}`;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function flag(code: string, severity: Severity, weight: number, message: string): RiskFlag {
  return { code, severity, weight, message };
}

export function computeReport(
  address: ShelleyAddress,
  data: AddressData,
  now: Date,
): AddressReport {
  const nowMs = now.getTime();
  const balance = lovelaceOf(data.address?.amount);
  const received = lovelaceOf(data.total?.received_sum);
  const sent = lovelaceOf(data.total?.sent_sum);
  const tokenCount = (data.address?.amount ?? []).filter(
    (a) => a.unit !== "lovelace" && a.quantity !== "0",
  ).length;
  const txCount = data.total?.tx_count ?? 0;
  const seenOnChain = data.address !== null || txCount > 0;
  const isScript = data.address?.script ?? address.paymentCredential === "script";

  const times = data.recentTxs.map((t) => t.block_time * 1000);
  const lastMs = times.length > 0 ? Math.max(...times) : null;
  const firstMs = data.firstTx === null ? null : data.firstTx.block_time * 1000;
  const within = (days: number) => times.filter((t) => nowMs - t <= days * DAY_MS).length;

  const flags: RiskFlag[] = [];
  if (txCount === 0) {
    flags.push(flag("NO_HISTORY", "high", 30, "Address has never appeared in a transaction."));
  } else {
    if (firstMs !== null && nowMs - firstMs < NEW_ADDRESS_DAYS * DAY_MS)
      flags.push(flag("NEW_ADDRESS", "medium", 20, "First transaction is less than 7 days old."));
    if (txCount < LOW_ACTIVITY_TXS)
      flags.push(flag("LOW_ACTIVITY", "low", 10, `Only ${txCount} transaction(s) in total.`));
    if (lastMs !== null && nowMs - lastMs > DORMANT_DAYS * DAY_MS)
      flags.push(flag("DORMANT", "low", 10, "No transaction in the last 90 days."));
  }
  if (isScript)
    flags.push(
      flag(
        "SCRIPT_ADDRESS",
        "medium",
        15,
        "Script payment credential: a plain transfer without the expected datum may be unspendable.",
      ),
    );
  if (tokenCount >= MANY_TOKENS)
    flags.push(
      flag("MANY_TOKENS", "medium", 15, `${tokenCount} distinct tokens: possible airdrop spam.`),
    );
  if (received >= DRAINED_RECEIVED_LOVELACE && balance < DRAINED_BALANCE_LOVELACE)
    flags.push(
      flag(
        "DRAINED",
        "medium",
        15,
        `Received ${formatAda(received)} ADA in total but holds under 1 ADA now.`,
      ),
    );
  if (
    data.recentTxs.length >= RECENT_TX_COUNT &&
    lastMs !== null &&
    lastMs - Math.min(...times) <= DAY_MS
  )
    flags.push(flag("BURST_ACTIVITY", "low", 10, "The last 20 transactions happened within 24h."));

  const riskScore = Math.min(
    100,
    flags.reduce((s, f) => s + f.weight, 0),
  );
  const account = data.account;
  const stakeAddress = data.address?.stake_address ?? null;

  return {
    address: address.bech32,
    network: NETWORK,
    addressKind: address.kind,
    paymentCredential: address.paymentCredential,
    isScript,
    seenOnChain,
    balanceLovelace: balance.toString(),
    balanceAda: formatAda(balance),
    tokenCount,
    utxoCount: data.utxos.length,
    utxoCountIsLowerBound: data.utxos.length >= UTXO_PAGE_SIZE,
    txCount,
    receivedLovelace: received.toString(),
    sentLovelace: sent.toString(),
    firstSeen: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastSeen: lastMs === null ? null : new Date(lastMs).toISOString(),
    recentActivity: { last24h: within(1), last7d: within(7), last30d: within(30) },
    recentTxs: data.recentTxs
      .slice(0, RECENT_LISTED)
      .map((t) => ({ txHash: t.tx_hash, time: iso(t.block_time) })),
    stake:
      stakeAddress === null
        ? null
        : {
            stakeAddress,
            registered: account?.registered ?? false,
            delegatedToPool: account?.active === true ? account.pool_id : null,
            delegatedToDrep: account?.drep_id ?? null,
          },
    riskFlags: flags,
    riskScore,
    generatedAt: now.toISOString(),
    dataSource: "blockfrost-preprod",
  };
}
