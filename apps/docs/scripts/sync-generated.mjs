#!/usr/bin/env node
/*
 * Renders the generated contract references into the site, unchanged in substance:
 *
 *   docs/API.md  -> src/content/docs/reference/rest-api.md
 *   docs/MCP.md  -> src/content/docs/reference/mcp.md
 *
 * docs/API.md and docs/MCP.md are generated from packages/shared (contract-docs.ts) and are
 * never edited by hand, so the site copies them on every build instead of keeping its own
 * version. This script only adds frontmatter, drops the H1 (Starlight renders the title) and
 * points repo-relative links at the matching docs page. The outputs are git-ignored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = fileURLToPath(new URL("../src/content/docs/reference/", import.meta.url));

/** Repo docs that have a page on this site. */
const PAGES = {
  "API.md": "/reference/rest-api/",
  "MCP.md": "/reference/mcp/",
  "ARCHITECTURE.md": "/architecture/decisions/",
  "SECURITY.md": "/security/",
  "CARDANO_X402.md": "/how-it-works/x402/",
  "DEPLOY.md": "/operations/deploy/",
  "SETUP.md": "/operations/local/",
  "INTEGRATIONS.md": "/architecture/",
  "IMPLEMENTATION_STATUS.md": "/evidence/coverage/",
};

const SOURCES = [
  {
    from: "docs/API.md",
    to: "rest-api.md",
    title: "REST and internal API",
    description:
      "Every ZyroPay API endpoint: the app's REST API, the internal API the MCP worker calls, error codes and implementation notes. Generated from @zyropay/shared.",
  },
  {
    from: "docs/MCP.md",
    to: "mcp.md",
    title: "MCP tools",
    description:
      "The ten tools ZyroPay's MCP server exposes, their exact input and output schemas, and the server guide: OAuth, transport, security model, connectors.",
  },
];

for (const src of SOURCES) {
  let md = readFileSync(join(ROOT, src.from), "utf8");
  // Starlight renders the page title as the H1.
  md = md.replace(/^# .*\n+/, "");
  // Repo-relative doc links -> the page on this site; anything else -> plain code.
  md = md.replace(/\[([^\]]+)\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_m, text, target) => {
    const [file, anchor] = String(target).split("#");
    const name = String(file).split("/").pop() ?? "";
    const page = PAGES[name];
    if (page === undefined) return text;
    if (page === PAGES[src.from.split("/").pop() ?? ""])
      return anchor ? `[${text}](#${anchor})` : text;
    return `[${text}](${page})`;
  });
  const front = [
    "---",
    `title: ${JSON.stringify(src.title)}`,
    `description: ${JSON.stringify(src.description)}`,
    "editUrl: false",
    "---",
    "",
    ":::note[Generated reference]",
    `This page is \`${src.from}\`, generated from the Zod contracts in \`packages/shared\` by \`pnpm --filter @zyropay/shared docs:generate\`. A test fails when it is stale, so it always matches the code.`,
    ":::",
    "",
  ].join("\n");
  writeFileSync(join(OUT, src.to), front + md);
}
console.log(`sync-generated: ${SOURCES.map((s) => s.to).join(", ")} written`);
