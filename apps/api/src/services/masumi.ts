/*
 * Masumi agent registry, read side (docs/CARDANO_X402.md "Discover and identify"): discovery
 * for the app (GET /v1/masumi/agents) and for agents (find_agents / verify_agent through the
 * internal endpoints). Public chain data read through Blockfrost by
 * @zyropay/integrations' registry client; nothing here touches a wallet. Paying an agent
 * found here is a pay_x402 like any other: the quote re-verifies the seller's registry claim
 * against the key that signs its terms, and the agent policy decides.
 */
import type { MasumiAgent, MasumiRegistryClient } from "@zyropay/integrations";
import type {
  MasumiAgentResolution,
  MasumiAgentSearchQuery,
  MasumiAgentSearchResult,
  MasumiAgentSummary,
  MasumiAgentVerification,
} from "@zyropay/shared";
import { describeMasumiPriceAmount, MasumiAgentSummarySchema } from "@zyropay/shared";
import type { Ctx } from "../deps";
import { AppError } from "../lib/errors";

function registryOf(ctx: Ctx): MasumiRegistryClient {
  const registry = ctx.deps.masumiRegistry;
  if (registry === null)
    throw new AppError("UPSTREAM_UNAVAILABLE", "the Masumi registry is not configured");
  return registry;
}

/** Registry read failures are upstream failures (never an empty result). */
function upstream(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("UPSTREAM_UNAVAILABLE", "the Masumi registry could not be read", {
    retryable: true,
  });
}

/** The contract subset; null for an entry outside it (dropped, never half-shown). */
function toMasumiAgentSummary(agent: MasumiAgent): MasumiAgentSummary | null {
  const parsed = MasumiAgentSummarySchema.safeParse({
    agentIdentifier: agent.agentIdentifier,
    network: agent.network,
    name: agent.name,
    description: agent.description,
    apiBaseUrl: agent.apiBaseUrl,
    capability: agent.capability,
    tags: agent.tags,
    pricing:
      agent.pricing.type === "Fixed"
        ? { type: "Fixed", amounts: agent.pricing.amounts.map(describeMasumiPriceAmount) }
        : agent.pricing,
    masumiEscrow: agent.masumiEscrow,
    registeredAt: agent.registeredAt,
    sellerPaymentKeyHash: agent.sellerPaymentKeyHash,
    active: agent.active,
  });
  return parsed.success ? parsed.data : null;
}

export async function searchMasumiAgents(
  ctx: Ctx,
  query: MasumiAgentSearchQuery,
): Promise<MasumiAgentSearchResult> {
  const registry = registryOf(ctx);
  // An amount alone is in lovelace; a unit alone means nothing.
  if (query.maxPriceUnit !== undefined && query.maxPriceAmount === undefined)
    throw new AppError("VALIDATION_FAILED", "maxPriceUnit needs maxPriceAmount");
  try {
    const result = await registry.searchAgents({
      ...(query.q !== undefined ? { query: query.q } : {}),
      ...(query.capability !== undefined ? { capability: query.capability } : {}),
      ...(query.tag !== undefined ? { tag: query.tag } : {}),
      ...(query.maxPriceAmount !== undefined
        ? { maxPrice: { unit: query.maxPriceUnit ?? "lovelace", amount: query.maxPriceAmount } }
        : {}),
      limit: query.limit,
    });
    return {
      agents: result.agents.flatMap((a) => toMasumiAgentSummary(a) ?? []),
      scanned: result.scanned,
      truncated: result.truncated,
    };
  } catch (error) {
    throw upstream(error);
  }
}

export async function resolveMasumiAgent(
  ctx: Ctx,
  agentIdentifier: string,
): Promise<MasumiAgentResolution> {
  const registry = registryOf(ctx);
  try {
    const r = await registry.resolveAgent(agentIdentifier);
    if (r.status === "not_found") return { status: "not_found", agent: null, reason: null };
    if (r.status === "invalid") return { status: "invalid", agent: null, reason: r.reason };
    const agent = toMasumiAgentSummary(r.agent);
    return agent === null
      ? { status: "invalid", agent: null, reason: "registry metadata is outside the contract" }
      : { status: r.status, agent, reason: null };
  } catch (error) {
    throw upstream(error);
  }
}

/**
 * Identity check of a registered agent. With `sellerAddress` (the key that signs a 402's
 * terms) the NFT must be held by it; without, the current holder is assumed and the other
 * checks still run (live NFT, key holder, canonical escrow, public https endpoint covering
 * `resourceUrl`).
 */
export async function verifyMasumiAgent(
  ctx: Ctx,
  input: { agentIdentifier: string; sellerAddress?: string; resourceUrl?: string },
): Promise<MasumiAgentVerification> {
  const registry = registryOf(ctx);
  let sellerVkey: string | undefined;
  if (input.sellerAddress === undefined) {
    let holder: string | null;
    try {
      const r = await registry.resolveAgent(input.agentIdentifier);
      holder = r.status === "active" ? r.agent.sellerPaymentKeyHash : null;
    } catch {
      holder = null; // verifySeller below reports the outage itself.
    }
    if (holder !== null) sellerVkey = holder;
  }
  const result = await registry.verifySeller({
    agentIdentifier: input.agentIdentifier,
    ...(input.sellerAddress !== undefined ? { sellerAddress: input.sellerAddress } : {}),
    ...(sellerVkey !== undefined ? { sellerVkey } : {}),
    ...(input.resourceUrl !== undefined ? { resourceUrl: input.resourceUrl } : {}),
    requireEscrow: true,
  });
  return {
    ok: result.ok,
    reasons: [...result.reasons],
    details: result.details.slice(0, 20).map((d) => d.slice(0, 300)),
    sellerChecked: input.sellerAddress !== undefined,
    agent: result.agent === null ? null : toMasumiAgentSummary(result.agent),
  };
}
