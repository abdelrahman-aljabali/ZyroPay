/*
 * Blockfrost (https://docs.blockfrost.io, OpenAPI https://github.com/blockfrost/openapi):
 * the Cardano read/submit provider. One project id per network, sent as the `project_id`
 * header; base URLs `https://cardano-{mainnet,preprod}.blockfrost.io/api/v0`.
 *
 * Limits: 10 requests/s per IP with a 500-request burst, plus a daily quota per plan.
 * Status codes: 400 invalid request (submit: ledger rejection), 402 daily quota exceeded,
 * 403 bad project id, 404 not found, 418 auto-banned, 425 mempool full, 429 rate limited,
 * 5xx provider trouble. 429/5xx are retried by `requestJson`; 402/418/425 are mapped to
 * retryable RATE_LIMITED / UPSTREAM_UNAVAILABLE here.
 *
 * Network binding: a project id starts with its network name (`mainnet...`, `preprod...`),
 * and `/genesis` must report the bound network's magic (764824073 mainnet, 1 preprod)
 * before anything is read or submitted. A mainnet key can never serve preprod or vice versa.
 */
import type { NetworkId } from "@zyropay/shared";
import { NETWORKS } from "@zyropay/shared";
import { ChainError } from "../errors";
import type { HttpOptions, ResolvedHttpOptions } from "../http";
import { isRecord, requestJson, resolveHttpOptions } from "../http";
import { assertFamily } from "../networks";

export const BLOCKFROST_BASE_URLS: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": "https://cardano-mainnet.blockfrost.io/api/v0",
  "cardano-preprod": "https://cardano-preprod.blockfrost.io/api/v0",
};

const PROJECT_PREFIX: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": "mainnet",
  "cardano-preprod": "preprod",
};

export interface BlockfrostConfig extends HttpOptions {
  readonly projectId: string;
  readonly network: NetworkId;
  /** Override for tests/self-hosted Blockfrost (Ryo); must be https outside tests. */
  readonly baseUrl?: string;
}

export interface BlockfrostAmount {
  readonly unit: string;
  readonly quantity: string;
}

export interface BlockfrostUtxo {
  readonly tx_hash: string;
  readonly output_index: number;
  readonly amount: readonly BlockfrostAmount[];
  readonly data_hash: string | null;
  readonly inline_datum: string | null;
  readonly reference_script_hash: string | null;
}

export interface ProtocolParams {
  readonly minFeeA: bigint;
  readonly minFeeB: bigint;
  readonly coinsPerUtxoByte: bigint;
  readonly maxTxSize: number;
  readonly maxValSize: number;
}

/** A non-negative rational (Blockfrost reports execution prices as decimal numbers). */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

/** What a Plutus script spend needs on top of `ProtocolParams`. */
export interface ScriptProtocolParams extends ProtocolParams {
  readonly priceMem: Rational;
  readonly priceStep: Rational;
  readonly collateralPercent: bigint;
  readonly maxCollateralInputs: number;
  readonly maxTxExMem: bigint;
  readonly maxTxExSteps: bigint;
  /** `cost_models_raw.PlutusV3`, in order (the language view hashes exactly this list). */
  readonly plutusV3CostModel: readonly bigint[];
}

/** Execution units the node reports for one redeemer (`spend:1` -> tag spend, index 1). */
export interface EvaluatedRedeemer {
  readonly tag: "spend" | "mint" | "cert" | "reward" | "vote" | "propose";
  readonly index: number;
  readonly mem: bigint;
  readonly steps: bigint;
}

/** One entry of Ogmios v5's `additionalUtxoSet` (UTxOs the node may not know yet). */
export interface AdditionalUtxo {
  readonly txHash: string;
  readonly index: number;
  readonly address: string;
  readonly coin: bigint;
  /** unit (policy id hex || asset name hex) -> quantity. */
  readonly assets?: ReadonlyMap<string, bigint>;
  /** Inline datum CBOR hex. */
  readonly inlineDatum?: string;
}

/** Exact rational of a decimal number or string ("0.0577", 7.21e-5, "721/10000000"). */
export function parseRational(value: unknown, field: string): Rational {
  if (typeof value === "string" && /^\d+\/\d+$/.test(value)) {
    const [n, d] = value.split("/");
    const den = BigInt(d ?? "0");
    if (den === 0n) throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: zero denominator`);
    return { num: BigInt(n ?? "0"), den };
  }
  const text = typeof value === "number" ? String(value) : value;
  const m = typeof text === "string" ? /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) : null;
  if (m === null) throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: expected a decimal`);
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0") - frac.length;
  const digits = BigInt((m[1] ?? "0") + frac);
  return exp >= 0
    ? { num: digits * 10n ** BigInt(exp), den: 1n }
    : { num: digits, den: 10n ** BigInt(-exp) };
}

const REDEEMER_PURPOSES: Readonly<Record<string, EvaluatedRedeemer["tag"]>> = {
  spend: "spend",
  mint: "mint",
  certificate: "cert",
  cert: "cert",
  withdrawal: "reward",
  reward: "reward",
  vote: "vote",
  propose: "propose",
};

/**
 * Parse Blockfrost's `/utils/txs/evaluate/utxos` reply (Ogmios v5 JSON-WSP:
 * `{result: {EvaluationResult: {"spend:0": {memory, steps}}}}`; failures arrive as
 * `{result: {EvaluationFailure: ...}}` or `{type: "jsonwsp/fault"}`). A failure throws
 * VALIDATION_FAILED with the node's reason: the script would fail, so never sign it.
 */
export function parseEvaluation(reply: unknown): EvaluatedRedeemer[] {
  if (!isRecord(reply)) throw new ChainError("UPSTREAM_UNAVAILABLE", "evaluate: malformed reply");
  if (reply.type === "jsonwsp/fault") {
    const fault = isRecord(reply.fault) ? reply.fault.string : undefined;
    throw new ChainError(
      "UPSTREAM_UNAVAILABLE",
      `evaluate: provider fault${typeof fault === "string" ? `: ${fault.slice(0, 300)}` : ""}`,
    );
  }
  const result = reply.result;
  if (!isRecord(result)) throw new ChainError("UPSTREAM_UNAVAILABLE", "evaluate: no result");
  if (result.EvaluationFailure !== undefined) {
    throw new ChainError(
      "VALIDATION_FAILED",
      `script evaluation failed: ${JSON.stringify(result.EvaluationFailure).slice(0, 500)}`,
    );
  }
  const ok = result.EvaluationResult;
  if (!isRecord(ok)) throw new ChainError("UPSTREAM_UNAVAILABLE", "evaluate: no EvaluationResult");
  return Object.entries(ok).map(([key, budget]) => {
    const m = /^([a-z]+):(\d+)$/.exec(key);
    const tag = m === null ? undefined : REDEEMER_PURPOSES[m[1] ?? ""];
    if (m === null || tag === undefined || !isRecord(budget))
      throw new ChainError("UPSTREAM_UNAVAILABLE", `evaluate: malformed entry ${key.slice(0, 40)}`);
    return {
      tag,
      index: Number(m[2]),
      mem: intString(budget.memory, "evaluate.memory"),
      steps: intString(budget.steps, "evaluate.steps"),
    };
  });
}

export interface ChainTip {
  readonly slot: bigint;
  readonly height: bigint;
  /** Block time, unix seconds. */
  readonly time: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function str(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: expected string`);
  return value;
}

function intString(value: unknown, field: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: expected a non-negative integer`);
}

export function parseAmounts(value: unknown, field: string): BlockfrostAmount[] {
  if (!Array.isArray(value))
    throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: expected array`);
  return value.map((a: unknown) => {
    if (!isRecord(a)) throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: malformed amount`);
    const unit = str(a.unit, `${field}.unit`);
    if (unit !== "lovelace" && !/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", `${field}: malformed unit`);
    }
    return { unit, quantity: intString(a.quantity, `${field}.quantity`).toString() };
  });
}

/*
 * Per-isolate memo of immutable or slow-moving answers, shared by every client on the same
 * Blockfrost project. A Worker builds its clients per request, so without it every client
 * re-checks /genesis (one extra round trip before its first call) and re-reads the epoch's
 * protocol parameters. Only clients on the global fetch share it: an injected fetch (tests,
 * fixtures) is its own world and never reads or fills it.
 */
const verifiedNetworks = new Set<string>();
/** Protocol parameters change at epoch boundaries (every 5 days); a minute is fresh enough. */
const PARAMS_TTL_MS = 60_000;
const paramsMemo = new Map<string, { readonly at: number; readonly value: Promise<unknown> }>();

export class BlockfrostClient {
  readonly network: NetworkId;
  private readonly http: ResolvedHttpOptions;
  private readonly baseUrl: string;
  private readonly projectId: string;
  /** Key into the per-isolate memo, or null for a client on an injected fetch. */
  private readonly memoKey: string | null;
  private networkChecked: Promise<void> | null = null;

  constructor(config: BlockfrostConfig) {
    assertFamily(config.network, "cardano");
    const base = config.baseUrl ?? BLOCKFROST_BASE_URLS[config.network];
    if (base === undefined)
      throw new ChainError("NETWORK_NOT_SUPPORTED", `no Blockfrost URL for ${config.network}`);
    if (!config.projectId)
      throw new ChainError("INTERNAL_ERROR", "Blockfrost project id is not set");
    const prefix = PROJECT_PREFIX[config.network] ?? "";
    if (!config.projectId.startsWith(prefix)) {
      // Strict mainnet/testnet separation: never let a mainnet key serve preprod or back.
      throw new ChainError(
        "NETWORK_MODE_MISMATCH",
        `the Blockfrost project id is not a ${prefix} project (${config.network})`,
      );
    }
    this.network = config.network;
    this.baseUrl = base.replace(/\/+$/, "");
    this.projectId = config.projectId;
    this.http = resolveHttpOptions(config);
    this.memoKey = config.fetch === undefined ? `${this.baseUrl}|${this.projectId}` : null;
    if (this.memoKey !== null && verifiedNetworks.has(this.memoKey))
      this.networkChecked = Promise.resolve();
  }

  /** GET a JSON resource; 404 => null. Never puts the project id in an error. */
  async getOrNull(path: string, label: string): Promise<unknown> {
    try {
      return await this.get(path, label);
    } catch (error) {
      if (error instanceof ChainError && error.details?.status === 404) return null;
      throw error;
    }
  }

  async get(path: string, label: string): Promise<unknown> {
    await this.ensureNetwork();
    return this.raw(path, label);
  }

  private async raw(
    path: string,
    label: string,
    rawBody?: { bytes: Uint8Array; contentType: string },
    jsonBody?: unknown,
  ): Promise<unknown> {
    try {
      return await requestJson(this.http, {
        url: `${this.baseUrl}${path}`,
        headers: { project_id: this.projectId },
        ...(rawBody === undefined ? {} : { rawBody, method: "POST" as const }),
        ...(jsonBody === undefined ? {} : { body: jsonBody, method: "POST" as const }),
        label: `blockfrost ${label}`,
      });
    } catch (error) {
      if (error instanceof ChainError) {
        const status = error.details?.status;
        if (status === 402 || status === 418) {
          throw new ChainError(
            "RATE_LIMITED",
            `blockfrost ${label}: quota exhausted (HTTP ${status})`,
            {
              retryable: true,
              details: { status },
            },
          );
        }
        if (status === 403) {
          throw new ChainError("UPSTREAM_UNAVAILABLE", `blockfrost ${label}: project id refused`, {
            details: { status },
          });
        }
      }
      throw error;
    }
  }

  /** `/genesis.network_magic` must equal the bound network's magic (checked once). */
  ensureNetwork(): Promise<void> {
    this.networkChecked ??= (async () => {
      const genesis = await this.raw("/genesis", "genesis");
      const expected = NETWORKS[this.network].cardano?.networkMagic;
      if (!isRecord(genesis) || genesis.network_magic !== expected) {
        throw new ChainError(
          "NETWORK_MODE_MISMATCH",
          `Blockfrost is not serving ${this.network} (network magic mismatch)`,
        );
      }
      if (this.memoKey !== null) verifiedNetworks.add(this.memoKey);
    })().catch((error: unknown) => {
      this.networkChecked = null; // retry the check next time (outages are transient)
      throw error;
    });
    return this.networkChecked;
  }

  /** /epochs/latest/parameters, memoized per isolate for a minute unless `fresh`. */
  private async latestParameters(fresh: boolean): Promise<unknown> {
    const load = () => this.get("/epochs/latest/parameters", "epochs/latest/parameters");
    const key = this.memoKey;
    if (key === null) return load();
    const hit = paramsMemo.get(key);
    if (!fresh && hit !== undefined && Date.now() - hit.at < PARAMS_TTL_MS) return hit.value;
    const value = load();
    paramsMemo.set(key, { at: Date.now(), value });
    // A failed read is never served from the memo.
    value.catch(() => {
      if (paramsMemo.get(key)?.value === value) paramsMemo.delete(key);
    });
    return value;
  }

  async protocolParams(): Promise<ProtocolParams> {
    const p = await this.latestParameters(false);
    if (!isRecord(p))
      throw new ChainError("UPSTREAM_UNAVAILABLE", "protocol parameters: malformed");
    const coins = p.coins_per_utxo_size ?? p.coins_per_utxo_word;
    return {
      minFeeA: intString(p.min_fee_a, "min_fee_a"),
      minFeeB: intString(p.min_fee_b, "min_fee_b"),
      coinsPerUtxoByte: intString(coins, "coins_per_utxo_size"),
      maxTxSize: Number(intString(p.max_tx_size, "max_tx_size")),
      maxValSize: Number(intString(p.max_val_size, "max_val_size")),
    };
  }

  /**
   * `protocolParams()` plus execution prices, collateral rules and the PlutusV3 cost model.
   * `fresh`: bypass the per-isolate memo (independent verification before signing).
   */
  async scriptProtocolParams(options: { fresh?: boolean } = {}): Promise<ScriptProtocolParams> {
    const p = await this.latestParameters(options.fresh === true);
    if (!isRecord(p))
      throw new ChainError("UPSTREAM_UNAVAILABLE", "protocol parameters: malformed");
    const coins = p.coins_per_utxo_size ?? p.coins_per_utxo_word;
    const raw = isRecord(p.cost_models_raw) ? p.cost_models_raw.PlutusV3 : undefined;
    if (!Array.isArray(raw) || raw.length === 0)
      throw new ChainError("UPSTREAM_UNAVAILABLE", "protocol parameters: no PlutusV3 cost model");
    const costs = (raw as unknown[]).map((c) => {
      if (typeof c === "bigint") return c;
      if (typeof c === "number" && Number.isSafeInteger(c)) return BigInt(c);
      if (typeof c === "string" && /^-?\d+$/.test(c)) return BigInt(c);
      throw new ChainError("UPSTREAM_UNAVAILABLE", "cost_models_raw.PlutusV3: expected integers");
    });
    return {
      minFeeA: intString(p.min_fee_a, "min_fee_a"),
      minFeeB: intString(p.min_fee_b, "min_fee_b"),
      coinsPerUtxoByte: intString(coins, "coins_per_utxo_size"),
      maxTxSize: Number(intString(p.max_tx_size, "max_tx_size")),
      maxValSize: Number(intString(p.max_val_size, "max_val_size")),
      priceMem: parseRational(p.price_mem, "price_mem"),
      priceStep: parseRational(p.price_step, "price_step"),
      collateralPercent: intString(p.collateral_percent, "collateral_percent"),
      maxCollateralInputs: Number(intString(p.max_collateral_inputs, "max_collateral_inputs")),
      maxTxExMem: intString(p.max_tx_ex_mem, "max_tx_ex_mem"),
      maxTxExSteps: intString(p.max_tx_ex_steps, "max_tx_ex_steps"),
      plutusV3CostModel: costs,
    };
  }

  /**
   * POST /utils/txs/evaluate/utxos (JSON `{cbor, additionalUtxoSet}`; the CBOR-body variant
   * has intermittent 500s). Returns each redeemer's execution units; throws VALIDATION_FAILED
   * when a script fails. Evaluation only: nothing is submitted.
   */
  async evaluateTx(
    txCborHex: string,
    additionalUtxos: readonly AdditionalUtxo[] = [],
  ): Promise<EvaluatedRedeemer[]> {
    await this.ensureNetwork();
    const additionalUtxoSet = additionalUtxos.map((u) => {
      const assets: Record<string, number | string> = {};
      for (const [unit, qty] of u.assets ?? []) {
        const key = unit.length > 56 ? `${unit.slice(0, 56)}.${unit.slice(56)}` : unit;
        assets[key] = qty <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(qty) : qty.toString();
      }
      return [
        { txId: u.txHash, index: u.index },
        {
          address: u.address,
          value: {
            coins: u.coin <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(u.coin) : u.coin.toString(),
            ...(Object.keys(assets).length > 0 ? { assets } : {}),
          },
          ...(u.inlineDatum !== undefined ? { datum: u.inlineDatum } : {}),
        },
      ];
    });
    const reply = await this.raw(
      "/utils/txs/evaluate/utxos",
      "utils/txs/evaluate/utxos",
      undefined,
      {
        cbor: txCborHex,
        additionalUtxoSet,
      },
    );
    return parseEvaluation(reply);
  }

  async tip(): Promise<ChainTip> {
    const b = await this.get("/blocks/latest", "blocks/latest");
    if (!isRecord(b)) throw new ChainError("UPSTREAM_UNAVAILABLE", "latest block: malformed");
    return {
      slot: intString(b.slot, "slot"),
      height: intString(b.height, "height"),
      time: Number(intString(b.time, "time")),
    };
  }

  /** Every UTxO at an address (pages of 100, at most `maxPages`). Unused address => []. */
  async utxos(address: string, maxPages = 10): Promise<BlockfrostUtxo[]> {
    const out: BlockfrostUtxo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const rows = await this.getOrNull(
        `/addresses/${encodeURIComponent(address)}/utxos?count=100&page=${page}`,
        "addresses/utxos",
      );
      if (rows === null) return out;
      if (!Array.isArray(rows)) throw new ChainError("UPSTREAM_UNAVAILABLE", "utxos: malformed");
      for (const r of rows as unknown[]) {
        if (!isRecord(r)) throw new ChainError("UPSTREAM_UNAVAILABLE", "utxo: malformed");
        const txHash = str(r.tx_hash, "utxo.tx_hash");
        if (!HEX64.test(txHash))
          throw new ChainError("UPSTREAM_UNAVAILABLE", "utxo.tx_hash: malformed");
        const index = Number(intString(r.output_index, "utxo.output_index"));
        out.push({
          tx_hash: txHash,
          output_index: index,
          amount: parseAmounts(r.amount, "utxo.amount"),
          data_hash: typeof r.data_hash === "string" ? r.data_hash : null,
          inline_datum: typeof r.inline_datum === "string" ? r.inline_datum : null,
          reference_script_hash:
            typeof r.reference_script_hash === "string" ? r.reference_script_hash : null,
        });
      }
      if (rows.length < 100) return out;
    }
    throw new ChainError(
      "VALIDATION_FAILED",
      `address holds more than ${maxPages * 100} UTxOs; consolidate them first`,
    );
  }

  /** POST /tx/submit (CBOR body). Returns the transaction id Blockfrost reports. */
  async submit(signed: Uint8Array): Promise<string> {
    await this.ensureNetwork();
    const result = await this.raw("/tx/submit", "tx/submit", {
      bytes: signed,
      contentType: "application/cbor",
    });
    if (typeof result !== "string" || !HEX64.test(result)) {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "tx/submit: unexpected response");
    }
    return result;
  }
}
