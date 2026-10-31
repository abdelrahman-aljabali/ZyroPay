import { NETWORK } from "@zyropay/seller/config";
import type { TokenData } from "./blockfrost";
import { PAGE_SIZE } from "./blockfrost";
import type { TokenQuery } from "./unit";

/*
 * The paid job: a deterministic token report computed from Blockfrost data. Same chain
 * state in -> same report out (except generatedAt). No LLM.
 *
 * riskScore = min(100, sum of the weights of the raised flags). Weights:
 *   UNKNOWN_ASSET   40  no such asset / policy on preprod
 *   OPEN_MINTING    20  minted or burned more than once: the policy may still mint
 *   SINGLE_HOLDER   20  one address holds the whole (fungible) supply
 *   CONCENTRATED    15  the largest holder has >= 90% of the supply
 *   RECENT_MINT     15  first minted less than 7 days ago
 *   NO_METADATA     10  neither on-chain (CIP-25/68) nor registry (CIP-26) metadata
 *   FEW_HOLDERS     10  fewer than 5 holders (fungible tokens)
 *   BURNED_OUT       5  current supply is 0
 * Holder figures are computed over the first Blockfrost page (100 holders).
 */

const DAY_MS = 86_400_000;
const RECENT_MINT_DAYS = 7;
const FEW_HOLDERS = 5;
const CONCENTRATED_BP = 9_000n; // basis points
const TOP_HOLDERS = 5;
const RECENT_ACTIONS = 10;

type Severity = "low" | "medium" | "high";

interface Flag {
  readonly code: string;
  readonly severity: Severity;
  readonly weight: number;
  readonly message: string;
}

const flag = (code: string, severity: Severity, weight: number, message: string): Flag => ({
  code,
  severity,
  weight,
  message,
});

function utf8Name(hex: string): string | null {
  if (hex === "") return null;
  try {
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Basis points of `part` in `whole` as "12.34" (percent), integer math. */
function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0";
  const bp = (part * 10_000n) / whole;
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}`;
}

const qty = (s: string | undefined): bigint =>
  s !== undefined && /^[0-9]+$/.test(s) ? BigInt(s) : 0n;

export function computeTokenReport(query: TokenQuery, data: TokenData, now: Date) {
  const a = data.asset;
  const flags: Flag[] = [];
  const policyId = query.policyId;
  const policy =
    data.policyAssets === null
      ? null
      : {
          policyId,
          assetCount: data.policyAssets.length,
          assetCountIsLowerBound: data.policyAssets.length >= PAGE_SIZE,
        };

  if (a === null) {
    flags.push(flag("UNKNOWN_ASSET", "high", 40, "No such asset or policy on Cardano preprod."));
    return {
      query: query.kind === "policy" ? query.policyId : query.unit,
      queryKind: query.kind,
      network: NETWORK,
      found: false,
      policy,
      asset: null,
      holders: null,
      mintHistory: null,
      metadata: null,
      riskFlags: flags,
      riskScore: 40,
      generatedAt: now.toISOString(),
      dataSource: "blockfrost-preprod" as const,
    };
  }

  const supply = qty(a.quantity);
  const holders = [...data.holders]
    .filter((h) => /^[0-9]+$/.test(h.quantity))
    .sort((x, y) => {
      const qx = BigInt(x.quantity);
      const qy = BigInt(y.quantity);
      if (qx !== qy) return qx > qy ? -1 : 1;
      return x.address < y.address ? -1 : x.address > y.address ? 1 : 0;
    });
  const top = holders[0];
  const topQty = qty(top?.quantity);
  const fungible = supply > 1n;
  const assetNameHex = a.asset_name ?? a.asset.slice(56);
  const onchain = a.onchain_metadata !== null && Object.keys(a.onchain_metadata).length > 0;
  const registry = a.metadata !== null;
  const mintMs = data.initialMint === null ? null : data.initialMint.block_time * 1000;

  if (a.mint_or_burn_count > 1)
    flags.push(
      flag(
        "OPEN_MINTING",
        "medium",
        20,
        `${a.mint_or_burn_count} mint/burn transactions: the policy may still mint.`,
      ),
    );
  if (fungible && holders.length === 1)
    flags.push(flag("SINGLE_HOLDER", "high", 20, "One address holds the entire supply."));
  else if (fungible && holders.length > 1 && (topQty * 10_000n) / supply >= CONCENTRATED_BP)
    flags.push(
      flag("CONCENTRATED", "medium", 15, `The largest holder has ${percent(topQty, supply)}%.`),
    );
  if (mintMs !== null && now.getTime() - mintMs < RECENT_MINT_DAYS * DAY_MS)
    flags.push(flag("RECENT_MINT", "medium", 15, "First minted less than 7 days ago."));
  if (!onchain && !registry)
    flags.push(flag("NO_METADATA", "low", 10, "No on-chain or registry metadata."));
  if (fungible && holders.length > 1 && holders.length < FEW_HOLDERS)
    flags.push(flag("FEW_HOLDERS", "low", 10, `Only ${holders.length} holders.`));
  if (supply === 0n) flags.push(flag("BURNED_OUT", "low", 5, "The whole supply was burned."));

  const meta = a.onchain_metadata ?? {};
  const name =
    (typeof meta.name === "string" ? meta.name : null) ??
    a.metadata?.name ??
    utf8Name(assetNameHex);

  return {
    query: query.kind === "policy" ? query.policyId : query.unit,
    queryKind: query.kind,
    network: NETWORK,
    found: true,
    policy,
    asset: {
      unit: a.asset,
      policyId: a.policy_id,
      assetNameHex,
      assetName: utf8Name(assetNameHex),
      fingerprint: a.fingerprint,
      supply: supply.toString(),
      decimals: a.metadata?.decimals ?? null,
      nftLike: supply === 1n,
    },
    holders: {
      count: holders.length,
      countIsLowerBound: data.holders.length >= PAGE_SIZE,
      topHolderPercent: percent(topQty, supply),
      top: holders.slice(0, TOP_HOLDERS).map((h) => ({ address: h.address, quantity: h.quantity })),
    },
    mintHistory: {
      mintOrBurnCount: a.mint_or_burn_count,
      initialMintTx: a.initial_mint_tx_hash,
      initialMintTime: mintMs === null ? null : new Date(mintMs).toISOString(),
      recent: data.history
        .slice(0, RECENT_ACTIONS)
        .map((h) => ({ txHash: h.tx_hash, action: h.action, amount: h.amount })),
    },
    metadata: {
      name,
      ticker: a.metadata?.ticker ?? null,
      onchain,
      onchainStandard: a.onchain_metadata_standard ?? null,
      registry,
    },
    riskFlags: flags,
    riskScore: Math.min(
      100,
      flags.reduce((s, f) => s + f.weight, 0),
    ),
    generatedAt: now.toISOString(),
    dataSource: "blockfrost-preprod" as const,
  };
}
