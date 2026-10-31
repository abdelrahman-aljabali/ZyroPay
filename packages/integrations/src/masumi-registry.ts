/*
 * Masumi agent registry, read side: DISCOVER agents and VERIFY a seller's identity before
 * ZyroPay pays it. Runtime-agnostic (fetch + AbortController + TextDecoder only), so it runs
 * on Cloudflare Workers; every key, the fetch and the cache are injected by the caller.
 *
 * What the registry is (sources: masumi-payment-service a846392):
 *  - An agent is a CIP-25 NFT minted under the Masumi registry V2 minting policy
 *    `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`, the SAME id on preprod and
 *    mainnet (packages/payment-core/src/config.ts REGISTRY_POLICY_ID_V2_*; `@x402/cardano`
 *    2.29 MASUMI_REGISTRY_POLICY_ID). V1 policies (7e8bdaf2... preprod, ad6424e3... mainnet)
 *    are legacy and not accepted by the x402 masumi method.
 *  - `agentIdentifier` = policyId (56 hex) || assetName (64 hex). V2 asset name =
 *    nonce(1 B, 0x10..0xff) || root_hash(28 B) || version(3 B BE); an update burns version n
 *    and mints n+1 (smart-contracts/registry-v2/README.md "Asset Name Rule").
 *  - Metadata (src/routes/api/registry/metadata-schema.ts; CIP-25 strings may be split into
 *    <=64-byte chunks): name, description, api_base_url (Standard) | openapi_spec_url |
 *    x402_resources_url | api_url (A2A), capability{name,version}, author{name,
 *    contact_email, contact_other, organization}, legal, tags[], image, example_output[],
 *    metadata_version, type?, V1 agentPricing{pricingType, fixedPricing[{amount,unit}]},
 *    V2 supported_payment_sources[{chain:"Cardano", network:"Preprod"|"Mainnet",
 *    settlement:{paymentSourceType:"Web3CardanoV2", address:<escrow>}, pricing:{pricingType:
 *    "Fixed"|"Dynamic"|"Free", fixed?[{asset ("" = lovelace), amount}]}}].
 *  - There is NO seller key in the metadata: the seller is whoever HOLDS the NFT. Masumi's own
 *    purchase path resolves `sellerVkey` as the payment key hash of the current holder
 *    (`blockfrost.assetsAddresses(agentIdentifier)`, src/routes/api/purchases/shared.ts:74-86),
 *    and checks the chosen Cardano source's settlement address is the escrow contract.
 *  - The V2 policy is PERMISSIONLESS by design: anyone can mint under it for ~2 ADA. The policy
 *    id alone is not a trust marker (registry-v2/README.md "Trust Model"). What this module
 *    proves is identity BINDING: the key that signs the x402 terms controls a live registry
 *    NFT whose metadata names this endpoint and price. Whether that agent is trustworthy is a
 *    separate decision: pass `trust` (an allowlist) to require it.
 *  - The hosted Registry Service (registry.masumi.network, POST /registry-entry-search, GET
 *    /payment-information) requires an API token ("No token provided"), so this module reads
 *    the chain through Blockfrost: /assets/policy/{policy}, /assets/{unit},
 *    /assets/{unit}/addresses, /txs/{hash}.
 *
 * Fail closed: verification returns ok only when every check passed; any upstream error is a
 * reason (`upstream_unavailable`), never a pass. Responses are size-capped and time-bounded.
 */
import type { MasumiRegistryValidator } from "@x402/cardano";
import { MASUMI_REGISTRY_POLICY_ID } from "@x402/cardano";
import type { FetchLike } from "@zyropay/blockchain";
import { BLOCKFROST_BASE_URLS, ChainError } from "@zyropay/blockchain";
import type { NetworkId } from "@zyropay/shared";
import { MASUMI_ESCROW_ADDRESSES, parseShelleyAddress } from "@zyropay/shared";

/** The canonical Masumi registry V2 policy per network (identical on both). */
export const MASUMI_REGISTRY_POLICY_IDS: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": MASUMI_REGISTRY_POLICY_ID,
  "cardano-preprod": MASUMI_REGISTRY_POLICY_ID,
};

/** Legacy V1 registry policies (Web3CardanoV1). Informational: never accepted for payment. */
export const MASUMI_REGISTRY_V1_POLICY_IDS: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": "ad6424e3ce9e47bbd8364984bd731b41de591f1d11f6d7d43d0da9b9",
  "cardano-preprod": "7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77",
};

const AGENT_IDENTIFIER_RE = /^[0-9a-f]{120}$/;
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const UNIT_RE = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;
const METADATA_NETWORK: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": "Mainnet",
  "cardano-preprod": "Preprod",
};
const X402_NETWORKS: Readonly<Record<string, NetworkId>> = {
  "cardano:mainnet": "cardano-mainnet",
  "cardano:preprod": "cardano-preprod",
};
const PROJECT_PREFIX: Readonly<Partial<Record<NetworkId, string>>> = {
  "cardano-mainnet": "mainnet",
  "cardano-preprod": "preprod",
};

const LIMITS = {
  name: 200,
  description: 2_000,
  url: 2_048,
  tag: 64,
  tags: 20,
  shortField: 200,
  priceEntries: 25,
  paymentSources: 10,
} as const;

// ---------------------------------------------------------------------------------------------
// Public types

export type MasumiAgentType = "Standard" | "OpenApi" | "X402" | "A2A";

/** `unit` is "lovelace" or the concatenated policyId||assetName hex (Blockfrost form). */
export interface MasumiPriceAmount {
  readonly unit: string;
  /** Base units, decimal string. */
  readonly amount: string;
}

export type MasumiAgentPricing =
  | { readonly type: "Fixed"; readonly amounts: readonly MasumiPriceAmount[] }
  | { readonly type: "Dynamic" }
  | { readonly type: "Free" }
  | { readonly type: "Unknown" };

export interface MasumiPaymentSource {
  readonly chain: string;
  readonly network: string;
  readonly paymentSourceType: string | null;
  /** Settlement address (for Web3CardanoV2: the escrow contract address). */
  readonly address: string | null;
  readonly pricing: MasumiAgentPricing;
}

export interface MasumiAgent {
  readonly agentIdentifier: string;
  readonly network: NetworkId;
  readonly policyId: string;
  readonly assetName: string;
  /** Registry entry version from the asset name (0 for a first mint, +1 per update). */
  readonly version: number;
  readonly fingerprint: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly type: MasumiAgentType;
  /** Where the agent is reached (api_base_url, or the type-specific URL). */
  readonly apiBaseUrl: string;
  readonly capability: { readonly name: string; readonly version: string } | null;
  readonly author: {
    readonly name: string;
    readonly contactEmail: string | null;
    readonly organization: string | null;
  } | null;
  readonly tags: readonly string[];
  readonly image: string | null;
  readonly metadataVersion: number | null;
  /** Pricing of this network's Cardano source (V2), else the V1 agentPricing. */
  readonly pricing: MasumiAgentPricing;
  readonly paymentSources: readonly MasumiPaymentSource[];
  /** True when a Cardano source on this network settles through the canonical V2 escrow. */
  readonly masumiEscrow: boolean;
  /** Mint (or update) transaction of this asset version. */
  readonly txHash: string;
  /** ISO time of that transaction's block, when known. */
  readonly registeredAt: string | null;
  /** False once the NFT is burned (deregistered or superseded by an update). */
  readonly active: boolean;
  /** Current holder of the NFT: the seller. Null when burned. */
  readonly holderAddress: string | null;
  /** Payment key hash of the holder (Masumi `sellerVkey`). Null for script holders/burned. */
  readonly sellerPaymentKeyHash: string | null;
}

/** KV-shaped cache (Cloudflare KV: `{get: k => kv.get(k), put: (k, v, t) => kv.put(k, v, {expirationTtl: Math.max(60, t)})}`). */
export interface MasumiRegistryCache {
  get(key: string): Promise<string | null | undefined>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface MasumiTrustList {
  /** Only these agentIdentifiers verify (when set). */
  readonly agentIdentifiers?: readonly string[];
  /** Only NFTs held by these payment key hashes verify (when set). */
  readonly sellerPaymentKeyHashes?: readonly string[];
}

export interface MasumiRegistryConfig {
  readonly network: NetworkId;
  /** Blockfrost project id of `network` (prefix `preprod` / `mainnet`). */
  readonly blockfrostProjectId: string;
  readonly blockfrostBaseUrl?: string;
  readonly fetch?: FetchLike;
  /** Per request (including the body read). Default 8 s. */
  readonly timeoutMs?: number;
  /** Retries for 429/5xx/network errors. Default 1. */
  readonly maxRetries?: number;
  /** Response body cap. Default 256 KiB. */
  readonly maxResponseBytes?: number;
  /** Parallel Blockfrost requests during a search. Default 4 (Blockfrost: 10 req/s). */
  readonly concurrency?: number;
  readonly cache?: MasumiRegistryCache;
  /** TTL of liveness data (policy listing, holder) in the cache. Default 60 s. */
  readonly livenessTtlSeconds?: number;
  /** Optional allowlist; when set, verification requires a match. */
  readonly trust?: MasumiTrustList;
  /** Accept http:// or private-host endpoints (local development only). Default false. */
  readonly allowInsecureEndpoints?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface MasumiSearchInput {
  /** Case-insensitive substring over name, description, tags and capability name. */
  readonly query?: string;
  /** Exact (case-insensitive) capability name. */
  readonly capability?: string;
  readonly tag?: string;
  /**
   * Only agents whose Fixed price is entirely in `unit` and at most `amount`, or Free.
   * Dynamic-priced agents are excluded unless `includeDynamic`.
   */
  readonly maxPrice?: MasumiPriceAmount;
  readonly includeDynamic?: boolean;
  /** Only agents payable through the canonical Masumi V2 escrow on this network. */
  readonly escrowOnly?: boolean;
  /** Results to return. Default 20, max 50. */
  readonly limit?: number;
  /** Live registry entries to inspect, newest first. Default 100, max 400. */
  readonly maxScan?: number;
}

export interface MasumiSearchResult {
  readonly agents: readonly MasumiAgent[];
  /** Live entries inspected. */
  readonly scanned: number;
  /** True when the scan budget ran out before the end of the registry. */
  readonly truncated: boolean;
}

export type MasumiResolution =
  | { readonly status: "active"; readonly agent: MasumiAgent }
  | { readonly status: "burned"; readonly agent: MasumiAgent }
  | { readonly status: "not_found" }
  | { readonly status: "invalid"; readonly reason: string };

export type MasumiVerifyReason =
  | "invalid_identifier"
  | "network_mismatch"
  | "wrong_policy"
  | "not_found"
  | "burned"
  | "multiple_holders"
  | "metadata_invalid"
  | "holder_not_key_address"
  | "seller_missing"
  | "seller_invalid"
  | "seller_mismatch"
  | "no_escrow_source"
  | "endpoint_invalid"
  | "endpoint_insecure"
  | "endpoint_mismatch"
  | "price_mismatch"
  | "not_trusted"
  | "upstream_unavailable";

export interface MasumiVerifyInput {
  readonly agentIdentifier: string;
  /** The seller address the x402 terms are signed by (`terms.sellerAddress`). */
  readonly sellerAddress?: string;
  /** Or the seller's payment key hash (Masumi `sellerVkey`). One of the two is required. */
  readonly sellerVkey?: string;
  /** The paid resource URL: must sit under the registered endpoint (same origin, path prefix). */
  readonly resourceUrl?: string;
  /** The signed price: x402 `asset` ("lovelace" | "<policy>.<name>" | unit) and amount. */
  readonly asset?: string;
  readonly amount?: string;
  /** Require the canonical Masumi V2 escrow payment source. Default true. */
  readonly requireEscrow?: boolean;
}

export interface MasumiVerifyResult {
  readonly ok: boolean;
  readonly reasons: readonly MasumiVerifyReason[];
  /** Human-readable detail per reason (no secrets, no URLs with keys). */
  readonly details: readonly string[];
  readonly agent: MasumiAgent | null;
}

export interface MasumiRegistryClient {
  readonly network: NetworkId;
  readonly policyId: string;
  searchAgents(input?: MasumiSearchInput): Promise<MasumiSearchResult>;
  resolveAgent(agentIdentifier: string): Promise<MasumiResolution>;
  verifySeller(input: MasumiVerifyInput): Promise<MasumiVerifyResult>;
  /** For `@x402/cardano` (`validateMasumiRegistryClaim` / `validateRegistryClaim`). Never throws. */
  registryValidator(): MasumiRegistryValidator;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CIP-25 text: a string or an array of string chunks. */
function text(value: unknown, max: number): string | null {
  let s: string | null = null;
  if (typeof value === "string") s = value;
  else if (Array.isArray(value) && value.length > 0 && value.length <= 256) {
    if (!value.every((c) => typeof c === "string")) return null;
    s = value.join("");
  }
  if (s === null) return null;
  s = s.trim();
  if (s === "") return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Like `text` but rejects (instead of truncating) over-long values: URLs, addresses. */
function exactText(value: unknown, max: number): string | null {
  const s = text(value, max + 1);
  return s === null || s.length > max ? null : s;
}

/** "lovelace" | "" | "<policy>.<name>" | unit -> canonical unit, or null. */
export function normalizeMasumiUnit(asset: string): string | null {
  const a = asset.trim().toLowerCase();
  if (a === "" || a === "lovelace") return "lovelace";
  const unit = a.replace(".", "");
  return UNIT_RE.test(unit) ? unit : null;
}

function isDecimal(s: string): boolean {
  return /^\d{1,30}$/.test(s);
}

function parsePricing(value: unknown, v1: boolean): MasumiAgentPricing {
  if (!isRecord(value)) return { type: "Unknown" };
  const type = text(value.pricingType, 20);
  if (type === "Dynamic") return { type: "Dynamic" };
  if (type === "Free") return { type: "Free" };
  if (type !== "Fixed") return { type: "Unknown" };
  const list = v1 ? value.fixedPricing : value.fixed;
  if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.priceEntries)
    return { type: "Unknown" };
  const amounts: MasumiPriceAmount[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) return { type: "Unknown" };
    const rawUnit = v1 ? entry.unit : entry.asset;
    // "" is lovelace; CIP-25 may encode it as "" or as chunks.
    const unitText = rawUnit === "" ? "" : exactText(rawUnit, 130);
    const amount =
      typeof entry.amount === "number" && Number.isSafeInteger(entry.amount)
        ? String(entry.amount)
        : exactText(entry.amount, 30);
    if (unitText === null || amount === null || !isDecimal(amount) || BigInt(amount) <= 0n)
      return { type: "Unknown" };
    const unit = normalizeMasumiUnit(unitText);
    if (unit === null) return { type: "Unknown" };
    amounts.push({ unit, amount });
  }
  return { type: "Fixed", amounts };
}

/** Total per unit of a Fixed price. */
function fixedTotals(pricing: MasumiAgentPricing): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  if (pricing.type !== "Fixed") return totals;
  for (const a of pricing.amounts)
    totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.amount));
  return totals;
}

function versionOf(assetName: string): number {
  return assetName.length === 64 ? Number.parseInt(assetName.slice(58), 16) : 0;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.includes(":")) {
    // IPv6 literal: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
    return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Resource must be under the registered endpoint: same origin and a path-segment prefix. */
function endpointCovers(apiBaseUrl: URL, resource: URL): boolean {
  if (apiBaseUrl.origin !== resource.origin) return false;
  const base = apiBaseUrl.pathname.replace(/\/+$/, "");
  if (base === "") return true;
  return resource.pathname === base || resource.pathname.startsWith(`${base}/`);
}

function parseUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

async function pool<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Metadata -> agent

interface AssetRecord {
  readonly unit: string;
  readonly fingerprint: string | null;
  readonly quantity: string;
  readonly txHash: string;
  readonly metadata: unknown;
}

type ParsedMetadata = Omit<
  MasumiAgent,
  "registeredAt" | "active" | "holderAddress" | "sellerPaymentKeyHash" | "fingerprint" | "txHash"
>;

/** Parse on-chain registry metadata. Null when it is not a usable registry entry. */
export function parseMasumiRegistryMetadata(
  network: NetworkId,
  agentIdentifier: string,
  metadata: unknown,
): ParsedMetadata | null {
  if (!isRecord(metadata)) return null;
  const name = text(metadata.name, LIMITS.name);
  if (name === null) return null;
  const onChainType = text(metadata.type, 40);
  const type: MasumiAgentType =
    onChainType === "a2aV1"
      ? "A2A"
      : onChainType === "x402V1" || metadata.x402_resources_url !== undefined
        ? "X402"
        : onChainType === "OpenAPI" || metadata.openapi_spec_url !== undefined
          ? "OpenApi"
          : "Standard";
  const url =
    type === "A2A"
      ? (exactText(metadata.api_url, LIMITS.url) ?? exactText(metadata.api_base_url, LIMITS.url))
      : (exactText(metadata.api_base_url, LIMITS.url) ??
        exactText(metadata.x402_resources_url, LIMITS.url) ??
        exactText(metadata.openapi_spec_url, LIMITS.url));
  if (url === null) return null;

  const cap = isRecord(metadata.capability) ? metadata.capability : null;
  const capName = cap ? text(cap.name, LIMITS.shortField) : null;
  const author = isRecord(metadata.author) ? metadata.author : null;
  const authorName = author ? text(author.name, LIMITS.shortField) : null;
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags
        .slice(0, LIMITS.tags)
        .map((t) => text(t, LIMITS.tag))
        .filter((t): t is string => t !== null)
    : [];
  const mv = Number(text(metadata.metadata_version, 4) ?? metadata.metadata_version);

  const escrow = MASUMI_ESCROW_ADDRESSES[network];
  const wantNetwork = METADATA_NETWORK[network];
  const sources: MasumiPaymentSource[] = [];
  if (Array.isArray(metadata.supported_payment_sources)) {
    for (const s of metadata.supported_payment_sources.slice(0, LIMITS.paymentSources)) {
      if (!isRecord(s)) continue;
      const settlement = isRecord(s.settlement) ? s.settlement : {};
      sources.push({
        chain: text(s.chain, 40) ?? "",
        network: text(s.network, 40) ?? "",
        paymentSourceType: text(settlement.paymentSourceType, 40),
        address: exactText(settlement.address ?? settlement.payTo, 200),
        pricing: parsePricing(s.pricing, false),
      });
    }
  }
  const cardano = sources.find((s) => s.chain === "Cardano" && s.network === wantNetwork);
  const masumiEscrow = sources.some(
    (s) =>
      s.chain === "Cardano" &&
      s.network === wantNetwork &&
      s.paymentSourceType === "Web3CardanoV2" &&
      escrow !== undefined &&
      s.address === escrow,
  );
  const pricing: MasumiAgentPricing =
    cardano !== undefined
      ? cardano.pricing
      : sources.length === 0
        ? parsePricing(metadata.agentPricing, true)
        : { type: "Unknown" };

  const assetName = agentIdentifier.slice(56);
  return {
    agentIdentifier,
    network,
    policyId: agentIdentifier.slice(0, 56),
    assetName,
    version: versionOf(assetName),
    name,
    description: text(metadata.description, LIMITS.description),
    type,
    apiBaseUrl: url,
    capability: capName ? { name: capName, version: (cap && text(cap.version, 60)) ?? "" } : null,
    author: authorName
      ? {
          name: authorName,
          contactEmail: author ? text(author.contact_email, LIMITS.shortField) : null,
          organization: author ? text(author.organization, LIMITS.shortField) : null,
        }
      : null,
    tags,
    image: exactText(metadata.image, LIMITS.url),
    metadataVersion: Number.isInteger(mv) ? mv : null,
    pricing,
    paymentSources: sources,
    masumiEscrow,
  };
}

// ---------------------------------------------------------------------------------------------
// Client

class HttpNotFound extends Error {}

export function createMasumiRegistryClient(config: MasumiRegistryConfig): MasumiRegistryClient {
  const { network } = config;
  const policyId = MASUMI_REGISTRY_POLICY_IDS[network];
  const baseUrl = config.blockfrostBaseUrl ?? BLOCKFROST_BASE_URLS[network];
  if (policyId === undefined || baseUrl === undefined)
    throw new ChainError("NETWORK_NOT_SUPPORTED", `no Masumi registry on ${network}`);
  if (!config.blockfrostProjectId)
    throw new ChainError("INTERNAL_ERROR", "Blockfrost project id is not set");
  const prefix = PROJECT_PREFIX[network] ?? "";
  if (!config.blockfrostProjectId.startsWith(prefix))
    throw new ChainError(
      "NETWORK_MODE_MISMATCH",
      `the Blockfrost project id is not a ${prefix} project (${network})`,
    );
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = config.timeoutMs ?? 8_000;
  const maxRetries = config.maxRetries ?? 1;
  const maxBytes = config.maxResponseBytes ?? 256 * 1024;
  const concurrency = Math.max(1, Math.min(config.concurrency ?? 4, 8));
  const livenessTtl = config.livenessTtlSeconds ?? 60;
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = config.cache;

  async function readCapped(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes)
      throw new ChainError("UPSTREAM_UNAVAILABLE", "registry: response too large");
    const body = response.body;
    if (body === null) {
      const t = await response.text();
      if (t.length > maxBytes)
        throw new ChainError("UPSTREAM_UNAVAILABLE", "registry: response too large");
      return t;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (chunk.done || chunk.value === undefined) break;
      const value = chunk.value;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ChainError("UPSTREAM_UNAVAILABLE", "registry: response too large");
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(all);
  }

  /** GET a Blockfrost path. Throws HttpNotFound on 404, ChainError on anything else. */
  async function get(path: string, label: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await doFetch(`${baseUrl}${path}`, {
          method: "GET",
          headers: { accept: "application/json", project_id: config.blockfrostProjectId },
          signal: controller.signal,
        });
        const status = response.status;
        if (status === 404) {
          await response.body?.cancel().catch(() => undefined);
          throw new HttpNotFound();
        }
        if (status === 429 || status === 402 || status === 418 || status === 425 || status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          throw new ChainError(
            status === 429 || status === 402 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
            `registry ${label}: HTTP ${status}`,
            { retryable: true, details: { status } },
          );
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ChainError("UPSTREAM_UNAVAILABLE", `registry ${label}: HTTP ${status}`, {
            details: { status },
          });
        }
        const body = await readCapped(response);
        try {
          return JSON.parse(body) as unknown;
        } catch (error) {
          throw new ChainError("UPSTREAM_UNAVAILABLE", `registry ${label}: invalid JSON`, {
            cause: error,
          });
        }
      } catch (error) {
        if (error instanceof HttpNotFound) throw error;
        const retryable = !(error instanceof ChainError) || error.retryable;
        if (attempt < maxRetries && retryable) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        if (error instanceof ChainError) throw error;
        throw new ChainError(
          "UPSTREAM_UNAVAILABLE",
          `registry ${label}: network error or timeout`,
          {
            retryable: true,
            cause: error,
          },
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function cached<T>(
    key: string,
    ttl: number,
    load: () => Promise<T>,
    check: (v: unknown) => v is T,
    bypass = false,
  ): Promise<T> {
    const fullKey = `masumi-registry:v1:${network}:${key}`;
    if (cache && !bypass) {
      try {
        const hit = await cache.get(fullKey);
        if (typeof hit === "string") {
          const parsed: unknown = JSON.parse(hit);
          if (check(parsed)) return parsed;
        }
      } catch {
        // A broken cache is a miss.
      }
    }
    const value = await load();
    if (cache) {
      try {
        await cache.put(fullKey, JSON.stringify(value), ttl);
      } catch {
        // Caching is best effort.
      }
    }
    return value;
  }

  const isAssetRecord = (v: unknown): v is AssetRecord =>
    isRecord(v) && typeof v.unit === "string" && typeof v.txHash === "string";

  /** Asset metadata and mint tx are immutable per unit: cached for a week. Quantity is not used from cache. */
  async function assetRecord(unit: string): Promise<AssetRecord | null> {
    try {
      return await cached(
        `asset:${unit}`,
        7 * 86_400,
        async () => {
          const body = await get(`/assets/${unit}`, "asset");
          if (!isRecord(body) || body.asset !== unit)
            throw new ChainError("UPSTREAM_UNAVAILABLE", "registry asset: unexpected response");
          const txHash =
            typeof body.initial_mint_tx_hash === "string" ? body.initial_mint_tx_hash : "";
          if (!TX_HASH_RE.test(txHash))
            throw new ChainError("UPSTREAM_UNAVAILABLE", "registry asset: no mint transaction");
          return {
            unit,
            fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : null,
            quantity: typeof body.quantity === "string" ? body.quantity : "0",
            txHash,
            metadata: body.onchain_metadata ?? null,
          };
        },
        isAssetRecord,
      );
    } catch (error) {
      if (error instanceof HttpNotFound) return null;
      throw error;
    }
  }

  const isHolders = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((a) => typeof a === "string");

  /** Addresses currently holding the NFT (empty when burned). */
  async function holders(unit: string, fresh: boolean): Promise<string[]> {
    return cached(
      `holders:${unit}`,
      livenessTtl,
      async () => {
        let body: unknown;
        try {
          body = await get(`/assets/${unit}/addresses?order=desc&count=2`, "holders");
        } catch (error) {
          if (error instanceof HttpNotFound) return [];
          throw error;
        }
        if (!Array.isArray(body))
          throw new ChainError("UPSTREAM_UNAVAILABLE", "registry holders: unexpected response");
        return body
          .filter((h) => isRecord(h) && typeof h.address === "string" && h.quantity !== "0")
          .map((h) => (h as { address: string }).address);
      },
      isHolders,
      fresh,
    );
  }

  const isTime = (v: unknown): v is { t: string | null } =>
    isRecord(v) && (typeof v.t === "string" || v.t === null);

  async function mintTime(txHash: string): Promise<string | null> {
    try {
      const r = await cached(
        `tx-time:${txHash}`,
        30 * 86_400,
        async () => {
          const body = await get(`/txs/${txHash}`, "tx");
          const t = isRecord(body) && typeof body.block_time === "number" ? body.block_time : null;
          return { t: t === null ? null : new Date(t * 1000).toISOString() };
        },
        isTime,
      );
      return r.t;
    } catch {
      return null; // Informational only.
    }
  }

  function buildAgent(
    record: AssetRecord,
    parsed: ParsedMetadata,
    holderList: readonly string[],
    registeredAt: string | null,
  ): MasumiAgent {
    const holder = holderList.length === 1 ? (holderList[0] ?? null) : null;
    const parsedHolder = holder === null ? null : parseShelleyAddress(holder);
    return {
      ...parsed,
      fingerprint: record.fingerprint,
      txHash: record.txHash,
      registeredAt,
      active: holderList.length > 0,
      holderAddress: holder,
      sellerPaymentKeyHash:
        parsedHolder?.payment?.kind === "key" ? parsedHolder.payment.hash : null,
    };
  }

  function checkIdentifier(agentIdentifier: unknown): string | null {
    if (typeof agentIdentifier !== "string") return "agentIdentifier must be a string";
    if (!AGENT_IDENTIFIER_RE.test(agentIdentifier))
      return "agentIdentifier must be 120 lowercase hex characters (policy id + 32-byte asset name)";
    if (!agentIdentifier.startsWith(policyId as string))
      return "agentIdentifier is not under the Masumi registry V2 policy";
    const nonce = Number.parseInt(agentIdentifier.slice(56, 58), 16);
    if (nonce < 0x10) return "agentIdentifier has a reserved nonce byte";
    return null;
  }

  async function resolve(agentIdentifier: string, fresh: boolean): Promise<MasumiResolution> {
    const invalid = checkIdentifier(agentIdentifier);
    if (invalid !== null) return { status: "invalid", reason: invalid };
    const record = await assetRecord(agentIdentifier);
    if (record === null) return { status: "not_found" };
    const parsed = parseMasumiRegistryMetadata(network, agentIdentifier, record.metadata);
    if (parsed === null)
      return { status: "invalid", reason: "registry metadata is missing or invalid" };
    const [holderList, registeredAt] = await Promise.all([
      holders(agentIdentifier, fresh),
      mintTime(record.txHash),
    ]);
    const agent = buildAgent(record, parsed, holderList, registeredAt);
    return { status: agent.active ? "active" : "burned", agent };
  }

  const isUnitList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((u) => typeof u === "string");

  async function liveUnitsPage(page: number): Promise<{ units: string[]; full: boolean }> {
    const r = await cached(
      `policy-page:${page}`,
      livenessTtl,
      async () => {
        const body = await get(
          `/assets/policy/${policyId}?count=100&order=desc&page=${page}`,
          "policy listing",
        );
        if (!Array.isArray(body))
          throw new ChainError(
            "UPSTREAM_UNAVAILABLE",
            "registry policy listing: unexpected response",
          );
        // Encode "full page" as a trailing marker so the cached value stays a string list.
        const live = body
          .filter((a) => isRecord(a) && typeof a.asset === "string" && a.quantity === "1")
          .map((a) => (a as { asset: string }).asset)
          .filter((u) => AGENT_IDENTIFIER_RE.test(u) && u.startsWith(policyId as string));
        return [...live, body.length === 100 ? "+" : "."];
      },
      isUnitList,
    );
    const marker = r[r.length - 1];
    return { units: r.slice(0, -1), full: marker === "+" };
  }

  function matches(agent: ParsedMetadata, input: MasumiSearchInput): boolean {
    if (input.escrowOnly && !agent.masumiEscrow) return false;
    if (input.capability !== undefined) {
      if (agent.capability?.name.toLowerCase() !== input.capability.trim().toLowerCase())
        return false;
    }
    if (input.tag !== undefined) {
      const tag = input.tag.trim().toLowerCase();
      if (!agent.tags.some((t) => t.toLowerCase() === tag)) return false;
    }
    if (input.query !== undefined && input.query.trim() !== "") {
      const q = input.query.trim().toLowerCase().slice(0, 200);
      const hay = [agent.name, agent.description ?? "", agent.capability?.name ?? "", ...agent.tags]
        .join("\n")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (input.maxPrice !== undefined) {
      const p = agent.pricing;
      if (p.type === "Dynamic") return input.includeDynamic === true;
      if (p.type === "Unknown") return false;
      if (p.type === "Fixed") {
        const unit = normalizeMasumiUnit(input.maxPrice.unit);
        if (unit === null || !isDecimal(input.maxPrice.amount)) return false;
        const totals = fixedTotals(p);
        if (totals.size !== 1) return false;
        const total = totals.get(unit);
        if (total === undefined || total > BigInt(input.maxPrice.amount)) return false;
      }
    }
    return true;
  }

  async function searchAgents(input: MasumiSearchInput = {}): Promise<MasumiSearchResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const maxScan = Math.max(1, Math.min(input.maxScan ?? 100, 400));
    const found: { record: AssetRecord; parsed: ParsedMetadata }[] = [];
    let scanned = 0;
    let truncated = false;
    for (let page = 1; page <= 50; page++) {
      const { units, full } = await liveUnitsPage(page);
      const budget = units.slice(0, maxScan - scanned);
      if (budget.length < units.length) truncated = true;
      const records = await pool(budget, concurrency, async (unit) => {
        try {
          return await assetRecord(unit);
        } catch {
          return null; // One bad entry never fails discovery.
        }
      });
      scanned += budget.length;
      for (const record of records) {
        if (record === null) continue;
        const parsed = parseMasumiRegistryMetadata(network, record.unit, record.metadata);
        if (parsed === null) continue;
        if (matches(parsed, input)) found.push({ record, parsed });
      }
      if (found.length >= limit) {
        truncated = truncated || full || budget.length < units.length;
        break;
      }
      if (!full) break;
      if (scanned >= maxScan) {
        truncated = true;
        break;
      }
    }
    const selected = found.slice(0, limit);
    const agents = await pool(selected, concurrency, async ({ record, parsed }) => {
      const [holderList, registeredAt] = await Promise.all([
        holders(record.unit, false).catch(() => null),
        mintTime(record.txHash),
      ]);
      if (holderList === null) {
        // Holder lookup failed: live per the listing, seller unknown (verify before paying).
        return { ...buildAgent(record, parsed, [], registeredAt), active: true };
      }
      return buildAgent(record, parsed, holderList, registeredAt);
    });
    return {
      // Burned between the listing and the holder lookup: dropped.
      agents: agents.filter((a) => a.active),
      scanned,
      truncated,
    };
  }

  async function verifySeller(input: MasumiVerifyInput): Promise<MasumiVerifyResult> {
    const reasons: MasumiVerifyReason[] = [];
    const details: string[] = [];
    const fail = (reason: MasumiVerifyReason, detail: string): void => {
      if (!reasons.includes(reason)) reasons.push(reason);
      details.push(detail);
    };
    const done = (agent: MasumiAgent | null): MasumiVerifyResult => ({
      ok: reasons.length === 0,
      reasons,
      details,
      agent,
    });

    // The seller key, from the address the terms are signed by or a given vkey hash.
    let sellerPkh: string | null = null;
    if (input.sellerAddress !== undefined) {
      const parsed = parseShelleyAddress(input.sellerAddress);
      const expectedNetworkId = network === "cardano-mainnet" ? 1 : 0;
      if (parsed === null || parsed.payment?.kind !== "key") {
        fail("seller_invalid", "the seller address is not a Shelley key address");
      } else if (parsed.networkId !== expectedNetworkId) {
        fail("network_mismatch", "the seller address is on another network");
      } else {
        sellerPkh = parsed.payment.hash;
      }
    }
    if (input.sellerVkey !== undefined) {
      const vkey = input.sellerVkey.toLowerCase();
      if (!/^[0-9a-f]{56}$/.test(vkey))
        fail("seller_invalid", "sellerVkey must be a 28-byte hex key hash");
      else if (sellerPkh !== null && sellerPkh !== vkey)
        fail("seller_mismatch", "sellerVkey and sellerAddress name different keys");
      else sellerPkh = vkey;
    }
    if (input.sellerAddress === undefined && input.sellerVkey === undefined)
      fail("seller_missing", "a seller address or vkey is required");

    if (
      typeof input.agentIdentifier !== "string" ||
      !AGENT_IDENTIFIER_RE.test(input.agentIdentifier)
    ) {
      fail("invalid_identifier", "agentIdentifier must be 120 lowercase hex characters");
      return done(null);
    }
    if (!input.agentIdentifier.startsWith(policyId as string)) {
      fail("wrong_policy", "agentIdentifier is not under the Masumi registry V2 policy");
      return done(null);
    }

    let resolution: MasumiResolution;
    try {
      resolution = await resolve(input.agentIdentifier, true);
    } catch (error) {
      fail(
        "upstream_unavailable",
        error instanceof Error ? error.message : "registry lookup failed",
      );
      return done(null);
    }
    if (resolution.status === "invalid") {
      fail(
        resolution.reason.includes("metadata") ? "metadata_invalid" : "invalid_identifier",
        resolution.reason,
      );
      return done(null);
    }
    if (resolution.status === "not_found") {
      fail("not_found", "no such registry NFT");
      return done(null);
    }
    const agent = resolution.agent;
    if (resolution.status === "burned")
      fail("burned", "the registry NFT is burned (deregistered or updated)");
    else if (agent.holderAddress === null)
      fail("multiple_holders", "the registry NFT has more than one holder");
    else if (agent.sellerPaymentKeyHash === null)
      fail("holder_not_key_address", "the registry NFT is held by a script, not a seller key");
    else if (sellerPkh !== null && agent.sellerPaymentKeyHash !== sellerPkh)
      fail("seller_mismatch", "the terms are signed by a key that does not hold this registry NFT");

    if ((input.requireEscrow ?? true) && !agent.masumiEscrow)
      fail(
        "no_escrow_source",
        "the agent does not advertise the canonical Masumi V2 escrow on this network",
      );

    const endpoint = parseUrl(agent.apiBaseUrl);
    if (endpoint === null)
      fail("endpoint_invalid", "the registered endpoint is not an http(s) URL");
    else if (
      !config.allowInsecureEndpoints &&
      (endpoint.protocol !== "https:" || isPrivateHost(endpoint.hostname))
    )
      fail("endpoint_insecure", "the registered endpoint is not a public https URL");
    if (input.resourceUrl !== undefined) {
      const resource = parseUrl(input.resourceUrl);
      if (resource === null) fail("endpoint_invalid", "the resource URL is not an http(s) URL");
      else if (endpoint !== null && !endpointCovers(endpoint, resource))
        fail("endpoint_mismatch", "the resource is not served under the registered endpoint");
    }

    if (input.amount !== undefined || input.asset !== undefined) {
      const unit = input.asset === undefined ? null : normalizeMasumiUnit(input.asset);
      const amount = input.amount ?? "";
      const p = agent.pricing;
      if (unit === null || !isDecimal(amount))
        fail("price_mismatch", "the signed price is malformed");
      else if (p.type === "Unknown") fail("price_mismatch", "the agent advertises no usable price");
      else if (p.type === "Free") {
        if (BigInt(amount) > 0n) fail("price_mismatch", "the agent is registered as free");
      } else if (p.type === "Fixed") {
        const totals = fixedTotals(p);
        if (totals.size !== 1 || totals.get(unit) !== BigInt(amount))
          fail("price_mismatch", "the signed price differs from the registered fixed price");
      }
      // Dynamic: the seller quotes per job; the buyer's own spending policy bounds it.
    }

    const trust = config.trust;
    if (trust !== undefined) {
      const byId = trust.agentIdentifiers?.includes(agent.agentIdentifier) ?? false;
      const byKey =
        agent.sellerPaymentKeyHash !== null &&
        (trust.sellerPaymentKeyHashes?.includes(agent.sellerPaymentKeyHash) ?? false);
      if (!byId && !byKey) fail("not_trusted", "the agent is not on the trusted list");
    }
    return done(agent);
  }

  function registryValidator(): MasumiRegistryValidator {
    return async (claim) => {
      try {
        if (X402_NETWORKS[claim.network] !== network) return false;
        const result = await verifySeller({
          agentIdentifier: claim.agentIdentifier,
          sellerAddress: claim.sellerAddress,
          resourceUrl: claim.resource.url,
          asset: claim.asset,
          amount: claim.amount,
          requireEscrow: true,
        });
        return result.ok;
      } catch {
        return false;
      }
    };
  }

  return {
    network,
    policyId,
    searchAgents,
    resolveAgent: (agentIdentifier) => resolve(agentIdentifier, false),
    verifySeller,
    registryValidator,
  };
}

// ---------------------------------------------------------------------------------------------
// Convenience wrappers (one-shot; pass `cache` to share results across calls)

export function searchMasumiAgents(
  input: MasumiRegistryConfig & MasumiSearchInput,
): Promise<MasumiSearchResult> {
  return createMasumiRegistryClient(input).searchAgents(input);
}

export function resolveMasumiAgent(
  config: MasumiRegistryConfig,
  agentIdentifier: string,
): Promise<MasumiResolution> {
  return createMasumiRegistryClient(config).resolveAgent(agentIdentifier);
}

export function verifyMasumiSeller(
  input: MasumiRegistryConfig & MasumiVerifyInput,
): Promise<MasumiVerifyResult> {
  return createMasumiRegistryClient(input).verifySeller(input);
}

/** In-memory MasumiRegistryCache (per isolate). Bounded; oldest entries evicted first. */
export function createMemoryRegistryCache(
  options: { maxEntries?: number; now?: () => number } = {},
): MasumiRegistryCache {
  const max = options.maxEntries ?? 2_000;
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, { value: string; expires: number }>();
  return {
    get(key) {
      const hit = map.get(key);
      if (hit === undefined) return Promise.resolve(null);
      if (hit.expires <= now()) {
        map.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(hit.value);
    },
    put(key, value, ttlSeconds) {
      map.delete(key);
      map.set(key, { value, expires: now() + ttlSeconds * 1000 });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      return Promise.resolve();
    },
  };
}
