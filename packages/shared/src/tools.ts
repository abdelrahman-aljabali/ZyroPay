import { z } from "zod";

/** Every MCP tool the ZyroPay MCP server exposes. */
export const MCP_TOOL_NAMES = [
  "get_balance",
  "get_wallets",
  "get_transactions",
  "send",
  "swap",
  "pay_x402",
  "get_approval_status",
  "get_agent_policy",
] as const;
export const McpToolNameSchema = z.enum(MCP_TOOL_NAMES);
export type McpToolName = z.infer<typeof McpToolNameSchema>;

/** Tools that move value and therefore create transaction requests. */
export const VALUE_MOVING_TOOLS = [
  "send",
  "swap",
  "pay_x402",
] as const satisfies readonly McpToolName[];
export type ValueMovingTool = (typeof VALUE_MOVING_TOOLS)[number];

export function isValueMovingTool(tool: McpToolName): tool is ValueMovingTool {
  return (VALUE_MOVING_TOOLS as readonly McpToolName[]).includes(tool);
}

/** Origin of a transaction request: an MCP tool, or a user action in the mobile app. */
export const RequestSourceSchema = z.enum(["app_send", ...VALUE_MOVING_TOOLS]);
export type RequestSource = z.infer<typeof RequestSourceSchema>;
