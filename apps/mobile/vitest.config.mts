import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests cover pure modules (API client, mock transport, stores, validation).
// Screens are covered by the Maestro flows in tests/e2e (need a simulator/device).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
