// Shared helpers for register-agent.ts and status.ts. Pure functions are exported for tests
// (apps/sokosumi-agent/masumi-lib.test.ts). Erasable TypeScript only, so `node scripts/x.ts` (Node 24 type stripping) and
// `tsx` both run it.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NETWORK = "Preprod";
/** Masumi V2 escrow (vested_pay) on preprod, the default V2 source of Payment Service 0.29.0. */
export const PREPROD_V2_ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
/** Registry V2 minting policy on preprod. agentIdentifier = this policy id + a 32-byte asset name. */
export const REGISTRY_V2_POLICY_PREPROD =
  "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";
/** Preprod tUSDM (policy id + asset name), 6 decimals. Sokosumi lists only USDM/tUSDM pricing. */
export const TUSDM = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
const DEFAULT_API_BASE_URL = "https://masumi-agent.zyropay.online";
/** Registration mint fee + the NFT's min-UTxO + a 5 ADA collateral UTxO for result submissions. */
export const MIN_SELLING_LOVELACE = 10_000_000n;

const here = dirname(fileURLToPath(import.meta.url));
const MASUMI_DIR = resolve(here, "..");
export const LOCAL_DIR = join(MASUMI_DIR, ".local");
export const AGENT_DIR = resolve(MASUMI_DIR, "../../apps/sokosumi-agent");
export const STATE_FILE = join(LOCAL_DIR, "registration.json");
export const RUNTIME_ENV_FILE = join(LOCAL_DIR, "mps-runtime.env");
export const WORKER_SECRETS_FILE = join(LOCAL_DIR, "mip003.secrets.json");

export interface Config {
  mpsUrl: string;
  adminKey: string;
  apiBaseUrl: string;
  authorName: string;
  authorEmail: string | undefined;
  priceUnits: string;
  publicMpsUrl: string | undefined;
  blockfrostKey: string | undefined;
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const priceTusdm = (env.AGENT_PRICE_TUSDM ?? "1").trim();
  if (!/^\d+(\.\d{1,6})?$/u.test(priceTusdm) || Number(priceTusdm) <= 0)
    throw new Error("AGENT_PRICE_TUSDM must be a positive amount with at most 6 decimals");
  const [whole, fraction = ""] = priceTusdm.split(".");
  return {
    mpsUrl: (env.MPS_URL?.trim() || `http://127.0.0.1:${env.MPS_PORT?.trim() || "3001"}`).replace(
      /\/+$/u,
      "",
    ),
    adminKey: env.ADMIN_KEY?.trim() ?? "",
    apiBaseUrl: (env.AGENT_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/u, ""),
    authorName: env.AGENT_AUTHOR_NAME?.trim() ?? "",
    authorEmail: env.AGENT_AUTHOR_EMAIL?.trim() || undefined,
    priceUnits: (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString(),
    publicMpsUrl: env.PUBLIC_MPS_URL?.trim().replace(/\/+$/u, "") || undefined,
    blockfrostKey: env.BLOCKFROST_API_KEY_PREPROD?.trim() || undefined,
  };
}

export interface RegistrationInput {
  apiBaseUrl: string;
  authorName: string;
  authorEmail?: string;
  sellingWalletVkey: string;
  escrowAddress: string;
  priceUnits: string;
}

/**
 * POST /api/v1/registry body (Payment Service 0.29.0, V2). Fixed 1 tUSDM on the V2 source:
 * Sokosumi's catalog hides Dynamic-priced V2 agents, and the node then rejects RequestedFunds.
 */
export function buildRegistration(input: RegistrationInput) {
  if (!input.authorName) throw new Error("AGENT_AUTHOR_NAME must be set (your name or team name)");
  if (!/^https:\/\/[^/\s]+(\/[^\s]*)?$/u.test(input.apiBaseUrl))
    throw new Error("AGENT_API_BASE_URL must be a public https URL (the MIP-003 Worker)");
  if (!/^[0-9a-f]{56}$/u.test(input.sellingWalletVkey))
    throw new Error("Selling wallet vkey must be a 56-character hex key hash");
  const description =
    "Deterministic risk report on a Cardano preprod address: balance, tokens, activity, stake and code-computed risk flags with a 0-100 caution score. Data: Blockfrost.";
  return {
    network: NETWORK,
    type: "Standard",
    name: "Cardano Address Intelligence",
    description,
    apiBaseUrl: input.apiBaseUrl,
    sellingWalletVkey: input.sellingWalletVkey,
    Capability: { name: "cardano-address-intel", version: "1.0.0" },
    Author: {
      name: input.authorName,
      organization: "ZyroPay",
      ...(input.authorEmail ? { contactEmail: input.authorEmail } : {}),
    },
    Tags: ["cardano", "preprod", "address-risk", "due-diligence", "blockfrost", "x402"],
    ExampleOutputs: [
      {
        name: "Demo input and output",
        url: `${input.apiBaseUrl}/demo`,
        mimeType: "application/json",
      },
    ],
    Legal: { other: "Caution score from public preprod chain data. Not a fraud verdict." },
    supportedPaymentSources: [
      {
        chain: "Cardano",
        network: NETWORK,
        paymentSourceType: "Web3CardanoV2",
        address: input.escrowAddress,
        pricing: { pricingType: "Fixed", fixed: [{ asset: TUSDM, amount: input.priceUnits }] },
      },
    ],
  };
}

/** Wallet-scoped ReadAndPay key for the MIP-003 Worker and the Coworker (template body). */
export function runtimeKeyBody(sellingWalletId: string) {
  return {
    usageLimited: "false",
    UsageCredits: [],
    NetworkLimit: [NETWORK],
    ChainIdLimit: [],
    canRead: true,
    canPay: true,
    canAdmin: false,
    walletScopeEnabled: true,
    WalletScopeHotWalletIds: [sellingWalletId],
    x402WalletScopeEnabled: true,
    X402WalletScopeEvmWalletIds: [],
  };
}

class NodeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createNodeClient({
  url,
  token,
  fetchImpl = (input, init) => fetch(input, init),
}: {
  url: string;
  token: string;
  fetchImpl?: FetchLike;
}) {
  return async function request<T = any>(
    path: string,
    { query, body }: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const search = query ? `?${new URLSearchParams(query)}` : "";
    let response: Response;
    try {
      response = await fetchImpl(`${url}/api/v1${path}${search}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { token, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new NodeError(
        `Payment Service not reachable at ${url} (${(error as Error).message}). Is \`docker compose up -d\` running?`,
        0,
      );
    }
    const data: any = await response.json().catch(() => null);
    if (!response.ok || data?.status !== "success") {
      const detail = data?.error?.message ?? data?.message ?? JSON.stringify(data ?? {});
      throw new NodeError(
        `${path} HTTP ${response.status}: ${String(detail).slice(0, 400)}`,
        response.status,
      );
    }
    return data.data as T;
  };
}

export interface PaymentSource {
  id: string;
  network: string;
  paymentSourceType: string;
  smartContractAddress: string;
  policyId: string | null;
}

export function findV2Source(sources: PaymentSource[]): PaymentSource {
  const v2 = sources.filter(
    (s) => s.network === NETWORK && s.paymentSourceType === "Web3CardanoV2",
  );
  const source = v2.find((s) => s.smartContractAddress === PREPROD_V2_ESCROW) ?? v2[0];
  if (!source)
    throw new Error(
      "No Preprod Web3CardanoV2 payment source. The seed did not run: check `docker logs zyropay-masumi-payment-setup`.",
    );
  return source;
}

export interface Wallet {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
}

export function pickSellingWallet(wallets: Wallet[], vkey?: string): Wallet {
  const wallet = vkey ? wallets.find((w) => w.walletVkey === vkey) : wallets[0];
  if (!wallet)
    throw new Error(
      vkey ? `No selling wallet with vkey ${vkey}` : "The V2 source has no selling wallet",
    );
  return wallet;
}

export function amountOf(
  balance: { unit: string; quantity: number | string }[],
  unit: string,
): bigint {
  const wanted = unit === "lovelace" ? ["", "lovelace"] : [unit];
  return balance
    .filter((b) => wanted.includes(b.unit))
    .reduce((sum, b) => sum + BigInt(b.quantity), 0n);
}

export const ada = (lovelace: bigint) =>
  `${lovelace / 1_000_000n}.${String(lovelace % 1_000_000n).padStart(6, "0")}`;

export interface RegistryEntry {
  id: string;
  name: string;
  apiBaseUrl: string | null;
  state: string;
  agentIdentifier: string | null;
  error: string | null;
  supportedPaymentSources: { address: string; paymentSourceType?: string }[] | null;
  SmartContractWallet: { walletVkey: string; walletAddress: string };
  CurrentTransaction: { txHash: string | null; status: string } | null;
}

/** Live (or in-flight) registrations that would make a new mint a duplicate. */
const LIVE_STATES = new Set([
  "RegistrationRequested",
  "RegistrationInitiated",
  "RegistrationConfirmed",
  "UpdateRequested",
  "UpdateInitiated",
  "UpdateConfirmed",
  "UpdateFailed",
]);

export function findExisting(
  assets: RegistryEntry[],
  { id, name, apiBaseUrl, vkey }: { id?: string; name: string; apiBaseUrl: string; vkey: string },
): RegistryEntry | undefined {
  if (id) return assets.find((a) => a.id === id);
  return assets.find(
    (a) =>
      a.name === name &&
      a.apiBaseUrl?.replace(/\/+$/u, "") === apiBaseUrl &&
      a.SmartContractWallet?.walletVkey === vkey &&
      LIVE_STATES.has(a.state),
  );
}

export const isConfirmed = (e: RegistryEntry) =>
  (e.state === "RegistrationConfirmed" || e.state === "UpdateConfirmed") &&
  Boolean(e.agentIdentifier);
export const isFailed = (e: RegistryEntry) => e.state === "RegistrationFailed";

/** Index of our escrow address in the registration's supportedPaymentSources (0 for ours). */
export function sourceIndexOf(entry: RegistryEntry, escrowAddress: string): number {
  const index = (entry.supportedPaymentSources ?? []).findIndex((s) => s.address === escrowAddress);
  return index < 0 ? 0 : index;
}

/** The quick-tunnel URL from `docker logs zyropay-masumi-tunnel` (the last one printed). */
export function parseTunnelUrl(log: string): string | undefined {
  const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gu);
  return matches?.at(-1);
}

/** The two files apps/sokosumi-agent/paid-task.mjs reads (template format plus pricingType). */
export function agentStateFiles(state: {
  sourceId: string;
  walletId: string;
  sellerAddress: string;
  sellerVkey: string;
  registrationId: string;
  entry: RegistryEntry;
  supportedPaymentSourceIndex: number;
}) {
  return {
    payment: {
      sourceId: state.sourceId,
      walletId: state.walletId,
      sellerAddress: state.sellerAddress,
    },
    registration: {
      provenance: "VERIFIED",
      sourceId: state.sourceId,
      walletId: state.walletId,
      registrationId: state.registrationId,
      registration: state.entry,
      registrationState:
        state.entry.state === "UpdateConfirmed" ? "RegistrationConfirmed" : state.entry.state,
      agentIdentifier: state.entry.agentIdentifier,
      supportedPaymentSourceIndex: state.supportedPaymentSourceIndex,
      sellerVkey: state.sellerVkey,
      pricingType: "Fixed",
    },
  };
}

export interface Availability {
  ok: boolean;
  detail: string;
}

/** The registry's own health rule: 200 JSON with type "masumi-agent", no redirect. */
export async function probeAvailability(
  apiBaseUrl: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<Availability> {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/availability`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body: any = await response.json();
    if (body?.type !== "masumi-agent")
      return { ok: false, detail: `type is ${JSON.stringify(body?.type)}` };
    return { ok: true, detail: `${body.status}${body.message ? `: ${body.message}` : ""}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
