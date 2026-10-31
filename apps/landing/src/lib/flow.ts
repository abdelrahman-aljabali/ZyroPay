/**
 * "Any agent. Any chain. One decision.": who asks, what ZyroPay checks, where it settles, and a
 * ticker of real decisions. Every ticker entry with a transaction reads its hash from
 * evidence.json, so the section and the evidence ledger can never disagree; an entry whose
 * evidence is missing is dropped rather than shown without its proof.
 */
import { CARDANO_LIVE, type Tx } from "./evidence";

export interface Agent {
  readonly id: string;
  readonly name: string;
  /** The monogram on the tile: letters only, no third-party logos. */
  readonly mono: string;
  readonly role: "buyer" | "seller";
}

export const AGENTS: readonly Agent[] = [
  { id: "chatgpt", name: "ChatGPT", mono: "Gp", role: "buyer" },
  { id: "claude", name: "Claude", mono: "Cl", role: "buyer" },
  { id: "grok", name: "Grok", mono: "Gk", role: "buyer" },
  { id: "cursor", name: "Cursor", mono: "Cu", role: "buyer" },
  { id: "mcp", name: "Any MCP agent", mono: "+", role: "buyer" },
  { id: "address", name: "Address Intelligence", mono: "Ad", role: "seller" },
  { id: "token", name: "Token Intelligence", mono: "Tk", role: "seller" },
  { id: "sokosumi", name: "Sokosumi Coworker", mono: "So", role: "seller" },
];

export const STEPS = ["Policy", "Passkey", "Device check", "Proof"] as const;

/** Per step: passed, not needed for this decision, or where the decision stopped. */
export type StepState = "on" | "off" | "stop";

export type Verdict = "auto" | "passkey" | "denied" | "refunded" | "hire" | "delivered";

export interface Decision {
  readonly id: string;
  readonly from: string;
  readonly fromAgent: string;
  readonly amount: string;
  readonly to: string;
  readonly toAgent: string | null;
  readonly verdict: Verdict;
  readonly verdictLabel: string;
  readonly why: string;
  readonly steps: readonly [StepState, StepState, StepState, StepState];
  /** Null only for a decision whose point is that nothing moved. */
  readonly tx: Tx | null;
}

interface Run extends Omit<Decision, "tx"> {
  readonly evidence: string | null;
}

const RUNS: readonly Run[] = [
  {
    id: "autopay",
    evidence: "autopay",
    from: "ChatGPT",
    fromAgent: "chatgpt",
    amount: "2 ADA",
    to: "Address Intelligence",
    toAgent: "address",
    verdict: "auto",
    verdictLabel: "Auto-paid",
    why: "within your on-chain allowance",
    steps: ["on", "off", "off", "on"],
  },
  {
    id: "denied",
    evidence: null,
    from: "ChatGPT",
    fromAgent: "chatgpt",
    amount: "1 ADA",
    to: "an unknown address",
    toAgent: null,
    verdict: "denied",
    verdictLabel: "Denied",
    why: "not on the allowlist · nothing moved",
    steps: ["stop", "off", "off", "off"],
  },
  {
    id: "allowed",
    evidence: "policy-allowlist",
    from: "ChatGPT",
    fromAgent: "chatgpt",
    amount: "1 ADA",
    to: "the same address",
    toAgent: null,
    verdict: "passkey",
    verdictLabel: "Passkey",
    why: "after you allowed it, approved on your phone",
    steps: ["on", "on", "on", "on"],
  },
  {
    id: "refund",
    evidence: "refund",
    from: "ChatGPT",
    fromAgent: "chatgpt",
    amount: "5 ADA",
    to: "Masumi escrow",
    toAgent: null,
    verdict: "refunded",
    verdictLabel: "Refunded",
    why: "the seller’s result did not match",
    steps: ["on", "on", "on", "stop"],
  },
  {
    id: "hire",
    evidence: "sub-hire",
    from: "Address Intelligence",
    fromAgent: "address",
    amount: "1.5 ADA",
    to: "Token Intelligence",
    toAgent: "token",
    verdict: "hire",
    verdictLabel: "Agent hires agent",
    why: "from its own capped budget",
    steps: ["on", "off", "off", "on"],
  },
  {
    id: "sokosumi",
    evidence: "sokosumi-task",
    from: "Sokosumi",
    fromAgent: "sokosumi",
    amount: "1 tUSDM",
    to: "Masumi escrow",
    toAgent: null,
    verdict: "delivered",
    verdictLabel: "Delivered",
    why: "result on chain, payment collected",
    steps: ["off", "off", "off", "on"],
  },
];

export const DECISIONS: readonly Decision[] = RUNS.flatMap(({ evidence, ...run }): Decision[] => {
  if (evidence === null) return [{ ...run, tx: null }];
  const tx = CARDANO_LIVE.find((e) => e.id === evidence)?.tx;
  return tx ? [{ ...run, tx }] : [];
});

export interface Chain {
  readonly slug: string;
  readonly name: string;
  readonly file: string;
  readonly plate: "dark" | "white" | "cardano";
  readonly assets: string;
  readonly can: readonly string[];
  readonly status: "live" | "tested";
}

/** Marks: the official files in public/brand/networks (src/lib/networks.json, unaltered). */
export const CHAINS: readonly Chain[] = [
  {
    slug: "cardano",
    name: "Cardano",
    file: "/brand/networks/cardano.svg",
    plate: "cardano",
    assets: "ADA, USDM, native tokens",
    can: ["Escrow", "Refunds", "On-chain auto-pay"],
    status: "live",
  },
  {
    slug: "solana",
    name: "Solana",
    file: "/brand/networks/solana.svg",
    plate: "dark",
    assets: "SOL, USDC",
    can: ["x402", "Auto-pay envelope"],
    status: "tested",
  },
  {
    slug: "ethereum",
    name: "Ethereum",
    file: "/brand/networks/ethereum.svg",
    plate: "dark",
    assets: "ETH, USDC",
    can: ["x402"],
    status: "tested",
  },
  {
    slug: "base",
    name: "Base",
    file: "/brand/networks/base.svg",
    plate: "white",
    assets: "ETH, USDC",
    can: ["x402"],
    status: "tested",
  },
];
