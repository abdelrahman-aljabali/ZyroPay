/**
 * Renders docs/API.md and docs/MCP.md from the Zod contracts, so docs cannot drift.
 * Regenerate with `pnpm --filter @zyropay/shared docs:generate`; a test fails if stale.
 */
import { z } from "zod";
import type { EndpointContract } from "../src/api/contracts";
import { api } from "../src/api/contracts";
import { apiExt } from "../src/api/ext";
import { apiWallets } from "../src/api/wallet-management";
import { mcpInternal } from "../src/api/internal";
import { ERROR_CODES, ERROR_HTTP_STATUS } from "../src/api/errors";
import { mcpDiscoveryTools, mcpTools } from "../src/mcp";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  format?: string;
  pattern?: string;
  description?: string;
  $ref?: string;
};

function toJson(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  return z.toJSONSchema(schema, { io, unrepresentable: "any", reused: "inline" }) as JsonSchema;
}

function typeLabel(s: JsonSchema): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" \\| ");
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map(typeLabel).join(" \\| ");
  if (s.type === "array") return `${s.items ? typeLabel(s.items) : "unknown"}[]`;
  if (Array.isArray(s.type)) return s.type.join(" \\| ");
  if (s.type === "string" && s.format) return `string (${s.format})`;
  if (s.type === "object" && s.properties) return "object";
  return s.type ?? (s.$ref ? "ref" : "unknown");
}

function fieldTable(title: string, schema: z.ZodType, io: "input" | "output"): string {
  const json = toJson(schema, io);
  const variants = json.anyOf ?? json.oneOf ?? [json];
  const blocks: string[] = [];
  variants.forEach((variant, i) => {
    const out: string[] = [];
    const props = variant.properties;
    const heading = variants.length > 1 ? `${title} (variant ${i + 1})` : title;
    if (!props || Object.keys(props).length === 0) {
      blocks.push(`**${heading}:** ${typeLabel(variant)}${props ? " (empty object)" : ""}`);
      return;
    }
    const required = new Set(variant.required ?? []);
    out.push(
      `**${heading}:**`,
      "",
      "| field | type | required | notes |",
      "| --- | --- | --- | --- |",
    );
    for (const [name, prop] of Object.entries(props)) {
      const notes = (prop.description ?? "").replace(/\|/g, "\\|");
      out.push(
        `| \`${name}\` | ${typeLabel(prop)} | ${required.has(name) ? "yes" : "no"} | ${notes} |`,
      );
    }
    blocks.push(out.join("\n"));
  });
  return blocks.join("\n\n");
}

const HEADER = (source: string) =>
  `<!-- GENERATED from ${source} by packages/shared/scripts/contract-docs.ts. Do not edit by hand. -->`;

function renderEndpoints(
  lines: string[],
  contracts: Readonly<Record<string, EndpointContract>>,
): void {
  lines.push("| name | method | path | auth |", "| --- | --- | --- | --- |");
  for (const [name, e] of Object.entries(contracts)) {
    lines.push(`| [${name}](#${name.toLowerCase()}) | ${e.method} | \`${e.path}\` | ${e.auth} |`);
  }
  for (const [name, e] of Object.entries(contracts)) {
    lines.push(
      "",
      `### ${name}`,
      "",
      `\`${e.method} ${e.path}\` (auth: ${e.auth}${e.idempotent === true ? ", idempotent" : ""})`,
      "",
      e.summary,
      "",
    );
    if (e.params !== undefined) lines.push(fieldTable("Path params", e.params, "input"), "");
    if (e.query !== undefined) lines.push(fieldTable("Query", e.query, "input"), "");
    if (e.body !== undefined) lines.push(fieldTable("Body", e.body, "input"), "");
    lines.push(fieldTable("Response 2xx", e.response, "output"));
  }
}

export function renderApiDocs(): string {
  const lines: string[] = [
    "# ZyroPay REST API",
    "",
    HEADER("packages/shared/src/api/{contracts,ext,wallet-management,internal}.ts"),
    "",
    "Source of truth: `api`, `apiExt`, `apiWallets` and `mcpInternal` in `@zyropay/shared`. Field tables show top-level fields only; see the Zod schemas for nested shapes and constraints.",
    "",
    "Auth: `user` = app session bearer token; `internal` = `INTERNAL_SERVICE_TOKEN` (service to service only); `webhook` = provider signature; `none` = public.",
    "",
    'Amounts are base-unit integer strings plus `decimals`. Errors always have the shape `{ "error": { "code", "message", "details?" } }`.',
    "",
    "## Endpoints",
    "",
  ];
  renderEndpoints(lines, api);
  lines.push(
    "",
    "## Additive endpoints (`apiExt`)",
    "",
    "Served by the API next to `api`: delegated signer lifecycle, chain webhooks and the MCP audit sink.",
    "",
  );
  renderEndpoints(lines, apiExt);
  lines.push(
    "",
    "## Wallet management (`apiWallets`)",
    "",
    "Served by the API next to `api`: link a wallet the app created with the passkey, rename, remove (unlink; keys stay in Turnkey) and read-only watch wallets. Watch wallets never sign, send or reach agents.",
    "",
  );
  renderEndpoints(lines, apiWallets);
  lines.push(
    "",
    "## Served by the MCP worker (`mcpInternal`)",
    "",
    "Called by the API over the `MCP` service binding (or `MCP_INTERNAL_URL` in local development).",
    "",
  );
  renderEndpoints(lines, mcpInternal);
  lines.push("", "## Error codes", "", "| code | HTTP status |", "| --- | --- |");
  for (const code of ERROR_CODES) lines.push(`| \`${code}\` | ${ERROR_HTTP_STATUS[code]} |`);
  return lines.join("\n") + "\n";
}

export function renderMcpDocs(): string {
  const lines: string[] = [
    "# ZyroPay MCP tools",
    "",
    HEADER("packages/shared/src/mcp.ts"),
    "",
    "Source of truth: `mcpTools` and `mcpDiscoveryTools` in `@zyropay/shared`. The MCP server registers exactly these tools with exactly these schemas. It never signs: value-moving tools create transaction requests through `POST /internal/v1/agents/:agentId/transaction-requests` and return the request state (often `PENDING_APPROVAL`; poll with `get_approval_status`).",
    "",
    "| tool | moves value |",
    "| --- | --- |",
  ];
  const all = { ...mcpTools, ...mcpDiscoveryTools };
  for (const [name, t] of Object.entries(all)) {
    lines.push(`| [\`${name}\`](#${name}) | ${t.valueMoving ? "yes" : "no"} |`);
  }
  lines.push(
    "",
    "`find_agents` and `verify_agent` (`mcpDiscoveryTools`) read the public Masumi agent registry on Cardano. They are not policy tools (`allowedTools`): every active agent with the read scope may call them.",
  );
  for (const [name, t] of Object.entries(all)) {
    lines.push(
      "",
      `## ${name}`,
      "",
      t.description,
      "",
      fieldTable("Input", t.input, "input"),
      "",
      fieldTable("Output", t.output, "output"),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * docs/API.md and docs/MCP.md = generated part, a blank line, this marker, then free-form
 * hand-written material that the generator preserves and docs.test.ts ignores.
 */
export const HAND_WRITTEN_MARKER = "<!-- HAND-WRITTEN BELOW -->";

/** The generated part of a doc file (everything before the marker's preceding blank line). */
export function generatedPart(file: string): string {
  const index = file.indexOf(`\n${HAND_WRITTEN_MARKER}`);
  return index < 0 ? file : file.slice(0, index);
}

/** The hand-written part of a doc file (after the marker line), or "" without a marker. */
export function handWrittenPart(file: string): string {
  const index = file.indexOf(`\n${HAND_WRITTEN_MARKER}`);
  if (index < 0) return "";
  const rest = file.slice(index + 1 + HAND_WRITTEN_MARKER.length);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

/** Generated text plus the preserved hand-written section. */
export function composeDoc(generated: string, handWritten: string): string {
  if (handWritten.trim() === "") return generated;
  return `${generated}\n${HAND_WRITTEN_MARKER}\n${handWritten}`;
}
