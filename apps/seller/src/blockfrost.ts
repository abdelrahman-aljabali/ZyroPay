/*
 * Minimal Blockfrost (Cardano preprod) client: only the endpoints the report needs.
 * Response shapes follow the Blockfrost OpenAPI (https://docs.blockfrost.io):
 * address_content, address_content_total, address_transactions_content,
 * address_utxo_content and account_content.
 */

export const BLOCKFROST_PREPROD_BASE_URL = "https://cardano-preprod.blockfrost.io/api/v0";
const BLOCKFROST_TIMEOUT_MS = 8_000;
export const RECENT_TX_COUNT = 20;
/** Blockfrost's page size cap. */
export const UTXO_PAGE_SIZE = 100;

export interface BfAmount {
  readonly unit: string;
  readonly quantity: string;
}

/** GET /addresses/{address} */
export interface BfAddress {
  readonly address: string;
  readonly amount: readonly BfAmount[];
  readonly stake_address: string | null;
  readonly type: "byron" | "shelley";
  readonly script: boolean;
}

/** GET /addresses/{address}/total */
export interface BfAddressTotal {
  readonly address: string;
  readonly received_sum: readonly BfAmount[];
  readonly sent_sum: readonly BfAmount[];
  readonly tx_count: number;
}

/** GET /addresses/{address}/transactions (one element) */
export interface BfAddressTx {
  readonly tx_hash: string;
  readonly tx_index: number;
  readonly block_height: number;
  /** UNIX seconds */
  readonly block_time: number;
}

/** GET /addresses/{address}/utxos (one element; only the fields the report reads) */
export interface BfUtxo {
  readonly tx_hash: string;
  readonly output_index: number;
  readonly amount: readonly BfAmount[];
}

/** GET /accounts/{stake_address} (only the fields the report reads) */
export interface BfAccount {
  readonly stake_address: string;
  readonly active: boolean;
  readonly registered: boolean;
  readonly pool_id: string | null;
  readonly drep_id: string | null;
}

/** Everything the report is computed from. `address === null` means "never seen on chain". */
export interface AddressData {
  readonly address: BfAddress | null;
  readonly total: BfAddressTotal | null;
  readonly recentTxs: readonly BfAddressTx[];
  readonly firstTx: BfAddressTx | null;
  readonly utxos: readonly BfUtxo[];
  readonly account: BfAccount | null;
}

/** A failure the API maps to an HTTP status. Messages are short and carry no secrets. */
export class DataSourceError extends Error {
  constructor(
    readonly status: 400 | 503,
    message: string,
  ) {
    super(message);
    this.name = "DataSourceError";
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Blockfrost status -> what the buyer is told. 404 never reaches here (it is data). */
export function mapBlockfrostStatus(status: number): DataSourceError {
  switch (status) {
    case 400:
      return new DataSourceError(400, "data source rejected the address");
    case 402:
      return new DataSourceError(503, "data source quota exhausted; try again later");
    case 403:
      return new DataSourceError(503, "data source unavailable (seller configuration)");
    case 418:
    case 429:
      return new DataSourceError(503, "data source rate limited; try again shortly");
    default:
      return new DataSourceError(503, `data source error (HTTP ${status}); try again later`);
  }
}

export class BlockfrostClient {
  constructor(
    private readonly projectId: string,
    private readonly baseUrl: string = BLOCKFROST_PREPROD_BASE_URL,
    private readonly timeoutMs: number = BLOCKFROST_TIMEOUT_MS,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /** JSON body, or null on 404. Throws DataSourceError for anything else. */
  private async get<T>(path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { project_id: this.projectId, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new DataSourceError(
        503,
        timedOut ? "data source timed out; try again later" : "data source unreachable",
      );
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw mapBlockfrostStatus(res.status);
    }
    try {
      return await res.json<T>();
    } catch {
      throw new DataSourceError(503, "data source returned malformed JSON");
    }
  }

  /** All the data for one address, in at most two rounds of parallel requests. */
  async fetchAddressData(address: string): Promise<AddressData> {
    const a = encodeURIComponent(address);
    const [info, total, recent, utxos] = await Promise.all([
      this.get<BfAddress>(`/addresses/${a}`),
      this.get<BfAddressTotal>(`/addresses/${a}/total`),
      this.get<BfAddressTx[]>(`/addresses/${a}/transactions?order=desc&count=${RECENT_TX_COUNT}`),
      this.get<BfUtxo[]>(`/addresses/${a}/utxos?count=${UTXO_PAGE_SIZE}`),
    ]);
    const recentTxs = recent ?? [];
    const txCount = total?.tx_count ?? 0;
    const stake = info?.stake_address ?? null;
    const [firstPage, account] = await Promise.all([
      // The oldest tx is already in the recent page when the history is short.
      txCount > recentTxs.length
        ? this.get<BfAddressTx[]>(`/addresses/${a}/transactions?order=asc&count=1`)
        : Promise.resolve(null),
      stake === null
        ? Promise.resolve(null)
        : this.get<BfAccount>(`/accounts/${encodeURIComponent(stake)}`),
    ]);
    const firstTx = firstPage?.[0] ?? recentTxs[recentTxs.length - 1] ?? null;
    return { address: info, total, recentTxs, firstTx, utxos: utxos ?? [], account };
  }
}
