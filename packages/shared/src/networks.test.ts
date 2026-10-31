import { describe, expect, it } from "vitest";
import {
  assertNetworkAllowedInMode,
  evmChainId,
  MAINNET_NETWORKS,
  NETWORK_IDS,
  NETWORKS,
  NetworkModeError,
  networkFromEvmChainId,
  networksForMode,
  sameEnvironment,
  TESTNET_NETWORKS,
} from "./networks";

describe("networks", () => {
  it("has the expected EVM chain ids", () => {
    expect(evmChainId("ethereum-mainnet")).toBe(1);
    expect(evmChainId("ethereum-sepolia")).toBe(11155111);
    expect(evmChainId("base-mainnet")).toBe(8453);
    expect(evmChainId("base-sepolia")).toBe(84532);
    expect(() => evmChainId("solana-mainnet")).toThrow();
    expect(networkFromEvmChainId(8453)).toBe("base-mainnet");
    expect(networkFromEvmChainId(999)).toBeUndefined();
  });
  it("partitions mainnets and testnets", () => {
    expect([...MAINNET_NETWORKS].sort()).toEqual([
      "base-mainnet",
      "cardano-mainnet",
      "ethereum-mainnet",
      "solana-mainnet",
    ]);
    expect([...TESTNET_NETWORKS].sort()).toEqual([
      "base-sepolia",
      "cardano-preprod",
      "ethereum-sepolia",
      "solana-devnet",
    ]);
  });
  it("counterparts are symmetric and cross the divide", () => {
    for (const id of NETWORK_IDS) {
      const other = NETWORKS[id].counterpart;
      expect(NETWORKS[other].counterpart).toBe(id);
      expect(sameEnvironment(id, other)).toBe(false);
      expect(NETWORKS[other].family).toBe(NETWORKS[id].family);
    }
  });
  it("modes never mix mainnet and testnet", () => {
    expect(networksForMode("production")).toEqual(MAINNET_NETWORKS);
    expect(networksForMode("development")).toEqual(TESTNET_NETWORKS);
    expect(() => assertNetworkAllowedInMode("solana-mainnet", "development")).toThrow(
      NetworkModeError,
    );
    expect(() => assertNetworkAllowedInMode("base-sepolia", "production")).toThrow(
      NetworkModeError,
    );
    expect(() => assertNetworkAllowedInMode("base-sepolia", "development")).not.toThrow();
  });
});
