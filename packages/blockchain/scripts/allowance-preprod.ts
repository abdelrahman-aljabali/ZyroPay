/**
 * One live cycle of the ZyroPay agent allowance (contracts/allowance) on Cardano PREPROD:
 *
 *   1. create   the owner locks 20 tADA with the limits below (one owner signature);
 *   2. refusals  an over-the-max payment and a payment to an unlisted payee, sent ONLY to
 *               Blockfrost's evaluator (never to the chain), which must reject them;
 *   3. pay x2   the agent pays 2 tADA to the x402 seller twice, with no owner signature;
 *   4. refusal  a third 2 tADA payment would pass the 5 tADA period cap: evaluated only;
 *   5. revoke   the owner takes the remainder back.
 *
 *   BLOCKFROST_PROJECT_ID=preprod... pnpm --filter @zyropay/blockchain allowance:preprod --yes \
 *     [--out run.json]
 *
 * Keys: contracts/allowance/.secrets/{owner,agent}.skey (32-byte Ed25519 seeds, hex, mode 0600,
 * git-ignored; never printed). Fund the printed owner (~25 tADA) and agent (~8 tADA, fees and
 * collateral) addresses first. Every step is skipped when the chain shows it already happened
 * (a live allowance is reused), so the script can be re-run after an interruption.
 *
 * A transaction whose script fails is never submitted: the spend builder measures every
 * honest spend with the evaluator first (a failure throws before signing), and refusals go
 * to the evaluator only. The run prints a JSON summary (public data only) at the end.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NetworkId } from "@zyropay/shared";
import { cardanoAddressFromBytes, cardanoKeyHash, cardanoPaymentKeyHash } from "@zyropay/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AllowanceDatum, AllowanceUtxo } from "../src/cardano/allowance";
import {
  ALLOWANCE_PLACEHOLDER_EX_UNITS,
  allowanceScript,
  createCardanoAllowanceBuilder,
  encodeAllowanceDatum,
  planAllowanceUncheckedSpend,
} from "../src/cardano/allowance";
import { BLOCKFROST_BASE_URLS, BlockfrostClient } from "../src/cardano/blockfrost";
import { cardanoSlotToPosixMs } from "../src/cardano/escrow";
import { attachCardanoWitness } from "../src/cardano/witness";
import { isRecord } from "../src/http";

const NETWORK: NetworkId = "cardano-preprod";
const ADA = 1_000_000n;
const DAY_MS = 86_400_000n;
/** The x402 seller's payTo (apps/seller): the only payee the allowance lists. */
const SELLER =
  "addr_test1qr954ww3l08ezv7gqk8kddlckaqupe2fkv6shu6len37cn4t54p3mmj5xp74prvahzg5qljdvff6cxucu2lzug775hcs0dkaen";
const LOCK = 20n * ADA;
const PAY = 2n * ADA;
const LIMITS = { perPaymentMax: 3n * ADA, periodMs: DAY_MS, periodCap: 5n * ADA };
const VALIDITY_SLOTS = 600n;

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const secrets = join(repo, "contracts", "allowance", ".secrets");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!process.argv.includes("--yes"))
  fail("This spends preprod test ADA (fees) from the owner and agent keys. Re-run with --yes.");
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? "";
if (!projectId.startsWith("preprod")) fail("Set BLOCKFROST_PROJECT_ID to a preprod project id.");

interface Key {
  readonly seed: Uint8Array;
  readonly publicKey: string;
  readonly keyHash: string;
  readonly address: string;
}

function loadKey(role: "owner" | "agent"): Key {
  const file = join(secrets, `${role}.skey`);
  if (!existsSync(file)) fail(`${file} is missing (32-byte Ed25519 seed, hex).`);
  const seed = hexToBytes(readFileSync(file, "utf8").trim());
  if (seed.length !== 32) fail(`${file} must hold a 32-byte seed in hex.`);
  const publicKey = bytesToHex(ed25519.getPublicKey(seed));
  const keyHash = cardanoKeyHash(publicKey);
  const address = cardanoAddressFromBytes(Uint8Array.from([0x60, ...hexToBytes(keyHash)]));
  if (address === null) fail("could not derive an address");
  return { seed, publicKey, keyHash, address };
}

const owner = loadKey("owner");
const agent = loadKey("agent");
const payeeHash = cardanoPaymentKeyHash(SELLER);
if (payeeHash === null) fail("the seller address has no payment key");
const script = allowanceScript(NETWORK, owner.keyHash);

const client = new BlockfrostClient({ network: NETWORK, projectId });
const builder = createCardanoAllowanceBuilder({ network: NETWORK, blockfrostProjectId: projectId });

console.log(`owner   ${owner.address}`);
console.log(`agent   ${agent.address}`);
console.log(`script  ${script.scriptHash}`);
console.log(`address ${script.address}`);

function sign(unsignedHex: string, bodyHash: string, key: Key): string {
  const signature = bytesToHex(ed25519.sign(hexToBytes(bodyHash), key.seed));
  return attachCardanoWitness({
    unsignedHex,
    publicKey: key.publicKey,
    signature,
    expectedKeyHash: key.keyHash,
  }).signedTransaction;
}

interface Confirmed {
  readonly txHash: string;
  readonly block: string;
  readonly height: number;
  readonly slot: number;
  readonly time: string;
  readonly fee: string;
  readonly validContract: boolean;
}

async function confirmed(txHash: string): Promise<Confirmed> {
  for (let i = 0; i < 90; i++) {
    const tx = await client.getOrNull(`/txs/${txHash}`, "txs");
    if (isRecord(tx) && typeof tx.block === "string") {
      return {
        txHash,
        block: tx.block,
        height: Number(tx.block_height),
        slot: Number(tx.slot),
        time: new Date(Number(tx.block_time) * 1000).toISOString(),
        fee: String(tx.fees),
        validContract: tx.valid_contract !== false,
      };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return fail(`${txHash} did not confirm within 7.5 minutes`);
}

async function submit(label: string, unsignedHex: string, bodyHash: string, key: Key) {
  const id = await client.submit(hexToBytes(sign(unsignedHex, bodyHash, key)));
  if (id !== bodyHash) fail(`${label}: Blockfrost reported a different id`);
  console.log(`${label}: submitted ${id}, waiting for a block...`);
  const c = await confirmed(id);
  if (!c.validContract) fail(`${label}: the script failed on chain`);
  console.log(`${label}: in block ${c.height} at ${c.time}, fee ${c.fee} lovelace`);
  await walletSettled(key.address, id);
  return c;
}

/**
 * Blockfrost's address index can lag a block behind `/txs`: wait until the signer's UTxO
 * set shows the transaction's change, so the next build never spends an input twice.
 */
async function walletSettled(address: string, txHash: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    if ((await client.utxos(address)).some((u) => u.tx_hash === txHash)) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail(`the UTxO set of ${address} does not show ${txHash} yet`);
}

/** Wait until Blockfrost's UTxO view shows the allowance created/continued by `txHash`. */
async function allowanceFrom(txHash: string | null): Promise<AllowanceUtxo | null> {
  for (let i = 0; i < 24; i++) {
    const live = (await builder.readAllowances(owner.keyHash)).filter(
      (a) => a.datum.agentKeyHash === agent.keyHash,
    );
    const found = txHash === null ? live[0] : live.find((a) => a.txHash === txHash);
    if (found !== undefined || txHash === null) return found ?? null;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return fail(`the allowance from ${txHash ?? "?"} is not visible yet`);
}

/** Raw evaluator reply for a transaction that must NOT pass (never submitted). */
async function refusal(name: string, allowance: AllowanceUtxo, lovelace: bigint, payee: string) {
  const [params, utxos, tip] = await Promise.all([
    client.scriptProtocolParams(),
    client.utxos(agent.address),
    client.tip(),
  ]);
  const lower = cardanoSlotToPosixMs(NETWORK, tip.slot);
  const spent =
    lower - allowance.datum.periodStart >= allowance.datum.periodMs
      ? 0n
      : allowance.datum.spentInPeriod;
  // The honest continuing datum for this payment; only the breached limit is wrong.
  const next: AllowanceDatum = { ...allowance.datum, spentInPeriod: spent + lovelace };
  const plan = planAllowanceUncheckedSpend({
    network: NETWORK,
    ownerKeyHash: owner.keyHash,
    action: "AgentPay",
    from: agent.address,
    allowance,
    outputs: [
      {
        address: script.address,
        value: { coin: allowance.value.coin - lovelace, assets: allowance.value.assets },
        inlineDatum: encodeAllowanceDatum(next, { unchecked: true }),
      },
      { address: payee, value: { coin: lovelace, assets: new Map() } },
    ],
    utxos,
    params,
    validityStartSlot: tip.slot,
    ttlSlot: tip.slot + VALIDITY_SLOTS,
    exUnits: ALLOWANCE_PLACEHOLDER_EX_UNITS,
  });
  const base = BLOCKFROST_BASE_URLS[NETWORK] ?? "";
  // Ogmios v5 JSON (what BlockfrostClient.evaluateTx parses) and v6, which names the failing
  // validator and error code. Evaluation only: neither endpoint submits anything.
  const v5 = await postJson(`${base}/utils/txs/evaluate/utxos`, "application/json", {
    cbor: plan.serialized,
    additionalUtxoSet: [],
  });
  const v6 = await postJson(
    `${base}/utils/txs/evaluate?version=6`,
    "application/cbor",
    plan.serialized,
  );
  const v5Result = isRecord(v5.body) && isRecord(v5.body.result) ? v5.body.result : {};
  const v6Error = isRecord(v6.body) && isRecord(v6.body.error) ? v6.body.error : {};
  const failures = Array.isArray(v6Error.data) ? (v6Error.data as unknown[]) : [];
  // Refused = the allowance's own redeemer failed to validate (Ogmios 3010 / 3012), not a
  // malformed or unresolvable transaction.
  const ours = failures.find(
    (f) =>
      isRecord(f) &&
      isRecord(f.validator) &&
      f.validator.purpose === "spend" &&
      f.validator.index === plan.redeemerIndex &&
      isRecord(f.error) &&
      f.error.code === 3012,
  );
  const refused =
    v5Result.EvaluationFailure !== undefined && v6Error.code === 3010 && ours !== undefined;
  console.log(
    `refusal ${name}: ${refused ? "REFUSED by the validator" : "NOT a clean refusal (!)"}`,
  );
  if (!refused) {
    console.error(JSON.stringify({ v5: v5.body, v6: v6.body }).slice(0, 2000));
    fail(`refusal ${name}: not refused by the allowance validator; stopping (nothing submitted)`);
  }
  return {
    name,
    lovelace: lovelace.toString(),
    payee,
    spentBefore: spent.toString(),
    redeemerIndex: plan.redeemerIndex,
    unsignedTxId: plan.bodyHash,
    submitted: false,
    evaluation: {
      ogmiosV5: { httpStatus: v5.status, result: v5Result },
      ogmiosV6: { httpStatus: v6.status, error: v6Error },
    },
  };
}

async function postJson(
  url: string,
  contentType: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { project_id: projectId, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    // The CBOR-body endpoint has intermittent 500s: retry those a few times.
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    return { status: res.status, body: await res.json() };
  }
}

async function agentPay(label: string, allowance: AllowanceUtxo) {
  const tip = await client.tip();
  const plan = await builder.buildAgentPay({
    ownerKeyHash: owner.keyHash,
    allowance,
    agent: agent.address,
    payee: SELLER,
    lovelace: PAY,
    validityStartSlot: tip.slot,
    ttlSlot: tip.slot + VALIDITY_SLOTS,
  });
  const c = await submit(label, plan.serialized, plan.bodyHash, agent);
  return {
    ...c,
    exUnits: { mem: plan.exUnits.mem.toString(), steps: plan.exUnits.steps.toString() },
    plannedFee: plan.fee.toString(),
    spentInPeriodAfter: plan.nextDatum.spentInPeriod.toString(),
  };
}

const outFlag = process.argv.indexOf("--out");
const outFile = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;
/** Print the summary; with `--out <file>` it is also rewritten after every step. */
function report(): void {
  const text = JSON.stringify(summary, null, 2);
  if (outFile !== undefined) writeFileSync(outFile, `${text}\n`);
  console.log(text);
}

const summary: Record<string, unknown> = {
  network: NETWORK,
  owner: owner.address,
  agent: agent.address,
  payee: SELLER,
  scriptHash: script.scriptHash,
  scriptAddress: script.address,
};

// 1. create (or reuse a live allowance for this agent)
let allowance = await allowanceFrom(null);
if (allowance === null) {
  const tip = await client.tip();
  const periodStart = cardanoSlotToPosixMs(NETWORK, tip.slot);
  const datum: AllowanceDatum = {
    agentKeyHash: agent.keyHash,
    ...LIMITS,
    periodStart,
    spentInPeriod: 0n,
    allowedPayees: [{ kind: "key", hash: payeeHash }],
    expiresAt: periodStart + 7n * DAY_MS,
  };
  const plan = await builder.buildCreate({
    from: owner.address,
    lovelace: LOCK,
    datum,
    ttlSlot: tip.slot + VALIDITY_SLOTS,
  });
  summary.create = await submit("create", plan.serialized, plan.bodyHash, owner);
  allowance = await allowanceFrom(plan.bodyHash);
} else {
  console.log(`reusing live allowance ${allowance.txHash}#${allowance.index}`);
}
if (allowance === null) fail("no allowance");
summary.datum = Object.fromEntries(
  Object.entries(allowance.datum).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
);

// 2. refusals that need room under the period cap
const refusals: unknown[] = [];
if (allowance.datum.spentInPeriod + 4n * ADA <= LIMITS.periodCap)
  refusals.push(await refusal("over-per-payment-max", allowance, 4n * ADA, SELLER));
if (allowance.datum.spentInPeriod + PAY <= LIMITS.periodCap)
  refusals.push(await refusal("unlisted-payee", allowance, PAY, agent.address));
summary.refusals = refusals;

// 3. two honest agent payments (no owner signature)
const pays: unknown[] = [];
while (allowance.datum.spentInPeriod + PAY <= LIMITS.periodCap) {
  const paid = await agentPay(`agent pay ${pays.length + 1}`, allowance);
  pays.push(paid);
  summary.agentPays = pays;
  if (outFile !== undefined) writeFileSync(outFile, JSON.stringify(summary, null, 2));
  allowance = await allowanceFrom(paid.txHash);
  if (allowance === null) fail("the continuing allowance is missing");
}
summary.agentPays = pays;

// 4. the period cap: spent + 2 tADA > 5 tADA
refusals.push(await refusal("over-period-cap", allowance, PAY, SELLER));
summary.refusals = refusals;

// 5. owner revoke: everything back to the owner
{
  const tip = await client.tip();
  const plan = await builder.buildOwnerSpend({
    owner: owner.address,
    allowance,
    validityStartSlot: tip.slot,
    ttlSlot: tip.slot + VALIDITY_SLOTS,
  });
  const c = await submit("revoke", plan.serialized, plan.bodyHash, owner);
  summary.revoke = {
    ...c,
    exUnits: { mem: plan.exUnits.mem.toString(), steps: plan.exUnits.steps.toString() },
    returnedLovelace: allowance.value.coin.toString(),
  };
}

report();
