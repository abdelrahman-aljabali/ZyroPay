import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPushData,
  defaultAgentPolicy,
  nativeAsset,
  toChecksumAddress,
  type Balance,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import { ASSETS, makeApprovals, makeTransactions, WALLET_MAIN } from "@/api/mock/fixtures";
import { formatUserCode, isCompleteUserCode } from "./agent-clients";
import { readEnv } from "./env";
import {
  centsToDollars,
  dollarsToCents,
  draftFromPolicy,
  makeAllowlistEntry,
  validateDraft,
} from "./policy-draft";
import { approvalIdFromPushData, pushRouteFromData } from "./push-data";
import { checkReviewIntegrity, summarizeReview } from "./review";
import { checkAmount, checkRecipient, needsChainFollow, sendProgress } from "./send";
import { base64ToHex, turnkeySignBody, unsignedHex } from "./turnkey/signer";

const SOL_ADDR = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const EVM_LOWER = "0x52908400098527886e0f7030069857d2e4169ee7";

const solBalance: Balance = {
  walletId: WALLET_MAIN,
  address: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
  network: "solana-devnet",
  asset: nativeAsset("solana-devnet"),
  amount: "2500000000",
  price: { value: "142.18", currency: "USD" },
  value: { value: "355.45", currency: "USD" },
};

describe("env", () => {
  it("defaults to development without mocks", () => {
    const e = readEnv({});
    expect(e.mode).toBe("development");
    expect(e.mocksActive).toBe(false);
  });
  it("activates mocks only outside production", () => {
    expect(readEnv({ EXPO_PUBLIC_USE_MOCKS: "1" }).mocksActive).toBe(true);
    const prod = readEnv({ EXPO_PUBLIC_USE_MOCKS: "1", EXPO_PUBLIC_ZYROPAY_MODE: "production" });
    expect(prod.mocksActive).toBe(false);
    expect(prod.mocksRefused).toBe(true);
  });
  it("allows the dev MockTurnkey passkey only in development", () => {
    expect(readEnv({ EXPO_PUBLIC_DEV_PASSKEY: "mock-turnkey" }).devMockPasskey).toBe(true);
    expect(
      readEnv({ EXPO_PUBLIC_DEV_PASSKEY: "mock-turnkey", EXPO_PUBLIC_ZYROPAY_MODE: "production" })
        .devMockPasskey,
    ).toBe(false);
    expect(readEnv({ EXPO_PUBLIC_DEV_PASSKEY: "1" }).devMockPasskey).toBe(false);
  });
  it("normalises URLs", () => {
    expect(readEnv({ EXPO_PUBLIC_API_URL: "https://api.example.com/" }).apiUrl).toBe(
      "https://api.example.com",
    );
  });
});

describe("send validation", () => {
  it("validates recipients per network", () => {
    expect(checkRecipient(solBalance, SOL_ADDR)).toEqual({ ok: true, warning: null });
    expect(checkRecipient(solBalance, EVM_LOWER)).toMatchObject({ ok: false });
    expect(checkRecipient(solBalance, solBalance.address)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sending from/),
    });
    const evm: Balance = {
      ...solBalance,
      network: "base-sepolia",
      asset: nativeAsset("base-sepolia"),
      address: toChecksumAddress("0x1111111111111111111111111111111111111111"),
    };
    expect(checkRecipient(evm, EVM_LOWER)).toMatchObject({
      ok: true,
      warning: expect.stringMatching(/checksum/),
    });
    expect(checkRecipient(evm, toChecksumAddress(EVM_LOWER))).toEqual({ ok: true, warning: null });
    const badChecksum = toChecksumAddress(EVM_LOWER).replace("E", "e").replace("d", "D");
    expect(checkRecipient(evm, badChecksum)).toMatchObject({ ok: false });
  });
  it("validates amounts with bigint base units", () => {
    expect(checkAmount(solBalance, "")).toEqual({ ok: false, error: null });
    expect(checkAmount(solBalance, "0")).toEqual({ ok: false, error: null });
    expect(checkAmount(solBalance, "1.5")).toEqual({ ok: true, baseUnits: "1500000000" });
    expect(checkAmount(solBalance, "2.5")).toEqual({ ok: true, baseUnits: "2500000000" });
    expect(checkAmount(solBalance, "2.500000001")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/balance/),
    });
    expect(checkAmount(solBalance, "0.0000000001")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/decimal/),
    });
  });
});

describe("send progress (status screen follows the chain after BROADCAST)", () => {
  // Regression: a real devnet send confirmed on-chain, but the status
  // screen showed "Sent to the network" forever because it only rendered the submit answer.
  const REQ = "01a15a71-b299-77bb-a309-5f38bcd84cfd";
  const HASH =
    "FWxcU4bfUrwadMeZCr8ANLNyt4ax1pNbjcmemFRFYThvr2ao858VJFxaieKS1jVm2hc4TJ7tS28kRCo7TpE8z25";
  const result = {
    requestId: REQ,
    state: "BROADCAST" as const,
    decision: "allow" as const,
    reasons: [],
    payloadHash: "d0dfe6a490dd5fd5dc3d50489e0ff422c4473328637d871eb0b6577ba56aefff",
    approvalUrl: null,
    txHash: HASH,
    explorerUrl: null,
    expiresAt: "2026-10-30T18:02:42.457Z",
    simulated: false,
  };
  const base = makeTransactions()[0];
  if (!base) throw new Error("fixture");
  const tx = (over: Partial<typeof base>) => ({
    ...base,
    txHash: HASH,
    direction: "out" as const,
    transactionRequestId: REQ,
    ...over,
  });
  it("stays BROADCAST until the chain transaction shows up and settles", () => {
    expect(needsChainFollow(result)).toBe(true);
    expect(sendProgress(result, undefined)).toBe("BROADCAST");
    expect(sendProgress(result, [])).toBe("BROADCAST");
    expect(sendProgress(result, [tx({ status: "pending" })])).toBe("BROADCAST");
  });
  it("reports CONFIRMED or FAILED from the matching transaction", () => {
    expect(sendProgress(result, [tx({ status: "confirmed" })])).toBe("CONFIRMED");
    expect(sendProgress(result, [tx({ status: "failed" })])).toBe("FAILED");
    expect(sendProgress(result, [tx({ status: "confirmed", transactionRequestId: null })])).toBe(
      "CONFIRMED",
    );
  });
  it("ignores other hashes, other requests and incoming legs", () => {
    expect(sendProgress(result, [tx({ status: "confirmed", txHash: "other" })])).toBe("BROADCAST");
    expect(
      sendProgress(result, [
        tx({ status: "confirmed", transactionRequestId: "01a15a71-0000-7000-8000-000000000000" }),
      ]),
    ).toBe("BROADCAST");
    expect(sendProgress(result, [tx({ status: "confirmed", direction: "in" })])).toBe("BROADCAST");
  });
  it("never follows simulated, hashless or already final results", () => {
    const confirmedTx = [tx({ status: "failed" })];
    expect(needsChainFollow({ ...result, simulated: true })).toBe(false);
    expect(sendProgress({ ...result, simulated: true }, confirmedTx)).toBe("BROADCAST");
    expect(needsChainFollow({ ...result, txHash: null })).toBe(false);
    expect(sendProgress({ ...result, state: "CONFIRMED" }, confirmedTx)).toBe("CONFIRMED");
  });
});

describe("policy draft", () => {
  it("converts dollars and cents exactly", () => {
    expect(dollarsToCents("12.5")).toBe("1250");
    expect(dollarsToCents("")).toBe("0");
    expect(centsToDollars("1250")).toBe("12.50");
    expect(centsToDollars("0")).toBe("");
    expect(() => dollarsToCents("1e3")).toThrow();
  });
  it("requires sane autonomous limits", () => {
    const base = {
      ...draftFromPolicy(defaultAgentPolicy()),
      allowedWalletIds: ["w"],
      allowedNetworks: ["base-sepolia" as const],
    };
    expect(validateDraft(base)).toEqual([]);
    const auto = {
      ...base,
      mode: "autonomous" as const,
      spendingEnabled: true,
      restrictRecipients: false,
      limits: { perTransactionUsdMinor: "500", dailyUsdMinor: "200", monthlyUsdMinor: "100" },
    };
    const msgs = validateDraft(auto).map((i) => i.field);
    expect(msgs).toContain("limits");
    const good = {
      ...auto,
      limits: { perTransactionUsdMinor: "500", dailyUsdMinor: "2000", monthlyUsdMinor: "20000" },
    };
    expect(validateDraft(good)).toEqual([]);
    expect(validateDraft({ ...good, allowedTools: ["swap"] }).map((i) => i.field)).toContain(
      "tools",
    );
  });
  it("normalises allowlist entries", () => {
    expect(makeAllowlistEntry("evm", EVM_LOWER, " Shop ")).toEqual({
      family: "evm",
      address: toChecksumAddress(EVM_LOWER),
      label: "Shop",
    });
    expect(makeAllowlistEntry("solana", EVM_LOWER, "")).toBeNull();
    expect(makeAllowlistEntry("solana", SOL_ADDR, "")?.label).toBeNull();
  });
});

describe("review integrity", () => {
  it("accepts an untouched review and flags tampering", () => {
    const first = makeApprovals()[0];
    if (!first) throw new Error("fixture");
    expect(checkReviewIntegrity(first.review, first.approval).ok).toBe(true);
    const tampered = { ...first.review, payload: { ...first.review.payload, amount: "999" } };
    const r = checkReviewIntegrity(tampered, first.approval);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/hash/);
    const otherApproval = { ...first.approval, payloadHash: "f".repeat(64) };
    expect(checkReviewIntegrity(first.review, otherApproval).ok).toBe(false);
    expect(
      checkReviewIntegrity(first.review, first.approval, new Date(Date.now() + 3600_000)).ok,
    ).toBe(false);
  });
  it("summarises amounts without floating point", () => {
    const first = makeApprovals()[0];
    if (!first) throw new Error("fixture");
    const s = summarizeReview(first.review, ASSETS.usdcSol.symbol);
    expect(s.amountLabel).toBe("25 USDC");
    expect(s.fiatLabel).toBe("≈ $25.00");
    expect(s.action).toBe("Send");
    expect(s.isTestnet).toBe(true);
  });
});

describe("turnkey sign body", () => {
  it("converts base64 to hex and builds SIGN_TRANSACTION_V2", () => {
    expect(base64ToHex("AQID")).toBe("010203");
    expect(unsignedHex({ encoding: "hex", serialized: "0xabcd" })).toBe("abcd");
    const body = turnkeySignBody(
      {
        organizationId: "org",
        signWith: SOL_ADDR,
        unsignedTransaction: { encoding: "base64", serialized: "AQID" },
        network: "solana-devnet",
      },
      "1",
    );
    expect(body).toEqual({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      organizationId: "org",
      timestampMs: "1",
      parameters: {
        signWith: SOL_ADDR,
        unsignedTransaction: "010203",
        type: "TRANSACTION_TYPE_SOLANA",
      },
    });
  });
});

describe("agent connect", () => {
  it("formats user codes", () => {
    expect(formatUserCode("abcd1234")).toBe("ABCD-1234");
    expect(formatUserCode("ab-c")).toBe("ABC");
    expect(isCompleteUserCode("ABCD-1234")).toBe(true);
    expect(isCompleteUserCode("ABCD-123")).toBe(false);
  });
});

describe("push payloads", () => {
  const id = "0192f3a1-0007-7000-8000-000000000001";
  it("accepts only the shared PushData and routes by its deep link", () => {
    const data = buildPushData("approval_requested", { approvalId: id });
    expect(approvalIdFromPushData(data)).toBe(id);
    expect(pushRouteFromData(buildPushData("transaction_confirmed", { requestId: id }))).toEqual({
      screen: "activity",
    });
    // The pre-contract shapes are no longer accepted.
    expect(approvalIdFromPushData({ type: "approval_requested", approvalId: id })).toBeNull();
    expect(approvalIdFromPushData({ url: `zyropay://approvals/${id}` })).toBeNull();
    expect(
      approvalIdFromPushData({ ...data, url: `https://evil.example/approvals/${id}` }),
    ).toBeNull();
    expect(approvalIdFromPushData({ ...data, amount: "100" })).toBeNull();
    expect(approvalIdFromPushData(null)).toBeNull();
  });
});

describe("brand mark", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("the UI component carries exactly the petal path of assets/brand/zyropay-mark.svg", () => {
    const svg = read("../../../../assets/brand/zyropay-mark.svg");
    const component = read("../../../../packages/ui/src/icons/ZyroMark.tsx");
    const glyph = /<path[^>]*\sd="([^"]+)"/.exec(svg)?.[1];
    expect(glyph).toBeDefined();
    expect(component.replace(/\s+/g, "")).toContain(`glyph:"${(glyph ?? "").replace(/\s+/g, "")}"`);
    // The white rounded tile and black ink of the source file.
    expect(svg).toMatch(/<rect[^>]*rx="28"[^>]*fill="#fff"/i);
    expect(svg).toMatch(/<path fill="#000"/);
  });

  it("the icon generator renders from that SVG, not a copy of the old Z", () => {
    const script = read("../../scripts/generate-icons.mjs");
    expect(script).toContain('"assets", "brand", "zyropay-mark.svg"');
    expect(script).not.toMatch(/M28 26h44v12/);
  });
});
