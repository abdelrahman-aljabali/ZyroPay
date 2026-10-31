import {
  type AllowanceMoney,
  type CreateAllowanceBody,
  addressesEqual,
  apiError,
  CARDANO_TURNKEY_ACCOUNT,
  cardanoEnterpriseAddress,
  IMPORTED_KEY_DERIVATION_PATH,
  chainFamilyOf,
  explorerTxUrl,
  getNetwork,
  httpStatusFor,
  isValidAddressForNetwork,
  networksOfFamily,
  normalizeAddress,
  networksForMode,
  parseBaseUnits,
  sha256Hex,
  subtractBaseUnits,
  TERMINAL_STATES,
  toChecksumAddress,
  type Agent,
  type AgentActivityItem,
  type AgentPolicy,
  type DelegatedSigner,
  type ErrorCode,
  type Transaction,
  type TransactionRequest,
  type TransactionRequestResult,
  type WatchWallet,
  type X402Delivery,
  type X402Escrow,
  type X402EscrowAction,
} from "@zyropay/shared";
import {
  SIMULATED_IMPORT_PREFIX,
  SIMULATED_NEW_WALLET_PREFIX,
  simulatedImports,
} from "@/lib/turnkey/signer";
import { lovelaceToFiat } from "@/lib/allowance";
import { escrowTermsOf } from "@/lib/escrow";
import { endpoints, type EndpointKey, type Transport, type TransportRequest } from "../client";
import {
  MockRegistryUnavailable,
  mockGetMasumiAgent,
  mockListMasumiAgents,
  mockSellerIdentity,
} from "./masumi";
import {
  advanceEscrow,
  EscrowConflict,
  escrowViewOf,
  MOCK_RECEIVED_SHA256,
  newMockEscrow,
  prepareEscrowSpend,
  submitEscrowSpend,
  type MockEscrow,
} from "./escrow";
import {
  advanceAllowance,
  AllowanceMockError,
  allowanceView,
  createAllowance,
  duePayment,
  MOCK_ADA_PRICE,
  ownerSpend,
  submitAllowance,
  type AllowanceOwner,
  type MockAllowance,
} from "./allowance";
import {
  ADA_PUBLIC_KEY_MAIN,
  ADDR,
  AGENT_CLAUDE,
  ASSETS,
  assetById,
  fakeHex,
  fakeId,
  fakeSolanaAddress,
  fiatValueOf,
  iso,
  makeAgents,
  makeApprovals,
  makeBalances,
  makeReview,
  makePlugins,
  makeReviewForSend,
  makeTransactions,
  makeUser,
  makeWallets,
  makeWatchBalances,
  makeWatchWallets,
  priceOf,
  USER_ID,
  WALLET_MAIN,
  x402Terms,
  type MockApproval,
} from "./fixtures";

/*
 * DEV MOCK TRANSPORT — enabled only with EXPO_PUBLIC_USE_MOCKS=1 and never in
 * production mode. It answers the shared REST contracts with simulated,
 * contract-valid fixtures; the real ApiClient still validates every response.
 */

class MockHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface MockState {
  wallets: ReturnType<typeof makeWallets>;
  /** Unlinked wallets (keys stay in the simulated Turnkey sub-org; re-creating links them back). */
  removedWallets: ReturnType<typeof makeWallets>;
  watchWallets: WatchWallet[];
  watchBalances: ReturnType<typeof makeWatchBalances>;
  /** Idempotency-Key -> created entity id (mirrors the API's replay behaviour). */
  idempotency: Map<string, string>;
  balances: ReturnType<typeof makeBalances>;
  transactions: Transaction[];
  agents: Agent[];
  approvals: MockApproval[];
  enabledPlugins: Set<string>;
  connections: Map<string, ConnectionRecord>;
  sends: Map<string, MockApproval["review"]>;
  /** Simulated delegated signer (autonomous mode, ADR-001 D6). */
  delegatedSigner: DelegatedSigner | null;
  /** Requests an autonomous agent executed without asking (activity feed). */
  autonomousRuns: TransactionRequest[];
  /** Approval id -> when it was approved: drives the simulated SIGNING -> CONFIRMED walk. */
  approvedAt: Map<string, number>;
  /** Request id -> simulated Masumi escrow (pay_x402 into escrow only). */
  escrows: Map<string, MockEscrow>;
  /** Agent id -> simulated Cardano auto-pay allowance (mock/allowance.ts). */
  allowances: Map<string, MockAllowance>;
  counter: number;
}

interface ConnectionRecord {
  id: string;
  userCode: string;
  clientName: string;
  clientUri: string | null;
  redirectUri: string;
  scopes: string[];
  status: "pending" | "approved" | "rejected" | "expired";
  agentId: string | null;
  expiresAt: string;
}

function initialState(): MockState {
  const agents = makeAgents();
  const approvals = makeApprovals();
  // The fixtures contain an autonomous agent, so a simulated delegated signer exists already.
  const autonomous = agents.filter((a) => a.policy.mode === "autonomous");
  const template = approvals[0]?.review.request;
  const autonomousRuns: TransactionRequest[] =
    template === undefined
      ? []
      : autonomous.flatMap((agent, i) =>
          [0, 1].map((k) => ({
            ...template,
            id: fakeId(12, i * 10 + k + 1),
            requester: { type: "agent" as const, agentId: agent.id, userId: USER_ID },
            state: "CONFIRMED" as const,
            policyDecision: "allow" as const,
            policyReasons: [],
            createdAt: iso(-(k + 1) * 3_600_000),
            updatedAt: iso(-(k + 1) * 3_600_000 + 30_000),
          })),
        );
  // Escrow payments: the pending one's seller delivers 15 s after the lock confirms; the one
  // approved earlier is locked (with its lock transaction) and waits for the seller.
  const escrows = new Map<string, MockEscrow>();
  for (const a of approvals) {
    if (escrowTermsOf(a.review.payload) === null) continue;
    const settled = a.review.request.state === "CONFIRMED";
    if (settled) a.review.request = { ...a.review.request, txHash: fakeHex(90 + escrows.size, 32) };
    const seller = a.escrowSeller;
    escrows.set(
      a.review.request.id,
      newMockEscrow(seller?.deliverAfterMs ?? (settled ? null : 15_000), seller?.result),
    );
  }
  return {
    escrows,
    allowances: new Map(),
    wallets: makeWallets(),
    removedWallets: [],
    watchWallets: makeWatchWallets(),
    watchBalances: makeWatchBalances(),
    idempotency: new Map(),
    balances: makeBalances(),
    transactions: makeTransactions(),
    agents,
    approvals,
    enabledPlugins: new Set(["x402"]),
    connections: new Map(),
    sends: new Map(),
    delegatedSigner:
      autonomous.length > 0
        ? {
            id: fakeId(13, 1),
            status: "active",
            apiPublicKey: `02${fakeHex(5, 32)}`,
            turnkeyUserId: "simulated-delegated-user",
            turnkeyPolicyIds: ["simulated-policy-1", "simulated-policy-2"],
            createdAt: iso(-86_400_000),
            revokedAt: null,
          }
        : null,
    autonomousRuns,
    approvedAt: new Map(),
    counter: 100,
  };
}

let state = initialState();

/** Reset simulated state (Settings → "Reset simulated data", tests). */
export function resetMockState(): void {
  state = initialState();
}

type Ctx = {
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: unknown;
};

type Handler = (ctx: Ctx) => unknown;

const DEV_NETWORKS = networksForMode("development");

function requestResult(
  review: MockApproval["review"],
  overrides: Partial<TransactionRequestResult> = {},
): TransactionRequestResult {
  const r = review.request;
  return {
    requestId: r.id,
    state: r.state,
    decision: r.policyDecision,
    reasons: r.policyReasons,
    payloadHash: r.payloadHash,
    approvalUrl: null,
    txHash: r.txHash,
    explorerUrl: r.txHash === null ? null : explorerTxUrl(r.payload.network, r.txHash),
    expiresAt: r.expiresAt,
    simulated: true,
    ...overrides,
  };
}

function findAgent(id: string | undefined): Agent {
  const agent = state.agents.find((a) => a.id === id);
  if (!agent) throw new MockHttpError("NOT_FOUND", "Agent not found");
  return agent;
}

function findApproval(id: string | undefined): MockApproval {
  const item = state.approvals.find((a) => a.approval.id === id);
  if (!item) throw new MockHttpError("NOT_FOUND", "Approval not found");
  return item;
}

function assertSimulatedStamp(body: unknown): void {
  const b = body as { signRequest?: { stamp?: { stampHeaderName?: string } } };
  if (b.signRequest?.stamp?.stampHeaderName !== "X-Stamp-Webauthn") {
    throw new MockHttpError("FORBIDDEN", "Approvals require a passkey stamp (X-Stamp-Webauthn)");
  }
}

/**
 * The stamp must be over what the review asks the passkey to sign, as the API checks it:
 * SIGN_RAW_PAYLOAD for Cardano (body hash) and x402 on EVM (EIP-712 digest, NO_OP hashing),
 * SIGN_TRANSACTION otherwise. The stamp itself is simulated and not checked.
 */
function assertStampMatchesReview(body: unknown, review: MockApproval["review"]): void {
  const req = (body as { signRequest?: { url?: string; body?: string } }).signRequest;
  const raw = review.rawPayload !== undefined || review.typedData !== undefined;
  const path = raw ? "/public/v1/submit/sign_raw_payload" : "/public/v1/submit/sign_transaction";
  if (req?.url?.endsWith(path) !== true)
    throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "Wrong Turnkey activity for this review");
  if (review.typedData === undefined) return;
  let params: { payload?: unknown; hashFunction?: unknown; signWith?: unknown } | undefined;
  try {
    params = (JSON.parse(req.body ?? "") as { parameters?: typeof params }).parameters;
  } catch {
    params = undefined;
  }
  if (
    params?.payload !== review.typedData.digest ||
    params.hashFunction !== "HASH_FUNCTION_NO_OP" ||
    params.signWith !== review.payload.from
  )
    throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "The stamp is not over the typed-data digest");
}

/** Simulated settlement after approval (ms since approving). x402 is handed off first. */
const SETTLE = { broadcastMs: 4_000, confirmMs: 10_000 } as const;

/**
 * Walk an approved request forward on read, like the API following the chain: x402 sits in
 * SIGNING until the (simulated) seller submits it, then BROADCAST, then CONFIRMED.
 */
function settle(item: MockApproval): void {
  const at = state.approvedAt.get(item.approval.id);
  if (at === undefined) return;
  const r = item.review.request;
  const elapsed = Date.now() - at;
  if (r.state === "SIGNING" && elapsed >= SETTLE.broadcastMs) {
    item.review.request = {
      ...r,
      state: "BROADCAST",
      txHash: fakeTxHash(r.payload.network, state.counter++),
      updatedAt: iso(0),
    };
  }
  const next = item.review.request;
  if (next.state === "BROADCAST" && elapsed >= SETTLE.confirmMs) {
    item.review.request = { ...next, state: "CONFIRMED", updatedAt: iso(0) };
    state.approvedAt.delete(item.approval.id);
  }
}

/**
 * pay_x402 delivery as the API reports it: once the (simulated) seller has the payment, it
 * "answered" with a delivery receipt that verified (signed by payTo over the exact body).
 */
function x402Delivery(item: MockApproval): X402Delivery | undefined {
  const { payload, request } = item.review;
  const resourceUrl = payload.plugin === "x402" ? payload.pluginData?.resourceUrl : undefined;
  if (typeof resourceUrl !== "string") return undefined;
  const delivered = request.state === "BROADCAST" || request.state === "CONFIRMED";
  const escrow = mockEscrowOf(item);
  return {
    ...(escrow ? { escrow } : {}),
    sellerIdentity: mockSellerIdentity(resourceUrl, escrow !== undefined),
    status: delivered
      ? "delivered"
      : request.state === "SIGNING"
        ? "ready"
        : TERMINAL_STATES.includes(request.state)
          ? "closed"
          : "awaiting_signature",
    resourceUrl,
    httpStatus: delivered ? 200 : null,
    deliveredAt: delivered ? request.updatedAt : null,
    proof:
      escrow !== undefined
        ? escrow.proof
        : delivered
          ? {
              state: "receipt_only",
              receivedHash: MOCK_RECEIVED_SHA256,
              onChainHash: null,
              resultTx: null,
              checkedAt: request.updatedAt,
              message: "Direct payment: no result is recorded on chain.",
            }
          : null,
    receipt: delivered
      ? {
          verified: true,
          contentSha256: MOCK_RECEIVED_SHA256,
          signedBy: payload.to,
          signedAt: request.updatedAt,
          reason: null,
        }
      : null,
  };
}

/** The simulated escrow of an escrow payment, walked forward to now. */
function mockEscrowOf(item: MockApproval): X402Escrow | undefined {
  const e = state.escrows.get(item.review.request.id);
  if (e === undefined) return undefined;
  advanceEscrow(e, item, () => state.counter++);
  return escrowViewOf(e, item);
}

function findEscrow(requestId: string | undefined): { item: MockApproval; e: MockEscrow } {
  const item = state.approvals.find((a) => a.review.request.id === requestId);
  const e = item ? state.escrows.get(item.review.request.id) : undefined;
  if (!item || !e) throw new MockHttpError("NOT_FOUND", "This request has no escrow");
  settle(item);
  advanceEscrow(e, item, () => state.counter++);
  return { item, e };
}

function prepareEscrow(requestId: string | undefined, action: X402EscrowAction) {
  const { item, e } = findEscrow(requestId);
  try {
    const review = prepareEscrowSpend(e, item, action);
    return { review, escrow: escrowViewOf(e, item) };
  } catch (err) {
    if (err instanceof EscrowConflict)
      throw new MockHttpError("CONFLICT", err.message, err.details);
    throw err;
  }
}

function submitEscrow(requestId: string | undefined, action: X402EscrowAction, body: unknown) {
  assertSimulatedStamp(body);
  const { item, e } = findEscrow(requestId);
  const b = body as { payloadHash?: string; bodyHash?: string };
  if (b.payloadHash !== item.review.payloadHash)
    throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "Payload changed");
  assertStampMatchesReview(body, item.review);
  try {
    submitEscrowSpend(
      e,
      action,
      b.bodyHash ?? "",
      fakeTxHash(item.review.payload.network, state.counter++),
    );
  } catch (err) {
    if (err instanceof EscrowConflict)
      throw err.message === "BODY_HASH"
        ? new MockHttpError(
            "PAYLOAD_HASH_MISMATCH",
            "The escrow spend changed since it was reviewed",
          )
        : new MockHttpError("CONFLICT", err.message);
    throw err;
  }
  return { escrow: escrowViewOf(e, item) };
}

function fakeTxHash(network: Transaction["network"], n: number): string {
  const family = getNetwork(network).family;
  if (family === "evm") return `0x${fakeHex(n, 32)}`;
  if (family === "cardano") return fakeHex(300 + n, 32);
  return fakeSolanaAddress(300 + n) + fakeSolanaAddress(400 + n);
}

function session() {
  return {
    accessToken: `simulated-access-${String(state.counter++)}`,
    accessTokenExpiresAt: iso(15 * 60_000),
    refreshToken: `simulated-refresh-${String(state.counter++)}`,
    refreshTokenExpiresAt: iso(30 * 24 * 3600_000),
  };
}

function portfolio(walletId?: string, network?: string) {
  const linked = new Set(state.wallets.map((w) => w.id));
  return snapshot(
    state.balances.filter(
      (b) =>
        linked.has(b.walletId) &&
        (walletId === undefined || b.walletId === walletId) &&
        (network === undefined || b.network === network),
    ),
    [...DEV_NETWORKS],
  );
}

function snapshot(balances: MockState["balances"], networks: Transaction["network"][]) {
  const totalCents = balances.reduce(
    (sum, b) => sum + (b.value ? BigInt(b.value.value.replace(".", "")) : 0n),
    0n,
  );
  const whole = totalCents / 100n;
  const cents = (totalCents % 100n).toString().padStart(2, "0");
  return {
    asOf: iso(-30_000),
    stale: false,
    currency: "USD",
    totalValue: { value: `${whole.toString()}.${cents}`, currency: "USD" },
    unpricedAssetCount: balances.filter((b) => b.value === null).length,
    networks,
    balances,
    simulated: true,
  };
}

function priceHistory(assetId: string, range: string, currency: string) {
  const asset = assetById(assetId);
  const price = asset ? priceOf(asset) : null;
  const base = { assetId, currency, range, simulated: true };
  if (currency !== "USD")
    return { history: { status: "unavailable", ...base, reason: "CURRENCY_UNSUPPORTED" } };
  if (!asset || price === null)
    return { history: { status: "unavailable", ...base, reason: "UNSUPPORTED_ASSET" } };
  const points = 48;
  const spanMs =
    { "1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000, "1Y": 365 * 86_400_000 }[
      range
    ] ?? 7 * 86_400_000;
  const [whole = "0", frac = ""] = price.split(".");
  const baseCents = BigInt(whole + frac.padEnd(2, "0").slice(0, 2));
  let seed = asset.symbol.charCodeAt(0) * 97 + range.length * 13;
  // Shorter ranges move less, so the simulated 24h change looks like a plausible day.
  const calm = ({ "1D": 5n, "1W": 4n, "1M": 2n } as Record<string, bigint>)[range] ?? 1n;
  const drift = ({ "1D": 3000n, "1W": 1200n, "1M": 600n } as Record<string, bigint>)[range] ?? 250n;
  const series: { t: string; price: string }[] = [];
  for (let i = 0; i < points; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const swing =
      asset.symbol === "USDC"
        ? BigInt((seed % 3) - 1)
        : (baseCents * BigInt((seed % 1200) - 600)) / (10000n * calm);
    const cents = baseCents + swing - (baseCents * BigInt(points - i)) / drift;
    const final = i === points - 1 ? baseCents : cents > 0n ? cents : 1n;
    series.push({
      t: new Date(Date.now() - spanMs + (spanMs / (points - 1)) * i).toISOString(),
      price: `${(final / 100n).toString()}.${(final % 100n).toString().padStart(2, "0")}`,
    });
  }
  return { history: { status: "available", ...base, points: series, source: "mock" } };
}

/** Mirrors the API: autonomy needs an active signer and a recorded (or supplied) envelope. */
function assertAutonomyAllowed(body: unknown): void {
  const signer = state.delegatedSigner;
  if (signer?.status !== "active")
    throw new MockHttpError("FORBIDDEN", "autonomous mode requires an active delegated signer");
  const request = (body as { turnkeyPolicyRequest?: { url?: string; body?: string } })
    .turnkeyPolicyRequest;
  if (request === undefined) {
    if (signer.turnkeyPolicyIds.length === 0)
      throw new MockHttpError("FORBIDDEN", "autonomous mode requires the Turnkey policy envelope");
    return;
  }
  assertSimulatedStamp({ signRequest: request });
  const parsed = JSON.parse(request.body ?? "{}") as {
    type?: string;
    parameters?: { policies?: { effect: string; consensus?: string }[] };
  };
  const policies = parsed.parameters?.policies ?? [];
  const bound = `approvers.any(user, user.id == '${signer.turnkeyUserId ?? ""}')`;
  if (
    parsed.type !== "ACTIVITY_TYPE_CREATE_POLICIES" ||
    policies.length === 0 ||
    policies.some((p) => p.effect === "EFFECT_ALLOW" && p.consensus !== bound)
  )
    throw new MockHttpError("FORBIDDEN", "invalid Turnkey policy request");
  state.delegatedSigner = {
    ...signer,
    turnkeyPolicyIds: policies.map((_, i) => `simulated-policy-${String(state.counter++ + i)}`),
  };
}

// --- auto-pay allowance (mock/allowance.ts) ----------------------------------------------

function allowanceError(e: unknown): never {
  if (e instanceof AllowanceMockError) throw new MockHttpError(e.code, e.message);
  throw e;
}

/** The wallet that funds an allowance: one of the user's, with a Cardano key, shared. */
function allowanceOwner(agent: Agent, walletId: string): AllowanceOwner {
  const wallet = state.wallets.find((w) => w.id === walletId);
  const ada = wallet?.addresses.find((a) => a.family === "cardano")?.address;
  if (wallet === undefined || ada === undefined)
    throw new MockHttpError("VALIDATION_FAILED", "the wallet has no Cardano account");
  if (!agent.policy.allowedWalletIds.includes(walletId))
    throw new MockHttpError("FORBIDDEN", "the wallet is not shared with this agent");
  // Only the main wallet's (simulated) Cardano key is known to the mock.
  if (ada !== ADDR.adaMain) throw new MockHttpError("VALIDATION_FAILED", "unknown Cardano key");
  return { walletId, ownerAddress: ada, ownerPublicKey: ADA_PUBLIC_KEY_MAIN };
}

function allowanceTx(
  n: number,
  direction: Transaction["direction"],
  from: string,
  to: string,
  lovelace: bigint,
  txHash: string,
  requestId: string | null = null,
): Transaction {
  const amount = lovelace.toString();
  return {
    id: fakeId(4, 500 + n),
    walletId: WALLET_MAIN,
    network: "cardano-preprod",
    txHash,
    direction,
    status: "confirmed",
    from,
    to,
    asset: ASSETS.ada,
    amount,
    fee: direction === "in" ? null : "312000",
    valueAtTime: fiatValueOf(ASSETS.ada, amount),
    timestamp: iso(0),
    blockNumber: String(2_000_000 + n),
    transactionRequestId: requestId,
    explorerUrl: explorerTxUrl("cardano-preprod", txHash),
    simulated: true,
  };
}

/**
 * Walk every allowance forward: confirmations, and the simulated agent's payments once one is
 * active: a 2 ADA x402 purchase auto-paid from the allowance (no approval), then a 40 ADA one
 * over the limits that comes to the phone with ALLOWANCE_LIMIT_EXCEEDED.
 */
function tickAllowances(): void {
  const now = Date.now();
  for (const [agentId, m] of state.allowances) {
    const before = m.allowance.status;
    advanceAllowance(m, now);
    const after = m.allowance.status;
    const hash = m.allowance.lastTxHash ?? "";
    if (before === "creating" && after === "active")
      state.transactions.unshift(
        allowanceTx(
          state.counter++,
          "out",
          m.allowance.ownerAddress,
          m.allowance.scriptAddress,
          BigInt(m.allowance.budgetLovelace),
          hash,
        ),
      );
    if (before === "revoking" && after === "revoked")
      state.transactions.unshift(
        allowanceTx(
          state.counter++,
          "in",
          m.allowance.scriptAddress,
          m.allowance.ownerAddress,
          BigInt(m.allowance.budgetLovelace) - 2_000_000n,
          hash,
        ),
      );
    const n = state.counter;
    const payee = ADDR.sellerAda;
    const listed =
      m.allowance.limits.payees.mode === "any" ||
      m.allowance.limits.payees.addresses.includes(payee);
    if (!listed) continue;
    const resourceUrl = `https://address-intel.zyropay.online/v1/reports/address/${ADDR.friendAda}`;
    const x402 = (amount: string) =>
      x402Terms({
        network: "cardano:preprod",
        asset: "lovelace",
        payTo: payee,
        amount,
        resourceUrl,
        description: "Cardano address intelligence report",
        extra: { assetTransferMethod: "default" },
      });
    const requestId = fakeId(6, 800 + n);
    const txHash = fakeTxHash("cardano-preprod", n);
    const small = 2_000_000n;
    if (BigInt(m.allowance.limits.perPaymentLovelace) < small) continue;
    const spend = duePayment(m, payee, small, requestId, txHash, now);
    if (spend === null) continue;
    state.counter += 2;
    const paid = makeReview(800 + n, {
      agentId,
      tool: "pay_x402",
      asset: ASSETS.ada,
      from: m.allowance.agentAddress,
      to: payee,
      amount: small.toString(),
      plugin: "x402",
      expiresInMs: 5 * 60_000,
      walletId: m.allowance.walletId,
      state: "CONFIRMED",
      pluginData: x402(small.toString()),
    }).request;
    state.autonomousRuns.push({
      ...paid,
      id: requestId,
      policyDecision: "allow",
      policyReasons: [{ code: "AUTO_PAY_ALLOWANCE", message: "Paid from the on-chain allowance." }],
      txHash,
      createdAt: iso(0),
      updatedAt: iso(0),
    });
    state.transactions.unshift(
      allowanceTx(n, "out", m.allowance.scriptAddress, payee, small, txHash, requestId),
    );
    // Then one over the limits: it comes to the phone, and says why.
    const big = BigInt(m.allowance.limits.perPaymentLovelace) + 10_000_000n;
    const review = makeReview(801 + n, {
      agentId,
      tool: "pay_x402",
      asset: ASSETS.ada,
      from: m.allowance.ownerAddress,
      to: payee,
      amount: big.toString(),
      plugin: "x402",
      expiresInMs: 10 * 60_000,
      walletId: m.allowance.walletId,
      state: "PENDING_APPROVAL",
      pluginData: x402(big.toString()),
    });
    review.request = {
      ...review.request,
      policyReasons: [
        { code: "AUTONOMY_NOT_SUPPORTED", message: "Cardano payments need your passkey." },
        { code: "ALLOWANCE_LIMIT_EXCEEDED", message: "over the allowance's per-payment limit" },
      ],
    };
    state.approvals.unshift({
      review,
      approval: {
        id: fakeId(7, 800 + n),
        transactionRequestId: review.request.id,
        userId: USER_ID,
        agentId,
        status: "pending",
        payloadHash: review.payloadHash,
        expiresAt: review.request.expiresAt,
        decidedAt: null,
        createdAt: iso(0),
      },
    });
  }
}

function assertRawStampOver(body: unknown, bodyHash: string): void {
  assertSimulatedStamp(body);
  const req = (body as { signRequest?: { url?: string; body?: string } }).signRequest;
  if (req?.url?.endsWith("/public/v1/submit/sign_raw_payload") !== true)
    throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "Wrong Turnkey activity for this review");
  let payload: unknown;
  try {
    payload = (JSON.parse(req.body ?? "") as { parameters?: { payload?: unknown } }).parameters
      ?.payload;
  } catch {
    payload = undefined;
  }
  if (payload !== bodyHash)
    throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "The stamp is not over the body hash");
}

/**
 * The portfolio in EUR: the mock only knows a simulated EUR price for ADA (enough for the
 * auto-pay previews); other assets show no EUR price rather than a made-up one.
 */
function inCurrency(p: ReturnType<typeof portfolio>, currency: string | undefined) {
  if (currency !== "EUR") return p;
  const balances = p.balances.map((b) =>
    b.asset.symbol === "ADA" && b.price !== null
      ? {
          ...b,
          price: { value: MOCK_ADA_PRICE.EUR, currency: "EUR" },
          value: {
            value: lovelaceToFiat(BigInt(b.amount), MOCK_ADA_PRICE.EUR) ?? "0.00",
            currency: "EUR",
          },
        }
      : { ...b, price: null, value: null },
  );
  const cents = balances.reduce(
    (sum, b) => sum + (b.value ? BigInt(b.value.value.replace(".", "")) : 0n),
    0n,
  );
  return {
    ...p,
    currency: "EUR",
    totalValue: {
      value: `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`,
      currency: "EUR",
    },
    unpricedAssetCount: balances.filter((b) => b.value === null).length,
    balances,
  };
}

const handlers: Partial<Record<EndpointKey, Handler>> = {
  createSession: () => ({ user: makeUser(), isNewUser: false, session: session() }),
  refreshSession: () => ({ session: session() }),
  deleteSession: () => ({ ok: true }),
  getMe: () => ({ user: makeUser() }),
  listWallets: () => ({ wallets: state.wallets }),
  syncWallets: () => ({ wallets: state.wallets }),
  getWallet: ({ params }) => {
    const wallet = state.wallets.find((w) => w.id === params.walletId);
    if (!wallet) throw new MockHttpError("NOT_FOUND", "Wallet not found");
    return { wallet };
  },
  getPortfolio: ({ query }) => ({
    portfolio: inCurrency(portfolio(query.walletId, query.network), query.currency),
  }),
  listTransactions: ({ query }) => {
    tickAllowances();
    return {
      transactions: state.transactions
        .filter(
          (t) =>
            (query.walletId === undefined || t.walletId === query.walletId) &&
            (query.network === undefined || t.network === query.network),
        )
        .slice(0, Number(query.limit ?? "20")),
      nextCursor: null,
    };
  },
  getTransaction: ({ params }) => {
    const transaction = state.transactions.find((t) => t.id === params.transactionId);
    if (!transaction) throw new MockHttpError("NOT_FOUND", "Transaction not found");
    return { transaction };
  },
  quoteSend: ({ body }) => {
    const b = body as {
      walletId: string;
      network: Transaction["network"];
      to: string;
      assetId: string;
      amount: string;
      decimals: number;
    };
    if (!DEV_NETWORKS.includes(b.network))
      throw new MockHttpError("NETWORK_MODE_MISMATCH", "Network not available in development mode");
    if (!isValidAddressForNetwork(b.network, b.to))
      throw new MockHttpError("INVALID_ADDRESS", "Invalid recipient address");
    const asset = assetById(b.assetId);
    if (!asset) throw new MockHttpError("NOT_FOUND", "Unknown asset");
    if (asset.decimals !== b.decimals)
      throw new MockHttpError("DECIMALS_MISMATCH", "Decimals do not match the asset");
    const bal = state.balances.find((x) => x.walletId === b.walletId && x.asset.id === b.assetId);
    if (!bal || parseBaseUnits(bal.amount) < parseBaseUnits(b.amount))
      throw new MockHttpError("INSUFFICIENT_FUNDS", "Not enough balance");
    const n = state.counter++;
    const review = makeReviewForSend(n, b.walletId, asset, bal.address, b.to, b.amount);
    state.sends.set(review.request.id, review);
    return { review };
  },
  submitSend: ({ params, body }) => {
    assertSimulatedStamp(body);
    const review = state.sends.get(params.requestId ?? "");
    if (!review) throw new MockHttpError("NOT_FOUND", "Request not found");
    if ((body as { payloadHash: string }).payloadHash !== review.payloadHash)
      throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "Payload changed");
    const n = state.counter++;
    const txHash = fakeTxHash(review.payload.network, n);
    review.request = { ...review.request, state: "BROADCAST", txHash, policyDecision: "allow" };
    const asset = assetById(review.payload.asset.id);
    const bal = state.balances.find(
      (x) => x.walletId === review.request.walletId && x.asset.id === review.payload.asset.id,
    );
    if (bal && asset) {
      bal.amount = subtractBaseUnits(bal.amount, review.payload.amount);
      bal.value = fiatValueOf(asset, bal.amount);
    }
    if (asset) {
      state.transactions.unshift({
        id: fakeId(4, n),
        walletId: review.request.walletId,
        network: review.payload.network,
        txHash,
        direction: "out",
        status: "pending",
        from: review.payload.from,
        to: review.payload.to,
        asset,
        amount: review.payload.amount,
        fee: review.estimatedFee.amount,
        valueAtTime: review.value,
        timestamp: iso(0),
        blockNumber: null,
        transactionRequestId: review.request.id,
        explorerUrl: explorerTxUrl(review.payload.network, txHash),
        simulated: true,
      });
    }
    return { request: requestResult(review) };
  },
  cancelRequest: ({ params }) => {
    const review = state.sends.get(params.requestId ?? "");
    if (!review) throw new MockHttpError("NOT_FOUND", "Request not found");
    review.request = { ...review.request, state: "CANCELLED" };
    return { request: requestResult(review) };
  },
  getReceiveInfo: ({ query }) => {
    const wallet = state.wallets.find((w) => w.id === query.walletId);
    const network = query.network as Transaction["network"];
    const family = getNetwork(network).family;
    const address = wallet?.addresses.find((a) => a.family === family)?.address;
    if (!address) throw new MockHttpError("NOT_FOUND", "No address for that network");
    const info = getNetwork(network);
    return {
      network,
      address,
      qrPayload:
        family === "solana"
          ? `solana:${address}`
          : family === "cardano"
            ? `web+cardano:${address}`
            : `ethereum:${address}@${String(info.evmChainId)}`,
      isTestnet: info.isTestnet,
      warnings: [
        `Only send ${info.displayName} assets to this address. Assets sent from other networks can be lost.`,
        ...(info.isTestnet ? ["This is a testnet address. Test tokens have no value."] : []),
      ],
    };
  },
  // --- wallet management (mirrors apps/api: sub-org check, mode, ownership, conflicts) ---
  createWallet: ({ body }) => {
    const b = body as {
      turnkeyWalletId: string;
      network: Transaction["network"];
      name?: string;
      idempotencyKey: string;
    };
    const replay = state.idempotency.get(b.idempotencyKey);
    const replayed = state.wallets.find((w) => w.id === replay);
    if (replayed) return { wallet: replayed };
    if (!DEV_NETWORKS.includes(b.network))
      throw new MockHttpError("NETWORK_MODE_MISMATCH", "Network not available in development mode");
    const family = chainFamilyOf(b.network);
    // A removed wallet is linked back (its keys never left the sub-org).
    const revived = state.removedWallets.find((w) => w.turnkeyWalletId === b.turnkeyWalletId);
    if (revived) {
      state.removedWallets = state.removedWallets.filter((w) => w !== revived);
      if (b.name !== undefined) revived.name = b.name;
      state.wallets.push(revived);
      state.idempotency.set(b.idempotencyKey, revived.id);
      return { wallet: revived };
    }
    // ADR-003: a simulated import (public test vectors only) registers every account it
    // "created", like the API does for a real imported wallet or private key.
    const imported = b.turnkeyWalletId.startsWith(SIMULATED_IMPORT_PREFIX)
      ? simulatedImports.get(b.turnkeyWalletId)
      : undefined;
    if (imported) {
      if (state.wallets.some((w) => w.turnkeyWalletId === b.turnkeyWalletId))
        throw new MockHttpError("CONFLICT", "This wallet is already linked");
      if (!imported.accounts.some((a) => a.family === family))
        throw new MockHttpError("NETWORK_NOT_SUPPORTED", `wallet has no ${family} account`);
      const cardanoNet = DEV_NETWORKS.find((n) => chainFamilyOf(n) === "cardano");
      const n = state.counter++;
      const id = fakeId(2, n);
      const wallet = {
        id,
        userId: USER_ID,
        name: b.name ?? "Imported wallet",
        turnkeySubOrganizationId:
          state.wallets[0]?.turnkeySubOrganizationId ?? "simulated-suborg-0000",
        turnkeyWalletId: b.turnkeyWalletId,
        createdAt: iso(0),
        addresses: imported.accounts.map((a, i) => ({
          id: fakeId(3, n * 10 + 1 + i),
          walletId: id,
          family: a.family,
          address:
            a.family === "cardano" && cardanoNet !== undefined
              ? cardanoEnterpriseAddress(a.address, cardanoNet)
              : normalizeAddress(a.family, a.address),
          derivationPath:
            imported.kind === "private_key"
              ? IMPORTED_KEY_DERIVATION_PATH
              : a.family === "solana"
                ? "m/44'/501'/0'/0'"
                : a.family === "cardano"
                  ? CARDANO_TURNKEY_ACCOUNT.path
                  : "m/44'/60'/0'/0/0",
          createdAt: iso(0),
        })),
      };
      state.wallets.push(wallet);
      state.idempotency.set(b.idempotencyKey, id);
      return { wallet };
    }
    // The simulated "sub-organization" only contains wallets the simulated passkey created.
    if (!b.turnkeyWalletId.startsWith(SIMULATED_NEW_WALLET_PREFIX))
      throw new MockHttpError(
        "FORBIDDEN",
        "That wallet is not in your ZyroPay sub-organization, so it can't be added.",
      );
    if (state.wallets.some((w) => w.turnkeyWalletId === b.turnkeyWalletId))
      throw new MockHttpError("CONFLICT", "This wallet is already linked");
    const n = state.counter++;
    const id = fakeId(2, n);
    const address =
      family === "solana"
        ? fakeSolanaAddress(500 + n)
        : family === "cardano"
          ? cardanoEnterpriseAddress(sha256Hex(id), b.network)
          : toChecksumAddress(`0x${sha256Hex(id).slice(0, 40)}`);
    const wallet = {
      id,
      userId: USER_ID,
      name: b.name ?? `${getNetwork(b.network).displayName.split(" ")[0] ?? "New"} wallet`,
      turnkeySubOrganizationId:
        state.wallets[0]?.turnkeySubOrganizationId ?? "simulated-suborg-0000",
      turnkeyWalletId: b.turnkeyWalletId,
      createdAt: iso(0),
      addresses: [
        {
          id: fakeId(3, n * 10 + 1),
          walletId: id,
          family,
          address,
          derivationPath:
            family === "solana"
              ? "m/44'/501'/0'/0'"
              : family === "cardano"
                ? CARDANO_TURNKEY_ACCOUNT.path
                : "m/44'/60'/0'/0/0",
          createdAt: iso(0),
        },
      ],
    };
    state.wallets.push(wallet);
    state.idempotency.set(b.idempotencyKey, id);
    return { wallet };
  },
  renameWallet: ({ params, body }) => {
    const wallet = state.wallets.find((w) => w.id === params.walletId);
    if (!wallet) throw new MockHttpError("NOT_FOUND", "Wallet not found");
    wallet.name = (body as { name: string }).name;
    return { wallet };
  },
  removeWallet: ({ params }) => {
    const wallet = state.wallets.find((w) => w.id === params.walletId);
    if (!wallet) throw new MockHttpError("NOT_FOUND", "Wallet not found");
    if (state.wallets.length === 1)
      throw new MockHttpError("CONFLICT", "You can't remove your only wallet.");
    const agent = state.agents.find(
      (a) => !a.policy.revoked && a.policy.allowedWalletIds.includes(wallet.id),
    );
    if (agent)
      throw new MockHttpError(
        "CONFLICT",
        `${agent.name} can use this wallet. Remove it from that agent first.`,
      );
    state.wallets = state.wallets.filter((w) => w !== wallet);
    state.removedWallets.push(wallet);
    return { ok: true };
  },
  listWatchWallets: () => ({ watchWallets: state.watchWallets }),
  createWatchWallet: ({ body }) => {
    const b = body as {
      network: Transaction["network"];
      address: string;
      name?: string;
      idempotencyKey: string;
    };
    const replay = state.watchWallets.find((w) => w.id === state.idempotency.get(b.idempotencyKey));
    if (replay) return { watchWallet: replay };
    if (!DEV_NETWORKS.includes(b.network))
      throw new MockHttpError("NETWORK_MODE_MISMATCH", "Network not available in development mode");
    if (!isValidAddressForNetwork(b.network, b.address))
      throw new MockHttpError(
        "INVALID_ADDRESS",
        `That is not a valid ${getNetwork(b.network).displayName} address`,
      );
    const family = chainFamilyOf(b.network);
    const address = normalizeAddress(family, b.address);
    const same = (a: string) => addressesEqual(family, a, address);
    if (state.watchWallets.some((w) => w.family === family && same(w.address)))
      throw new MockHttpError("CONFLICT", "You're already watching this address");
    if (state.wallets.some((w) => w.addresses.some((a) => a.family === family && same(a.address))))
      throw new MockHttpError("CONFLICT", "This address is one of your own wallets");
    const watchWallet: WatchWallet = {
      id: fakeId(14, state.counter++),
      userId: USER_ID,
      name: b.name ?? `Watched ${getNetwork(b.network).displayName}`,
      family,
      network: b.network,
      address,
      watchOnly: true,
      createdAt: iso(0),
    };
    state.watchWallets.push(watchWallet);
    state.idempotency.set(b.idempotencyKey, watchWallet.id);
    return { watchWallet };
  },
  renameWatchWallet: ({ params, body }) => {
    const w = state.watchWallets.find((x) => x.id === params.watchWalletId);
    if (!w) throw new MockHttpError("NOT_FOUND", "Watch wallet not found");
    w.name = (body as { name: string }).name;
    return { watchWallet: w };
  },
  removeWatchWallet: ({ params }) => {
    const w = state.watchWallets.find((x) => x.id === params.watchWalletId);
    if (!w) throw new MockHttpError("NOT_FOUND", "Watch wallet not found");
    state.watchWallets = state.watchWallets.filter((x) => x !== w);
    return { ok: true };
  },
  getWatchWalletPortfolio: ({ params }) => {
    const w = state.watchWallets.find((x) => x.id === params.watchWalletId);
    if (!w) throw new MockHttpError("NOT_FOUND", "Watch wallet not found");
    return {
      portfolio: snapshot(
        state.watchBalances.filter((b) => b.walletId === w.id),
        networksOfFamily(w.family).filter((n) => DEV_NETWORKS.includes(n)),
      ),
    };
  },
  listAgents: () => ({ agents: state.agents }),
  getAgent: ({ params }) => ({ agent: findAgent(params.agentId) }),
  updateAgent: ({ params, body }) => {
    const agent = findAgent(params.agentId);
    agent.name = (body as { name: string }).name;
    return { agent };
  },
  revokeAgent: ({ params }) => {
    const agent = findAgent(params.agentId);
    agent.policy = { ...agent.policy, revoked: true, version: agent.policy.version + 1 };
    agent.revokedAt = iso(0);
    for (const a of state.approvals) {
      if (a.approval.agentId === agent.id && a.approval.status === "pending")
        a.approval = { ...a.approval, status: "cancelled", decidedAt: iso(0) };
    }
    return { agent };
  },
  getAgentPolicy: ({ params }) => ({ policy: findAgent(params.agentId).policy }),
  updateAgentPolicy: ({ params, body }) => {
    const agent = findAgent(params.agentId);
    const b = body as { expectedVersion: number; policy: Omit<AgentPolicy, "version" | "revoked"> };
    if (b.expectedVersion !== agent.policy.version)
      throw new MockHttpError("VERSION_CONFLICT", "Policy changed elsewhere; reload and try again");
    if (b.policy.mode === "autonomous") assertAutonomyAllowed(body);
    agent.policy = {
      ...b.policy,
      revoked: agent.policy.revoked,
      version: agent.policy.version + 1,
    };
    return { policy: agent.policy };
  },
  claimAgentConnection: ({ body }) => {
    const userCode = (body as { userCode: string }).userCode;
    const clientName = userCode.startsWith("CHAT")
      ? "ChatGPT"
      : userCode.startsWith("GROK")
        ? "Grok"
        : "Claude";
    const record: ConnectionRecord = {
      id: fakeId(8, state.counter++),
      userCode,
      clientName,
      clientUri: null,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      scopes: ["wallet:read", "payments:request"],
      status: "pending",
      agentId: null,
      expiresAt: iso(10 * 60_000),
    };
    state.connections.set(record.id, record);
    return { connection: record };
  },
  approveAgentConnection: ({ params, body }) => {
    const record = state.connections.get(params.connectionId ?? "");
    if (!record) throw new MockHttpError("NOT_FOUND", "Connection not found");
    const b = body as {
      name: string;
      walletIds: string[];
      networks: Agent["policy"]["allowedNetworks"];
    };
    const template = state.agents.find((a) => a.id === AGENT_CLAUDE);
    if (!template) throw new MockHttpError("INTERNAL_ERROR", "fixture missing");
    const agent: Agent = {
      id: fakeId(5, state.counter++),
      userId: USER_ID,
      name: b.name,
      oauthClientId: `simulated-${record.clientName.toLowerCase()}`,
      createdAt: iso(0),
      lastUsedAt: null,
      revokedAt: null,
      policy: {
        mode: "always_ask",
        spendingEnabled: false,
        allowedWalletIds: b.walletIds,
        allowedNetworks: b.networks,
        allowedTools: [...template.policy.allowedTools],
        restrictRecipients: true,
        recipientAllowlist: [],
        allowedProtocols: [],
        limits: { perTransactionUsdMinor: "0", dailyUsdMinor: "0", monthlyUsdMinor: "0" },
        overLimitBehavior: "require_approval",
        sessionExpiresAt: null,
        revoked: false,
        version: 1,
      },
    };
    state.agents.unshift(agent);
    record.status = "approved";
    record.agentId = agent.id;
    return { connection: record, agent };
  },
  rejectAgentConnection: ({ params }) => {
    const record = state.connections.get(params.connectionId ?? "");
    if (!record) throw new MockHttpError("NOT_FOUND", "Connection not found");
    record.status = "rejected";
    return { connection: record };
  },
  listApprovals: ({ query }) => {
    tickAllowances();
    for (const a of state.approvals) {
      if (
        a.approval.status === "pending" &&
        new Date(a.approval.expiresAt).getTime() < Date.now()
      ) {
        a.approval = { ...a.approval, status: "expired" };
      }
    }
    return {
      approvals: state.approvals
        .map((a) => a.approval)
        .filter((a) => query.status === undefined || a.status === query.status),
      nextCursor: null,
    };
  },
  getApproval: ({ params }) => {
    const item = findApproval(params.approvalId);
    settle(item);
    const agent = item.approval.agentId
      ? (state.agents.find((a) => a.id === item.approval.agentId) ?? null)
      : null;
    const x402 = x402Delivery(item);
    return { approval: item.approval, review: item.review, agent, ...(x402 ? { x402 } : {}) };
  },
  approveApproval: ({ params, body }) => {
    assertSimulatedStamp(body);
    const item = findApproval(params.approvalId);
    if (item.approval.status !== "pending")
      throw new MockHttpError("ILLEGAL_STATE_TRANSITION", "Approval is no longer pending");
    if (new Date(item.approval.expiresAt).getTime() < Date.now())
      throw new MockHttpError("REQUEST_EXPIRED", "Approval expired");
    if ((body as { payloadHash: string }).payloadHash !== item.approval.payloadHash)
      throw new MockHttpError("PAYLOAD_HASH_MISMATCH", "Payload changed");
    assertStampMatchesReview(body, item.review);
    item.approval = { ...item.approval, status: "approved", decidedAt: iso(0) };
    // x402: signed, then ZyroPay hands the payment to the seller, who submits it. Anything
    // else is broadcast by the API right away.
    item.review.request =
      item.review.payload.plugin === "x402"
        ? { ...item.review.request, state: "SIGNING", updatedAt: iso(0) }
        : {
            ...item.review.request,
            state: "BROADCAST",
            txHash: fakeTxHash(item.review.payload.network, state.counter++),
            updatedAt: iso(0),
          };
    state.approvedAt.set(item.approval.id, Date.now());
    return { approval: item.approval, request: requestResult(item.review) };
  },
  rejectApproval: ({ params }) => {
    const item = findApproval(params.approvalId);
    if (item.approval.status !== "pending")
      throw new MockHttpError("ILLEGAL_STATE_TRANSITION", "Approval is no longer pending");
    item.approval = { ...item.approval, status: "rejected", decidedAt: iso(0) };
    item.review.request = { ...item.review.request, state: "REJECTED" };
    return { approval: item.approval, request: requestResult(item.review) };
  },
  getX402Escrow: ({ params }) => {
    const { item, e } = findEscrow(params.requestId);
    return { escrow: escrowViewOf(e, item) };
  },
  prepareX402RefundRequest: ({ params }) => prepareEscrow(params.requestId, "request_refund"),
  submitX402RefundRequest: ({ params, body }) =>
    submitEscrow(params.requestId, "request_refund", body),
  prepareX402RefundWithdrawal: ({ params }) => prepareEscrow(params.requestId, "withdraw_refund"),
  submitX402RefundWithdrawal: ({ params, body }) =>
    submitEscrow(params.requestId, "withdraw_refund", body),
  listPlugins: () => ({ plugins: makePlugins(state.enabledPlugins) }),
  setPluginEnabled: ({ params, body }) => {
    const enabled = (body as { enabled: boolean }).enabled;
    const id = params.pluginId ?? "";
    if (
      enabled &&
      makePlugins(state.enabledPlugins).find((p) => p.manifest.id === id)?.configured !== true
    )
      throw new MockHttpError("PLUGIN_DISABLED", "plugin is not available in this deployment");
    if (enabled) state.enabledPlugins.add(id);
    else state.enabledPlugins.delete(id);
    return { pluginId: id, enabled };
  },
  quoteOnramp: ({ body }) => {
    const b = body as {
      fiat: { value: string; currency: string };
      network: Transaction["network"];
      assetId: string;
    };
    const asset = assetById(b.assetId);
    const price = asset ? priceOf(asset) : null;
    if (!asset || price === null)
      throw new MockHttpError("VALUATION_UNAVAILABLE", "No quote for that asset");
    // crypto = (fiat - fee) / price, all in bigint cents.
    const [w = "0", f = ""] = b.fiat.value.split(".");
    const fiatCents = BigInt(w + f.padEnd(2, "0").slice(0, 2));
    const feeCents = (fiatCents * 3n) / 100n + 99n;
    const [pw = "0", pf = ""] = price.split(".");
    const priceCents = BigInt(pw + pf.padEnd(2, "0").slice(0, 2));
    const net = fiatCents > feeCents ? fiatCents - feeCents : 0n;
    const crypto = (net * 10n ** BigInt(asset.decimals)) / priceCents;
    return {
      quote: {
        quoteId: `simulated-quote-${String(state.counter++)}`,
        provider: "Transak (simulated)",
        fiat: b.fiat,
        network: b.network,
        assetId: b.assetId,
        cryptoAmount: crypto.toString(),
        decimals: asset.decimals,
        fees: {
          value: `${(feeCents / 100n).toString()}.${(feeCents % 100n).toString().padStart(2, "0")}`,
          currency: b.fiat.currency,
        },
        expiresAt: iso(60_000),
        simulated: true,
      },
    };
  },
  createOnrampSession: () => ({
    sessionId: `simulated-session-${String(state.counter++)}`,
    url: "https://example.com/?zyropay-simulated-checkout=1",
    expiresAt: iso(15 * 60_000),
    simulated: true,
  }),
  registerDevice: () => ({ deviceId: fakeId(9, state.counter++) }),
  unregisterDevice: () => ({ ok: true }),
  getPriceHistory: ({ params, query }) =>
    priceHistory(params.assetId ?? "", query.range ?? "1W", query.currency ?? "USD"),
  getAgentAllowance: ({ params }) => {
    findAgent(params.agentId);
    tickAllowances();
    return { allowance: allowanceView(state.allowances.get(params.agentId ?? ""), Date.now()) };
  },
  createAgentAllowance: ({ params, body }) => {
    const agent = findAgent(params.agentId);
    const b = body as CreateAllowanceBody;
    if (!agent.policy.allowedNetworks.includes("cardano-preprod"))
      throw new MockHttpError("FORBIDDEN", "the agent may not use Cardano Preprod");
    const owner = allowanceOwner(agent, b.walletId);
    try {
      const res = createAllowance(
        state.allowances.get(agent.id),
        agent.id,
        owner,
        b,
        state.counter++,
        Date.now(),
      );
      state.allowances.set(agent.id, res.m);
      return { allowance: res.allowance, review: res.review };
    } catch (e) {
      return allowanceError(e);
    }
  },
  topUpAgentAllowance: ({ params, body }) => {
    const agent = findAgent(params.agentId);
    const m = state.allowances.get(agent.id);
    try {
      return ownerSpend(
        m,
        allowanceOwner(agent, m?.allowance.walletId ?? ""),
        "top_up",
        (body as { budget: AllowanceMoney }).budget,
        state.counter++,
        Date.now(),
      );
    } catch (e) {
      return allowanceError(e);
    }
  },
  revokeAgentAllowance: ({ params }) => {
    const agent = findAgent(params.agentId);
    const m = state.allowances.get(agent.id);
    try {
      return ownerSpend(
        m,
        allowanceOwner(agent, m?.allowance.walletId ?? ""),
        "revoke",
        null,
        state.counter++,
        Date.now(),
      );
    } catch (e) {
      return allowanceError(e);
    }
  },
  submitAgentAllowance: ({ params, body }) => {
    const agent = findAgent(params.agentId);
    const b = body as { bodyHash: string };
    assertRawStampOver(body, b.bodyHash);
    try {
      return {
        allowance: submitAllowance(
          state.allowances.get(agent.id),
          b.bodyHash,
          fakeTxHash("cardano-preprod", state.counter++),
          Date.now(),
        ),
      };
    } catch (e) {
      return allowanceError(e);
    }
  },
  listAgentAllowanceSpends: ({ params, query }) => {
    findAgent(params.agentId);
    tickAllowances();
    const spends = state.allowances.get(params.agentId ?? "")?.spends ?? [];
    return { spends: spends.slice(0, Number(query.limit ?? "20")) };
  },
  listAgentRequests: ({ params, query }) => {
    const agent = findAgent(params.agentId);
    tickAllowances();
    for (const a of state.approvals) settle(a);
    const items: AgentActivityItem[] = [
      ...state.approvals
        .filter((a) => a.approval.agentId === agent.id)
        .map((a) => ({ request: a.review.request, approvalId: a.approval.id, autonomous: false })),
      ...state.autonomousRuns
        .filter((r) => r.requester.type === "agent" && r.requester.agentId === agent.id)
        .map((request) => ({ request, approvalId: null, autonomous: true })),
    ]
      .filter((i) => query.state === undefined || i.request.state === query.state)
      .sort((x, y) => y.request.createdAt.localeCompare(x.request.createdAt));
    return { items, nextCursor: null };
  },
  getDelegatedSigner: () => ({ signer: state.delegatedSigner }),
  createDelegatedSigner: () => {
    state.delegatedSigner ??= {
      id: fakeId(13, state.counter++),
      status: "pending",
      apiPublicKey: `03${fakeHex(state.counter++, 32)}`,
      turnkeyUserId: null,
      turnkeyPolicyIds: [],
      createdAt: iso(0),
      revokedAt: null,
    };
    return { signer: state.delegatedSigner };
  },
  activateDelegatedSigner: ({ body }) => {
    const signer = state.delegatedSigner;
    if (signer === null)
      throw new MockHttpError("NOT_FOUND", "no delegated signer; create one first");
    const turnkeyUserId = (body as { turnkeyUserId: string }).turnkeyUserId;
    if (!turnkeyUserId.startsWith("simulated-delegated-"))
      throw new MockHttpError("FORBIDDEN", "the Turnkey user does not match the delegated signer");
    state.delegatedSigner = { ...signer, status: "active", turnkeyUserId };
    return { signer: state.delegatedSigner };
  },
  listMasumiAgents: ({ query }) => {
    try {
      return mockListMasumiAgents(query);
    } catch (e) {
      if (e instanceof MockRegistryUnavailable)
        throw new MockHttpError("UPSTREAM_UNAVAILABLE", e.message);
      throw e;
    }
  },
  getMasumiAgent: ({ params }) => mockGetMasumiAgent(params.agentIdentifier ?? ""),
  deleteDelegatedSigner: () => {
    state.delegatedSigner = null;
    for (const a of state.agents)
      if (a.policy.mode === "autonomous")
        a.policy = { ...a.policy, mode: "always_ask", version: a.policy.version + 1 };
    return { ok: true };
  },
};

interface CompiledRoute {
  readonly name: EndpointKey;
  readonly method: string;
  readonly regex: RegExp;
  readonly keys: string[];
}

const routes: CompiledRoute[] = (Object.keys(endpoints) as EndpointKey[]).map((name) => {
  const contract = endpoints[name];
  const keys: string[] = [];
  const pattern = contract.path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { name, method: contract.method, regex: new RegExp(`^${pattern}$`), keys };
});

function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const [path = "", qs = ""] = url.split("?");
  const query: Record<string, string> = {};
  for (const part of qs.split("&")) {
    if (part === "") continue;
    const [k = "", v = ""] = part.split("=");
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { path, query };
}

export interface MockTransportOptions {
  /** Artificial latency so loading states are visible. */
  readonly latencyMs?: number;
}

export function mockTransport({ latencyMs = 450 }: MockTransportOptions = {}): Transport {
  return async (req: TransportRequest) => {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    const { path, query } = parseUrl(req.url);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(match[i + 1] ?? "");
      });
      const handler = handlers[route.name];
      if (!handler)
        return { status: 404, json: apiError("NOT_FOUND", `${route.name} is not simulated`) };
      try {
        const json = handler({
          params,
          query,
          body: req.body === undefined ? undefined : JSON.parse(req.body),
        });
        return { status: 200, json: JSON.parse(JSON.stringify(json)) };
      } catch (e) {
        if (e instanceof MockHttpError)
          return { status: httpStatusFor(e.code), json: apiError(e.code, e.message, e.details) };
        return {
          status: 500,
          json: apiError("INTERNAL_ERROR", e instanceof Error ? e.message : "mock failure"),
        };
      }
    }
    return { status: 404, json: apiError("NOT_FOUND", `No route for ${req.method} ${path}`) };
  };
}
