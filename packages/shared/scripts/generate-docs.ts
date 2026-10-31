import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { composeDoc, handWrittenPart, renderApiDocs, renderMcpDocs } from "./contract-docs";

const docs = fileURLToPath(new URL("../../../docs/", import.meta.url));

/** Regenerate the generated part; keep everything after `<!-- HAND-WRITTEN BELOW -->`. */
function write(name: string, generated: string): void {
  const path = `${docs}${name}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, composeDoc(generated, handWrittenPart(existing)));
}

write("API.md", renderApiDocs());
write("MCP.md", renderMcpDocs());
console.log(`wrote ${docs}API.md and ${docs}MCP.md (hand-written sections preserved)`);
