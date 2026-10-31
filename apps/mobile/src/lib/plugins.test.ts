import { getPluginManifest } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ApiClient } from "@/api/client";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import { offersSwap, swapUnavailableReason } from "./plugins";

const SWAP_ON_DEVNET =
  "Swaps are available on Solana mainnet only. This wallet is on Solana Devnet (test network), so no swap can be made.";

describe("swaps on test networks", () => {
  it("explains that swaps are Solana mainnet only in a development (testnet) build", () => {
    expect(swapUnavailableReason("development")).toBe(SWAP_ON_DEVNET);
    expect(swapUnavailableReason("production")).toBeNull();
  });

  it("knows which plugin offers swaps", () => {
    expect(offersSwap(getPluginManifest("jupiter")!)).toBe(true);
    expect(offersSwap(getPluginManifest("x402")!)).toBe(false);
  });

  it("mock mode never offers a simulated swap: Jupiter is not configured and cannot be enabled", async () => {
    resetMockState();
    const client = new ApiClient({
      transport: mockTransport({ latencyMs: 0 }),
      getAccessToken: () => "tok",
    });
    const { plugins } = await client.call("listPlugins", {});
    expect(plugins.find((p) => p.manifest.id === "jupiter")?.configured).toBe(false);
    expect(plugins.find((p) => p.manifest.id === "x402")?.configured).toBe(true);
    await expect(
      client.call("setPluginEnabled", { params: { pluginId: "jupiter" }, body: { enabled: true } }),
    ).rejects.toMatchObject({ code: "PLUGIN_DISABLED" });
  });
});
