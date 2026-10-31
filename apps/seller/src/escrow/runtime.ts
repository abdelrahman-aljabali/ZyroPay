/*
 * Escrow wiring shared by the HTTP app and the cron handler: whether the escrow route is on,
 * and the dependencies the sweeper / SubmitResult need.
 *
 * The escrow route needs SELLER_SIGNING_KEY (it signs the quotes and every seller spend)
 * and a valid escrow configuration; ESCROW_KV is optional (see store.ts).
 */
import { masumiEscrowAddress } from "@x402/cardano";
import type { Client } from "@evolution-sdk/evolution";
import type { Config } from "../config";
import { NETWORK } from "../config";
import type { SellerKey } from "../receipt";
import { loadSellerKey } from "../receipt";
import { EscrowChain, sellerClient } from "./chain";
import type { EscrowConfig, EscrowEnv } from "./config";
import { loadEscrowConfig } from "./config";
import type { SpendSeller } from "./spend";
import type { KvLike } from "./store";
import { EscrowStore } from "./store";
import type { SweepDeps } from "./sweeper";

let escrowAddressMemo: string | undefined;

/**
 * The vested_pay v2 escrow address on NETWORK. Computed on first use, not at module scope:
 * deriving it decodes and applies parameters to the 10 kB UPLC script, which costs hundreds
 * of ms of CPU (mostly GC) and would push the Worker over its startup limit.
 * @x402/cardano caches the script hash, so its own later derivations are cheap.
 */
export function escrowAddress(): string {
  return (escrowAddressMemo ??= masumiEscrowAddress(NETWORK));
}

export interface EscrowBindings extends EscrowEnv {
  readonly SELLER_SIGNING_KEY?: string;
  readonly ESCROW_KV?: KvLike;
}

export type EscrowRuntime =
  | {
      readonly enabled: true;
      readonly config: EscrowConfig;
      readonly key: SellerKey;
      readonly seller: SpendSeller;
      readonly store: EscrowStore;
      readonly chain: EscrowChain;
      /** Evolution client (built on first use: it is only needed to spend). */
      client(): Client.SigningClient;
      sweepDeps(): SweepDeps;
    }
  | { readonly enabled: false; readonly problems: readonly string[] };

export function escrowRuntime(env: EscrowBindings, base: Config): EscrowRuntime {
  const problems: string[] = [];
  const key = loadSellerKey(env.SELLER_SIGNING_KEY, base.payTo);
  if (!key.ok) problems.push(key.problem);
  const cfg = loadEscrowConfig(env);
  if (!cfg.ok) problems.push(...cfg.problems);
  // A hosted facilitator has no validator for this seller's registry claim and refuses it.
  else if (cfg.config.agentIdentifier !== null && base.facilitatorMode !== "embedded")
    problems.push('MASUMI_AGENT_IDENTIFIER needs FACILITATOR_MODE "embedded"');
  if (!key.ok || !cfg.ok || problems.length > 0) return { enabled: false, problems };

  const seller: SpendSeller = { ...key.key, address: base.payTo };
  const chain = new EscrowChain(base.blockfrostBaseUrl, base.blockfrostProjectId);
  const store = new EscrowStore(env.ESCROW_KV);
  let client: Client.SigningClient | null = null;
  const getClient = () =>
    (client ??= sellerClient(base.blockfrostBaseUrl, base.blockfrostProjectId, key.key.privateKey));
  return {
    enabled: true,
    config: cfg.config,
    key: key.key,
    seller,
    store,
    chain,
    client: getClient,
    sweepDeps: () => ({
      chain,
      client: getClient(),
      seller,
      store,
      config: cfg.config,
      escrowAddress: escrowAddress(),
    }),
  };
}
