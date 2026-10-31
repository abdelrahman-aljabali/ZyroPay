/*
 * Blockfrost (Cardano preprod) reads for the token report. Shapes follow the Blockfrost
 * OpenAPI (https://docs.blockfrost.io): asset, asset_addresses, asset_history,
 * asset_policy and tx_content (only the fields the report reads). Error mapping is shared
 * with Address Intelligence (@zyropay/seller/blockfrost).
 */
import { DataSourceError, mapBlockfrostStatus } from "@zyropay/seller/blockfrost";
import type { TokenQuery } from "./unit";

const TIMEOUT_MS = 8_000;
/** Blockfrost's page size cap. */
export const PAGE_SIZE = 100;
const HISTORY_COUNT = 20;

/** GET /assets/{asset} */
export interface BfAsset {
  readonly asset: string;
  readonly policy_id: string;
  readonly asset_name: string | null;
  readonly fingerprint: string;
  readonly quantity: string;
  readonly initial_mint_tx_hash: string;
  readonly mint_or_burn_count: number;
  readonly onchain_metadata: Record<string, unknown> | null;
  readonly onchain_metadata_standard?: string | null;
  /** CIP-26 off-chain registry metadata. */
  readonly metadata: {
    readonly name?: string;
    readonly ticker?: string | null;
    readonly decimals?: number | null;
  } | null;
}

/** GET /assets/{asset}/addresses (one element) */
export interface BfAssetHolder {
  readonly address: string;
  readonly quantity: string;
}

/** GET /assets/{asset}/history (one element) */
export interface BfAssetAction {
  readonly tx_hash: string;
  readonly amount: string;
  readonly action: "minted" | "burned";
}

/** GET /assets/policy/{policy_id} (one element) */
export interface BfPolicyAsset {
  readonly asset: string;
  readonly quantity: string;
}

/** GET /txs/{hash} (fields read) */
export interface BfTx {
  readonly hash: string;
  /** UNIX seconds */
  readonly block_time: number;
}

export interface TokenData {
  readonly policyAssets: readonly BfPolicyAsset[] | null;
  /** The asset reported on: the queried unit, or the policy's largest-supply asset. */
  readonly asset: BfAsset | null;
  readonly holders: readonly BfAssetHolder[];
  readonly history: readonly BfAssetAction[];
  readonly initialMint: BfTx | null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Largest quantity first, then lowest unit: a deterministic pick. */
export function largestAsset(assets: readonly BfPolicyAsset[]): BfPolicyAsset | null {
  const sorted = assets
    .filter((a) => /^[0-9]+$/.test(a.quantity))
    .sort((a, b) => {
      const qa = BigInt(a.quantity);
      const qb = BigInt(b.quantity);
      if (qa !== qb) return qa > qb ? -1 : 1;
      return a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;
    });
  return sorted[0] ?? null;
}

export class TokenBlockfrost {
  constructor(
    private readonly projectId: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /** JSON body, or null on 404. Throws DataSourceError for anything else. */
  private async get<T>(path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { project_id: this.projectId, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
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

  /** At most three rounds of requests (policy list, asset + holders + history, mint tx). */
  async fetchTokenData(query: TokenQuery): Promise<TokenData> {
    let policyAssets: BfPolicyAsset[] | null = null;
    let unit: string | null;
    if (query.kind === "policy") {
      policyAssets =
        (await this.get<BfPolicyAsset[]>(`/assets/policy/${query.policyId}?count=${PAGE_SIZE}`)) ??
        [];
      unit = largestAsset(policyAssets)?.asset ?? null;
    } else {
      unit = query.unit;
    }
    if (unit === null)
      return { policyAssets, asset: null, holders: [], history: [], initialMint: null };
    const u = encodeURIComponent(unit);
    const [asset, holders, history] = await Promise.all([
      this.get<BfAsset>(`/assets/${u}`),
      this.get<BfAssetHolder[]>(`/assets/${u}/addresses?count=${PAGE_SIZE}`),
      this.get<BfAssetAction[]>(`/assets/${u}/history?order=desc&count=${HISTORY_COUNT}`),
    ]);
    const mintTx = asset?.initial_mint_tx_hash;
    const initialMint =
      typeof mintTx === "string" && /^[0-9a-f]{64}$/.test(mintTx)
        ? await this.get<BfTx>(`/txs/${mintTx}`)
        : null;
    return { policyAssets, asset, holders: holders ?? [], history: history ?? [], initialMint };
  }
}
