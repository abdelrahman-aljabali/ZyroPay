import {
  buildDelegatedPolicyEnvelope,
  nativeAsset,
  type Balance,
  type NetworkId,
  type PortfolioSnapshot,
} from "@zyropay/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, type Transport } from "@/api/client";
import { AGENT_CLAUDE } from "@/api/mock/fixtures";
import { mockTransport, resetMockState } from "@/api/mock/transport";
import { AutonomousSetupError, nativeUsdPrices, prepareAutonomous } from "./autonomous";
import { draftFromPolicy } from "./policy-draft";
import { simulatedSigner, unavailableSigner } from "./turnkey/signer";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function client(transport: Transport = mockTransport({ latencyMs: 0 })) {
  return new ApiClient({ transport, getAccessToken: () => "tok" });
}

describe("autonomous mode setup (ADR-001 D6)", () => {
  it("creates the delegated user with the passkey, activates it, stamps the envelope, saves", async () => {
    resetMockState();
    const c = client();
    await c.call("deleteDelegatedSigner", {}); // start from Always Ask everywhere
    const signer = simulatedSigner();
    const createUser = vi.spyOn(signer, "createDelegatedUser");
    const cleanup = vi.spyOn(signer, "removeStaleDelegatedAccess");
    const { agent } = await c.call("getAgent", { params: { agentId: AGENT_CLAUDE } });
    const policy = {
      ...draftFromPolicy(agent.policy),
      mode: "autonomous" as const,
      spendingEnabled: true,
      allowedNetworks: ["solana-devnet" as const],
      recipientAllowlist: [{ family: "solana" as const, address: RECIPIENT, label: null }],
      limits: { perTransactionUsdMinor: "2000", dailyUsdMinor: "4000", monthlyUsdMinor: "10000" },
    };
    const { turnkeyPolicyRequest } = await prepareAutonomous({
      call: (n, i) => c.call(n, i),
      signer,
      organizationId: "simulated-suborg-0000",
      policy,
      nativeUsdPrice: { solana: "150" },
    });
    expect(createUser).toHaveBeenCalledTimes(1);
    const signerState = await c.call("getDelegatedSigner", {});
    expect(signerState.signer?.status).toBe("active");
    // Leftovers of a revoked earlier setup are removed before the new envelope (ADR-001 D8).
    expect(cleanup).toHaveBeenCalledWith({
      organizationId: "simulated-suborg-0000",
      keepUserId: signerState.signer?.turnkeyUserId,
    });
    expect(turnkeyPolicyRequest?.stamp.stampHeaderName).toBe("X-Stamp-Webauthn");
    const body = JSON.parse(turnkeyPolicyRequest?.body ?? "{}") as {
      type: string;
      organizationId: string;
      parameters: { policies: { consensus: string; condition: string }[] };
    };
    expect(body.type).toBe("ACTIVITY_TYPE_CREATE_POLICIES");
    expect(body.organizationId).toBe("simulated-suborg-0000");
    for (const p of body.parameters.policies)
      expect(p.consensus).toBe(
        `approvers.any(user, user.id == '${signerState.signer?.turnkeyUserId ?? ""}')`,
      );
    expect(body.parameters.policies[0]?.condition).toContain(RECIPIENT);

    // Without the envelope the save is refused; with it, Autonomous is saved.
    await expect(
      c.call("updateAgentPolicy", {
        params: { agentId: AGENT_CLAUDE },
        body: { expectedVersion: agent.policy.version, policy },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const saved = await c.call("updateAgentPolicy", {
      params: { agentId: AGENT_CLAUDE },
      body: {
        expectedVersion: agent.policy.version,
        policy,
        ...(turnkeyPolicyRequest ? { turnkeyPolicyRequest } : {}),
      },
    });
    expect(saved.policy.mode).toBe("autonomous");

    // A second agent reuses the envelope: no new passkey prompts.
    createUser.mockClear();
    const again = await prepareAutonomous({
      call: (n, i) => c.call(n, i),
      signer,
      organizationId: "simulated-suborg-0000",
      policy,
      nativeUsdPrice: { solana: "150" },
    });
    expect(again).toEqual({});
    expect(createUser).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a passkey signer and makes no API call", async () => {
    const transport = vi.fn<Transport>();
    await expect(
      prepareAutonomous({
        call: (n, i) => client(transport).call(n, i),
        signer: unavailableSigner("Turnkey is not configured."),
        organizationId: "org",
        policy: draftFromPolicy(
          (await client().call("getAgent", { params: { agentId: AGENT_CLAUDE } })).agent.policy,
        ),
        nativeUsdPrice: {},
      }),
    ).rejects.toThrow(AutonomousSetupError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses to build an envelope without a price for the allowed networks", async () => {
    resetMockState();
    const c = client();
    await c.call("deleteDelegatedSigner", {});
    const { agent } = await c.call("getAgent", { params: { agentId: AGENT_CLAUDE } });
    await expect(
      prepareAutonomous({
        call: (n, i) => c.call(n, i),
        signer: simulatedSigner(),
        organizationId: "simulated-suborg-0000",
        policy: {
          ...draftFromPolicy(agent.policy),
          mode: "autonomous",
          allowedNetworks: ["base-sepolia"],
          restrictRecipients: false,
          limits: { perTransactionUsdMinor: "500", dailyUsdMinor: "500", monthlyUsdMinor: "500" },
        },
        nativeUsdPrice: { solana: "150" },
      }),
    ).rejects.toThrow(/no ETH price/);
  });

  it("reads native USD prices from the portfolio valuation", async () => {
    resetMockState();
    const { portfolio } = await client().call("getPortfolio", { query: {} });
    const prices = nativeUsdPrices(portfolio);
    expect(prices.solana).toMatch(/^\d+(\.\d+)?$/);
    expect(prices.evm).toMatch(/^\d+(\.\d+)?$/);
    expect(nativeUsdPrices(undefined)).toEqual({});
  });
});

describe("autonomous mode on testnets valued at mainnet prices", () => {
  const WALLET = "0199e7a0-0000-7000-8000-000000000001";
  const bal = (network: NetworkId, address: string, price: string | null): Balance => ({
    walletId: WALLET,
    address,
    network,
    asset: nativeAsset(network),
    amount: "0",
    price: price === null ? null : { value: price, currency: "USD" },
    value: price === null ? null : { value: "0.00", currency: "USD" },
    priceBasis: price === null ? null : "mainnet_proxy",
  });
  const portfolio: PortfolioSnapshot = {
    asOf: "2026-10-30T12:00:00.000Z",
    stale: false,
    currency: "USD",
    totalValue: { value: "0.00", currency: "USD" },
    unpricedAssetCount: 0,
    networks: ["cardano-preprod", "solana-devnet", "ethereum-sepolia", "base-sepolia"],
    balances: [
      bal(
        "cardano-preprod",
        "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz",
        "0.62",
      ),
      bal("solana-devnet", RECIPIENT, "150"),
      bal("ethereum-sepolia", "0x52908400098527886E0F7030069857D2E4169EE7", "3000"),
      bal("base-sepolia", "0x52908400098527886E0F7030069857D2E4169EE7", "3000"),
    ],
    simulated: false,
  };

  it("derives the SOL and ETH caps from the proxied testnet natives (never ADA)", () => {
    const prices = nativeUsdPrices(portfolio);
    expect(prices).toEqual({ solana: "150", evm: "3000" });
    const intents = buildDelegatedPolicyEnvelope({
      delegatedUserId: "user-abc-123",
      allowedNetworks: ["solana-devnet", "ethereum-sepolia", "base-sepolia"],
      restrictRecipients: false,
      recipientAllowlist: [],
      perTransactionUsdMinor: "1000",
      nativeUsdPrice: prices,
    });
    // $10 * 1.25 at $3000/ETH and $150/SOL.
    expect(intents[0]?.condition).toContain("eth.tx.chain_id in [84532, 11155111]");
    expect(intents[0]?.condition).toContain("eth.tx.value <= 4166666666666666");
    expect(intents[1]?.condition).toContain("t.amount <= 83333333");
  });

  it("still fails closed when a testnet native has no price", () => {
    const unpriced = {
      ...portfolio,
      balances: portfolio.balances.map((b) =>
        b.network === "ethereum-sepolia" || b.network === "base-sepolia"
          ? { ...b, price: null, value: null, priceBasis: null }
          : b,
      ),
    };
    expect(nativeUsdPrices(unpriced)).toEqual({ solana: "150" });
  });
});

describe("agent activity (mock transport)", () => {
  it("lists approval-gated requests and autonomous executions", async () => {
    resetMockState();
    const c = client();
    const { agents } = await c.call("listAgents", {});
    const auto = agents.find((a) => a.policy.mode === "autonomous");
    if (!auto) throw new Error("fixture missing");
    const feed = await c.call("listAgentRequests", { params: { agentId: auto.id }, query: {} });
    expect(feed.items.some((i) => i.autonomous && i.approvalId === null)).toBe(true);
    const confirmed = await c.call("listAgentRequests", {
      params: { agentId: auto.id },
      query: { state: "CONFIRMED" },
    });
    expect(confirmed.items.every((i) => i.request.state === "CONFIRMED")).toBe(true);
  });
});
