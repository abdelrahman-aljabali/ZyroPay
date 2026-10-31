import type { CanonicalTransactionPayload, NetworkId } from "@zyropay/shared";
import { createCanonicalPayload, nativeAssetId, tokenAssetId } from "@zyropay/shared";
import { SOLANA_DEVNET_GENESIS } from "../testing";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../solana/constants";

export const SOL_FROM = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const SOL_TO = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
export const BLOCKHASH_2 = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const EVM_FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const EVM_TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
/** Hardhat/anvil account #0 private key: public test key, never funded on any real chain. */
export const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function payload(
  overrides: Partial<CanonicalTransactionPayload> & { network: NetworkId },
): CanonicalTransactionPayload {
  const isSolana = overrides.network.startsWith("solana");
  return createCanonicalPayload({
    version: 1,
    from: isSolana ? SOL_FROM : EVM_FROM,
    to: isSolana ? SOL_TO : EVM_TO,
    asset: {
      id: nativeAssetId(overrides.network),
      kind: "native",
      decimals: isSolana ? 9 : 18,
    },
    amount: "1000000",
    feeCap: isSolana ? "100000" : "1000000000000000",
    plugin: null,
    tool: "app_send",
    pluginData: null,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "idem-key-0001",
    ...overrides,
  });
}

export function splPayload(
  overrides: Partial<CanonicalTransactionPayload> = {},
): CanonicalTransactionPayload {
  return payload({
    network: "solana-devnet",
    asset: { id: tokenAssetId("solana-devnet", DEVNET_USDC), kind: "spl", decimals: 6 },
    amount: "2500000",
    ...overrides,
  });
}

interface SolanaRpcState {
  genesis?: string;
  existing?: Record<string, string>; // address -> owner program
  mint?: { program?: string; decimals?: number; extensions?: unknown[] } | null;
  unitsConsumed?: number;
  simulateErr?: unknown;
  fees?: number[];
  blockhashes?: string[];
  blockHeight?: number[];
}

/** JSON-RPC fixtures for a devnet node. */
export function solanaRpcFixtures(state: SolanaRpcState = {}): Record<string, unknown> {
  const blockhashes = state.blockhashes ?? [BLOCKHASH];
  let bh = 0;
  const heights = state.blockHeight ?? [1000];
  let hi = 0;
  return {
    getGenesisHash: state.genesis ?? SOLANA_DEVNET_GENESIS,
    getLatestBlockhash: () => ({
      context: { slot: 1 },
      value: {
        blockhash: blockhashes[Math.min(bh++, blockhashes.length - 1)],
        lastValidBlockHeight: 1150 + bh,
      },
    }),
    getBlockHeight: () => heights[Math.min(hi++, heights.length - 1)],
    getRecentPrioritizationFees: () =>
      (state.fees ?? [0, 1000, 5000, 20000]).map((f, i) => ({ slot: i, prioritizationFee: f })),
    getMinimumBalanceForRentExemption: 2039280,
    simulateTransaction: () => ({
      context: { slot: 1 },
      value: {
        err: state.simulateErr ?? null,
        logs: ["Program 11111111111111111111111111111111 success"],
        unitsConsumed: state.unitsConsumed ?? 4000,
      },
    }),
    getAccountInfo: (params: unknown) => {
      const [address, opts] = params as [string, { encoding: string }];
      if (opts.encoding === "jsonParsed") {
        if (state.mint === null) return { context: { slot: 1 }, value: null };
        return {
          context: { slot: 1 },
          value: {
            owner: state.mint?.program ?? TOKEN_PROGRAM,
            lamports: 1461600,
            executable: false,
            data: {
              program: "spl-token",
              parsed: {
                type: "mint",
                info: {
                  decimals: state.mint?.decimals ?? 6,
                  supply: "1000000000000",
                  isInitialized: true,
                  ...(state.mint?.extensions !== undefined
                    ? { extensions: state.mint.extensions }
                    : {}),
                },
              },
              space: 82,
            },
          },
        };
      }
      const owner = state.existing?.[address];
      return {
        context: { slot: 1 },
        value:
          owner === undefined
            ? null
            : { owner, lamports: 2039280, executable: false, data: ["", "base64"] },
      };
    },
  };
}

export { TOKEN_2022_PROGRAM, TOKEN_PROGRAM };
