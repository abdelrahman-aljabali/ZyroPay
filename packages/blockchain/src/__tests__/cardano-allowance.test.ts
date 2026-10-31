import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  cardanoAddressBytes,
  cardanoAddressFromBytes,
  cardanoPaymentKeyHash,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import type { AllowanceDatum, AllowanceUtxo } from "../cardano/allowance";
import {
  ALLOWANCE_UNAPPLIED_SCRIPT,
  allowanceCurrentPeriod,
  allowanceRedeemer,
  allowanceScript,
  decodeAllowanceDatum,
  encodeAllowanceDatum,
  ALLOWANCE_PLACEHOLDER_EX_UNITS,
  measureAllowanceSpend,
  nextAllowanceDatum,
  planAllowanceAgentPay,
  planAllowanceCreate,
  planAllowanceOwnerSpend,
  planAllowanceUncheckedSpend,
} from "../cardano/allowance";
import { ALLOWANCE_UNAPPLIED_SCRIPT_HEX } from "../cardano/allowance-script";
import type { EvaluatedRedeemer, ScriptProtocolParams } from "../cardano/blockfrost";
import type { Cbor } from "../cardano/cbor";
import { array, bytes, encodeCbor, map, tag, uint } from "../cardano/cbor";
import {
  cardanoSlotToPosixMs,
  MASUMI_SCRIPT_HASH,
  masumiEscrowAddress,
  plutusV3ScriptHash,
} from "../cardano/escrow";
import { decodeCardanoTx } from "../cardano/tx";
import { ChainError } from "../errors";
import { FROM, TIP, TO, utxo } from "./cardano-fixtures";
import COST_MODEL from "./fixtures/cardano/plutus-v3-cost-model.json";

const NET = "cardano-preprod" as const;
const OWNER = FROM;
const OWNER_KH = cardanoPaymentKeyHash(OWNER) ?? "";
const PAYEE = TO;
const PAYEE_KH = cardanoPaymentKeyHash(PAYEE) ?? "";
const AGENT_KH = "ab".repeat(28);
const AGENT = cardanoAddressFromBytes(Uint8Array.from([0x60, ...hexToBytes(AGENT_KH)])) ?? "";
const ADA = 1_000_000n;
const DAY = 86_400_000n;

const PARAMS: ScriptProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155381n,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384,
  maxValSize: 5000,
  priceMem: { num: 577n, den: 10000n },
  priceStep: { num: 721n, den: 10000000n },
  collateralPercent: 150n,
  maxCollateralInputs: 3,
  maxTxExMem: 16_500_000n,
  maxTxExSteps: 10_000_000_000n,
  plutusV3CostModel: COST_MODEL.PlutusV3.map((c) => BigInt(c)),
};
const EXUNITS = { mem: 14_000_000n, steps: 10_000_000_000n };

const START_SLOT = BigInt(TIP.slot - 60);
const TTL_SLOT = BigInt(TIP.slot + 600);
const PERIOD_START = cardanoSlotToPosixMs(NET, BigInt(TIP.slot - 3600));

const DATUM: AllowanceDatum = {
  agentKeyHash: AGENT_KH,
  perPaymentMax: 5n * ADA,
  periodMs: DAY,
  periodCap: 20n * ADA,
  periodStart: PERIOD_START,
  spentInPeriod: 0n,
  allowedPayees: [{ kind: "key", hash: PAYEE_KH }],
  expiresAt: PERIOD_START + 30n * DAY,
};

const SCRIPT = allowanceScript(NET, OWNER_KH);
const ALLOWANCE: AllowanceUtxo = {
  txHash: "5".repeat(64),
  index: 0,
  value: { coin: 50n * ADA, assets: new Map() },
  datum: DATUM,
};
const agentUtxos = [
  { ...utxo("6", 0, "8000000"), address: AGENT },
  { ...utxo("7", 1, "3000000"), address: AGENT },
];
const ownerUtxos = [utxo("8", 0, "9000000")];

function agentPay(overrides: Partial<Parameters<typeof planAllowanceAgentPay>[0]> = {}) {
  return planAllowanceAgentPay({
    network: NET,
    ownerKeyHash: OWNER_KH,
    allowance: ALLOWANCE,
    agent: AGENT,
    payee: PAYEE,
    lovelace: 3n * ADA,
    utxos: agentUtxos,
    params: PARAMS,
    validityStartSlot: START_SLOT,
    ttlSlot: TTL_SLOT,
    exUnits: EXUNITS,
    ...overrides,
  });
}

function revoke() {
  return planAllowanceOwnerSpend({
    network: NET,
    owner: OWNER,
    allowance: ALLOWANCE,
    utxos: ownerUtxos,
    params: PARAMS,
    validityStartSlot: START_SLOT,
    ttlSlot: TTL_SLOT,
    exUnits: EXUNITS,
  });
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChainError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return undefined;
};

describe("allowance script", () => {
  it("is the blueprint's compiled code (regenerate allowance-script.ts after aiken build)", () => {
    const blueprint = JSON.parse(
      readFileSync(new URL("../../../../contracts/allowance/plutus.json", import.meta.url), "utf8"),
    ) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };
    const spend = blueprint.validators.find((v) => v.title === "allowance.allowance.spend");
    expect(spend?.compiledCode).toBe(ALLOWANCE_UNAPPLIED_SCRIPT_HEX);
    expect(plutusV3ScriptHash(ALLOWANCE_UNAPPLIED_SCRIPT)).toBe(spend?.hash);
  });

  it("applies the owner as a byte-aligned prefix and keeps the program body verbatim", () => {
    const flatOf = (s: Uint8Array) => s.subarray(3); // 59 xx xx header
    const applied = flatOf(SCRIPT.script);
    const original = flatOf(ALLOWANCE_UNAPPLIED_SCRIPT);
    // version; wrapper bits 0011 0011 0010 0010 0011 0000|00000001 0000|00000010 0100 110000 + filler 01;
    // bytestring chunk [len 0x1e: 0x58 0x1c owner]; terminator 0; then the original term.
    expect(bytesToHex(applied.subarray(0, 3))).toBe("010100");
    expect(bytesToHex(applied.subarray(3, 10))).toBe("332230010024c1");
    expect(bytesToHex(applied.subarray(10, 41))).toBe(`1e581c${OWNER_KH}`);
    expect(applied[41]).toBe(0);
    expect(bytesToHex(applied.subarray(42))).toBe(bytesToHex(original.subarray(3)));
  });

  it("gives every owner a distinct, deterministic script address", () => {
    const again = allowanceScript(NET, OWNER_KH);
    const other = allowanceScript(NET, "cd".repeat(28));
    expect(again.scriptHash).toBe(SCRIPT.scriptHash);
    expect(other.scriptHash).not.toBe(SCRIPT.scriptHash);
    expect(SCRIPT.address.startsWith("addr_test1w")).toBe(true);
    expect(allowanceScript("cardano-mainnet", OWNER_KH).address.startsWith("addr1w")).toBe(true);
    expect(bytesToHex(cardanoAddressBytes(SCRIPT.address))).toBe(`70${SCRIPT.scriptHash}`);
  });
});

describe("allowance datum", () => {
  it("round-trips and matches the Aiken constructor layout", () => {
    const cbor = encodeAllowanceDatum(DATUM);
    expect(bytesToHex(cbor).startsWith(`d8799f`) || bytesToHex(cbor).startsWith("d87988")).toBe(
      true,
    );
    expect(decodeAllowanceDatum(cbor)).toEqual(DATUM);
    const anyPayee = {
      ...DATUM,
      allowedPayees: [{ kind: "script" as const, hash: "ee".repeat(28) }],
    };
    expect(decodeAllowanceDatum(bytesToHex(encodeAllowanceDatum(anyPayee)))).toEqual(anyPayee);
  });

  it("decodes indefinite-length lists, as other tools write them", () => {
    const definite = bytesToHex(encodeAllowanceDatum({ ...DATUM, allowedPayees: [] }));
    // d87988 ... 80 ... -> d8799f ... 9fff ... ff
    const indefinite = `d8799f${definite.slice(6).replace(/80(1b[0-9a-f]{16})$/, "9fff$1")}ff`;
    expect(decodeAllowanceDatum(indefinite).allowedPayees).toEqual([]);
  });

  it("refuses unusable datums", () => {
    expect(codeOf(() => encodeAllowanceDatum({ ...DATUM, periodMs: 0n }))).toMatch(/periodMs/);
    expect(codeOf(() => encodeAllowanceDatum({ ...DATUM, spentInPeriod: 21n * ADA }))).toMatch(
      /spentInPeriod/,
    );
    expect(codeOf(() => encodeAllowanceDatum({ ...DATUM, agentKeyHash: "00" }))).toMatch(/hash/);
    expect(codeOf(() => decodeAllowanceDatum("d87980"))).toMatch(/8 fields/);
  });

  it("encodes the redeemers as Constr 0 / Constr 1", () => {
    expect(bytesToHex(encodeCbor(allowanceRedeemer("AgentPay")))).toBe("d87980");
    expect(bytesToHex(encodeCbor(allowanceRedeemer("Owner")))).toBe("d87a80");
  });

  it("mirrors the on-chain period accounting", () => {
    const spent = { ...DATUM, spentInPeriod: 20n * ADA };
    expect(allowanceCurrentPeriod(spent, PERIOD_START + DAY - 1n)).toEqual({
      periodStart: PERIOD_START,
      spent: 20n * ADA,
    });
    expect(allowanceCurrentPeriod(spent, PERIOD_START + 3n * DAY + 5n)).toEqual({
      periodStart: PERIOD_START + 3n * DAY,
      spent: 0n,
    });
    const at = PERIOD_START + 1000n;
    expect(nextAllowanceDatum(DATUM, 5n * ADA, at, at + 1n).spentInPeriod).toBe(5n * ADA);
    expect(codeOf(() => nextAllowanceDatum(DATUM, 5n * ADA + 1n, at, at + 1n))).toMatch(
      /per-payment/,
    );
    expect(codeOf(() => nextAllowanceDatum(spent, 1n, at, at + 1n))).toMatch(/left in this period/);
    expect(codeOf(() => nextAllowanceDatum(DATUM, 1n, at, DATUM.expiresAt + 1n))).toMatch(
      /REQUEST_EXPIRED/,
    );
    expect(codeOf(() => nextAllowanceDatum(DATUM, 0n, at, at + 1n))).toMatch(/positive/);
  });
});

describe("allowance transactions", () => {
  it("create: owner pays the allowance address with the inline datum, no script", () => {
    const plan = planAllowanceCreate({
      network: NET,
      from: OWNER,
      lovelace: 50n * ADA,
      datum: DATUM,
      utxos: [utxo("9", 0, "60000000")],
      params: PARAMS,
      ttlSlot: TTL_SLOT,
    });
    expect(plan.address).toBe(SCRIPT.address);
    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect([...tx.bodyKeys].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    const [out] = tx.outputs;
    expect(out?.address).toBe(SCRIPT.address);
    expect(out?.value.coin).toBe(50n * ADA);
    expect(decodeAllowanceDatum(out?.inlineDatum ?? new Uint8Array())).toEqual(DATUM);
    expect(tx.outputs[1]?.address).toBe(OWNER);
  });

  it("agent pay: continuing output, payee, agent change, agent as the only signer", () => {
    const plan = agentPay();
    const tx = decodeCardanoTx(hexToBytes(plan.serialized), { strict: true });
    expect([...tx.bodyKeys].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 8, 11, 13, 14, 16, 17]);
    expect([...tx.witnessKeys].sort((a, b) => a - b)).toEqual([5, 7]);
    expect(tx.requiredSigners).toEqual([AGENT_KH]);
    expect(bytesToHex(tx.plutusV3Scripts[0] ?? new Uint8Array())).toBe(bytesToHex(SCRIPT.script));
    const [cont, pay, change] = tx.outputs;
    expect(cont?.address).toBe(SCRIPT.address);
    expect(cont?.value.coin).toBe(47n * ADA);
    expect(decodeAllowanceDatum(cont?.inlineDatum ?? new Uint8Array())).toEqual({
      ...DATUM,
      spentInPeriod: 3n * ADA,
    });
    expect(pay?.address).toBe(PAYEE);
    expect(pay?.value.coin).toBe(3n * ADA);
    expect(change?.address).toBe(AGENT);
    // The fee comes from the agent, never from the allowance.
    const agentIn = tx.inputs.filter((i) => i.txHash !== ALLOWANCE.txHash).length;
    expect(agentIn).toBeGreaterThan(0);
    expect(tx.redeemers).toHaveLength(1);
    expect(tx.redeemers[0]?.index).toBe(plan.redeemerIndex);
    expect(bytesToHex(tx.redeemers[0]?.dataBytes ?? new Uint8Array())).toBe("d87980");
    expect(tx.collateral).toEqual([plan.collateralInput]);
  });

  it("agent pay: refuses what the validator would refuse, before building", () => {
    expect(codeOf(() => agentPay({ lovelace: 6n * ADA }))).toMatch(/per-payment/);
    expect(codeOf(() => agentPay({ payee: OWNER }))).toMatch(/not on the allowance's list/);
    expect(codeOf(() => agentPay({ agent: OWNER }))).toMatch(/not the allowance's agent/);
    expect(codeOf(() => agentPay({ payee: SCRIPT.address }))).toMatch(/cannot be paid/);
    const late = { ...ALLOWANCE, datum: { ...DATUM, expiresAt: PERIOD_START + 3_600_000n } };
    expect(codeOf(() => agentPay({ allowance: late }))).toMatch(/REQUEST_EXPIRED/);
    const full = { ...ALLOWANCE, datum: { ...DATUM, spentInPeriod: 18n * ADA } };
    expect(codeOf(() => agentPay({ allowance: full }))).toMatch(/left in this period/);
    expect(codeOf(() => agentPay({ utxos: [] }))).toMatch(/INSUFFICIENT_FUNDS/);
  });

  it("owner revoke: everything back to the owner, owner as the only signer", () => {
    const plan = revoke();
    const tx = decodeCardanoTx(hexToBytes(plan.serialized), { strict: true });
    expect(tx.requiredSigners).toEqual([OWNER_KH]);
    expect(tx.outputs.every((o) => o.address === OWNER)).toBe(true);
    expect(tx.outputs.some((o) => o.address === SCRIPT.address)).toBe(false);
    expect(bytesToHex(tx.redeemers[0]?.dataBytes ?? new Uint8Array())).toBe("d87a80");
  });

  it("owner top-up: a continuing allowance with more value", () => {
    const plan = planAllowanceOwnerSpend({
      network: NET,
      owner: OWNER,
      allowance: ALLOWANCE,
      continuing: { lovelace: 55n * ADA, datum: DATUM },
      utxos: [utxo("8", 0, "20000000")],
      params: PARAMS,
      validityStartSlot: START_SLOT,
      ttlSlot: TTL_SLOT,
      exUnits: EXUNITS,
    });
    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect(tx.outputs[0]?.address).toBe(SCRIPT.address);
    expect(tx.outputs[0]?.value.coin).toBe(55n * ADA);
  });
});

describe("measured execution units", () => {
  /** A fake evaluator: what it "measures" depends on the declared units, like a real fee would. */
  const evaluator = (usage: (declared: bigint) => { mem: bigint; steps: bigint }) => {
    const calls: string[] = [];
    const evaluate = (serialized: string): Promise<EvaluatedRedeemer[]> => {
      calls.push(serialized);
      const tx = decodeCardanoTx(hexToBytes(serialized));
      const r = tx.redeemers[0];
      return Promise.resolve([{ tag: "spend", index: r?.index ?? 0, ...usage(r?.mem ?? 0n) }]);
    };
    return { calls, evaluate };
  };

  it("rebuilds with exactly the measured units and a fee that reflects them", async () => {
    const used = { mem: 280_000n, steps: 115_000_000n };
    const { calls, evaluate } = evaluator(() => used);
    const plan = await measureAllowanceSpend({
      build: (exUnits) => agentPay({ exUnits }),
      evaluate,
      params: PARAMS,
    });
    expect(calls).toHaveLength(2);
    expect(plan.exUnits).toEqual(used);
    expect(plan.measured).toEqual(used);
    const tx = decodeCardanoTx(hexToBytes(plan.serialized));
    expect(tx.redeemers[0]?.mem).toBe(used.mem);
    expect(tx.redeemers[0]?.steps).toBe(used.steps);
    // The placeholder build pays for ~14 M mem; the measured one costs a fraction of that.
    const draft = agentPay({ exUnits: ALLOWANCE_PLACEHOLDER_EX_UNITS });
    expect(plan.fee).toBeLessThan(draft.fee - 500_000n);
  });

  it("re-measures until the declared units cover what the final transaction uses", async () => {
    // The first rebuild uses a little more than measured on the draft (its fee changed).
    let n = 0;
    const { calls, evaluate } = evaluator(() => {
      n++;
      return n === 1 ? { mem: 100n, steps: 1000n } : { mem: 110n, steps: 1005n };
    });
    const plan = await measureAllowanceSpend({
      build: (exUnits) => agentPay({ exUnits }),
      evaluate,
      params: PARAMS,
    });
    expect(calls).toHaveLength(3);
    expect(plan.exUnits).toEqual({ mem: 110n, steps: 1005n });
  });

  it("applies a margin when asked and never exceeds the per-transaction limits", async () => {
    const { evaluate } = evaluator(() => ({ mem: 1000n, steps: 10_000n }));
    const plan = await measureAllowanceSpend({
      build: (exUnits) => agentPay({ exUnits }),
      evaluate,
      params: PARAMS,
      marginPercent: 10,
    });
    expect(plan.exUnits).toEqual({ mem: 1100n, steps: 11_000n });
    const huge = evaluator(() => ({ mem: PARAMS.maxTxExMem * 2n, steps: 1n }));
    await expect(
      measureAllowanceSpend({ build: (exUnits) => agentPay({ exUnits }), ...huge, params: PARAMS }),
    ).rejects.toThrow(/did not converge/);
  });

  it("passes a script failure through: nothing that fails is returned", async () => {
    const evaluate = () =>
      Promise.reject(new ChainError("VALIDATION_FAILED", "script evaluation failed: {}"));
    await expect(
      measureAllowanceSpend({
        build: (exUnits) => agentPay({ exUnits }),
        evaluate,
        params: PARAMS,
      }),
    ).rejects.toThrow(/script evaluation failed/);
  });
});

/** An agent payment built WITHOUT the planner's checks: only the validator decides. */
function uncheckedPay(lovelace: bigint, payee: string, spentAfter: bigint) {
  return planAllowanceUncheckedSpend({
    network: NET,
    ownerKeyHash: OWNER_KH,
    action: "AgentPay",
    from: AGENT,
    allowance: ALLOWANCE,
    outputs: [
      {
        address: SCRIPT.address,
        value: { coin: ALLOWANCE.value.coin - lovelace, assets: new Map() },
        inlineDatum: encodeAllowanceDatum({ ...DATUM, spentInPeriod: spentAfter }),
      },
      { address: payee, value: { coin: lovelace, assets: new Map() } },
    ],
    utxos: agentUtxos,
    params: PARAMS,
    validityStartSlot: START_SLOT,
    ttlSlot: TTL_SLOT,
    exUnits: EXUNITS,
  });
}

// --- evaluation against the real validator (aiken tx simulate) ---------------------------

const AIKEN = [
  join(homedir(), ".aiken", "bin", "aiken"),
  "/usr/local/bin/aiken",
  "/opt/homebrew/bin/aiken",
].find((p) => existsSync(p));

/** CBOR of a resolved output (map format; inline datum when given). */
function outputCbor(address: string, coin: bigint, datum?: Uint8Array): Cbor {
  const entries: Array<readonly [Cbor, Cbor]> = [
    [uint(0), bytes(cardanoAddressBytes(address))],
    [uint(1), uint(coin)],
  ];
  if (datum !== undefined) entries.push([uint(2), array([uint(1), tag(24, bytes(datum))])]);
  return map(entries);
}

interface Resolved {
  readonly txHash: string;
  readonly index: number;
  readonly output: Cbor;
}

/**
 * Runs the transaction's scripts with the real validator. `budget` is aiken's measured
 * execution budget when every script succeeded; `out` holds aiken's report otherwise.
 */
function simulate(
  serialized: string,
  resolved: readonly Resolved[],
): { ok: boolean; out: string; budget?: { mem: number; cpu: number } } {
  if (AIKEN === undefined) throw new Error("aiken not installed");
  const dir = mkdtempSync(join(tmpdir(), "zyropay-allowance-"));
  try {
    const inputs = array(resolved.map((r) => array([bytes(hexToBytes(r.txHash)), uint(r.index)])));
    const outputs = array(resolved.map((r) => r.output));
    const files = ["tx", "inputs", "outputs"].map((f) => join(dir, f));
    const [txFile = "", inFile = "", outFile = ""] = files;
    writeFileSync(txFile, serialized);
    writeFileSync(inFile, bytesToHex(encodeCbor(inputs)));
    writeFileSync(outFile, bytesToHex(encodeCbor(outputs)));
    // Preprod slot config, as the planner's validity bounds use.
    const args = ["tx", "simulate", "--zero-time", "1655769600000", "--zero-slot", "86400"];
    try {
      const out = execFileSync(AIKEN, [...args, ...files], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [budget] = JSON.parse(out) as Array<{ mem: number; cpu: number }>;
      return budget === undefined ? { ok: false, out } : { ok: true, out, budget };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A rejection by the validator itself (not a malformed transaction or test setup). */
const VALIDATOR_FAILED = /failed script execution/;

const walletResolved = (
  utxos: ReadonlyArray<{
    tx_hash: string;
    output_index: number;
    amount: ReadonlyArray<{ quantity: string }>;
  }>,
  address: string,
): Resolved[] =>
  utxos.map((u) => ({
    txHash: u.tx_hash,
    index: u.output_index,
    output: outputCbor(address, BigInt(u.amount[0]?.quantity ?? "0")),
  }));

/** The allowance UTxO as it is on chain (its REAL datum, whatever the planner was told). */
const onChainAllowance = (datum: AllowanceDatum = DATUM): Resolved => ({
  txHash: ALLOWANCE.txHash,
  index: ALLOWANCE.index,
  output: outputCbor(SCRIPT.address, ALLOWANCE.value.coin, encodeAllowanceDatum(datum)),
});

describe.skipIf(AIKEN === undefined)("allowance transactions under the validator (aiken)", () => {
  it("accepts the agent payment the planner builds, within the budgeted units", () => {
    const r = simulate(agentPay().serialized, [
      onChainAllowance(),
      ...walletResolved(agentUtxos, AGENT),
    ]);
    expect(r.ok, r.out).toBe(true);
    expect(BigInt(r.budget?.mem ?? Infinity)).toBeLessThan(EXUNITS.mem);
    expect(BigInt(r.budget?.cpu ?? Infinity)).toBeLessThan(EXUNITS.steps);
  });

  it("accepts a payment into a listed script payee (a Masumi escrow address)", () => {
    const escrow = masumiEscrowAddress(NET);
    const datum = {
      ...DATUM,
      allowedPayees: [{ kind: "script" as const, hash: MASUMI_SCRIPT_HASH }],
    };
    const plan = agentPay({ allowance: { ...ALLOWANCE, datum }, payee: escrow });
    const r = simulate(plan.serialized, [
      onChainAllowance(datum),
      ...walletResolved(agentUtxos, AGENT),
    ]);
    expect(r.ok, r.out).toBe(true);
  });

  it("accepts a payment that rolls the period over", () => {
    const old = { ...DATUM, periodStart: PERIOD_START - 2n * DAY, spentInPeriod: 20n * ADA };
    const plan = agentPay({ allowance: { ...ALLOWANCE, datum: old } });
    expect(plan.nextDatum.periodStart).toBe(PERIOD_START);
    const r = simulate(plan.serialized, [
      onChainAllowance(old),
      ...walletResolved(agentUtxos, AGENT),
    ]);
    expect(r.ok, r.out).toBe(true);
  });

  it("accepts the owner's revoke", () => {
    const r = simulate(revoke().serialized, [
      onChainAllowance(),
      ...walletResolved(ownerUtxos, OWNER),
    ]);
    expect(r.ok, r.out).toBe(true);
  });

  it("rejects a payment built from a forged datum (counter reset)", () => {
    // On chain the period is spent; the planner is lied to with a fresh counter.
    const real = { ...DATUM, spentInPeriod: 18n * ADA };
    const r = simulate(agentPay().serialized, [
      onChainAllowance(real),
      ...walletResolved(agentUtxos, AGENT),
    ]);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(VALIDATOR_FAILED);
  });

  it("rejects a payment built from a forged datum (raised per-payment max)", () => {
    const forged = { ...ALLOWANCE, datum: { ...DATUM, perPaymentMax: 10n * ADA } };
    const plan = agentPay({ allowance: forged, lovelace: 8n * ADA });
    const r = simulate(plan.serialized, [onChainAllowance(), ...walletResolved(agentUtxos, AGENT)]);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(VALIDATOR_FAILED);
  });

  it("rejects a payment to a payee the on-chain datum does not list", () => {
    const forged = { ...ALLOWANCE, datum: { ...DATUM, allowedPayees: [] } };
    const plan = agentPay({ allowance: forged, payee: OWNER });
    const r = simulate(plan.serialized, [onChainAllowance(), ...walletResolved(agentUtxos, AGENT)]);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(VALIDATOR_FAILED);
  });

  it("unchecked spends: the validator refuses each limit breach on its own", () => {
    expect(codeOf(() => encodeAllowanceDatum({ ...DATUM, spentInPeriod: 21n * ADA }))).toMatch(
      /exceeds periodCap/,
    );
    const resolved = [onChainAllowance(), ...walletResolved(agentUtxos, AGENT)];
    // Control: the same shape within every limit is accepted.
    expect(simulate(uncheckedPay(3n * ADA, PAYEE, 3n * ADA).serialized, resolved).ok).toBe(true);
    // Over the per-payment maximum (5 ADA), with an honest counter.
    const over = simulate(uncheckedPay(6n * ADA, PAYEE, 6n * ADA).serialized, resolved);
    expect(over.out).toMatch(VALIDATOR_FAILED);
    // A payee the datum does not list.
    const stranger = simulate(uncheckedPay(3n * ADA, OWNER, 3n * ADA).serialized, resolved);
    expect(stranger.out).toMatch(VALIDATOR_FAILED);
    // Over the period cap (20 ADA) with 18 already spent.
    const spent = { ...DATUM, spentInPeriod: 18n * ADA };
    const capped = planAllowanceUncheckedSpend({
      network: NET,
      ownerKeyHash: OWNER_KH,
      action: "AgentPay",
      from: AGENT,
      allowance: ALLOWANCE,
      outputs: [
        {
          address: SCRIPT.address,
          value: { coin: ALLOWANCE.value.coin - 3n * ADA, assets: new Map() },
          inlineDatum: encodeAllowanceDatum(
            { ...spent, spentInPeriod: 21n * ADA },
            { unchecked: true },
          ),
        },
        { address: PAYEE, value: { coin: 3n * ADA, assets: new Map() } },
      ],
      utxos: agentUtxos,
      params: PARAMS,
      validityStartSlot: START_SLOT,
      ttlSlot: TTL_SLOT,
      exUnits: EXUNITS,
    });
    const r = simulate(capped.serialized, [
      onChainAllowance(spent),
      ...walletResolved(agentUtxos, AGENT),
    ]);
    expect(r.out).toMatch(VALIDATOR_FAILED);
  });
});

describe("the device-side derivation in @zyropay/shared matches the builders", () => {
  it("same applied script, script hash, address and datum bytes", async () => {
    const shared = await import("@zyropay/shared");
    expect(bytesToHex(shared.allowanceAppliedScript(OWNER_KH))).toBe(bytesToHex(SCRIPT.script));
    expect(shared.allowanceScriptHash(OWNER_KH)).toBe(SCRIPT.scriptHash);
    expect(shared.allowanceScriptAddress(NET, OWNER_KH)).toBe(SCRIPT.address);
    const view = {
      agentKeyHash: DATUM.agentKeyHash,
      perPaymentMax: DATUM.perPaymentMax.toString(),
      periodMs: DATUM.periodMs.toString(),
      periodCap: DATUM.periodCap.toString(),
      periodStart: DATUM.periodStart.toString(),
      spentInPeriod: DATUM.spentInPeriod.toString(),
      allowedPayees: [...DATUM.allowedPayees, { kind: "script" as const, hash: "cd".repeat(28) }],
      expiresAt: DATUM.expiresAt.toString(),
    };
    expect(shared.encodeAllowanceDatumHex(view)).toBe(
      bytesToHex(
        encodeAllowanceDatum({
          ...DATUM,
          allowedPayees: [...DATUM.allowedPayees, { kind: "script", hash: "cd".repeat(28) }],
        }),
      ),
    );
  });
});

describe("planAllowanceFloatSweep", () => {
  const params = { ...PARAMS };
  it("sends every pure-ADA UTxO of the agent to the owner in one output, no change", async () => {
    const { planAllowanceFloatSweep } = await import("../cardano/allowance");
    const plan = planAllowanceFloatSweep({
      network: NET,
      from: AGENT,
      to: OWNER,
      utxos: agentUtxos,
      params,
      ttlSlot: TTL_SLOT,
    });
    expect(plan).not.toBeNull();
    const tx = decodeCardanoTx(hexToBytes(plan?.serialized ?? ""));
    expect(tx.inputs).toHaveLength(2);
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0]?.value.coin).toBe(11_000_000n - (plan?.fee ?? 0n));
    expect(tx.outputs[0]?.address).toBe(OWNER);
  });
  it("returns null when nothing worth sending is left", async () => {
    const { planAllowanceFloatSweep } = await import("../cardano/allowance");
    const dust = [{ ...utxo("9", 0, "900000"), address: AGENT }];
    expect(
      planAllowanceFloatSweep({
        network: NET,
        from: AGENT,
        to: OWNER,
        utxos: dust,
        params,
        ttlSlot: TTL_SLOT,
      }),
    ).toBeNull();
    expect(
      planAllowanceFloatSweep({
        network: NET,
        from: AGENT,
        to: OWNER,
        utxos: [],
        params,
        ttlSlot: TTL_SLOT,
      }),
    ).toBeNull();
  });
});
