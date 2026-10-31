import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeDoc,
  generatedPart,
  handWrittenPart,
  HAND_WRITTEN_MARKER,
  renderApiDocs,
  renderMcpDocs,
} from "../scripts/contract-docs";
import { PLUGIN_REGISTRY } from "./plugins";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");

describe("generated docs and env are in sync with the contracts", () => {
  it("docs/API.md is up to date (pnpm --filter @zyropay/shared docs:generate)", () => {
    expect(generatedPart(read("docs/API.md"))).toBe(renderApiDocs());
  });
  it("docs/MCP.md is up to date (pnpm --filter @zyropay/shared docs:generate)", () => {
    expect(generatedPart(read("docs/MCP.md"))).toBe(renderMcpDocs());
  });
  it("the hand-written section after the marker is ignored and preserved", () => {
    const generated = "# Title\n\n| a |\n";
    const doc = composeDoc(generated, "## Notes\n\nfree text\n");
    expect(doc).toBe(`# Title\n\n| a |\n\n${HAND_WRITTEN_MARKER}\n## Notes\n\nfree text\n`);
    expect(generatedPart(doc)).toBe(generated);
    expect(handWrittenPart(doc)).toBe("## Notes\n\nfree text\n");
    expect(generatedPart(generated)).toBe(generated);
    expect(handWrittenPart(generated)).toBe("");
    expect(composeDoc(generated, "")).toBe(generated);
  });
  it("every plugin config env var is listed in .env.example", () => {
    const env = read(".env.example");
    for (const plugin of PLUGIN_REGISTRY) {
      for (const req of plugin.configRequirements) {
        expect(env, `${plugin.id}: ${req.envVar}`).toMatch(new RegExp(`^${req.envVar}=`, "m"));
      }
    }
  });
});
