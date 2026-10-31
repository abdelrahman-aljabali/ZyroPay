import {
  allowanceScriptAddress,
  cardanoPaymentKeyHash,
  MASUMI_ESCROW_ADDRESSES,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ADDR, makeTransactions, makeWallets } from "@/api/mock/fixtures";
import { allowanceAddressesOf } from "./allowance";
import { transactionKind, transactionKindCopy } from "./tx-kind";

const ESCROW = MASUMI_ESCROW_ADDRESSES["cardano-preprod"] ?? "";
const base = { network: "cardano-preprod" as const, from: ADDR.adaMain, to: ADDR.friendAda };

describe("transactionKind", () => {
  it("tells escrow locks, refund requests and refunds from plain transfers", () => {
    expect(transactionKind({ ...base, direction: "out" })).toBe("transfer");
    expect(transactionKind({ ...base, to: ESCROW, direction: "out" })).toBe("escrow_lock");
    expect(transactionKind({ ...base, from: ESCROW, to: ESCROW, direction: "self" })).toBe(
      "escrow_refund_request",
    );
    expect(transactionKind({ ...base, from: ESCROW, to: ADDR.adaMain, direction: "in" })).toBe(
      "escrow_refund",
    );
  });

  it("only on networks with a Masumi escrow", () => {
    expect(
      transactionKind({ network: "solana-devnet", from: "a", to: ESCROW, direction: "out" }),
    ).toBe("transfer");
  });

  it("labels the simulated history's escrow rows", () => {
    const labels = makeTransactions()
      .map((t) => transactionKindCopy(t)?.label)
      .filter((l) => l !== undefined);
    expect(labels).toEqual(["Escrow lock", "Refund"]);
  });

  it("tells allowance funding, auto-payments and returns apart (own allowance only)", () => {
    const kh = cardanoPaymentKeyHash(ADDR.adaMain) ?? "";
    const script = allowanceScriptAddress("cardano-preprod", kh);
    const mine = new Set([script]);
    const fund = { ...base, to: script, direction: "out" as const };
    const pay = { ...base, from: script, to: ADDR.friendAda, direction: "out" as const };
    const back = { ...base, from: script, to: ADDR.adaMain, direction: "in" as const };
    expect(transactionKind(fund, mine)).toBe("allowance_fund");
    expect(transactionKind({ ...base, from: script, to: script, direction: "self" }, mine)).toBe(
      "allowance_fund",
    );
    expect(transactionKind(pay, mine)).toBe("auto_pay");
    expect(transactionKind(back, mine)).toBe("allowance_return");
    expect(transactionKindCopy(pay, mine)?.label).toBe("Auto-paid · allowance");
    // Someone else's allowance (not derived from this device's wallets) is a plain transfer.
    expect(transactionKind(pay)).toBe("transfer");
    expect(transactionKind(pay, new Set(["addr_test1wother"]))).toBe("transfer");
  });
});

describe("allowanceAddressesOf (useAllowanceAddresses)", () => {
  it("derives the allowance contract of each preprod key address on the device", () => {
    const wallets = makeWallets();
    const set = allowanceAddressesOf(wallets);
    const kh = cardanoPaymentKeyHash(ADDR.adaMain) ?? "";
    expect(set.has(allowanceScriptAddress("cardano-preprod", kh))).toBe(true);
    for (const a of set) expect(a.startsWith("addr_test1w")).toBe(true);
    expect(allowanceAddressesOf([])).toEqual(new Set());
    expect(
      allowanceAddressesOf([{ addresses: [{ family: "solana", address: "So1ana" }] }]).size,
    ).toBe(0);
  });
});
