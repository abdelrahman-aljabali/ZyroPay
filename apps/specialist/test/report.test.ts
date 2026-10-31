import { describe, expect, it } from "vitest";
import type { TokenData } from "../src/blockfrost";
import { largestAsset } from "../src/blockfrost";
import { computeTokenReport } from "../src/report";
import { checkUnit } from "../src/unit";
import {
  ASSET,
  HISTORY,
  HOLDERS,
  MINT,
  NOW,
  OTHER_UNIT,
  POLICY,
  POLICY_ASSETS,
  UNIT,
} from "./support";

const q = (u: string) => {
  const c = checkUnit(u);
  if (!c.ok) throw new Error(c.reason);
  return c.query;
};
const DATA: TokenData = {
  policyAssets: null,
  asset: ASSET,
  holders: HOLDERS,
  history: HISTORY as TokenData["history"],
  initialMint: MINT,
};

describe("computeTokenReport", () => {
  it("is deterministic and flags open minting, concentration, recent mint, no metadata, few holders", () => {
    const r = computeTokenReport(q(UNIT), DATA, NOW);
    expect(r).toEqual(
      computeTokenReport(q(UNIT), { ...DATA, holders: [...HOLDERS].reverse() }, NOW),
    );
    expect(r.found).toBe(true);
    expect(r.asset).toMatchObject({ supply: "1000000", assetName: "testtoken", nftLike: false });
    expect(r.holders).toMatchObject({
      count: 3,
      countIsLowerBound: false,
      topHolderPercent: "94.00",
    });
    expect(r.holders?.top[0]?.quantity).toBe("940000");
    expect(r.mintHistory).toMatchObject({
      mintOrBurnCount: 3,
      initialMintTime: "2026-10-30T00:00:00.000Z",
    });
    expect(r.riskFlags.map((f) => f.code)).toEqual([
      "OPEN_MINTING",
      "CONCENTRATED",
      "RECENT_MINT",
      "NO_METADATA",
      "FEW_HOLDERS",
    ]);
    expect(r.riskScore).toBe(70);
  });

  it("an NFT with metadata and one holder raises nothing", () => {
    const nft = {
      ...ASSET,
      quantity: "1",
      mint_or_burn_count: 1,
      onchain_metadata: { name: "Test NFT", image: "ipfs://x" },
      onchain_metadata_standard: "CIP25v2",
    };
    const r = computeTokenReport(
      q(UNIT),
      {
        ...DATA,
        asset: nft,
        holders: [{ address: HOLDERS[0]!.address, quantity: "1" }],
        initialMint: { ...MINT, block_time: MINT.block_time - 30 * 86_400 },
      },
      NOW,
    );
    expect(r.riskFlags).toEqual([]);
    expect(r.asset?.nftLike).toBe(true);
    expect(r.metadata).toMatchObject({
      name: "Test NFT",
      onchain: true,
      onchainStandard: "CIP25v2",
    });
  });

  it("an unknown asset is a valid (flagged) result", () => {
    const r = computeTokenReport(
      q(POLICY),
      { policyAssets: [], asset: null, holders: [], history: [], initialMint: null },
      NOW,
    );
    expect(r).toMatchObject({ found: false, riskScore: 40, policy: { assetCount: 0 } });
    expect(r.riskFlags[0]?.code).toBe("UNKNOWN_ASSET");
  });

  it("a policy query reports its largest asset", () => {
    expect(largestAsset(POLICY_ASSETS)?.asset).toBe(UNIT);
    expect(
      largestAsset([
        { asset: OTHER_UNIT, quantity: "5" },
        { asset: UNIT, quantity: "5" },
      ])?.asset,
    ).toBe(OTHER_UNIT);
    expect(largestAsset([])).toBeNull();
  });
});
