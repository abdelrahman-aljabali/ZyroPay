/**
 * Live READ-ONLY Helius checks for the key failover (nothing is signed or sent).
 *
 * Skipped unless LIVE_TESTS=1 and both keys are in the environment, e.g. from the repo root:
 *   LIVE_TESTS=1 node --env-file=.env.local node_modules/.bin/... or
 *   pnpm --filter @zyropay/blockchain test:live:helius   (with the keys exported in the shell)
 *
 * Keys are never printed: assertions and events only use key indexes.
 */
import type { WatchedAddress } from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import type { KeyFailoverEvent } from "../key-failover";
import { ApiKeyPool, HELIUS_HOSTS } from "../key-failover";
import { JsonRpcClient, resolveHttpOptions } from "../http";
import { rpcUrlFor } from "../networks";
import { createSolanaPortfolioProvider } from "../portfolio/solana";

const LIVE = process.env.LIVE_TESTS === "1";
const PRIMARY = process.env.HELIUS_API_KEY ?? "";
const SECONDARY = process.env.HELIUS_API_KEY_SECONDARY ?? "";
const T = 30_000;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const INVALID = "00000000-0000-4000-8000-000000000000";
/** Solana devnet faucet-style public address (any valid address works for a balance read). */
const PUBLIC_DEVNET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function genesis(keys: string[], events: KeyFailoverEvent[] = []) {
  const pool = new ApiKeyPool(keys, {
    provider: "helius",
    hosts: HELIUS_HOSTS,
    onEvent: (e) => events.push(e),
  });
  const http = resolveHttpOptions({ maxRetries: 0 });
  const rpc = new JsonRpcClient(
    rpcUrlFor("solana-devnet", { heliusApiKey: keys }),
    { ...http, fetch: pool.wrap(http.fetch) },
    "helius",
  );
  return rpc.call<string>("getGenesisHash", []);
}

describe.skipIf(!LIVE || PRIMARY === "" || SECONDARY === "")(
  "live: Helius devnet key failover",
  () => {
    it(
      "the configured list [primary, secondary] serves devnet whichever key is exhausted",
      async () => {
        const events: KeyFailoverEvent[] = [];
        await expect(genesis([PRIMARY, SECONDARY], events)).resolves.toBe(DEVNET_GENESIS);
        // Report (by index only) whether the primary had to be skipped on this run.
        console.info(
          "helius live: failover events",
          events.map((e) => ({ keyIndex: e.keyIndex, status: e.status, reason: e.reason })),
        );
        for (const e of events) expect(e.keyIndex).toBe(0);
        const reversed: KeyFailoverEvent[] = [];
        await expect(genesis([SECONDARY, PRIMARY], reversed)).resolves.toBe(DEVNET_GENESIS);
      },
      T,
    );

    it(
      "an invalid key (401) is skipped and the request still succeeds",
      async () => {
        const events: KeyFailoverEvent[] = [];
        await expect(genesis([INVALID, PRIMARY, SECONDARY], events)).resolves.toBe(DEVNET_GENESIS);
        expect(events[0]).toMatchObject({ keyIndex: 0, status: 401, reason: "unauthorized" });
      },
      T,
    );

    it(
      "DAS getAssetsByOwner reads a devnet balance through the key list",
      async () => {
        const address: WatchedAddress = {
          walletId: "00000000-0000-4000-8000-000000000001",
          network: "solana-devnet",
          address: PUBLIC_DEVNET,
        };
        const provider = createSolanaPortfolioProvider({
          heliusApiKey: [INVALID, PRIMARY, SECONDARY],
          network: "solana-devnet",
        });
        const snap = await provider.getSnapshot({ addresses: [address], currency: "USD" });
        expect(snap.stale).toBe(false);
        expect(snap.balances.length).toBeGreaterThan(0);
      },
      T,
    );
  },
);
