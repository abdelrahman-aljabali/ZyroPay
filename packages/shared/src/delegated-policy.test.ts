import { describe, expect, it } from "vitest";
import { buildDelegatedPolicyEnvelope, EnvelopeError, nativeCapForUsd } from "./delegated-policy";

const SOL_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_TO = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("delegated signer policy envelope", () => {
  it("derives native caps from the USD limit with a 25% margin, in bigint", () => {
    // $10 at $150/SOL = 0.0666.. SOL; * 1.25 = 0.08333.. SOL = 83_333_333 lamports.
    expect(nativeCapForUsd("1000", "150", 9)).toBe(83_333_333n);
    // $10 at $3000.50/ETH * 1.25 = 0.0041659723... ETH
    expect(nativeCapForUsd("1000", "3000.50", 18)).toBe(4_165_972_337_943_676n);
    expect(() => nativeCapForUsd("1000", "0", 9)).toThrow(EnvelopeError);
    expect(() => nativeCapForUsd("1000", "1e3", 9)).toThrow();
  });

  it("binds every policy to the delegated user and bounds chain, recipient and amount", () => {
    const intents = buildDelegatedPolicyEnvelope({
      delegatedUserId: "user-abc-123",
      allowedNetworks: ["solana-devnet", "base-sepolia", "ethereum-sepolia"],
      restrictRecipients: true,
      recipientAllowlist: [
        { family: "solana", address: SOL_TO, label: null },
        { family: "evm", address: EVM_TO, label: "friend" },
      ],
      perTransactionUsdMinor: "1000",
      nativeUsdPrice: { solana: "150", evm: "3000" },
    });
    expect(intents.map((i) => [i.policyName, i.effect])).toEqual([
      ["zyropay-delegated-evm", "EFFECT_ALLOW"],
      ["zyropay-delegated-solana", "EFFECT_ALLOW"],
      ["zyropay-delegated-deny-alt", "EFFECT_DENY"],
    ]);
    for (const i of intents)
      expect(i.consensus).toBe("approvers.any(user, user.id == 'user-abc-123')");
    const [evm, sol] = intents;
    expect(evm?.condition).toBe(
      `eth.tx.chain_id in [84532, 11155111] && eth.tx.data == '0x' && eth.tx.value <= 4166666666666666 && eth.tx.to in ['${EVM_TO.toLowerCase()}']`,
    );
    expect(sol?.condition).toContain(`t.to in ['${SOL_TO}'] && t.amount <= 83333333`);
    expect(sol?.condition).toContain("solana.tx.program_keys.all(");
  });

  it("fails closed without prices, recipients, a limit or a valid user id", () => {
    const base = {
      delegatedUserId: "u1",
      allowedNetworks: ["solana-devnet"] as const,
      restrictRecipients: true,
      recipientAllowlist: [{ family: "solana" as const, address: SOL_TO, label: null }],
      perTransactionUsdMinor: "1000",
      nativeUsdPrice: { solana: "150" },
    };
    expect(() => buildDelegatedPolicyEnvelope({ ...base, nativeUsdPrice: {} })).toThrow(
      /no SOL price/,
    );
    expect(() => buildDelegatedPolicyEnvelope({ ...base, recipientAllowlist: [] })).toThrow(
      /no Solana recipients/,
    );
    expect(() => buildDelegatedPolicyEnvelope({ ...base, perTransactionUsdMinor: "0" })).toThrow();
    expect(() =>
      buildDelegatedPolicyEnvelope({ ...base, delegatedUserId: "x' || true" }),
    ).toThrow();
    expect(() => buildDelegatedPolicyEnvelope({ ...base, allowedNetworks: [] })).toThrow();
  });

  it("omits the recipient clause only when recipients are unrestricted", () => {
    const [sol] = buildDelegatedPolicyEnvelope({
      delegatedUserId: "u1",
      allowedNetworks: ["solana-devnet"],
      restrictRecipients: false,
      recipientAllowlist: [],
      perTransactionUsdMinor: "1000",
      nativeUsdPrice: { solana: "150" },
    });
    expect(sol?.condition).toContain("solana.tx.transfers.all(t, t.amount <= 83333333)");
  });
});
