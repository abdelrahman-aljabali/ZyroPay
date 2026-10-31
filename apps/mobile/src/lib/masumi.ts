import {
  MAX_TRUSTED_AGENT_IDENTIFIERS,
  type MasumiAgentPricing,
  type MasumiAgentSummary,
  type X402SellerIdentity,
} from "@zyropay/shared";
import { formatShortDate, formatTokenAmount } from "@zyropay/ui/format";

type MasumiAgent = MasumiAgentSummary;
type MasumiPricing = MasumiAgentPricing;
type MasumiPrice = Extract<MasumiAgentPricing, { type: "Fixed" }>["amounts"][number];

/*
 * Pure helpers for Masumi agent discovery and seller identity (unit-tested). Everything an
 * agent publishes in the registry is third-party text: these helpers only ever turn it into
 * plain strings (never links), cut to a safe length.
 */

/** Masumi agentIdentifier: policy id (56 hex) + asset name (64 hex). */
const AGENT_IDENTIFIER_RE = /^[0-9a-f]{120}$/;

function normalizeAgentIdentifier(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidAgentIdentifier(input: string): boolean {
  return AGENT_IDENTIFIER_RE.test(normalizeAgentIdentifier(input));
}

/** "abcd1234…9f0e" for a long identifier, in monospace contexts. */
export function shortAgentIdentifier(id: string, lead = 8, tail = 6): string {
  return id.length <= lead + tail + 1 ? id : `${id.slice(0, lead)}…${id.slice(-tail)}`;
}

// --- Prices -------------------------------------------------------------------

/** CIP-67 label prefixes on Cardano asset names: 333 (fungible), 222 (NFT), 100 (reference). */
const CIP67_PREFIXES = ["0014df10", "000de140", "000643b0"];
/** Stablecoins priced in Masumi: 6 decimals. */
const SIX_DECIMAL_TOKENS = new Set(["USDM", "tUSDM", "USDCx", "iUSD", "DJED"]);

export interface UnitInfo {
  readonly symbol: string;
  readonly decimals: number;
}

function decodeAssetName(hex: string): string | null {
  let body = hex;
  for (const p of CIP67_PREFIXES) if (body.startsWith(p)) body = body.slice(p.length);
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-f]+$/.test(body)) return null;
  let out = "";
  for (let i = 0; i < body.length; i += 2) {
    const c = parseInt(body.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) return null;
    out += String.fromCharCode(c);
  }
  return out;
}

/** What a Masumi price unit is: ADA for ""/"lovelace", else the token's readable name. */
export function masumiUnitInfo(unit: string): UnitInfo {
  const u = unit.trim();
  if (u === "" || u.toLowerCase() === "lovelace") return { symbol: "ADA", decimals: 6 };
  const normalized = u.replace(".", "").toLowerCase();
  if (/^[0-9a-f]{56}/.test(normalized)) {
    const name = decodeAssetName(normalized.slice(56));
    if (name !== null && /^[A-Za-z0-9]{1,12}$/.test(name))
      return { symbol: name, decimals: SIX_DECIMAL_TOKENS.has(name) ? 6 : 0 };
    return { symbol: `token ${normalized.slice(0, 6)}…`, decimals: 0 };
  }
  return { symbol: "units", decimals: 0 };
}

function formatMasumiPrice(price: MasumiPrice): string {
  const info = masumiUnitInfo(price.unit);
  return formatTokenAmount(price.amount, info.decimals, { symbol: info.symbol });
}

/** "2 ADA", "1.5 tUSDM + 1 ADA", "Free", "Priced per job", "Price not listed". */
export function formatMasumiPricing(pricing: MasumiPricing): string {
  switch (pricing.type) {
    case "Free":
      return "Free";
    case "Dynamic":
      return "Priced per job";
    case "Unknown":
      return "Price not listed";
    case "Fixed": {
      const fixed = pricing.amounts;
      if (fixed.length === 0) return "Price not listed";
      return fixed.map(formatMasumiPrice).join(" + ");
    }
  }
}

// --- Filters ------------------------------------------------------------------

export interface MasumiFilters {
  readonly q?: string;
  readonly capability?: string | null;
  readonly tag?: string | null;
  /** Only agents with a fixed price at most `amount` in `unit` (Free always matches). */
  readonly maxPrice?: { readonly unit: string; readonly amount: string } | null;
}

const sameUnit = (a: string, b: string) => {
  const n = (u: string) => {
    const t = u.trim().replace(".", "").toLowerCase();
    return t === "" ? "lovelace" : t;
  };
  return n(a) === n(b);
};

function withinPrice(agent: MasumiAgent, max: { unit: string; amount: string }): boolean {
  if (agent.pricing.type === "Free") return true;
  if (agent.pricing.type !== "Fixed") return false;
  const fixed = agent.pricing.amounts;
  const match = fixed.find((p) => sameUnit(p.unit, max.unit));
  return match !== undefined && fixed.length === 1 && BigInt(match.amount) <= BigInt(max.amount);
}

/** The filtering the API applies, mirrored for mock mode and for instant local narrowing. */
export function filterMasumiAgents(
  agents: readonly MasumiAgent[],
  filters: MasumiFilters,
): MasumiAgent[] {
  const q = (filters.q ?? "").trim().toLowerCase();
  const cap = filters.capability?.toLowerCase() ?? null;
  const tag = filters.tag?.toLowerCase() ?? null;
  return agents.filter((a) => {
    if (!a.active) return false;
    if (cap !== null && a.capability?.name.toLowerCase() !== cap) return false;
    if (tag !== null && !a.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (filters.maxPrice && !withinPrice(a, filters.maxPrice)) return false;
    if (q === "") return true;
    return [a.name, a.description ?? "", a.capability?.name ?? "", ...a.tags].some((s) =>
      s.toLowerCase().includes(q),
    );
  });
}

/** Capability names and tags present in a result, most common first (for filter chips). */
export function masumiFacets(
  agents: readonly MasumiAgent[],
  max = 8,
): { capabilities: string[]; tags: string[] } {
  const count = (values: string[]) => {
    const m = new Map<string, number>();
    for (const v of values) {
      const k = v.trim();
      if (k !== "" && k.length <= 32) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, max)
      .map(([k]) => k);
  };
  return {
    capabilities: count(agents.flatMap((a) => (a.capability ? [a.capability.name] : []))),
    tags: count(agents.flatMap((a) => a.tags)),
  };
}

// --- Third-party text ------------------------------------------------------------

/**
 * Registry text as one plain line: control and bidi-override characters removed, whitespace
 * collapsed, cut to `max` characters with an ellipsis.
 */
export function plainText(input: string, max = 280): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** Host of an agent's endpoint, shown as text (never a link); null when not http(s). */
export function endpointHost(apiBaseUrl: string): string | null {
  try {
    const url = new URL(apiBaseUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.host === "" ? null : url.host;
  } catch {
    return null;
  }
}

export function registeredLabel(registeredAt: string | null): string | null {
  if (registeredAt === null) return null;
  const d = formatShortDate(registeredAt);
  return d === "" ? null : `Registered ${d}`;
}

// --- Seller identity (approval screen) -------------------------------------------

export type SellerBadgeKind = "registered" | "unregistered" | "failed";

export interface SellerBadge {
  readonly kind: SellerBadgeKind;
  readonly tone: "success" | "caution" | "danger";
  readonly title: string;
  readonly lines: readonly string[];
}

/** Seller identity check reasons (MASUMI_VERIFY_REASONS) in plain words. */
const SELLER_REASON_TEXT: Readonly<Record<string, string>> = {
  invalid_identifier: "The seller's agent identifier isn't a valid Masumi identifier.",
  network_mismatch: "The seller is registered on a different Cardano network.",
  wrong_policy: "The identifier isn't from the Masumi registry.",
  not_found: "No Masumi registry entry has this identifier.",
  burned: "The seller's registration was withdrawn.",
  multiple_holders: "More than one wallet holds the registry NFT.",
  metadata_invalid: "The seller's registry entry can't be read.",
  holder_not_key_address: "The registry NFT isn't held by a regular wallet.",
  seller_missing: "The payment names no seller.",
  seller_invalid: "The seller's address isn't valid.",
  seller_mismatch: "The seller isn't the wallet that holds the registry NFT.",
  no_escrow_source: "The seller can't be checked without an escrow payment.",
  endpoint_invalid: "The registered endpoint isn't a valid web address.",
  endpoint_insecure: "The registered endpoint doesn't use HTTPS.",
  endpoint_mismatch: "The resource isn't served from the seller's registered endpoint.",
  price_mismatch: "The price differs from the registered price.",
  not_trusted: "The seller isn't on this agent's trusted list.",
  upstream_unavailable: "The Masumi registry couldn't be reached to check the seller.",
};

function sellerReasonText(code: string): string {
  return SELLER_REASON_TEXT[code] ?? plainText(code.replace(/_/g, " "), 120);
}

/**
 * The seller line in "What you're paying for": registered (green), unregistered (amber,
 * neutral) or failed verification (red, with the reasons). Null: the API did not check.
 */
export function sellerBadge(identity: X402SellerIdentity | null | undefined): SellerBadge | null {
  if (identity == null) return null;
  if (identity.registered) {
    const name = identity.name === null ? "" : plainText(identity.name, 60);
    return {
      kind: "registered",
      tone: "success",
      title: name === "" ? "Registered Masumi agent" : `Registered Masumi agent · ${name}`,
      lines: ["The seller holds its registry NFT on Cardano."],
    };
  }
  // "not_claimed": the seller simply claims no registry identity (not a failed check).
  const reasons = identity.reasons
    .filter((r) => r !== "not_claimed")
    .map(sellerReasonText)
    .filter((r) => r !== "");
  if (reasons.length > 0)
    return {
      kind: "failed",
      tone: "danger",
      title: "Seller not verified",
      lines: reasons.slice(0, 4),
    };
  return {
    kind: "unregistered",
    tone: "caution",
    title: "Unregistered seller",
    lines: ["This seller is not a registered Masumi agent. Pay only if you trust it."],
  };
}

// --- Trusted agents (policy editor) -------------------------------------------------

export type TrustedAgentInputError = "invalid" | "duplicate" | "full";

const MAX_TRUSTED_AGENTS = MAX_TRUSTED_AGENT_IDENTIFIERS;

/** Add a pasted agentIdentifier to the trusted list, or say why not. */
export function addTrustedAgent(
  list: readonly string[],
  input: string,
): { list: string[]; error: TrustedAgentInputError | null } {
  const id = normalizeAgentIdentifier(input);
  if (!isValidAgentIdentifier(id)) return { list: [...list], error: "invalid" };
  if (list.includes(id)) return { list: [...list], error: "duplicate" };
  if (list.length >= MAX_TRUSTED_AGENTS) return { list: [...list], error: "full" };
  return { list: [...list, id], error: null };
}

export const TRUSTED_AGENT_ERROR: Readonly<Record<TrustedAgentInputError, string>> = {
  invalid: "An agent identifier is 120 hex characters (policy id + asset name).",
  duplicate: "That agent is already on your list.",
  full: `You can trust up to ${String(MAX_TRUSTED_AGENTS)} agents.`,
};
