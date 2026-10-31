import { z } from "zod";

/** Read wallets, balances, history, policy and request status. */
export const SCOPE_READ = "wallet:read";
/** Create transaction requests (send / swap / pay_x402); the API's policy still decides. */
export const SCOPE_PAYMENTS = "payments:request";
const SCOPE_OFFLINE = "offline_access";

/** Everything this authorization server can grant (RFC 8414 scopes_supported). */
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_PAYMENTS, SCOPE_OFFLINE];
/** Baseline every MCP session needs (RFC 9728 scopes_supported / 401 challenge). */
export const REQUIRED_SCOPES = [SCOPE_READ, SCOPE_PAYMENTS];

/**
 * The consent decision happens in the app and is all-or-nothing (the app then narrows
 * the agent's POLICY, which is the real authority). The grant therefore always carries
 * the baseline scopes, plus offline_access when the client asked for refresh tokens.
 */
export function scopesToGrant(requested: readonly string[]): string[] {
  return requested.includes(SCOPE_OFFLINE)
    ? [...REQUIRED_SCOPES, SCOPE_OFFLINE]
    : [...REQUIRED_SCOPES];
}

/** What completeAuthorization stores as `props` (encrypted at rest by the provider). */
export const GrantPropsSchema = z.object({
  userId: z.uuid(),
  agentId: z.uuid(),
  connectionId: z.uuid(),
});
export type GrantProps = z.infer<typeof GrantPropsSchema>;
