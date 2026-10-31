/*
 * API -> MCP worker calls (service-to-service, Bearer INTERNAL_SERVICE_TOKEN).
 *
 * Revoking an agent pushes `mcpRevokeAgentGrants` so its OAuth grants (and so its access
 * and refresh tokens) die at once. Revocation does not depend on this call: the API already
 * refuses every internal call for a revoked agent, and the MCP worker revokes the grant
 * itself when it sees that refusal. A failed push is therefore logged and retried from the
 * queue, never surfaced to the user.
 */
import { mcpInternal } from "@zyropay/shared";
import type { AppDeps } from "../deps";

/** Host used over the service binding (bindings ignore it). */
const SERVICE_BINDING_BASE = "https://zyropay-mcp.internal";

export interface McpClient {
  revokeAgentGrants(input: { agentId: string; userId: string }): Promise<number>;
}

export function createMcpClient(options: {
  binding: Fetcher | undefined;
  baseUrl: string | null;
  serviceToken: string | null;
  timeoutMs?: number;
}): McpClient | null {
  const { binding, baseUrl, serviceToken } = options;
  if (serviceToken === null || (binding === undefined && baseUrl === null)) return null;
  const fetcher = (request: Request) =>
    binding !== undefined && baseUrl === null ? binding.fetch(request) : fetch(request);
  const origin = baseUrl ?? SERVICE_BINDING_BASE;
  return {
    async revokeAgentGrants({ agentId, userId }) {
      const contract = mcpInternal.mcpRevokeAgentGrants;
      const path = contract.path.replace(":agentId", encodeURIComponent(agentId));
      const response = await fetcher(
        new Request(new URL(path, origin), {
          method: contract.method,
          headers: {
            Authorization: `Bearer ${serviceToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(contract.body.parse({ userId })),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        }),
      );
      if (!response.ok) throw new Error(`MCP revoke-grants responded ${response.status}`);
      const parsed = contract.response.safeParse(await response.json());
      if (!parsed.success) throw new Error("MCP revoke-grants returned an unexpected body");
      return parsed.data.revokedGrantCount;
    },
  };
}

/** Push the revocation; on failure, schedule a retry through the queue. Never throws. */
export async function pushAgentRevocation(
  deps: AppDeps,
  input: { agentId: string; userId: string },
  options: { inline: boolean } = { inline: true },
): Promise<void> {
  const client = deps.mcp;
  if (client === null) {
    deps.logger.warn("mcp.revoke_not_configured", { agentId: input.agentId });
    return;
  }
  try {
    const count = await client.revokeAgentGrants(input);
    deps.logger.info("mcp.grants_revoked", { agentId: input.agentId, count });
  } catch (error) {
    deps.logger.warn("mcp.revoke_failed", { agentId: input.agentId, error });
    if (!options.inline) throw error; // queue retry with backoff
    await deps.queue
      .send({ type: "mcp_revoke", ...input }, { delaySeconds: 30 })
      .catch((e: unknown) => {
        deps.logger.error("mcp.revoke_enqueue_failed", { error: e });
      });
  }
}
