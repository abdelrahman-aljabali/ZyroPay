import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The escrow round trips build and evaluate Plutus spends in process; under the parallel
    // root `pnpm check` one can pass 5 s (standalone ~1 s). Same budget as mcp and blockchain.
    testTimeout: 30_000,
  },
});
