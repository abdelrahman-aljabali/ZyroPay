import { checkPayToAddress } from "./address";
import { BLOCKFROST_PREPROD_BASE_URL } from "./blockfrost";
import type { EscrowEnv } from "./escrow/config";
import type { KvLike } from "./escrow/store";
import type { SubhireEnv } from "./subhire";

/** Worker bindings (wrangler vars and secrets). Every value is a string or absent. */
export interface Env extends EscrowEnv, SubhireEnv {
  readonly SELLER_ADDRESS?: string;
  readonly BLOCKFROST_PROJECT_ID?: string;
  readonly FACILITATOR_URL?: string;
  /** "embedded" (default): verify and settle in this worker; "hosted": FACILITATOR_URL. */
  readonly FACILITATOR_MODE?: string;
  readonly PRICE_LOVELACE?: string;
  readonly L1_CONFIRMATIONS?: string;
  /** Optional Blockfrost-compatible base URL (e.g. a proxy or Dolos). Default: Blockfrost preprod. */
  readonly BLOCKFROST_BASE_URL?: string;
  /**
   * Optional secret: the payment signing key of SELLER_ADDRESS (hex), used to sign delivery
   * receipts (src/receipt.ts), Masumi escrow quotes and the seller's escrow spends.
   * Absent: paid responses carry no receipt and the escrow route is off.
   */
  readonly SELLER_SIGNING_KEY?: string;
  /** "enabled" turns on the escrow route's `?demo=tamper|nodelivery` switch (src/demo.ts). */
  readonly DEMO_DISHONEST_MODE?: string;
  /** Optional KV namespace for escrow delivery records (src/escrow/store.ts). */
  readonly ESCROW_KV?: KvLike;
}

export const NETWORK = "cardano:preprod" as const;
export const ASSET = "lovelace";
export const DEFAULT_FACILITATOR_URL = "https://x402.preprod.dev.ecosyseng.cf-deployments.org";
const DEFAULT_PRICE_LOVELACE = "2000000";
/** A lovelace-only output below ~1 ADA fails the ledger's min-UTxO rule. */
const MIN_PRICE_LOVELACE = 1_000_000n;
/** Sanity ceiling so a typo cannot ask buyers for a fortune (100 tADA). */
const MAX_PRICE_LOVELACE = 100_000_000n;
export const MAX_TIMEOUT_SECONDS = 600;
/** The hosted facilitator advertises l1Confirmations 0..20. */
const MAX_L1_CONFIRMATIONS = 20;

export interface Config {
  readonly payTo: string;
  readonly blockfrostProjectId: string;
  readonly facilitatorMode: "embedded" | "hosted";
  readonly facilitatorUrl: string;
  readonly blockfrostBaseUrl: string;
  readonly priceLovelace: string;
  readonly l1Confirmations: number;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly problems: readonly string[] };

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** An https base URL (http only for localhost), no credentials/query; "" plus a problem if not. */
export function serviceUrl(
  raw: string | undefined,
  fallback: string,
  name: string,
  problems: string[],
): string {
  const value = raw?.trim() || fallback;
  try {
    const u = new URL(value);
    const okScheme = u.protocol === "https:" || (u.protocol === "http:" && isLocalHost(u.hostname));
    if (okScheme && u.username === "" && u.password === "" && u.search === "" && u.hash === "")
      return u.href.replace(/\/+$/, "");
  } catch {
    // reported below
  }
  problems.push(`${name} must be an https URL (http only for localhost), without credentials`);
  return "";
}

/**
 * Validate the bindings. Problems name the variable and the rule, never the value, so
 * they are safe to log and to show on the free info route.
 */
export function loadConfig(env: Env): ConfigResult {
  const problems: string[] = [];

  const payTo = checkPayToAddress(env.SELLER_ADDRESS);
  if (!payTo.ok) problems.push(payTo.reason);

  const projectId = env.BLOCKFROST_PROJECT_ID?.trim() ?? "";
  if (projectId === "") problems.push("BLOCKFROST_PROJECT_ID is not set");
  else if (!/^preprod[A-Za-z0-9]{8,64}$/.test(projectId))
    problems.push("BLOCKFROST_PROJECT_ID must be a preprod project id (starts with 'preprod')");

  const facilitatorUrl = serviceUrl(
    env.FACILITATOR_URL,
    DEFAULT_FACILITATOR_URL,
    "FACILITATOR_URL",
    problems,
  );
  const modeRaw = env.FACILITATOR_MODE?.trim() || "embedded";
  const facilitatorMode = modeRaw === "embedded" || modeRaw === "hosted" ? modeRaw : null;
  if (facilitatorMode === null) problems.push('FACILITATOR_MODE must be "embedded" or "hosted"');
  const blockfrostBaseUrl = serviceUrl(
    env.BLOCKFROST_BASE_URL,
    BLOCKFROST_PREPROD_BASE_URL,
    "BLOCKFROST_BASE_URL",
    problems,
  );

  const priceRaw = env.PRICE_LOVELACE?.trim() || DEFAULT_PRICE_LOVELACE;
  let priceLovelace = "";
  if (!/^[1-9][0-9]{0,15}$/.test(priceRaw)) {
    problems.push("PRICE_LOVELACE must be a positive integer number of lovelace");
  } else if (BigInt(priceRaw) < MIN_PRICE_LOVELACE) {
    problems.push("PRICE_LOVELACE must be >= 1000000 (1 tADA, the min-UTxO floor)");
  } else if (BigInt(priceRaw) > MAX_PRICE_LOVELACE) {
    problems.push("PRICE_LOVELACE must be <= 100000000 (100 tADA)");
  } else {
    priceLovelace = priceRaw;
  }

  const confRaw = env.L1_CONFIRMATIONS?.trim() || "0";
  const l1Confirmations = /^[0-9]{1,2}$/.test(confRaw) ? Number(confRaw) : -1;
  if (l1Confirmations < 0 || l1Confirmations > MAX_L1_CONFIRMATIONS)
    problems.push("L1_CONFIRMATIONS must be an integer from 0 to 20");

  if (problems.length > 0 || !payTo.ok || facilitatorMode === null) return { ok: false, problems };
  return {
    ok: true,
    config: {
      payTo: payTo.address.bech32,
      blockfrostProjectId: projectId,
      facilitatorMode,
      facilitatorUrl,
      blockfrostBaseUrl,
      priceLovelace,
      l1Confirmations,
    },
  };
}
