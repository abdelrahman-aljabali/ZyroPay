import {
  allowancePayeeOf,
  allowanceScriptAddress,
  cardanoEnterpriseAddress,
  cardanoPaymentKeyHash,
  cardanoUnsignedBodyHash,
  checkCardanoAllowanceCreateTx,
  checkCardanoAllowanceOwnerSpendTx,
  explorerTxUrl,
  type AllowanceDatumView,
  type AllowanceMoney,
  type AllowancePayees,
  type AllowanceReview,
  type CardanoAllowance,
  type CreateAllowanceBody,
  type NetworkId,
  type TransactionRequest,
} from "@zyropay/shared";
import { formatDateTime, formatFiat, formatTokenAmount, shortenAddress } from "@zyropay/ui/format";
import { txMismatch } from "./review";

/*
 * Auto-pay on Cardano (docs/AUTOPAY.md), unit-tested: the setup draft and its validation,
 * ADA <-> fiat previews, how an allowance reads on the card, the review sheet and the
 * on-device check of every transaction the passkey signs for it. The Cardano validator
 * enforces the limits; the app only explains them and refuses to sign anything that does not
 * do exactly what it shows.
 */

/** The only network auto-pay runs on (preprod; the contract is not audited). */
export const ALLOWANCE_NETWORK = "cardano-preprod" satisfies NetworkId;

export type FiatCurrency = "EUR" | "USD";
/** What the amounts in the setup form are typed in. */
export type MoneyUnit = "ADA" | FiatCurrency;

const LOVELACE_PER_ADA = 1_000_000n;
/** Lovelace the allowance output always keeps (min-UTxO with its datum): comes back on revoke. */
const ALLOWANCE_RESIDUE_LOVELACE = 2_000_000n;
/** Smallest per-payment max worth setting: Cardano refuses outputs below ~1 ADA. */
const MIN_PER_PAYMENT_LOVELACE = 1_000_000n;
const FLOAT_MIN_ADA = 3;
const FLOAT_MAX_ADA = 20;
export const EXPIRY_CHOICES = [7, 30] as const;
const EXPIRY_MIN_DAYS = 1;
const EXPIRY_MAX_DAYS = 90;
/** Most payees the datum holds. */
export const MAX_PAYEES = 16;

// --- amounts ---------------------------------------------------------------------------

/**
 * "50 ADA", "2.5 ADA": exact when it has at most 2 decimals; otherwise rounded to 2 and marked
 * "≈ 20.83 ADA" (limits converted from fiat would read "20.833333 ADA").
 */
export function ada(lovelace: string | bigint): string {
  const v = BigInt(lovelace);
  if (v % 10_000n === 0n) {
    return formatTokenAmount(v.toString(), 6, { symbol: "ADA", maxFractionDigits: 2 });
  }
  return `≈ ${formatTokenAmount(v.toString(), 6, { symbol: "ADA", maxFractionDigits: 2 })}`;
}

/** "≈ 20.8 ADA": a preview, 2 decimals at most. */
function adaRounded(lovelace: bigint): string {
  return formatTokenAmount(lovelace.toString(), 6, { symbol: "ADA", maxFractionDigits: 2 });
}

const AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d+)?$/;

/**
 * A typed amount as a plain decimal ("12,50" -> "12.50"), or null when it isn't one. ADA keeps
 * up to 6 decimals, fiat up to 2.
 */
export function normalizeAmount(text: string, unit: MoneyUnit): string | null {
  const t = text.trim().replace(",", ".");
  if (!AMOUNT_RE.test(t)) return null;
  const frac = t.split(".")[1] ?? "";
  if (frac.length > (unit === "ADA" ? 6 : 2)) return null;
  return t;
}

/** Keep only what an amount field accepts while typing. */
export function amountKeystrokes(text: string): string {
  return text.replace(/[^0-9.,]/g, "").replace(",", ".");
}

/** Decimal string -> integer scaled by 10^digits (exact; the input is already validated). */
function scaled(decimal: string, digits: number): bigint {
  const [whole = "0", frac = ""] = decimal.split(".");
  return BigInt(whole + frac.padEnd(digits, "0").slice(0, digits));
}

/** Fiat amount -> lovelace at `price` (fiat per ADA), rounded down. */
export function fiatToLovelace(amount: string, price: string): bigint | null {
  if (!AMOUNT_RE.test(amount) || !AMOUNT_RE.test(price)) return null;
  const p = scaled(price, 12);
  if (p === 0n) return null;
  return (scaled(amount, 12) * LOVELACE_PER_ADA) / p;
}

/** Lovelace -> fiat decimal at `price`, rounded to the cent (half up). */
export function lovelaceToFiat(lovelace: bigint, price: string): string | null {
  if (!AMOUNT_RE.test(price)) return null;
  const cents2 = (lovelace * scaled(price, 12) * 1000n) / (LOVELACE_PER_ADA * 10n ** 12n);
  const cents = (cents2 + 5n) / 10n;
  return `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Lovelace of a typed amount: exact for ADA, at the live price for fiat (null without one). */
export function amountToLovelace(
  amount: string,
  unit: MoneyUnit,
  price: string | null,
): bigint | null {
  const n = normalizeAmount(amount, unit);
  if (n === null) return null;
  if (unit === "ADA") return scaled(n, 6);
  return price === null ? null : fiatToLovelace(n, price);
}

/** What the API gets for a typed amount: lovelace for ADA, fiat to convert at creation. */
export function moneyOf(amount: string, unit: MoneyUnit): AllowanceMoney | null {
  const n = normalizeAmount(amount, unit);
  if (n === null) return null;
  return unit === "ADA"
    ? { lovelace: scaled(n, 6).toString() }
    : { fiat: { currency: unit, amount: n } };
}

/** The live preview under an amount field: "≈ €10.00" for ADA, "≈ 20.83 ADA" for fiat. */
export function conversionPreview(
  amount: string,
  unit: MoneyUnit,
  price: { readonly value: string; readonly currency: FiatCurrency } | null,
): string | null {
  const n = normalizeAmount(amount, unit);
  if (n === null || price === null) return null;
  if (unit === "ADA") {
    const fiat = lovelaceToFiat(scaled(n, 6), price.value);
    return fiat === null ? null : `≈ ${formatFiat(fiat, price.currency)}`;
  }
  if (unit !== price.currency) return null;
  const l = fiatToLovelace(n, price.value);
  return l === null ? null : `≈ ${adaRounded(l)}`;
}

/** An amount in another unit, for switching the form's unit ("10" EUR -> "20.83" ADA). */
export function convertAmount(
  amount: string,
  from: MoneyUnit,
  to: MoneyUnit,
  price: { readonly value: string; readonly currency: FiatCurrency } | null,
): string {
  if (from === to) return amount;
  const n = normalizeAmount(amount, from);
  if (n === null || price === null) return amount;
  if (from === "ADA" && to === price.currency)
    return lovelaceToFiat(scaled(n, 6), price.value) ?? amount;
  if (to === "ADA" && from === price.currency) {
    const l = fiatToLovelace(n, price.value);
    if (l === null) return amount;
    // Round to 2 decimals for a readable field.
    const centiAda = (l + 5_000n) / 10_000n;
    const whole = (centiAda / 100n).toString();
    const frac = (centiAda % 100n).toString().padStart(2, "0").replace(/0+$/, "");
    return frac === "" ? whole : `${whole}.${frac}`;
  }
  return amount;
}

// --- the setup draft ---------------------------------------------------------------------

export interface AllowanceDraft {
  readonly walletId: string | null;
  readonly unit: MoneyUnit;
  readonly budget: string;
  readonly perPayment: string;
  readonly perDay: string;
  readonly payeeMode: AllowancePayees["mode"];
  /** Selected payee addresses (list mode). */
  readonly payees: readonly string[];
  readonly expiresInDays: number;
  /** The agent's ADA for network fees, in ADA. */
  readonly floatAda: string;
}

/** Defaults: €10 per payment, €20 a day, €30 budget, 7 days, 5 ADA float, the given payees. */
export function defaultAllowanceDraft(opts: {
  readonly walletId: string | null;
  readonly currency: FiatCurrency;
  readonly payees: readonly string[];
}): AllowanceDraft {
  return {
    walletId: opts.walletId,
    unit: opts.currency,
    budget: "30",
    perPayment: "10",
    perDay: "20",
    payeeMode: "list",
    payees: [...new Set(opts.payees)].slice(0, MAX_PAYEES),
    expiresInDays: 7,
    floatAda: "5",
  };
}

/** A pending (unsigned) allowance as a draft in ADA, to finish or change its setup. */
export function draftFromAllowance(a: CardanoAllowance, now: Date = new Date()): AllowanceDraft {
  const days = Math.round((Date.parse(a.limits.expiresAt) - now.getTime()) / 86_400_000);
  const plain = (l: string) => ada(l).replace(/ ADA$/, "").replace(/,/g, "");
  return {
    walletId: a.walletId,
    unit: "ADA",
    budget: plain(a.budgetLovelace),
    perPayment: plain(a.limits.perPaymentLovelace),
    perDay: plain(a.limits.perDayLovelace),
    payeeMode: a.limits.payees.mode,
    payees: a.limits.payees.mode === "list" ? a.limits.payees.addresses : [],
    expiresInDays: Math.min(EXPIRY_MAX_DAYS, Math.max(EXPIRY_MIN_DAYS, days)),
    floatAda: plain(a.floatLovelace),
  };
}

export type DraftField =
  "wallet" | "budget" | "perPayment" | "perDay" | "payees" | "expiresInDays" | "float";

export interface DraftIssue {
  readonly field: DraftField;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface DraftCheck {
  readonly issues: readonly DraftIssue[];
  /** Errors only: what blocks Continue. */
  readonly ok: boolean;
  /** The create body, when there are no errors. */
  readonly body: CreateAllowanceBody | null;
  /** The limits in lovelace (at the live price for fiat), where known. */
  readonly lovelace: {
    readonly budget: bigint | null;
    readonly perPayment: bigint | null;
    readonly perDay: bigint | null;
    readonly float: bigint | null;
  };
}

const FIELD_NAME: Readonly<Record<"budget" | "perPayment" | "perDay", string>> = {
  budget: "budget",
  perPayment: "max per payment",
  perDay: "max per day",
};

/**
 * Validate the setup form: amounts are positive, max per payment <= max per day, one payment
 * at the max fits the budget (above the 2 ADA the contract keeps), payees are Cardano payment
 * addresses (at most 16, no duplicates), expiry 1..90 days, fee float 3..20 ADA. A budget below
 * a day's max is allowed (the budget simply runs out first) but called out. All three amounts
 * share one unit, so they compare without a price; ADA minimums need the price for fiat.
 */
export function checkAllowanceDraft(draft: AllowanceDraft, price: string | null): DraftCheck {
  const issues: DraftIssue[] = [];
  const err = (field: DraftField, message: string) => {
    issues.push({ field, severity: "error", message });
  };
  if (draft.walletId === null) err("wallet", "Choose the Cardano wallet that funds the allowance.");

  const amounts = {} as Record<"budget" | "perPayment" | "perDay", string | null>;
  for (const key of ["budget", "perPayment", "perDay"] as const) {
    const n = normalizeAmount(draft[key], draft.unit);
    amounts[key] = n;
    if (n === null)
      err(
        key,
        `Enter the ${FIELD_NAME[key]} as a plain amount, like ${draft.unit === "ADA" ? "25 or 12.5" : "25 or 12.50"}.`,
      );
    else if (scaled(n, 6) === 0n) err(key, `The ${FIELD_NAME[key]} must be more than zero.`);
  }
  const unitScaled = (k: "budget" | "perPayment" | "perDay") => {
    const n = amounts[k];
    return n === null ? null : scaled(n, 6);
  };
  const [b, per, day] = [unitScaled("budget"), unitScaled("perPayment"), unitScaled("perDay")];
  const lovelace = {
    budget: amounts.budget === null ? null : amountToLovelace(amounts.budget, draft.unit, price),
    perPayment:
      amounts.perPayment === null ? null : amountToLovelace(amounts.perPayment, draft.unit, price),
    perDay: amounts.perDay === null ? null : amountToLovelace(amounts.perDay, draft.unit, price),
    float: null as bigint | null,
  };
  if (per !== null && day !== null && per > day)
    err("perPayment", "Max per payment can't be more than max per day.");
  if (
    lovelace.perPayment !== null &&
    lovelace.perPayment > 0n &&
    lovelace.perPayment < MIN_PER_PAYMENT_LOVELACE
  )
    err("perPayment", "Max per payment must be at least 1 ADA: Cardano refuses smaller payments.");
  if (
    lovelace.budget !== null &&
    lovelace.budget > 0n &&
    lovelace.budget <= ALLOWANCE_RESIDUE_LOVELACE
  )
    err("budget", "The budget must be more than 2 ADA: the contract always keeps 2 ADA.");
  else if (
    lovelace.budget !== null &&
    lovelace.perPayment !== null &&
    lovelace.perPayment > lovelace.budget - ALLOWANCE_RESIDUE_LOVELACE
  )
    err(
      "budget",
      "The budget can't cover one payment at the max (the contract keeps 2 ADA of it). Raise the budget or lower the max per payment.",
    );
  else if (b !== null && per !== null && per > b)
    err("budget", "The budget can't be less than the max per payment.");
  if (b !== null && day !== null && day > b && issues.every((i) => i.field !== "budget"))
    issues.push({
      field: "perDay",
      severity: "warning",
      message: "The budget is less than a day's max, so the agent could use all of it in one day.",
    });

  if (draft.payeeMode === "list") {
    if (draft.payees.length === 0) err("payees", "Choose at least one payee, or allow any payee.");
    else if (draft.payees.length > MAX_PAYEES)
      err("payees", `At most ${String(MAX_PAYEES)} payees fit in the allowance.`);
    else if (new Set(draft.payees).size !== draft.payees.length)
      err("payees", "A payee is on the list twice.");
    else if (draft.payees.some((p) => !isAllowancePayee(p)))
      err("payees", "Every payee must be a Cardano Preprod address (addr_test1…).");
  }

  if (
    !Number.isInteger(draft.expiresInDays) ||
    draft.expiresInDays < EXPIRY_MIN_DAYS ||
    draft.expiresInDays > EXPIRY_MAX_DAYS
  )
    err(
      "expiresInDays",
      `The allowance must expire in ${String(EXPIRY_MIN_DAYS)} to ${String(EXPIRY_MAX_DAYS)} days.`,
    );

  const f = normalizeAmount(draft.floatAda, "ADA");
  if (f === null) err("float", "Enter the agent's ADA for fees as a plain amount, like 5.");
  else {
    lovelace.float = scaled(f, 6);
    if (
      lovelace.float < BigInt(FLOAT_MIN_ADA) * LOVELACE_PER_ADA ||
      lovelace.float > BigInt(FLOAT_MAX_ADA) * LOVELACE_PER_ADA
    )
      err(
        "float",
        `The agent's ADA for fees must be ${String(FLOAT_MIN_ADA)} to ${String(FLOAT_MAX_ADA)} ADA.`,
      );
  }

  const ok = issues.every((i) => i.severity !== "error");
  const budget = moneyOf(draft.budget, draft.unit);
  const perPayment = moneyOf(draft.perPayment, draft.unit);
  const perDay = moneyOf(draft.perDay, draft.unit);
  const body: CreateAllowanceBody | null =
    ok && draft.walletId !== null && budget && perPayment && perDay && lovelace.float !== null
      ? {
          walletId: draft.walletId,
          network: ALLOWANCE_NETWORK,
          budget,
          perPayment,
          perDay,
          payees:
            draft.payeeMode === "any"
              ? { mode: "any" }
              : { mode: "list", addresses: [...draft.payees] },
          expiresInDays: draft.expiresInDays,
          floatLovelace: lovelace.float.toString(),
        }
      : null;
  return { issues, ok, body, lovelace };
}

/** A Cardano Preprod address with a payment credential (what the datum lists). */
export function isAllowancePayee(address: string): boolean {
  const a = address.trim();
  return a.startsWith("addr_test1") && allowancePayeeOf(a) !== null;
}

/**
 * Payees to offer: the agent's Cardano recipient allowlist first (with labels), then the
 * sellers it paid with x402 on Cardano Preprod (direct payments only, not escrow), deduplicated.
 */
export function suggestedPayees(
  allowlist: readonly {
    readonly family: string;
    readonly address: string;
    readonly label?: string | null | undefined;
  }[],
  requests: readonly Pick<TransactionRequest, "payload">[],
): { readonly address: string; readonly label: string }[] {
  const out = new Map<string, string>();
  for (const r of allowlist)
    if (r.family === "cardano" && isAllowancePayee(r.address) && !out.has(r.address))
      out.set(r.address, r.label ?? "Allowed recipient");
  for (const { payload: p } of requests) {
    if (p.network !== ALLOWANCE_NETWORK || p.tool !== "pay_x402" || !isAllowancePayee(p.to))
      continue;
    if (p.pluginData?.escrow !== undefined) continue;
    if (out.has(p.to)) continue;
    const url = p.pluginData?.resourceUrl;
    let host = "x402 seller";
    if (typeof url === "string")
      try {
        host = `x402 seller · ${new URL(url).host}`;
      } catch {
        // keep the generic label
      }
    out.set(p.to, host);
  }
  return [...out].map(([address, label]) => ({ address, label })).slice(0, MAX_PAYEES * 2);
}

// --- how an allowance reads --------------------------------------------------------------

export type AllowanceTone = "success" | "caution" | "neutral" | "danger";

export interface AllowanceStatusView {
  readonly label: string;
  readonly tone: AllowanceTone;
  readonly message: string;
}

export function allowanceStatusView(a: CardanoAllowance): AllowanceStatusView {
  switch (a.status) {
    case "pending_create":
      return {
        label: "Not signed yet",
        tone: "caution",
        message: "Set up but not signed. Finish with your passkey, or nothing is locked.",
      };
    case "creating":
      return {
        label: "Creating",
        tone: "neutral",
        message: "Sent to Cardano. It becomes active once the network confirms it (about 20 s).",
      };
    case "active":
      return a.inFlightRequestId !== null
        ? {
            label: "Active",
            tone: "success",
            message: "A payment is confirming on Cardano. The next one waits for it.",
          }
        : {
            label: "Active",
            tone: "success",
            message: "Payments within these limits go through without asking you.",
          };
    case "exhausted":
      return {
        label: "Used up",
        tone: "caution",
        message: "Less than one payment is left. Top it up, or revoke to get the rest back.",
      };
    case "expired":
      return {
        label: "Expired",
        tone: "neutral",
        message: "Payments now come to you again. Revoke to get what's left back to your wallet.",
      };
    case "revoking":
      return {
        label: "Revoking",
        tone: "neutral",
        message: "Returning everything to your wallet. Waiting for Cardano to confirm…",
      };
    case "revoked":
      return {
        label: "Revoked",
        tone: "neutral",
        message: "Everything went back to your wallet and the agent's key was destroyed.",
      };
    case "failed":
      return {
        label: "Didn't go through",
        tone: "danger",
        message: "The allowance was never created on Cardano. Nothing was locked.",
      };
  }
}

/** Shown as a card (anything but gone). */
export function isLiveAllowance(a: CardanoAllowance | null | undefined): boolean {
  return a != null && a.status !== "revoked" && a.status !== "failed";
}

/** Poll interval for getAgentAllowance: fast while the chain is about to change it. */
export function allowancePollMs(a: CardanoAllowance | null | undefined): number | false {
  if (a == null) return false;
  if (a.status === "creating" || a.status === "revoking" || a.inFlightRequestId !== null)
    return 5_000;
  if (a.status === "active" || a.status === "exhausted") return 30_000;
  return false;
}

export interface AllowanceActions {
  readonly topUp: boolean;
  readonly revoke: boolean;
  /** pending_create: sign it (or change it) from the setup screen. */
  readonly finish: boolean;
}

export function allowanceActions(a: CardanoAllowance): AllowanceActions {
  return {
    topUp: a.status === "active" || a.status === "exhausted",
    revoke: a.status === "active" || a.status === "exhausted" || a.status === "expired",
    finish: a.status === "pending_create",
  };
}

/** Spent today against the day's cap, for the progress bar. */
export function spentToday(a: CardanoAllowance): {
  readonly spent: bigint;
  readonly cap: bigint;
  /** 0..1 */
  readonly fraction: number;
  readonly label: string;
} | null {
  if (a.onChain === null) return null;
  const spent = BigInt(a.onChain.spentInPeriodLovelace);
  const cap = BigInt(a.limits.perDayLovelace);
  const fraction = cap === 0n ? 0 : Math.min(1, Number((spent * 10_000n) / cap) / 10_000);
  return { spent, cap, fraction, label: `${ada(spent)} of ${ada(cap)}` };
}

/** "€10.00 (20.83 ADA)" when the limit was set in fiat, "5 ADA" otherwise. */
export function limitLabel(
  lovelace: string,
  fiat: string | null | undefined,
  currency: FiatCurrency | undefined,
): string {
  return fiat != null && currency !== undefined
    ? `${formatFiat(fiat, currency)} (${ada(lovelace)})`
    : ada(lovelace);
}

export function payeesLabel(p: AllowancePayees): string {
  if (p.mode === "any") return "Any payee";
  return p.addresses.length === 1
    ? shortenAddress(p.addresses[0] ?? "", 10, 6)
    : `${String(p.addresses.length)} payees`;
}

/** Cardanoscan page of an address (the network's explorer, address view). */
export function explorerAddressLink(network: NetworkId, address: string): string {
  const tx = explorerTxUrl(network, "TX");
  return tx.replace(/transaction\/TX$/, `address/${encodeURIComponent(address)}`);
}

/**
 * The allowance contract address of every Cardano Preprod wallet: the owner-applied validator
 * is a pure function of the wallet's payment key hash, so the device derives it itself.
 */
export function allowanceAddressesOf(
  wallets: readonly {
    readonly addresses: readonly { readonly family: string; readonly address: string }[];
  }[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const w of wallets)
    for (const a of w.addresses) {
      if (a.family !== "cardano" || !a.address.startsWith("addr_test1")) continue;
      const kh = cardanoPaymentKeyHash(a.address);
      if (kh === null) continue;
      try {
        out.add(allowanceScriptAddress(ALLOWANCE_NETWORK, kh));
      } catch {
        // not a key address: no allowance
      }
    }
  return out;
}

// --- auto-paid requests and fallbacks ---------------------------------------------------

type Reason = { readonly code: string; readonly message: string };

export function isAutoPaid(request: { readonly policyReasons: readonly Reason[] }): boolean {
  return request.policyReasons.some((r) => r.code === "AUTO_PAY_ALLOWANCE");
}

export const AUTO_PAID_LABEL = "Auto-paid · allowance";
export const AUTO_PAID_NOTE =
  "Paid automatically from your on-chain allowance — no approval needed.";

export interface AllowanceFallback {
  readonly code: string;
  readonly title: string;
  readonly message: string;
}

const FALLBACK: Readonly<Record<string, { title: string; message: string }>> = {
  ALLOWANCE_PAYEE_NOT_LISTED: {
    title: "Payee isn't on your auto-pay list",
    message: "Auto-pay only pays the payees you listed, so this one needs your approval.",
  },
  ALLOWANCE_LIMIT_EXCEEDED: {
    title: "Over your auto-pay limits",
    message:
      "It's more than your max per payment, or more than what's left of today's max, so it needs your approval.",
  },
  ALLOWANCE_INSUFFICIENT: {
    title: "Allowance too low",
    message:
      "Your allowance, or the agent's ADA for fees, holds too little for this payment. Top it up, or approve this one.",
  },
  ALLOWANCE_EXPIRED: {
    title: "Auto-pay allowance expired",
    message: "Payments come to you again. Revoke it to get the rest back, or set up a new one.",
  },
  ALLOWANCE_BUSY: {
    title: "Another auto-payment is confirming",
    message:
      "Payments from the allowance go one at a time, and the last one isn't confirmed on Cardano yet.",
  },
  ALLOWANCE_UNAVAILABLE: {
    title: "Auto-pay couldn't be used",
    message:
      "Cardano couldn't be read just now, or this kind of payment isn't auto-paid (only direct ADA payments are).",
  },
};

/** Why a request came to the phone although the agent has an allowance, or null. */
export function allowanceFallback(reasons: readonly Reason[]): AllowanceFallback | null {
  for (const r of reasons) {
    const copy = FALLBACK[r.code];
    if (copy !== undefined) return { code: r.code, ...copy };
  }
  return null;
}

/** Short labels of the auto-pay reason codes (policyReasonText). */
export const ALLOWANCE_REASON_LABEL = {
  AUTO_PAY_ALLOWANCE: "Auto-paid from your allowance",
  ALLOWANCE_PAYEE_NOT_LISTED: "Payee isn't on your auto-pay list",
  ALLOWANCE_LIMIT_EXCEEDED: "Over your auto-pay limits",
  ALLOWANCE_INSUFFICIENT: "Allowance too low",
  ALLOWANCE_EXPIRED: "Auto-pay allowance expired",
  ALLOWANCE_BUSY: "Another auto-payment is confirming",
  ALLOWANCE_UNAVAILABLE: "Auto-pay unavailable",
} as const;

// --- review and on-device verification ----------------------------------------------------

export type AllowanceAction = AllowanceReview["action"];

/** What the on-device decode proved the transaction does. */
export type AllowanceVerification =
  | {
      readonly kind: "create";
      readonly lockedLovelace: string;
      readonly perPaymentLovelace: string;
      readonly perDayLovelace: string;
      readonly floatLovelace: string;
    }
  | { readonly kind: "top_up"; readonly addedLovelace: string; readonly newLovelace: string }
  | { readonly kind: "revoke"; readonly returnedLovelace: string; readonly to: string };

export interface AllowanceIntegrity {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly verified?: AllowanceVerification;
}

/** "Verified on this device: locks 50 ADA in your allowance (…)". */
export function allowanceVerifiedLine(v: AllowanceVerification): string {
  switch (v.kind) {
    case "create":
      return `Verified on this device: locks ${ada(v.lockedLovelace)} in your allowance (max ${ada(v.perPaymentLovelace)} per payment, ${ada(v.perDayLovelace)} per day) and sends ${ada(v.floatLovelace)} to the agent for fees.`;
    case "top_up":
      return `Verified on this device: the transaction adds ${ada(v.addedLovelace)} to your allowance (${ada(v.newLovelace)} in it after) and keeps its limits.`;
    case "revoke":
      return `Verified on this device: the transaction returns everything in your allowance (${ada(v.returnedLovelace)}) to your wallet ${shortenAddress(v.to, 10, 6)}.`;
  }
}

/** What the user asked for, to compare with what the API built (exact amounts only). */
export interface AllowanceRequested {
  /** create: the body sent. */
  readonly create?: CreateAllowanceBody;
  /** top_up: the lovelace added, when typed in ADA. */
  readonly addLovelace?: bigint | null;
}

function datumMatchesLimits(d: AllowanceDatumView, a: CardanoAllowance): string | null {
  const agentKh = cardanoPaymentKeyHash(a.agentAddress);
  if (agentKh === null || d.agentKeyHash !== agentKh)
    return "The allowance names a different agent key.";
  if (d.perPaymentMax !== a.limits.perPaymentLovelace)
    return "The max per payment differs from the one shown.";
  if (d.periodCap !== a.limits.perDayLovelace) return "The max per day differs from the one shown.";
  if (d.periodMs !== a.limits.periodMs || d.periodMs !== "86400000")
    return "The limit period isn't one day.";
  if (Number(d.expiresAt) !== Date.parse(a.limits.expiresAt))
    return "The expiry differs from the one shown.";
  const want =
    a.limits.payees.mode === "any" ? [] : a.limits.payees.addresses.map((x) => allowancePayeeOf(x));
  if (want.some((p) => p === null)) return "A payee shown has no Cardano payment credential.";
  const key = (p: { kind: string; hash: string } | null) =>
    p === null ? "" : `${p.kind}:${p.hash}`;
  const got = d.allowedPayees.map(key).sort().join(",");
  if (got !== want.map(key).sort().join(",")) return "The payees differ from the ones shown.";
  return null;
}

function payeesKey(p: AllowancePayees): string {
  return p.mode === "any" ? "any" : [...p.addresses].sort().join(",");
}

/** Lovelace typed in a create body, when exact (ADA); null for fiat. */
function bodyLovelace(m: AllowanceMoney): string | null {
  return "lovelace" in m ? m.lovelace : null;
}

/**
 * Check an allowance review before the passkey signs it (the API re-checks everything): it is
 * the action asked for, of this allowance; the passkey key is the wallet's; the review shows
 * what the allowance record says and what the user asked; and (real reviews) the body hash is
 * the transaction's and decoding the transaction on this device it does exactly that
 * (checkCardanoAllowanceCreateTx / checkCardanoAllowanceOwnerSpendTx). Simulated reviews are
 * not CBOR: the decode only runs on real ones.
 */
export function checkAllowanceReview(
  review: AllowanceReview,
  ctx: {
    readonly action: AllowanceAction;
    readonly allowance: CardanoAllowance;
    readonly simulated: boolean;
    readonly requested?: AllowanceRequested;
    readonly now?: Date;
  },
): AllowanceIntegrity {
  const now = ctx.now ?? new Date();
  const a = ctx.allowance;
  const e = review.expect;
  const problems: string[] = [];
  const network = a.network as NetworkId;
  if (network !== ALLOWANCE_NETWORK) problems.push("Auto-pay only runs on Cardano Preprod.");
  if (review.action !== ctx.action || e.kind !== ctx.action)
    problems.push("The review is for a different allowance action.");
  if (review.allowanceId !== a.id) problems.push("The review is for a different allowance.");
  if (Date.parse(review.validUntil) <= now.getTime())
    problems.push("This review is no longer valid; prepare it again.");
  if (e.owner !== a.ownerAddress) problems.push("The allowance belongs to a different wallet.");
  try {
    if (cardanoEnterpriseAddress(review.rawPayload.signWith, network) !== a.ownerAddress)
      problems.push("The signing key does not belong to your wallet.");
  } catch {
    problems.push("The signing key is malformed.");
  }
  const ownerKh = cardanoPaymentKeyHash(a.ownerAddress);
  try {
    if (ownerKh === null || allowanceScriptAddress(network, ownerKh) !== a.scriptAddress)
      problems.push("The allowance contract address isn't yours.");
  } catch {
    problems.push("The allowance contract address isn't yours.");
  }
  let shownFee: bigint;
  let maxFee: bigint;
  try {
    shownFee = BigInt(review.estimatedFee.lovelace);
    maxFee = BigInt(e.maxFeeLovelace);
  } catch {
    return { ok: false, problems: [...problems, "The review's amounts are malformed."] };
  }
  const feeCap = shownFee < maxFee ? shownFee : maxFee;

  let verified: AllowanceVerification | undefined;
  const req = ctx.requested;
  if (e.kind === "create") {
    const limits = datumMatchesLimits(e.datum, a);
    if (limits !== null) problems.push(limits);
    if (e.datum.spentInPeriod !== "0") problems.push("A new allowance must start unspent.");
    if (e.agentAddress !== a.agentAddress) problems.push("It funds a different agent.");
    if (e.allowanceLovelace !== a.budgetLovelace) problems.push("It locks a different budget.");
    if (e.floatLovelace !== a.floatLovelace)
      problems.push("It gives the agent a different amount.");
    if (ownerKh !== null && e.ownerKeyHash !== ownerKh)
      problems.push("The allowance belongs to a different wallet.");
    const body = req?.create;
    if (body !== undefined) {
      const exact: [AllowanceMoney, string, string][] = [
        [body.budget, e.allowanceLovelace, "budget"],
        [body.perPayment, e.datum.perPaymentMax, "max per payment"],
        [body.perDay, e.datum.periodCap, "max per day"],
      ];
      for (const [m, got, name] of exact) {
        const want = bodyLovelace(m);
        if (want !== null && want !== got)
          problems.push(`The ${name} differs from what you entered.`);
      }
      if (body.floatLovelace !== undefined && body.floatLovelace !== e.floatLovelace)
        problems.push("The agent's ADA for fees differs from what you entered.");
      if (payeesKey(body.payees) !== payeesKey(a.limits.payees))
        problems.push("The payees differ from the ones you chose.");
      const days = (Number(e.datum.expiresAt) - now.getTime()) / 86_400_000;
      if (Math.abs(days - body.expiresInDays) > 1)
        problems.push("The expiry differs from the one you chose.");
    }
    if (!ctx.simulated && problems.length === 0) {
      const check = checkCardanoAllowanceCreateTx(review.unsignedTransaction.serialized, {
        network,
        owner: a.ownerAddress,
        agentAddress: e.agentAddress,
        allowanceLovelace: BigInt(e.allowanceLovelace),
        floatLovelace: BigInt(e.floatLovelace),
        datum: e.datum,
        maxFee: feeCap,
        now,
      });
      if (!check.ok) problems.push(txMismatch(check.reason));
      else
        verified = {
          kind: "create",
          lockedLovelace: e.allowanceLovelace,
          perPaymentLovelace: e.datum.perPaymentMax,
          perDayLovelace: e.datum.periodCap,
          floatLovelace: e.floatLovelace,
        };
    }
  } else {
    const utxo = a.onChain?.utxo ?? null;
    if (utxo === null) problems.push("The allowance isn't on Cardano yet.");
    else if (e.utxo !== utxo) problems.push("The review spends a different allowance output.");
    const balance = a.onChain === null ? null : BigInt(a.onChain.balanceLovelace);
    if (e.kind === "top_up") {
      const limits = datumMatchesLimits(e.datum, a);
      if (limits !== null) problems.push(limits);
      const next = BigInt(e.newLovelace);
      if (balance !== null && next <= balance) problems.push("The top-up doesn't add anything.");
      if (balance !== null && req?.addLovelace != null && next !== balance + req.addLovelace)
        problems.push("The top-up amount differs from what you entered.");
    }
    if (!ctx.simulated && problems.length === 0) {
      const check = checkCardanoAllowanceOwnerSpendTx(review.unsignedTransaction.serialized, {
        network,
        action: e.kind,
        owner: a.ownerAddress,
        utxo: e.utxo,
        ...(e.kind === "top_up" ? { newLovelace: BigInt(e.newLovelace), datum: e.datum } : {}),
        maxFee: feeCap,
        validFrom: e.validFrom,
        validUntil: e.validUntil,
        now,
      });
      if (!check.ok) problems.push(txMismatch(check.reason));
      else
        verified =
          e.kind === "top_up"
            ? {
                kind: "top_up",
                addedLovelace: (BigInt(e.newLovelace) - (balance ?? 0n)).toString(),
                newLovelace: e.newLovelace,
              }
            : {
                kind: "revoke",
                returnedLovelace: check.payout.lovelace.toString(),
                to: a.ownerAddress,
              };
    }
  }
  if (
    !ctx.simulated &&
    cardanoUnsignedBodyHash(review.unsignedTransaction.serialized) !== review.rawPayload.payload
  )
    problems.push("The Cardano signing payload does not match the transaction.");
  const ok = problems.length === 0;
  return ok && verified !== undefined ? { ok, problems, verified } : { ok, problems };
}

export interface ReviewRow {
  readonly label: string;
  readonly value: string;
}

/** The review sheet's rows: what this transaction does to the allowance, in ADA (and fiat). */
export function allowanceReviewRows(review: AllowanceReview, a: CardanoAllowance): ReviewRow[] {
  const e = review.expect;
  const fiat = a.limits.fiat;
  const cur = fiat?.currency;
  const fee = { label: "Network fee", value: ada(review.estimatedFee.lovelace) };
  switch (e.kind) {
    case "create":
      return [
        { label: "Locks (budget)", value: limitLabel(e.allowanceLovelace, fiat?.budget, cur) },
        {
          label: "Max per payment",
          value: limitLabel(e.datum.perPaymentMax, fiat?.perPayment, cur),
        },
        { label: "Max per day", value: limitLabel(e.datum.periodCap, fiat?.perDay, cur) },
        { label: "Payees", value: payeesLabel(a.limits.payees) },
        {
          label: "Expires",
          value: formatDateTime(new Date(Number(e.datum.expiresAt)).toISOString()),
        },
        { label: "Agent's fee ADA", value: ada(e.floatLovelace) },
        fee,
        ...(fiat !== null
          ? [
              {
                label: "ADA price used",
                value: `${formatFiat(fiat.adaPrice, fiat.currency)} per ADA`,
              },
            ]
          : []),
      ];
    case "top_up": {
      const before = a.onChain?.balanceLovelace ?? "0";
      return [
        { label: "Adds", value: ada(BigInt(e.newLovelace) - BigInt(before)) },
        { label: "In the allowance after", value: ada(e.newLovelace) },
        { label: "Limits", value: "Unchanged" },
        fee,
        { label: "Valid until", value: formatDateTime(e.validUntil) },
      ];
    }
    case "revoke":
      return [
        {
          label: "Comes back to you",
          value: `${ada(a.onChain?.balanceLovelace ?? "0")} minus the fee`,
        },
        { label: "To", value: shortenAddress(a.ownerAddress, 10, 6) },
        {
          label: "Agent's fee ADA",
          value: a.float ? `${ada(a.float.lovelace)}, returned after` : "Returned after",
        },
        fee,
        { label: "Valid until", value: formatDateTime(e.validUntil) },
      ];
  }
}

export const ALLOWANCE_ACTION_COPY: Readonly<
  Record<AllowanceAction, { title: string; message: string; done: string }>
> = {
  create: {
    title: "Turn on auto-pay",
    message:
      "Locks the budget in your own allowance contract on Cardano and gives the agent a little ADA for network fees. Payments within these limits go through without asking you. Cardano itself enforces the limits — not ZyroPay. Anything above them still comes to you.",
    done: "Sent to Cardano. Auto-pay turns on once it confirms.",
  },
  top_up: {
    title: "Top up the allowance",
    message: "Adds ADA to the allowance. The limits and today's spending stay as they are.",
    done: "Top-up sent. The new balance shows once Cardano confirms it.",
  },
  revoke: {
    title: "Revoke and withdraw",
    message:
      "Returns everything in the allowance to your wallet, then the agent's ADA for fees, and destroys the agent's key. Payments come to you for approval again.",
    done: "Revoke sent. Everything comes back to your wallet once Cardano confirms it.",
  },
};

/** Plain words for an allowance API error. */
export function allowanceErrorMessage(err: {
  readonly code: string;
  readonly message: string;
}): string | null {
  switch (err.code) {
    case "INSUFFICIENT_FUNDS":
      return "Your wallet doesn't hold enough plain ADA for the budget, the agent's ADA for fees and the network fee. Add ADA or lower the budget.";
    case "CONFLICT":
      return "This agent's allowance changed in the meantime (one already exists or is being changed). Pull to refresh and try again.";
    case "PAYLOAD_HASH_MISMATCH":
      return "The transaction changed since you reviewed it, so nothing was signed. Review it again.";
    case "VALUATION_UNAVAILABLE":
      return "The ADA price is unavailable right now, so fiat limits can't be converted. Enter the amounts in ADA, or try again shortly.";
    default:
      return null;
  }
}
