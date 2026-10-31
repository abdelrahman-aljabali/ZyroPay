import {
  MasumiAgentResolutionSchema,
  MasumiAgentSearchResultSchema,
  type MasumiAgentSummary,
} from "@zyropay/shared";
import { describe, expect, it } from "vitest";
import {
  MOCK_MASUMI_AGENTS,
  MOCK_SELLER_AGENT_ID,
  mockGetMasumiAgent,
  mockListMasumiAgents,
  mockSellerIdentity,
  TUSDM_PREPROD,
} from "@/api/mock/masumi";
import { policyReasonText } from "./escrow";
import {
  addTrustedAgent,
  endpointHost,
  filterMasumiAgents,
  formatMasumiPricing,
  isValidAgentIdentifier,
  masumiFacets,
  masumiUnitInfo,
  plainText,
  registeredLabel,
  sellerBadge,
  shortAgentIdentifier,
} from "./masumi";

const ID = "a".repeat(56) + "b".repeat(64);

function agent(over: Partial<MasumiAgentSummary> = {}): MasumiAgentSummary {
  return {
    agentIdentifier: ID,
    network: "cardano-preprod",
    name: "Agent",
    description: "Does things",
    apiBaseUrl: "https://agent.example/api",
    capability: { name: "reports", version: "1.0.0" },
    tags: ["cardano"],
    pricing: { type: "Fixed", amounts: [{ unit: "lovelace", amount: "2000000" }] },
    masumiEscrow: true,
    registeredAt: "2026-10-30T09:30:00.000Z",
    sellerPaymentKeyHash: null,
    active: true,
    ...over,
  };
}

describe("masumi: prices", () => {
  it("formats ADA from lovelace (unit 'lovelace' or empty)", () => {
    expect(
      formatMasumiPricing({ type: "Fixed", amounts: [{ unit: "lovelace", amount: "2000000" }] }),
    ).toBe("2 ADA");
    expect(formatMasumiPricing({ type: "Fixed", amounts: [{ unit: "", amount: "1500000" }] })).toBe(
      "1.5 ADA",
    );
  });

  it("formats tUSDM / USDM (CIP-67 asset names, 6 decimals)", () => {
    expect(masumiUnitInfo(TUSDM_PREPROD)).toEqual({ symbol: "tUSDM", decimals: 6 });
    expect(
      formatMasumiPricing({ type: "Fixed", amounts: [{ unit: TUSDM_PREPROD, amount: "1500000" }] }),
    ).toBe("1.5 tUSDM");
    const usdm = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d";
    expect(masumiUnitInfo(usdm)).toEqual({ symbol: "USDM", decimals: 6 });
  });

  it("joins multi-asset prices; names non-fixed pricing", () => {
    expect(
      formatMasumiPricing({
        type: "Fixed",
        amounts: [
          { unit: TUSDM_PREPROD, amount: "1000000" },
          { unit: "lovelace", amount: "500000" },
        ],
      }),
    ).toBe("1 tUSDM + 0.5 ADA");
    expect(formatMasumiPricing({ type: "Fixed", amounts: [] })).toBe("Price not listed");
    expect(formatMasumiPricing({ type: "Free" })).toBe("Free");
    expect(formatMasumiPricing({ type: "Dynamic" })).toBe("Priced per job");
    expect(formatMasumiPricing({ type: "Unknown" })).toBe("Price not listed");
  });

  it("never shows an unreadable asset name as text", () => {
    const binary = `${"1".repeat(56)}00ff10`;
    expect(masumiUnitInfo(binary).symbol).toBe("token 111111…");
  });
});

describe("masumi: filters and facets", () => {
  const list = [
    agent({ name: "Address Intel", tags: ["cardano", "wallets"] }),
    agent({
      agentIdentifier: "c".repeat(120),
      name: "Token Intel",
      capability: { name: "tokens", version: "0.1.0" },
      tags: ["cardano", "tokens"],
      pricing: { type: "Fixed", amounts: [{ unit: "lovelace", amount: "5000000" }] },
    }),
    agent({
      agentIdentifier: "d".repeat(120),
      name: "Free one",
      pricing: { type: "Free" },
      tags: [],
    }),
    agent({ agentIdentifier: "e".repeat(120), name: "Gone", active: false }),
  ];

  it("searches name, description, capability and tags; drops inactive entries", () => {
    expect(filterMasumiAgents(list, { q: "intel" }).map((a) => a.name)).toEqual([
      "Address Intel",
      "Token Intel",
    ]);
    expect(filterMasumiAgents(list, { q: "WALLETS" }).map((a) => a.name)).toEqual([
      "Address Intel",
    ]);
    expect(filterMasumiAgents(list, {}).some((a) => a.name === "Gone")).toBe(false);
  });

  it("filters by capability, tag and maximum price", () => {
    expect(filterMasumiAgents(list, { capability: "TOKENS" }).map((a) => a.name)).toEqual([
      "Token Intel",
    ]);
    expect(filterMasumiAgents(list, { tag: "tokens" }).map((a) => a.name)).toEqual(["Token Intel"]);
    expect(
      filterMasumiAgents(list, { maxPrice: { unit: "", amount: "2000000" } }).map((a) => a.name),
    ).toEqual(["Address Intel", "Free one"]);
  });

  it("lists the most common capabilities and tags", () => {
    expect(masumiFacets(list)).toEqual({
      capabilities: ["reports", "tokens"],
      tags: ["cardano", "tokens", "wallets"],
    });
  });
});

describe("masumi: third-party text", () => {
  it("flattens and truncates registry text", () => {
    expect(plainText("  Line one\n\nline\u202etwo \u0000 ")).toBe("Line one line two");
    expect(plainText("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("shows only the endpoint host, and only for web addresses", () => {
    expect(endpointHost("https://address-intel.zyropay.online/v1?x=1")).toBe(
      "address-intel.zyropay.online",
    );
    expect(endpointHost("http://localhost:8080/a")).toBe("localhost:8080");
    expect(endpointHost("javascript:alert(1)")).toBeNull();
    expect(endpointHost("not a url")).toBeNull();
  });

  it("labels the registration date", () => {
    expect(registeredLabel("2026-10-30T09:30:00.000Z")).toBe("Registered 30 Oct 2026");
    expect(registeredLabel(null)).toBeNull();
  });
});

describe("masumi: seller badge", () => {
  it("registered: green, with the registered name", () => {
    expect(
      sellerBadge({
        registered: true,
        agentIdentifier: ID,
        name: "Cardano Address Intelligence",
        reasons: [],
      }),
    ).toEqual({
      kind: "registered",
      tone: "success",
      title: "Registered Masumi agent · Cardano Address Intelligence",
      lines: ["The seller holds its registry NFT on Cardano."],
    });
  });

  it("no claim: neutral 'Unregistered seller'", () => {
    const b = sellerBadge({
      registered: false,
      agentIdentifier: null,
      name: null,
      reasons: ["not_claimed"],
    });
    expect(b?.kind).toBe("unregistered");
    expect(b?.tone).toBe("caution");
    expect(b?.title).toBe("Unregistered seller");
  });

  it("failed verification: red, with readable reasons", () => {
    const b = sellerBadge({
      registered: false,
      agentIdentifier: ID,
      name: null,
      reasons: ["seller_mismatch", "some_new_code"],
    });
    expect(b?.kind).toBe("failed");
    expect(b?.tone).toBe("danger");
    expect(b?.lines).toEqual([
      "The seller isn't the wallet that holds the registry NFT.",
      "some new code",
    ]);
  });

  it("nothing checked: no badge", () => {
    expect(sellerBadge(null)).toBeNull();
    expect(sellerBadge(undefined)).toBeNull();
  });
});

describe("masumi: trusted agents", () => {
  it("validates 56 + 64 hex characters", () => {
    expect(isValidAgentIdentifier(ID)).toBe(true);
    expect(isValidAgentIdentifier(` ${ID.toUpperCase()} `)).toBe(true);
    expect(isValidAgentIdentifier(ID.slice(1))).toBe(false);
    expect(isValidAgentIdentifier(`${ID.slice(1)}g`)).toBe(false);
  });

  it("adds normalized, rejects invalid and duplicates", () => {
    expect(addTrustedAgent([], ID.toUpperCase())).toEqual({ list: [ID], error: null });
    expect(addTrustedAgent([ID], ID).error).toBe("duplicate");
    expect(addTrustedAgent([], "abc").error).toBe("invalid");
    const full = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(120, "0"));
    expect(addTrustedAgent(full, ID).error).toBe("full");
  });

  it("shortens identifiers for display", () => {
    expect(shortAgentIdentifier(ID)).toBe("aaaaaaaa…bbbbbb");
  });

  it("labels the Masumi policy reasons", () => {
    expect(policyReasonText({ code: "AGENT_NOT_REGISTERED", message: "x" })).toBe(
      "Seller isn't a registered Masumi agent: x.",
    );
    expect(policyReasonText({ code: "AGENT_NOT_TRUSTED", message: "x" })).toBe(
      "Seller isn't on your trusted agents: x.",
    );
  });
});

describe("masumi: simulated registry", () => {
  it("serves contract-valid, clearly simulated listings", () => {
    const res = MasumiAgentSearchResultSchema.parse(mockListMasumiAgents({}));
    expect(res.agents.map((a) => a.name)).toEqual([
      "Cardano Address Intelligence",
      "Cardano Token Intelligence",
      "Stake Pool Scout",
      "Governance Digest",
    ]);
    for (const a of MOCK_MASUMI_AGENTS) {
      expect(a.description).toMatch(/^Simulated listing\./);
      // Third-party listings use .example hosts; our own sellers their zyropay.online ones.
      expect(endpointHost(a.apiBaseUrl)).toMatch(/\.example$|\.zyropay\.online$/);
    }
    expect(mockListMasumiAgents({ tag: "tokens" }).agents.map((a) => a.name)).toEqual([
      "Cardano Token Intelligence",
    ]);
    expect(() => mockListMasumiAgents({ q: "simulate-error" })).toThrow();
  });

  it("looks agents up by identifier", () => {
    expect(MasumiAgentResolutionSchema.parse(mockGetMasumiAgent(MOCK_SELLER_AGENT_ID)).status).toBe(
      "active",
    );
    expect(mockGetMasumiAgent("f".repeat(120)).status).toBe("not_found");
    const burned = MOCK_MASUMI_AGENTS.find((a) => !a.active);
    expect(mockGetMasumiAgent(burned?.agentIdentifier ?? "").status).toBe("burned");
  });

  it("attaches seller identity to escrow payments only", () => {
    expect(
      mockSellerIdentity("https://address-intel.zyropay.online/v1/audits/address/x", true)
        ?.registered,
    ).toBe(true);
    expect(
      mockSellerIdentity("https://address-intel.zyropay.online/v1/datasets/x", true)?.reasons,
    ).toEqual(["not_claimed"]);
    expect(
      mockSellerIdentity("https://address-intel.zyropay.online/v1/audits/address/x", false),
    ).toBeNull();
  });
});
