import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // Every file boots PGlite (WASM + Postgres) per worker. More than a few at once only
    // adds CPU and memory contention (and `pnpm check` runs tsc and eslint alongside).
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
