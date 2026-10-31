// Registers Cardano Address Intelligence on the Masumi registry (Preprod) through your own
// Payment Service, and writes everything the MIP-003 Worker and the Coworker paid path need.
//
//   register-agent all        key + register + secrets (what the README runs)
//   register-agent check      read-only: node, V2 source, selling wallet, balance, Worker URL
//   register-agent key        wallet-scoped ReadAndPay key -> .local/mps-runtime.env (600)
//   register-agent register   POST /registry, then poll until agentIdentifier exists
//   register-agent secrets    .local/mip003.secrets.json for `wrangler secret bulk`
//
// Every write first saves a "pending" marker in .local/registration.json. A write whose outcome
// is unknown is never repeated automatically: the script stops and says what to inspect.
// Config: infrastructure/masumi/.env (README). Run via
//   pnpm --filter @zyropay/sokosumi-agent masumi:register [command]
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  AGENT_DIR,
  LOCAL_DIR,
  MIN_SELLING_LOVELACE,
  NETWORK,
  RUNTIME_ENV_FILE,
  STATE_FILE,
  TUSDM,
  WORKER_SECRETS_FILE,
  ada,
  agentStateFiles,
  amountOf,
  buildRegistration,
  createNodeClient,
  findExisting,
  findV2Source,
  isConfirmed,
  isFailed,
  parseTunnelUrl,
  pickSellingWallet,
  probeAvailability,
  readConfig,
  runtimeKeyBody,
  sourceIndexOf,
  type PaymentSource,
  type RegistryEntry,
  type Wallet,
} from "./lib.ts";

const POLL_MS = 20_000;
const POLL_LIMIT_MS = 30 * 60_000;

const config = readConfig(process.env);
if (!config.adminKey) {
  console.error("ADMIN_KEY is not set. Copy infrastructure/masumi/.env.example to .env first.");
  process.exit(1);
}
const node = createNodeClient({ url: config.mpsUrl, token: config.adminKey });

mkdirSync(LOCAL_DIR, { recursive: true, mode: 0o700 });
let state: Record<string, any> = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
const writePrivate = (path: string, text: string) => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};
const step = (text: string) => console.log(`\n== ${text}`);
const ok = (text: string) => console.log(`ok   ${text}`);
const warn = (text: string) => console.log(`warn ${text}`);
function stop(text: string, code = 2): never {
  console.error(`STOP ${text}`);
  process.exit(code);
}

async function check(): Promise<{ source: PaymentSource; wallet: Wallet; lovelace: bigint }> {
  step(`Payment Service ${config.mpsUrl}`);
  await node("/health");
  ok("health");
  const { PaymentSources } = await node<{ PaymentSources: PaymentSource[] }>("/payment-source", {
    query: { take: "100" },
  });
  const source = findV2Source(PaymentSources);
  ok(`V2 payment source ${source.id} (escrow ${source.smartContractAddress})`);
  const { Wallets } = await node<{ Wallets: Wallet[] }>("/wallet/list", {
    query: { take: "100", paymentSourceId: source.id, walletType: "Selling" },
  });
  const wallet = pickSellingWallet(
    Wallets,
    process.env.SELLING_WALLET_VKEY?.trim() || state.sellerVkey,
  );
  ok(`selling wallet ${wallet.walletAddress}`);
  if (wallet.collectionAddress)
    warn(
      "the selling wallet has a collection address: the Coworker paid path (paid-task.mjs) refuses payments that carry a sellerReturnAddress",
    );
  const { Balance } = await node<{ Balance: { unit: string; quantity: number }[] }>("/balance", {
    query: { address: wallet.walletAddress, network: NETWORK },
  });
  const lovelace = amountOf(Balance, "lovelace");
  const tusdm = amountOf(Balance, TUSDM);
  console.log(`     balance ${ada(lovelace)} tADA, ${ada(tusdm)} tUSDM`);
  state = {
    ...state,
    sourceId: source.id,
    walletId: wallet.id,
    sellerVkey: wallet.walletVkey,
    sellerAddress: wallet.walletAddress,
    escrowAddress: source.smartContractAddress,
  };
  save();
  step(`MIP-003 Worker ${config.apiBaseUrl}`);
  const availability = await probeAvailability(config.apiBaseUrl);
  if (availability.ok) ok(`/availability ${availability.detail}`);
  else
    warn(
      `/availability ${availability.detail}. Registration still works; the registry marks the agent Online once the Worker answers (pnpm --filter @zyropay/sokosumi-agent mip003:deploy).`,
    );
  return { source, wallet, lovelace };
}

async function key() {
  step("Wallet-scoped runtime key (canPay, not admin)");
  if (state.runtimeKeyId && existsSync(RUNTIME_ENV_FILE)) {
    ok(`already created: ${state.runtimeKeyId}`);
    return copyRuntimeKey();
  }
  if (state.keyWritePending)
    stop(
      "a previous key write has an unknown outcome. Inspect API keys in http://127.0.0.1:3001/admin, delete a stray one, then remove keyWritePending from .local/registration.json.",
    );
  if (!state.walletId) await check();
  state.keyWritePending = true;
  save();
  const created = await node<{ id: string; token: string }>("/api-key", {
    body: runtimeKeyBody(state.walletId),
  });
  state.runtimeKeyId = created.id;
  state.keyWritePending = false;
  save();
  if (typeof created.token !== "string" || created.token.startsWith("*****"))
    stop(
      `key ${created.id} was created but its token was not revealed; delete it in the admin UI and rerun`,
    );
  writePrivate(RUNTIME_ENV_FILE, `MPS_RUNTIME_TOKEN=${created.token}\n`);
  ok(`created ${created.id} -> ${RUNTIME_ENV_FILE}`);
  copyRuntimeKey();
}

function copyRuntimeKey() {
  // The Coworker paid path (paid-task.mjs, isPaidReady) reads the same key from its own .local/.
  const target = join(AGENT_DIR, ".local", "mps-runtime.env");
  mkdirSync(join(AGENT_DIR, ".local"), { recursive: true, mode: 0o700 });
  writePrivate(target, readFileSync(RUNTIME_ENV_FILE, "utf8"));
  ok(`copied to ${target}`);
}

async function listRegistry(): Promise<RegistryEntry[]> {
  const all: RegistryEntry[] = [];
  let cursorId: string | undefined;
  for (let page = 0; page < 20; page++) {
    const { Assets } = await node<{ Assets: RegistryEntry[] }>("/registry", {
      query: {
        network: NETWORK,
        filterPaymentSourceType: "Web3CardanoV2",
        limit: "100",
        ...(cursorId ? { cursorId } : {}),
      },
    });
    all.push(...Assets);
    if (Assets.length < 100) break;
    cursorId = Assets.at(-1)?.id;
  }
  return all;
}

async function register() {
  const { lovelace } = await check();
  step("Registry entry");
  const body = buildRegistration({
    apiBaseUrl: config.apiBaseUrl,
    authorName: config.authorName,
    authorEmail: config.authorEmail,
    sellingWalletVkey: state.sellerVkey,
    escrowAddress: state.escrowAddress,
    priceUnits: config.priceUnits,
  });
  let entry = findExisting(await listRegistry(), {
    id: state.registrationId,
    name: body.name,
    apiBaseUrl: body.apiBaseUrl,
    vkey: state.sellerVkey,
  });
  if (entry && !state.registrationId) {
    ok(`reusing existing registration ${entry.id} (${entry.state})`);
    state.registrationId = entry.id;
    state.registrationWritePending = false;
    save();
  }
  if (!entry) {
    if (state.registrationWritePending)
      stop(
        "a previous registration write has an unknown outcome and no matching entry is listed yet. Wait 2 minutes and rerun; if still missing, check AI Agents in http://127.0.0.1:3001/admin, then remove registrationWritePending from .local/registration.json.",
      );
    if (state.registrationId)
      stop(`saved registration ${state.registrationId} is not listed by the node`);
    if (lovelace < MIN_SELLING_LOVELACE)
      stop(
        `the selling wallet holds ${ada(lovelace)} tADA; fund ${state.sellerAddress} with at least ${ada(MIN_SELLING_LOVELACE)} (100 recommended) from https://docs.cardano.org/cardano-testnets/tools/faucet (Preprod) or https://dispenser.masumi.network, wait ~1 minute, rerun`,
      );
    state.registrationWritePending = true;
    state.request = body;
    save();
    entry = await node<RegistryEntry>("/registry", { body });
    state.registrationId = entry.id;
    state.registrationWritePending = false;
    save();
    ok(`requested ${entry.id}: the node mints the registry NFT from the selling wallet`);
  }
  const started = Date.now();
  let last = "";
  while (!isConfirmed(entry)) {
    if (isFailed(entry))
      stop(
        `registration failed: ${entry.error ?? "no error text"}. Fix it, delete the entry in the admin UI, remove registrationId from .local/registration.json, rerun.`,
      );
    if (Date.now() - started > POLL_LIMIT_MS)
      stop(
        "still not confirmed after 30 minutes; rerun `register` later (it resumes, it does not mint again)",
      );
    const line = `${entry.state}${entry.CurrentTransaction?.txHash ? ` tx ${entry.CurrentTransaction.txHash}` : ""}`;
    if (line !== last) console.log(`     ${new Date().toISOString().slice(11, 19)} ${line}`);
    last = line;
    await new Promise((r) => setTimeout(r, POLL_MS));
    entry = (await listRegistry()).find((a) => a.id === state.registrationId) ?? entry;
  }
  state.entry = entry;
  state.agentIdentifier = entry.agentIdentifier;
  state.supportedPaymentSourceIndex = sourceIndexOf(entry, state.escrowAddress);
  save();
  ok(`${entry.state}: agentIdentifier ${entry.agentIdentifier}`);
  if (entry.CurrentTransaction?.txHash)
    console.log(
      `     https://preprod.cardanoscan.io/transaction/${entry.CurrentTransaction.txHash}`,
    );
  writeAgentState(entry);
}

function writeAgentState(entry: RegistryEntry) {
  const files = agentStateFiles({
    sourceId: state.sourceId,
    walletId: state.walletId,
    sellerAddress: state.sellerAddress,
    sellerVkey: state.sellerVkey,
    registrationId: state.registrationId,
    entry,
    supportedPaymentSourceIndex: state.supportedPaymentSourceIndex,
  });
  const docs = join(AGENT_DIR, "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "payment-state.json"), JSON.stringify(files.payment, null, 2));
  writeFileSync(join(docs, "registration-state.json"), JSON.stringify(files.registration, null, 2));
  ok(`wrote ${docs}/payment-state.json and registration-state.json (Coworker paid path)`);
}

function tunnelUrl(): string | undefined {
  if (config.publicMpsUrl) return config.publicMpsUrl;
  // cloudflared logs to stderr, which `docker logs` replays on stderr: read both streams.
  const out = spawnSync("docker", ["logs", "zyropay-masumi-tunnel"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return parseTunnelUrl(`${out.stdout ?? ""}${out.stderr ?? ""}`);
}

async function secrets() {
  step("MIP-003 Worker secrets");
  if (!state.agentIdentifier) stop("no confirmed registration yet: run `register` first");
  if (!existsSync(RUNTIME_ENV_FILE)) stop("no runtime key yet: run `key` first");
  const token = parseEnv(readFileSync(RUNTIME_ENV_FILE, "utf8")).MPS_RUNTIME_TOKEN;
  const publicUrl = tunnelUrl();
  if (!publicUrl)
    stop(
      "no tunnel URL: `docker compose up -d` starts zyropay-masumi-tunnel; or set PUBLIC_MPS_URL in .env",
    );
  if (!config.blockfrostKey) stop("BLOCKFROST_API_KEY_PREPROD is not set in .env");
  const health = await fetch(`${publicUrl}/api/v1/health`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (health?.ok) ok(`${publicUrl} reaches the Payment Service through the gateway`);
  else
    warn(
      `${publicUrl}/api/v1/health did not answer yet (new quick tunnels take ~30 s); the Worker retries`,
    );
  const values = {
    MPS_URL: publicUrl,
    MPS_TOKEN: token,
    AGENT_IDENTIFIER: state.agentIdentifier,
    SELLER_VKEY: state.sellerVkey,
    SUPPORTED_PAYMENT_SOURCE_INDEX: String(state.supportedPaymentSourceIndex ?? 0),
    BLOCKFROST_API_KEY_PREPROD: config.blockfrostKey,
  };
  writePrivate(WORKER_SECRETS_FILE, JSON.stringify(values, null, 2));
  ok(`wrote ${WORKER_SECRETS_FILE}`);
  console.log("     next: pnpm --filter @zyropay/sokosumi-agent mip003:secrets");
}

const command = process.argv[2] ?? "all";
try {
  if (command === "check") await check();
  else if (command === "key") await key();
  else if (command === "register") await register();
  else if (command === "secrets") await secrets();
  else if (command === "all") {
    await key();
    await register();
    await secrets();
  } else stop(`unknown command ${command}: use all, check, key, register or secrets`, 1);
  console.log("\nDone.");
} catch (error) {
  stop((error as Error).message, 1);
}
