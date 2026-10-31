import type {
  MasumiAgentResolution,
  MasumiAgentSearchResult,
  MasumiAgentSummary,
  X402SellerIdentity,
} from "@zyropay/shared";
import { filterMasumiAgents } from "@/lib/masumi";

/*
 * DEV MOCK: a simulated slice of the Masumi agent registry on Cardano preprod. Every entry
 * is invented (hosts on the reserved `.example` domain, made-up identifiers) and is only
 * served with EXPO_PUBLIC_USE_MOCKS=1, under the app's "Simulated data" banner.
 */

/** Deterministic 120-hex agentIdentifier (56 policy id + 64 asset name). */
function fakeAgentId(seed: number): string {
  const policy = "7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77";
  let name = "";
  for (let i = 0; i < 64; i++) name += ((seed * 7 + i * 3) % 16).toString(16);
  return `${policy}${name}`;
}

/** tUSDM on Cardano preprod: policy id + CIP-67 (333) asset name "tUSDM". */
export const TUSDM_PREPROD =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export const MOCK_SELLER_AGENT_ID = fakeAgentId(1);
const MOCK_TOKEN_AGENT_ID = fakeAgentId(2);

const SELLER_KEY_HASH = "5f2c0d9a41e6b37c88d4a1f09e2b6c7d3a85f1e04b9c2d6a7e31f8b0";

export const MOCK_MASUMI_AGENTS: readonly MasumiAgentSummary[] = [
  {
    agentIdentifier: MOCK_SELLER_AGENT_ID,
    network: "cardano-preprod",
    name: "Cardano Address Intelligence",
    description:
      "Simulated listing. Reports on any Cardano address: balance history, stake delegation, token holdings and linked script activity, as signed JSON.",
    apiBaseUrl: "https://address-intel.zyropay.online/v1",
    capability: { name: "address-intelligence", version: "1.2.0" },
    tags: ["cardano", "analytics", "wallets"],
    pricing: { type: "Fixed", amounts: [{ unit: "lovelace", amount: "2000000" }] },
    masumiEscrow: true,
    registeredAt: "2026-10-30T13:30:00.000Z",
    sellerPaymentKeyHash: SELLER_KEY_HASH,
    active: true,
  },
  {
    agentIdentifier: MOCK_TOKEN_AGENT_ID,
    network: "cardano-preprod",
    name: "Cardano Token Intelligence",
    description:
      "Simulated listing. Specialist for Cardano native tokens: supply, holder concentration, minting policy checks and liquidity across DEX pools.",
    apiBaseUrl: "https://token-intel.zyropay.online/v1",
    capability: { name: "token-intelligence", version: "0.9.1" },
    tags: ["cardano", "tokens", "analytics"],
    pricing: { type: "Fixed", amounts: [{ unit: TUSDM_PREPROD, amount: "1500000" }] },
    masumiEscrow: true,
    registeredAt: "2026-10-31T14:05:00.000Z",
    sellerPaymentKeyHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
    active: true,
  },
  {
    agentIdentifier: fakeAgentId(3),
    network: "cardano-preprod",
    name: "Stake Pool Scout",
    description:
      "Simulated listing. Ranks stake pools by performance, fees and saturation for a delegation goal you describe.",
    apiBaseUrl: "https://pools.example",
    capability: { name: "pool-ranking", version: "2.0.0" },
    tags: ["staking", "cardano"],
    pricing: { type: "Dynamic" },
    masumiEscrow: true,
    registeredAt: "2026-10-30T11:00:00.000Z",
    sellerPaymentKeyHash: "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e",
    active: true,
  },
  {
    agentIdentifier: fakeAgentId(4),
    network: "cardano-preprod",
    name: "Governance Digest",
    description:
      "Simulated listing. Plain-language summaries of open Cardano governance actions and how DReps voted.",
    apiBaseUrl: "https://gov-digest.example/agent",
    capability: { name: "governance-summary", version: "1.0.0" },
    tags: ["governance", "summaries"],
    pricing: { type: "Free" },
    masumiEscrow: false,
    registeredAt: "2026-10-30T08:15:00.000Z",
    sellerPaymentKeyHash: null,
    active: true,
  },
  {
    // Deregistered (registry NFT burned): never listed, looked up as "burned".
    agentIdentifier: fakeAgentId(5),
    network: "cardano-preprod",
    name: "Retired Price Oracle",
    description: "Simulated listing. No longer registered.",
    apiBaseUrl: "https://oracle.example",
    capability: { name: "price-feed", version: "0.1.0" },
    tags: ["prices"],
    pricing: { type: "Fixed", amounts: [{ unit: "lovelace", amount: "500000" }] },
    masumiEscrow: true,
    registeredAt: "2026-10-30T08:00:00.000Z",
    sellerPaymentKeyHash: null,
    active: false,
  },
];

/** Search text that makes the simulated registry fail (to see the error state). */
const MOCK_MASUMI_ERROR_QUERY = "simulate-error";

export class MockRegistryUnavailable extends Error {}

/** GET /v1/masumi/agents (the API's filtering, over the simulated registry). */
export function mockListMasumiAgents(query: Record<string, string>): MasumiAgentSearchResult {
  const { q, capability, tag, maxPriceUnit, maxPriceAmount } = query;
  if (q?.trim().toLowerCase() === MOCK_MASUMI_ERROR_QUERY)
    throw new MockRegistryUnavailable("the Masumi registry is unreachable (simulated)");
  const limit = Math.min(Math.max(Number(query.limit ?? "20") || 20, 1), 50);
  const agents = filterMasumiAgents(MOCK_MASUMI_AGENTS, {
    ...(q !== undefined ? { q } : {}),
    capability: capability ?? null,
    tag: tag ?? null,
    maxPrice:
      maxPriceAmount !== undefined ? { unit: maxPriceUnit ?? "", amount: maxPriceAmount } : null,
  }).slice(0, limit);
  return { agents, scanned: MOCK_MASUMI_AGENTS.length, truncated: false };
}

/** GET /v1/masumi/agents/:agentIdentifier. */
export function mockGetMasumiAgent(agentIdentifier: string): MasumiAgentResolution {
  const agent = MOCK_MASUMI_AGENTS.find((a) => a.agentIdentifier === agentIdentifier);
  if (agent === undefined) return { status: "not_found", agent: null, reason: null };
  return { status: agent.active ? "active" : "burned", agent, reason: null };
}

/**
 * Seller identity the simulated API attaches to an escrow x402 approval: the address and
 * token reports come from the registered simulated sellers; any other seller claims no
 * registry identity. Direct payments carry none (null).
 */
export function mockSellerIdentity(
  resourceUrl: string,
  escrow: boolean,
): X402SellerIdentity | null {
  if (!escrow) return null;
  const path = (() => {
    try {
      return new URL(resourceUrl).pathname;
    } catch {
      return "";
    }
  })();
  const agent = path.startsWith("/v1/audits/address/")
    ? MOCK_MASUMI_AGENTS[0]
    : path.startsWith("/v1/reports/token-holders")
      ? MOCK_MASUMI_AGENTS[1]
      : undefined;
  if (agent === undefined)
    return { registered: false, agentIdentifier: null, name: null, reasons: ["not_claimed"] };
  return {
    registered: true,
    agentIdentifier: agent.agentIdentifier,
    name: agent.name,
    reasons: [],
  };
}
