import {
  allowancePayeeOf,
  allowanceScriptAddress,
  cardanoEnterpriseAddress,
  cardanoPaymentKeyHash,
  type AllowanceDatumView,
  type AllowanceMoney,
  type AllowanceReview,
  type AllowanceSpend,
  type CardanoAllowance,
  type CreateAllowanceBody,
} from "@zyropay/shared";
import { fiatToLovelace } from "@/lib/allowance";
import { mockCreateTx, mockOwnerSpendTx, slotAlignedIso, type MockTx } from "./allowance-tx";
import { fakeHex, fakeId, iso } from "./fixtures";

/*
 * DEV MOCK: the agent's Cardano auto-pay allowance (docs/AUTOPAY.md). Every review carries a
 * real unsigned transaction (allowance-tx.ts), so the app's on-device checks run on it as on
 * the real API's. After the passkey: creating -> active, revoking -> revoked a few seconds
 * later; once active the simulated agent pays the seller from it (no tap) and then asks for
 * one payment over the limits, which comes to the phone (ALLOWANCE_LIMIT_EXCEEDED).
 */

export const ALLOWANCE_TIMING = {
  /** Submitted -> on chain. */
  confirmMs: 5_000,
  /** Active -> the agent's first auto-payment. */
  firstPaymentMs: 3_000,
} as const;

/** Simulated ADA price per currency (the USD one matches the fixtures' PRICES.ADA). */
export const MOCK_ADA_PRICE = { USD: "0.52", EUR: "0.48" } as const;

const DAY_MS = 86_400_000;
const FEE = 182_000n;
const SPEND_FEE = 312_000n;
const RESIDUE = 2_000_000n;
/** What the simulated wallet holds in plain ADA (fixtures: 250 ADA received). */
const WALLET_LOVELACE = 250_000_000n;

export class AllowanceMockError extends Error {
  constructor(
    readonly code:
      | "CONFLICT"
      | "NOT_FOUND"
      | "PAYLOAD_HASH_MISMATCH"
      | "INSUFFICIENT_FUNDS"
      | "VALIDATION_FAILED",
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  readonly action: AllowanceReview["action"];
  readonly bodyHash: string;
  readonly validUntil: number;
  /** top_up: the new balance. */
  readonly newLovelace?: bigint;
}

export interface MockAllowance {
  allowance: CardanoAllowance;
  balance: bigint;
  spent: bigint;
  periodStart: number;
  pending: Pending | null;
  /** When the chain "confirms" the submitted transaction. */
  confirmAt: number | null;
  activeAt: number | null;
  /** The simulated agent's payments have run. */
  paid: boolean;
  spends: AllowanceSpend[];
}

export interface AllowanceOwner {
  readonly walletId: string;
  readonly ownerAddress: string;
  /** The wallet's Cardano public key (the passkey signs with it). */
  readonly ownerPublicKey: string;
}

function lovelaceOf(m: AllowanceMoney): bigint {
  if ("lovelace" in m) return BigInt(m.lovelace);
  const l = fiatToLovelace(m.fiat.amount, MOCK_ADA_PRICE[m.fiat.currency]);
  if (l === null) throw new AllowanceMockError("VALIDATION_FAILED", "invalid amount");
  return l;
}

function fiatOf(body: CreateAllowanceBody): CardanoAllowance["limits"]["fiat"] {
  const all = [body.budget, body.perPayment, body.perDay];
  const fiat = all.find((m) => "fiat" in m);
  if (fiat === undefined || !("fiat" in fiat)) return null;
  const currency = fiat.fiat.currency;
  const amount = (m: AllowanceMoney) =>
    "fiat" in m && m.fiat.currency === currency ? m.fiat.amount : null;
  return {
    currency,
    perPayment: amount(body.perPayment),
    perDay: amount(body.perDay),
    budget: amount(body.budget),
    adaPrice: MOCK_ADA_PRICE[currency],
    pricedAt: iso(0),
  };
}

function datumOf(m: MockAllowance, spent = m.spent): AllowanceDatumView {
  const a = m.allowance;
  const agentKh = cardanoPaymentKeyHash(a.agentAddress) ?? "";
  return {
    agentKeyHash: agentKh,
    perPaymentMax: a.limits.perPaymentLovelace,
    periodMs: a.limits.periodMs,
    periodCap: a.limits.perDayLovelace,
    periodStart: String(m.periodStart),
    spentInPeriod: spent.toString(),
    allowedPayees:
      a.limits.payees.mode === "any"
        ? []
        : a.limits.payees.addresses.flatMap((x) => {
            const p = allowancePayeeOf(x);
            return p === null ? [] : [p];
          }),
    expiresAt: String(Date.parse(a.limits.expiresAt)),
  };
}

function review(
  m: MockAllowance,
  owner: AllowanceOwner,
  action: AllowanceReview["action"],
  tx: MockTx,
  fee: bigint,
  expect: AllowanceReview["expect"],
  validUntil: number,
): AllowanceReview {
  return {
    action,
    allowanceId: m.allowance.id,
    unsignedTransaction: { encoding: "hex", serialized: tx.hex },
    rawPayload: {
      kind: "cardano_tx_body_hash",
      payload: tx.bodyHash,
      signWith: owner.ownerPublicKey,
    },
    estimatedFee: { lovelace: fee.toString() },
    validUntil: new Date(validUntil).toISOString(),
    expect,
  };
}

function view(m: MockAllowance, now: number): CardanoAllowance {
  const a = m.allowance;
  const onChain =
    m.activeAt === null && a.status !== "revoking"
      ? null
      : (() => {
          const periodEnds = m.periodStart + DAY_MS;
          const rolled = now >= periodEnds;
          const spent = rolled ? 0n : m.spent;
          const cap = BigInt(a.limits.perDayLovelace);
          const usable = m.balance > RESIDUE ? m.balance - RESIDUE : 0n;
          const remaining = cap - spent < usable ? cap - spent : usable;
          const per = BigInt(a.limits.perPaymentLovelace);
          return {
            utxo: `${a.lastTxHash ?? a.createTxHash ?? fakeHex(70, 32)}#0`,
            balanceLovelace: m.balance.toString(),
            spentInPeriodLovelace: spent.toString(),
            periodStart: new Date(rolled ? now : m.periodStart).toISOString(),
            periodEndsAt: new Date(rolled ? now + DAY_MS : periodEnds).toISOString(),
            remainingTodayLovelace: (remaining > 0n ? remaining : 0n).toString(),
            availableNowLovelace: (remaining < per
              ? remaining > 0n
                ? remaining
                : 0n
              : per
            ).toString(),
            readAt: new Date(now).toISOString(),
          };
        })();
  return {
    ...a,
    onChain,
    float:
      m.activeAt === null
        ? null
        : {
            lovelace: a.floatLovelace,
            low: BigInt(a.floatLovelace) < 2_000_000n,
            readAt: new Date(now).toISOString(),
          },
  };
}

/** Walk a submitted allowance forward to `now` (the chain confirming it). */
export function advanceAllowance(m: MockAllowance, now: number): void {
  if (m.confirmAt === null || now < m.confirmAt) return;
  const a = m.allowance;
  m.confirmAt = null;
  if (a.status === "creating") {
    m.activeAt = now;
    m.allowance = { ...a, status: "active", updatedAt: new Date(now).toISOString() };
  } else if (a.status === "revoking") {
    m.balance = 0n;
    m.allowance = { ...a, status: "revoked", updatedAt: new Date(now).toISOString() };
  }
}

export function allowanceView(m: MockAllowance | undefined, now: number): CardanoAllowance | null {
  if (m === undefined) return null;
  advanceAllowance(m, now);
  if (m.allowance.status === "active" && Date.parse(m.allowance.limits.expiresAt) <= now)
    m.allowance = { ...m.allowance, status: "expired" };
  return view(m, now);
}

function isLive(m: MockAllowance | undefined): boolean {
  return m !== undefined && m.allowance.status !== "revoked" && m.allowance.status !== "failed";
}

/** POST create: a new pending allowance (or a rebuild of the pending one). */
export function createAllowance(
  existing: MockAllowance | undefined,
  agentId: string,
  owner: AllowanceOwner,
  body: CreateAllowanceBody,
  n: number,
  now: number,
): { m: MockAllowance; allowance: CardanoAllowance; review: AllowanceReview } {
  if (isLive(existing) && existing?.allowance.status !== "pending_create")
    throw new AllowanceMockError("CONFLICT", "this agent already has an allowance");
  const budget = lovelaceOf(body.budget);
  const per = lovelaceOf(body.perPayment);
  const day = lovelaceOf(body.perDay);
  const float = BigInt(body.floatLovelace ?? "5000000");
  if (per > day) throw new AllowanceMockError("VALIDATION_FAILED", "perPayment exceeds perDay");
  if (budget + float + FEE > WALLET_LOVELACE)
    throw new AllowanceMockError("INSUFFICIENT_FUNDS", "not enough ADA");
  const ownerKh = cardanoPaymentKeyHash(owner.ownerAddress) ?? "";
  const reuse = existing?.allowance.status === "pending_create" ? existing : undefined;
  const id = reuse?.allowance.id ?? fakeId(20, n);
  const agentAddress =
    reuse?.allowance.agentAddress ??
    cardanoEnterpriseAddress(fakeHex(40 + n, 32), "cardano-preprod");
  const expiresAt = new Date(
    Math.floor((now + body.expiresInDays * DAY_MS) / 1000) * 1000,
  ).toISOString();
  const allowance: CardanoAllowance = {
    id,
    agentId,
    walletId: owner.walletId,
    network: "cardano-preprod",
    status: "pending_create",
    ownerAddress: owner.ownerAddress,
    scriptAddress: allowanceScriptAddress("cardano-preprod", ownerKh),
    agentAddress,
    limits: {
      perPaymentLovelace: per.toString(),
      perDayLovelace: day.toString(),
      periodMs: String(DAY_MS),
      expiresAt,
      payees: body.payees,
      fiat: fiatOf(body),
    },
    budgetLovelace: budget.toString(),
    floatLovelace: float.toString(),
    onChain: null,
    float: null,
    createTxHash: null,
    lastTxHash: null,
    inFlightRequestId: null,
    createdAt: reuse?.allowance.createdAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const m: MockAllowance = {
    allowance,
    balance: budget,
    spent: 0n,
    periodStart: Math.floor(now / 1000) * 1000 - 60_000,
    pending: null,
    confirmAt: null,
    activeAt: null,
    paid: false,
    spends: [],
  };
  const datum = datumOf(m, 0n);
  const validUntil = Math.floor((now + 10 * 60_000) / 1000) * 1000;
  const tx = mockCreateTx({
    fundingUtxo: `${fakeHex(80 + n, 32)}#1`,
    owner: owner.ownerAddress,
    script: allowance.scriptAddress,
    agent: agentAddress,
    allowanceLovelace: budget,
    floatLovelace: float,
    changeLovelace: WALLET_LOVELACE - budget - float - FEE,
    datum,
    fee: FEE,
    ttlMs: validUntil,
  });
  m.pending = { action: "create", bodyHash: tx.bodyHash, validUntil };
  const r = review(
    m,
    owner,
    "create",
    tx,
    FEE,
    {
      kind: "create",
      owner: owner.ownerAddress,
      ownerKeyHash: ownerKh,
      agentAddress,
      allowanceLovelace: budget.toString(),
      floatLovelace: float.toString(),
      datum,
      maxFeeLovelace: "1000000",
    },
    validUntil,
  );
  return { m, allowance: view(m, now), review: r };
}

/** POST top-up / revoke: build the owner spend. */
export function ownerSpend(
  m: MockAllowance | undefined,
  owner: AllowanceOwner,
  action: "top_up" | "revoke",
  add: AllowanceMoney | null,
  n: number,
  now: number,
): { allowance: CardanoAllowance; review: AllowanceReview } {
  if (m === undefined) throw new AllowanceMockError("NOT_FOUND", "this agent has no allowance");
  advanceAllowance(m, now);
  const a = m.allowance;
  const allowed =
    action === "top_up"
      ? a.status === "active" || a.status === "exhausted"
      : a.status === "active" || a.status === "exhausted" || a.status === "expired";
  if (!allowed) throw new AllowanceMockError("CONFLICT", `not possible while ${a.status}`);
  if (a.inFlightRequestId !== null)
    throw new AllowanceMockError("CONFLICT", "a payment from the allowance is still confirming");
  const current = view(m, now);
  const utxo = current.onChain?.utxo ?? "";
  const validFrom = Math.floor((now - 60_000) / 1000) * 1000;
  const validUntil = Math.floor((now + 10 * 60_000) / 1000) * 1000;
  const added = action === "top_up" && add !== null ? lovelaceOf(add) : 0n;
  if (action === "top_up" && added <= 0n)
    throw new AllowanceMockError("VALIDATION_FAILED", "nothing to add");
  const newLovelace = m.balance + added;
  const datum = datumOf(m);
  const tx = mockOwnerSpendTx({
    utxo,
    walletUtxo: `${fakeHex(90 + n, 32)}#2`,
    owner: owner.ownerAddress,
    script: a.scriptAddress,
    cont: action === "top_up" ? { lovelace: newLovelace, datum } : null,
    ownerLovelace:
      action === "top_up" ? 40_000_000n - added - SPEND_FEE : m.balance + 40_000_000n - SPEND_FEE,
    fee: SPEND_FEE,
    validFromMs: validFrom,
    validUntilMs: validUntil,
  });
  m.pending = { action, bodyHash: tx.bodyHash, validUntil, newLovelace };
  const common = {
    owner: owner.ownerAddress,
    utxo,
    maxFeeLovelace: "1000000",
    validFrom: slotAlignedIso(validFrom),
    validUntil: slotAlignedIso(validUntil),
  };
  return {
    allowance: current,
    review: review(
      m,
      owner,
      action,
      tx,
      SPEND_FEE,
      action === "top_up"
        ? { kind: "top_up", ...common, newLovelace: newLovelace.toString(), datum }
        : { kind: "revoke", ...common },
      validUntil,
    ),
  };
}

/** POST submit: the passkey-stamped body hash of the pending build. */
export function submitAllowance(
  m: MockAllowance | undefined,
  bodyHash: string,
  txHash: string,
  now: number,
): CardanoAllowance {
  if (m === undefined) throw new AllowanceMockError("NOT_FOUND", "this agent has no allowance");
  const p = m.pending;
  if (p === null) throw new AllowanceMockError("CONFLICT", "nothing is waiting for a signature");
  if (p.bodyHash !== bodyHash)
    throw new AllowanceMockError("PAYLOAD_HASH_MISMATCH", "the body hash is not the pending build");
  if (now > p.validUntil)
    throw new AllowanceMockError("CONFLICT", "the build expired; prepare it again");
  m.pending = null;
  const at = new Date(now).toISOString();
  const a = m.allowance;
  if (p.action === "create") {
    m.allowance = {
      ...a,
      status: "creating",
      createTxHash: txHash,
      lastTxHash: txHash,
      updatedAt: at,
    };
    m.confirmAt = now + ALLOWANCE_TIMING.confirmMs;
  } else if (p.action === "top_up") {
    const prev = m.balance;
    m.balance = p.newLovelace ?? m.balance;
    m.allowance = {
      ...a,
      status: "active",
      budgetLovelace: (BigInt(a.budgetLovelace) + m.balance - prev).toString(),
      lastTxHash: txHash,
      updatedAt: at,
    };
  } else {
    m.allowance = { ...a, status: "revoking", lastTxHash: txHash, updatedAt: at };
    m.confirmAt = now + ALLOWANCE_TIMING.confirmMs;
  }
  return view(m, now);
}

/**
 * The simulated agent pays from the allowance: returns the payment when one is due (once,
 * `firstPaymentMs` after activation) and records it on the allowance.
 */
export function duePayment(
  m: MockAllowance | undefined,
  payee: string,
  lovelace: bigint,
  requestId: string,
  txHash: string,
  now: number,
): AllowanceSpend | null {
  if (m === undefined || m.paid || m.activeAt === null) return null;
  if (m.allowance.status !== "active" || now < m.activeAt + ALLOWANCE_TIMING.firstPaymentMs)
    return null;
  m.paid = true;
  m.balance -= lovelace;
  m.spent += lovelace;
  m.allowance = { ...m.allowance, lastTxHash: txHash, updatedAt: new Date(now).toISOString() };
  const spend: AllowanceSpend = {
    id: fakeId(21, m.spends.length + 1),
    requestId,
    tool: "pay_x402",
    payee,
    lovelace: lovelace.toString(),
    txHash,
    status: "confirmed",
    createdAt: new Date(now).toISOString(),
  };
  m.spends.unshift(spend);
  return spend;
}
