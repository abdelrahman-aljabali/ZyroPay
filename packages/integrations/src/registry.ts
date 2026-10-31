import { ChainError } from "@zyropay/blockchain";
import type { NetworkId, PluginAdapter, ZyroPayMode } from "@zyropay/shared";
import { isNetworkAllowedInMode } from "@zyropay/shared";

export interface PluginRegistryOptions {
  readonly mode: ZyroPayMode;
  /** Allow adapters whose manifest status is "coming_soon" (Kamino, Aave, Hyperliquid). Default false. */
  readonly enableComingSoon?: boolean;
}

export interface PluginRegistry {
  list(): readonly PluginAdapter[];
  get(id: string): PluginAdapter | undefined;
  /**
   * The adapter for a value-moving action, or a ChainError: PLUGIN_DISABLED (unknown, not
   * available, action not in the manifest, mock in production), NETWORK_MODE_MISMATCH (network
   * outside this deployment's mode) or NETWORK_NOT_SUPPORTED (not a manifest network).
   */
  require(id: string, input: { network: NetworkId; action: string }): PluginAdapter;
}

function isSimulated(adapter: PluginAdapter): boolean {
  return (adapter as { simulated?: unknown }).simulated === true;
}

export function createPluginRegistry(
  adapters: readonly PluginAdapter[],
  options: PluginRegistryOptions,
): PluginRegistry {
  const byId = new Map<string, PluginAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.manifest.id)) throw new Error(`duplicate plugin ${adapter.manifest.id}`);
    if (options.mode === "production" && isSimulated(adapter)) {
      throw new Error(`mock plugin ${adapter.manifest.id} cannot be registered in production mode`);
    }
    byId.set(adapter.manifest.id, adapter);
  }
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
    require(id, { network, action }) {
      const adapter = byId.get(id);
      if (adapter === undefined)
        throw new ChainError("PLUGIN_DISABLED", `plugin ${id} is not installed`);
      const m = adapter.manifest;
      if (m.status !== "available" && options.enableComingSoon !== true) {
        throw new ChainError("PLUGIN_DISABLED", `plugin ${id} is not available yet`);
      }
      if (!m.tools.some((t) => t.name === action))
        throw new ChainError("PLUGIN_DISABLED", `plugin ${id} has no action ${action}`);
      if (!isNetworkAllowedInMode(network, options.mode)) {
        throw new ChainError(
          "NETWORK_MODE_MISMATCH",
          `${network} is not available in ${options.mode} mode`,
        );
      }
      if (!m.networks.includes(network))
        throw new ChainError("NETWORK_NOT_SUPPORTED", `plugin ${id} does not support ${network}`);
      return adapter;
    },
  };
}
