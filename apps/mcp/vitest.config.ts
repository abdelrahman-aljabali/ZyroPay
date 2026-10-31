import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // e2e files each boot workerd; keep them sequential to avoid port and CPU contention.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
