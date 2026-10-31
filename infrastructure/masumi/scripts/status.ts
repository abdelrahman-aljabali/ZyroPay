// Read-only status of the whole Masumi path. Writes nothing, spends nothing.
//   pnpm --filter @zyropay/sokosumi-agent masumi:status
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  NETWORK,
  REGISTRY_V2_POLICY_PREPROD,
  RUNTIME_ENV_FILE,
  STATE_FILE,
  TUSDM,
  WORKER_SECRETS_FILE,
  ada,
  amountOf,
  createNodeClient,
  findV2Source,
  parseTunnelUrl,
  probeAvailability,
  readConfig,
  type PaymentSource,
  type RegistryEntry,
} from "./lib.ts";

const config = readConfig(process.env);
const state: Record<string, any> = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : {};
let failures = 0;
const line = (good: boolean | null, text: string) => {
  if (good === false) failures++;
  console.log(`${good === null ? "info" : good ? "ok  " : "FAIL"} ${text}`);
};

function docker(args: string[]): string | null {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  } catch (error: any) {
    return error?.stdout || error?.stderr ? `${error.stdout ?? ""}${error.stderr ?? ""}` : null;
  }
}

console.log("== Containers");
const ps = docker([
  "ps",
  "-a",
  "--filter",
  "name=zyropay-masumi",
  "--format",
  "{{.Names}}\t{{.Status}}",
]);
if (ps === null) line(false, "docker is not available (install Docker Desktop and start it)");
else if (!ps.trim())
  line(false, "no zyropay-masumi containers: cd infrastructure/masumi && docker compose up -d");
else
  for (const row of ps.trim().split("\n"))
    line(!/Exited \([1-9]|Restarting|unhealthy/u.test(row), row.replace("\t", "  "));

console.log("\n== Payment Service");
if (!config.adminKey) line(false, "ADMIN_KEY missing in infrastructure/masumi/.env");
else {
  const node = createNodeClient({ url: config.mpsUrl, token: config.adminKey });
  try {
    await node("/health");
    line(true, `${config.mpsUrl} healthy`);
    const { PaymentSources } = await node<{ PaymentSources: PaymentSource[] }>("/payment-source", {
      query: { take: "100" },
    });
    const source = findV2Source(PaymentSources);
    line(true, `V2 source ${source.smartContractAddress}`);
    if (state.sellerAddress) {
      const { Balance } = await node<{ Balance: { unit: string; quantity: number }[] }>(
        "/balance",
        {
          query: { address: state.sellerAddress, network: NETWORK },
        },
      );
      const lovelace = amountOf(Balance, "lovelace");
      line(
        lovelace >= 5_000_000n,
        `selling wallet ${state.sellerAddress}: ${ada(lovelace)} tADA, ${ada(amountOf(Balance, TUSDM))} tUSDM`,
      );
    } else line(null, "selling wallet not read yet: run masumi:register check");
    if (state.registrationId) {
      const { Assets } = await node<{ Assets: RegistryEntry[] }>("/registry", {
        query: { network: NETWORK, filterPaymentSourceType: "Web3CardanoV2", limit: "100" },
      });
      const entry = Assets.find((a) => a.id === state.registrationId);
      if (!entry) line(false, `registration ${state.registrationId} not listed`);
      else {
        line(
          /Confirmed$/u.test(entry.state),
          `registration ${entry.state}${entry.error ? ` (${entry.error})` : ""}`,
        );
        if (entry.agentIdentifier) {
          line(
            entry.agentIdentifier.startsWith(REGISTRY_V2_POLICY_PREPROD),
            `agentIdentifier ${entry.agentIdentifier} (Masumi V2 registry policy)`,
          );
          line(null, `https://preprod.cardanoscan.io/token/${entry.agentIdentifier}`);
          if (state.agentIdentifier && state.agentIdentifier !== entry.agentIdentifier)
            line(
              false,
              "agentIdentifier changed (registry update): rerun masumi:register secrets and mip003:secrets",
            );
        }
      }
    } else line(null, "not registered yet: pnpm --filter @zyropay/sokosumi-agent masumi:register");
  } catch (error) {
    line(false, (error as Error).message);
  }
}
line(existsSync(RUNTIME_ENV_FILE), `runtime key file ${RUNTIME_ENV_FILE}`);

console.log("\n== Public path (what Sokosumi uses)");
// cloudflared logs to stderr, which `docker logs` replays on stderr: read both streams.
const tunnelOut = spawnSync("docker", ["logs", "zyropay-masumi-tunnel"], {
  encoding: "utf8",
  timeout: 15_000,
});
const tunnelLog = `${tunnelOut.stdout ?? ""}${tunnelOut.stderr ?? ""}`;
const tunnel = config.publicMpsUrl ?? (tunnelLog ? parseTunnelUrl(tunnelLog) : undefined);
if (!tunnel) line(false, "no tunnel URL (zyropay-masumi-tunnel not running, PUBLIC_MPS_URL unset)");
else {
  const health = await fetch(`${tunnel}/api/v1/health`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  line(
    Boolean(health?.ok),
    `${tunnel} -> gateway -> Payment Service ${health ? `HTTP ${health.status}` : "unreachable"}`,
  );
  const admin = await fetch(`${tunnel}/admin`, {
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  }).catch(() => null);
  line(
    admin?.status === 404,
    `admin UI is not exposed through the tunnel (HTTP ${admin?.status ?? "-"})`,
  );
  if (existsSync(WORKER_SECRETS_FILE)) {
    const secretUrl = JSON.parse(readFileSync(WORKER_SECRETS_FILE, "utf8")).MPS_URL;
    line(
      secretUrl === tunnel,
      secretUrl === tunnel
        ? "Worker secret MPS_URL matches the tunnel"
        : `tunnel URL changed since the Worker secrets were written: rerun masumi:register secrets, then mip003:secrets`,
    );
  }
}
const availability = await probeAvailability(config.apiBaseUrl);
line(availability.ok, `${config.apiBaseUrl}/availability ${availability.detail}`);
line(
  null,
  'Sokosumi Preprod catalog: https://preprod.sokosumi.com/agents (search "Cardano Address Intelligence"; listing follows registry sync, minutes)',
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
