import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // chain.test.ts drives three workers' code in process; under the parallel root
    // `pnpm check` it can pass 5 s (standalone ~1 s). Same budget as mcp and blockchain.
    testTimeout: 30_000,
  },
});
