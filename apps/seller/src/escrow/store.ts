/*
 * Optional seller state in Workers KV (binding ESCROW_KV). The chain is the source of truth
 * for every escrow's state; KV only remembers what the chain cannot tell: the result hash of
 * the report this seller delivered for a paid lock, so the cron sweeper can still submit it
 * when the post-response attempt did not get the lock confirmed in time.
 *
 * Key `escrow:<sellerNonce>` (the 32-byte nonce in the seller-signed terms, unique per quote).
 * Without the binding everything still works except that late SubmitResults are lost (the
 * buyer then refunds after submit_result_time).
 */

export interface EscrowRecord {
  /** The lock transaction the facilitator settled. */
  readonly lockTx: string;
  readonly sellerNonce: string;
  readonly blockchainIdentifier: string;
  /** sha256 (hex) of the delivered body = X-Delivery-Receipt contentSha256 = on-chain result_hash. */
  readonly resultHash: string;
  readonly resourceUrl: string;
  readonly createdAt: string;
  /** The SubmitResult transaction, once submitted. */
  readonly resultTx?: string;
}

/** The subset of KVNamespace used (so tests can pass a Map-backed fake). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

const PREFIX = "escrow:";
/** Kept for 3 days: every deadline of a quote falls within ~1 hour of its 402. */
const TTL_SECONDS = 3 * 24 * 3600;
const MAX_LISTED = 200;

export class EscrowStore {
  constructor(private readonly kv: KvLike | undefined) {}

  get enabled(): boolean {
    return this.kv !== undefined;
  }

  async get(sellerNonce: string): Promise<EscrowRecord | null> {
    if (this.kv === undefined) return null;
    const raw = await this.kv.get(PREFIX + sellerNonce);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as EscrowRecord;
    } catch {
      return null;
    }
  }

  async put(record: EscrowRecord): Promise<void> {
    await this.kv?.put(PREFIX + record.sellerNonce, JSON.stringify(record), {
      expirationTtl: TTL_SECONDS,
    });
  }

  /** Records whose result has not been submitted yet (bounded). */
  async pending(): Promise<EscrowRecord[]> {
    if (this.kv === undefined) return [];
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
      names.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined && names.length < MAX_LISTED);
    const records = await Promise.all(
      names.slice(0, MAX_LISTED).map((n) => this.get(n.slice(PREFIX.length))),
    );
    return records.filter((r): r is EscrowRecord => r !== null && r.resultTx === undefined);
  }
}
