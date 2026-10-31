import { z } from "zod";
import {
  AllowanceReviewSchema,
  AllowanceSpendSchema,
  CardanoAllowanceSchema,
  CreateAllowanceBodySchema,
  TopUpAllowanceBodySchema,
} from "../cardano-allowance";
import { AddressSchema } from "../addresses";
import { CursorSchema, IdempotencyKeySchema, IsoDateTimeSchema, PageLimitSchema } from "../common";
import { AgentPolicySchema, AgentSchema } from "../domain/agents";
import { AssetIdSchema, PriceBasisSchema } from "../domain/assets";
import {
  MasumiAgentIdentifierSchema,
  MasumiAgentResolutionSchema,
  MasumiAgentSearchQuerySchema,
  MasumiAgentSearchResultSchema,
  MasumiAgentVerificationSchema,
  MasumiAgentVerifyBodySchema,
} from "../domain/masumi";
import { PortfolioSnapshotSchema } from "../domain/portfolio";
import {
  ApprovalRequestSchema,
  ApprovalStatusSchema,
  TransactionRequestResultSchema,
  TransactionRequestSchema,
  X402DeliverySchema,
  X402EscrowActionSchema,
  X402EscrowSchema,
} from "../domain/requests";
import { TransactionSchema } from "../domain/transactions";
import { UserSchema, WalletSchema } from "../domain/wallets";
import { mcpTools } from "../mcp";
import {
  BaseUnitAmountSchema,
  DecimalsSchema,
  FiatCurrencySchema,
  FiatValueSchema,
} from "../money";
import { NetworkIdSchema } from "../networks";
import { CanonicalTransactionPayloadSchema, PayloadHashSchema } from "../payload";
import { PluginIdSchema, PluginManifestSchema } from "../plugins";
import { X402_RECEIPT_MAX_HEADER_BYTES } from "../x402-receipt";

/*
 * REST contract between the mobile app / MCP server and the API.
 * Every endpoint: method, path (":param" segments), auth, and Zod schemas.
 * The API validates requests with these schemas; clients validate responses.
 * Errors always use ApiErrorBodySchema ({ error: { code, message, details? } }).
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 *  - none:     public
 *  - user:     `Authorization: Bearer <session access token>` (mobile app)
 *  - internal: `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (MCP server only) plus the
 *              agent id in the path; the API re-checks that the agent is active.
 *  - webhook:  provider signature header verified against the raw body.
 */
export type EndpointAuth = "none" | "user" | "internal" | "webhook";

export interface EndpointContract {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly auth: EndpointAuth;
  readonly summary: string;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
  /** Requires an `Idempotency-Key` header (also echoed in the body where noted). */
  readonly idempotent?: boolean;
}

function endpoint<const T extends EndpointContract>(contract: T): T {
  return contract;
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/**
 * A request pre-signed ("stamped") by the user's passkey on the device and forwarded
 * by the API to Turnkey unmodified. The stamp covers the exact body, so the API can
 * inspect but never alter it. See docs/ARCHITECTURE.md ADR-001.
 */
export const StampedTurnkeyRequestSchema = z.object({
  /** Full Turnkey API URL, e.g. https://api.turnkey.com/public/v1/submit/sign_transaction */
  url: z.url({ protocol: /^https$/ }),
  /** Exact JSON body string that was stamped. */
  body: z.string().min(2).max(65_536),
  stamp: z.object({
    stampHeaderName: z.enum(["X-Stamp-Webauthn", "X-Stamp"]),
    stampHeaderValue: z.string().min(1).max(16_384),
  }),
});
export type StampedTurnkeyRequest = z.infer<typeof StampedTurnkeyRequestSchema>;

const SessionTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDateTimeSchema,
  refreshToken: z.string(),
  refreshTokenExpiresAt: IsoDateTimeSchema,
});

const WalletIdParams = z.object({ walletId: z.uuid() });
const AgentIdParams = z.object({ agentId: z.uuid() });
const ApprovalIdParams = z.object({ approvalId: z.uuid() });
const RequestIdParams = z.object({ requestId: z.uuid() });

const PortfolioQuery = z.object({
  walletId: z.uuid().optional(),
  network: NetworkIdSchema.optional(),
  currency: FiatCurrencySchema.default("USD"),
});

const TransactionsQuery = z.object({
  walletId: z.uuid().optional(),
  network: NetworkIdSchema.optional(),
  limit: PageLimitSchema,
  cursor: CursorSchema.optional(),
});

const TransactionsPage = z.object({
  transactions: z.array(TransactionSchema),
  nextCursor: CursorSchema.nullable(),
});

const SendDraftSchema = z.object({
  walletId: z.uuid(),
  network: NetworkIdSchema,
  to: AddressSchema,
  assetId: AssetIdSchema,
  amount: BaseUnitAmountSchema,
  decimals: DecimalsSchema,
});

/** Everything the app needs to show the user BEFORE they sign. */
export const SigningReviewSchema = z.object({
  request: TransactionRequestSchema,
  payload: CanonicalTransactionPayloadSchema,
  payloadHash: PayloadHashSchema,
  /** Unsigned transaction the passkey must sign, exactly as the API built it. */
  unsignedTransaction: z.object({
    encoding: z.enum(["base64", "hex"]),
    serialized: z.string().min(1),
  }),
  /**
   * Present when the passkey must sign typed data instead of a transaction (x402 on EVM).
   * The app then stamps SIGN_RAW_PAYLOAD_V2 over `digest` (PAYLOAD_ENCODING_HEXADECIMAL,
   * HASH_FUNCTION_NO_OP) and shows `typedData`; `unsignedTransaction.serialized` equals
   * `digest` in that case.
   */
  typedData: z
    .object({
      kind: z.literal("eip712"),
      digest: z.string().regex(/^0x[0-9a-f]{64}$/),
      typedData: z.record(z.string(), z.unknown()),
    })
    .optional(),
  /**
   * Present when the passkey must sign a raw payload instead of a transaction (Cardano;
   * docs/ARCHITECTURE.md ADR-002). The app stamps SIGN_RAW_PAYLOAD_V2 with `signWith` (the
   * account's Ed25519 public key, hex), `payload` (the blake2b-256 hash of the transaction
   * body inside `unsignedTransaction`, hex), PAYLOAD_ENCODING_HEXADECIMAL and
   * HASH_FUNCTION_NOT_APPLICABLE (Ed25519 signs the message itself). The app should
   * recompute `payload` from `unsignedTransaction.serialized`; the API re-checks both.
   */
  rawPayload: z
    .object({
      kind: z.literal("cardano_tx_body_hash"),
      payload: z.string().regex(/^[0-9a-f]{64}$/),
      signWith: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  /**
   * Present when the review is a Masumi escrow action of a pay_x402 request (refund request
   * or refund withdrawal) instead of the request's own payment. `request` and `payload` are
   * still the original request (`payloadHash` binds it); `unsignedTransaction` is the escrow
   * script spend and `rawPayload.payload` its body hash, which the passkey signs.
   */
  escrowSpend: z
    .object({
      action: X402EscrowActionSchema,
      /** The escrow UTxO being spent, `<txHash>#<index>`. */
      escrowUtxo: z.string(),
      /** Lovelace locked in the escrow (a withdrawal returns it to `refundTo`, minus the fee). */
      lockedLovelace: BaseUnitAmountSchema,
      /** The buyer address: pays the fee and the Plutus collateral, receives the refund. */
      refundTo: z.string(),
      validFrom: IsoDateTimeSchema,
      validUntil: IsoDateTimeSchema,
    })
    .optional(),
  estimatedFee: z.object({ amount: BaseUnitAmountSchema, value: FiatValueSchema.nullable() }),
  value: FiatValueSchema.nullable(),
  /** Basis of `value` and `estimatedFee.value`; `mainnet_proxy` = testnet at mainnet price. */
  priceBasis: PriceBasisSchema.nullable().optional(),
  warnings: z.array(
    z.object({
      code: z.enum([
        "TESTNET",
        "FIRST_TIME_RECIPIENT",
        "UNVERIFIED_TOKEN",
        "PRICE_UNAVAILABLE",
        "HIGH_FEE",
        "SIMULATED",
      ]),
      message: z.string(),
    }),
  ),
});
export type SigningReview = z.infer<typeof SigningReviewSchema>;

/** Body for completing a passkey-signed action bound to a payload hash. */
const SignedSubmissionSchema = z.object({
  payloadHash: PayloadHashSchema,
  signRequest: StampedTurnkeyRequestSchema,
});

/**
 * Body for submitting a passkey-signed escrow action: the request's payloadHash plus the
 * body hash of the escrow spend that was reviewed (`review.rawPayload.payload`). A spend
 * rebuilt since the review has another body hash and is refused.
 */
const EscrowSpendSubmissionSchema = SignedSubmissionSchema.extend({
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const EscrowSpendReviewSchema = z.object({ review: SigningReviewSchema, escrow: X402EscrowSchema });

const AgentPolicyUpdateSchema = z.object({
  /** Must equal the current policy.version; mismatch => VERSION_CONFLICT. */
  expectedVersion: z.number().int().min(1),
  policy: AgentPolicySchema.omit({ version: true, revoked: true }),
});

const AgentConnectionSchema = z.object({
  id: z.uuid(),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  clientName: z.string(),
  clientUri: z.url().nullable(),
  redirectUri: z.url(),
  scopes: z.array(z.string()),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  agentId: z.uuid().nullable(),
  expiresAt: IsoDateTimeSchema,
});

const AgentContextSchema = z.object({
  agent: AgentSchema,
  wallets: z.array(WalletSchema),
});

/** Agent-initiated transaction request (MCP -> API). Params mirror the MCP tool inputs. */
export const AgentTransactionRequestBodySchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("send"), input: mcpTools.send.input }),
  z.object({ tool: z.literal("swap"), input: mcpTools.swap.input }),
  z.object({
    tool: z.literal("pay_x402"),
    input: mcpTools.pay_x402.input,
    /** Payment requirements returned by the resource's 402 response, fetched by MCP. */
    paymentRequirements: z.record(z.string(), z.unknown()),
  }),
]);
export type AgentTransactionRequestBody = z.infer<typeof AgentTransactionRequestBodySchema>;

export const OnrampQuoteSchema = z.object({
  quoteId: z.string(),
  provider: z.string(),
  fiat: FiatValueSchema,
  network: NetworkIdSchema,
  assetId: AssetIdSchema,
  cryptoAmount: BaseUnitAmountSchema,
  decimals: DecimalsSchema,
  fees: FiatValueSchema,
  expiresAt: IsoDateTimeSchema,
  simulated: z.boolean(),
});

const OkSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // --- auth / session -------------------------------------------------------
  createSession: endpoint({
    method: "POST",
    path: "/v1/auth/session",
    auth: "none",
    summary:
      "Sign in or sign up. The app stamps a Turnkey `get_whoami` request with the passkey; the API forwards it to Turnkey, learns the sub-organization, and issues a session.",
    body: z.object({
      whoamiRequest: StampedTurnkeyRequestSchema,
      email: z.email().optional(),
      displayName: z.string().max(64).optional(),
    }),
    response: z.object({ user: UserSchema, isNewUser: z.boolean(), session: SessionTokensSchema }),
  }),
  refreshSession: endpoint({
    method: "POST",
    path: "/v1/auth/refresh",
    auth: "none",
    summary: "Rotate the refresh token and issue a new access token.",
    body: z.object({ refreshToken: z.string().min(1) }),
    response: z.object({ session: SessionTokensSchema }),
  }),
  deleteSession: endpoint({
    method: "DELETE",
    path: "/v1/auth/session",
    auth: "user",
    summary: "Log out (revokes the current session).",
    response: OkSchema,
  }),

  // --- me ---------------------------------------------------------------------
  getMe: endpoint({
    method: "GET",
    path: "/v1/me",
    auth: "user",
    summary: "Current user.",
    response: z.object({ user: UserSchema }),
  }),

  // --- wallets / portfolio / transactions ----------------------------------
  listWallets: endpoint({
    method: "GET",
    path: "/v1/wallets",
    auth: "user",
    summary: "Wallets and addresses (mirrored from the user's Turnkey sub-organization).",
    response: z.object({ wallets: z.array(WalletSchema) }),
  }),
  syncWallets: endpoint({
    method: "POST",
    path: "/v1/wallets/sync",
    auth: "user",
    summary: "Re-read wallets/accounts from Turnkey (after creating an account in the app).",
    response: z.object({ wallets: z.array(WalletSchema) }),
  }),
  getWallet: endpoint({
    method: "GET",
    path: "/v1/wallets/:walletId",
    auth: "user",
    summary: "One wallet.",
    params: WalletIdParams,
    response: z.object({ wallet: WalletSchema }),
  }),
  getPortfolio: endpoint({
    method: "GET",
    path: "/v1/portfolio",
    auth: "user",
    summary: "Portfolio snapshot (may be stale; check `stale` and `asOf`).",
    query: PortfolioQuery,
    response: z.object({ portfolio: PortfolioSnapshotSchema }),
  }),
  listTransactions: endpoint({
    method: "GET",
    path: "/v1/transactions",
    auth: "user",
    summary: "Normalized transaction history, newest first.",
    query: TransactionsQuery,
    response: TransactionsPage,
  }),
  getTransaction: endpoint({
    method: "GET",
    path: "/v1/transactions/:transactionId",
    auth: "user",
    summary: "One transaction.",
    params: z.object({ transactionId: z.uuid() }),
    response: z.object({ transaction: TransactionSchema }),
  }),

  // --- send / receive -------------------------------------------------------
  quoteSend: endpoint({
    method: "POST",
    path: "/v1/send/quote",
    auth: "user",
    summary:
      "Validate a send, build the unsigned transaction and canonical payload, create a transaction request (CREATED) and return what the user must review and sign.",
    idempotent: true,
    body: SendDraftSchema.extend({ idempotencyKey: IdempotencyKeySchema }),
    response: z.object({ review: SigningReviewSchema }),
  }),
  submitSend: endpoint({
    method: "POST",
    path: "/v1/send/:requestId/submit",
    auth: "user",
    summary:
      "Submit the passkey-stamped sign request. The API checks payloadHash and that the stamped body signs exactly the unsigned transaction it built, forwards to Turnkey, broadcasts.",
    params: RequestIdParams,
    body: SignedSubmissionSchema,
    response: z.object({ request: TransactionRequestResultSchema }),
  }),
  cancelRequest: endpoint({
    method: "POST",
    path: "/v1/transaction-requests/:requestId/cancel",
    auth: "user",
    summary: "Cancel a request that has not started signing.",
    params: RequestIdParams,
    response: z.object({ request: TransactionRequestResultSchema }),
  }),
  // --- x402 Masumi escrow (buyer actions) -------------------------------------
  getX402Escrow: endpoint({
    method: "GET",
    path: "/v1/transaction-requests/:requestId/escrow",
    auth: "user",
    summary:
      "Escrow state of a pay_x402 request paid into Masumi escrow, read live from the chain (the escrow UTxO's inline datum), with the buyer actions possible right now. 404 when the request has no escrow.",
    params: RequestIdParams,
    response: z.object({ escrow: X402EscrowSchema }),
  }),
  prepareX402RefundRequest: endpoint({
    method: "POST",
    path: "/v1/transaction-requests/:requestId/escrow/refund-request",
    auth: "user",
    summary:
      "Build the Masumi SetRefundRequested spend of the escrow (script evaluated by the chain provider, verified independently) and return it for review. The passkey signs `review.rawPayload.payload` (the spend's body hash) with SIGN_RAW_PAYLOAD_V2, exactly like a Cardano approval. Allowed while the escrow is funds_locked, result_submitted or disputed, before the unlock time and after the buyer cooldown; 409 otherwise. Repeating the call rebuilds the spend.",
    params: RequestIdParams,
    response: EscrowSpendReviewSchema,
  }),
  submitX402RefundRequest: endpoint({
    method: "POST",
    path: "/v1/transaction-requests/:requestId/escrow/refund-request/submit",
    auth: "user",
    summary:
      "Submit the passkey-stamped signature of the reviewed refund request: the API re-verifies the stored spend, checks the stamp (sub-org, key, body hash, freshness), attaches the witness and broadcasts it; the escrow state follows the chain.",
    params: RequestIdParams,
    body: EscrowSpendSubmissionSchema,
    response: z.object({ escrow: X402EscrowSchema }),
  }),
  prepareX402RefundWithdrawal: endpoint({
    method: "POST",
    path: "/v1/transaction-requests/:requestId/escrow/withdraw-refund",
    auth: "user",
    summary:
      "Build the Masumi WithdrawRefund spend that returns the escrowed funds to the wallet, for review (as prepareX402RefundRequest). Allowed once the seller authorized the refund (refund_authorized), or after submitResultTime while no result was submitted (funds_locked, refund_requested); 409 otherwise.",
    params: RequestIdParams,
    response: EscrowSpendReviewSchema,
  }),
  submitX402RefundWithdrawal: endpoint({
    method: "POST",
    path: "/v1/transaction-requests/:requestId/escrow/withdraw-refund/submit",
    auth: "user",
    summary:
      "Submit the passkey-stamped signature of the reviewed refund withdrawal (same checks as submitX402RefundRequest), attach the witness and broadcast.",
    params: RequestIdParams,
    body: EscrowSpendSubmissionSchema,
    response: z.object({ escrow: X402EscrowSchema }),
  }),
  getReceiveInfo: endpoint({
    method: "GET",
    path: "/v1/receive",
    auth: "user",
    summary: "Receive address and QR payload for a wallet on a network.",
    query: z.object({ walletId: z.uuid(), network: NetworkIdSchema }),
    response: z.object({
      network: NetworkIdSchema,
      address: AddressSchema,
      /**
       * e.g. "solana:<address>", "ethereum:<address>@8453" (EIP-681) or
       * "web+cardano:<address>" (CIP-13).
       */
      qrPayload: z.string(),
      isTestnet: z.boolean(),
      warnings: z.array(z.string()),
    }),
  }),

  // --- agents ----------------------------------------------------------------
  listAgents: endpoint({
    method: "GET",
    path: "/v1/agents",
    auth: "user",
    summary: "Connected agents.",
    response: z.object({ agents: z.array(AgentSchema) }),
  }),
  getAgent: endpoint({
    method: "GET",
    path: "/v1/agents/:agentId",
    auth: "user",
    summary: "One agent.",
    params: AgentIdParams,
    response: z.object({ agent: AgentSchema }),
  }),
  updateAgent: endpoint({
    method: "PATCH",
    path: "/v1/agents/:agentId",
    auth: "user",
    summary: "Rename an agent.",
    params: AgentIdParams,
    body: z.object({ name: z.string().min(1).max(64) }),
    response: z.object({ agent: AgentSchema }),
  }),
  revokeAgent: endpoint({
    method: "DELETE",
    path: "/v1/agents/:agentId",
    auth: "user",
    summary:
      "Revoke an agent: policy.revoked=true, OAuth grants/tokens revoked, pending requests cancelled, Turnkey delegated key removed (see ADR-001).",
    params: AgentIdParams,
    response: z.object({ agent: AgentSchema }),
  }),
  getAgentPolicy: endpoint({
    method: "GET",
    path: "/v1/agents/:agentId/policy",
    auth: "user",
    summary: "Agent policy.",
    params: AgentIdParams,
    response: z.object({ policy: AgentPolicySchema }),
  }),
  // --- Auto-pay on Cardano: the agent's on-chain allowance (docs/AUTOPAY.md) ----------
  getAgentAllowance: endpoint({
    method: "GET",
    path: "/v1/agents/:agentId/allowance",
    auth: "user",
    summary:
      "The agent's Cardano auto-pay allowance (null when none), with its on-chain state read live: balance, spent in the current window, what can be paid right now, and the agent's fee float.",
    params: AgentIdParams,
    response: z.object({ allowance: CardanoAllowanceSchema.nullable() }),
  }),
  createAgentAllowance: endpoint({
    method: "POST",
    path: "/v1/agents/:agentId/allowance",
    auth: "user",
    summary:
      "Create the agent's auto-pay allowance: fiat limits are converted to lovelace now, a fresh agent key is generated (encrypted at rest), and the create transaction (allowance output with the exact datum + the agent's fee float) is built for review. The passkey signs `review.rawPayload.payload`; check it on the device with checkCardanoAllowanceCreateTx. 409 when the agent already has a live allowance; repeating while pending rebuilds.",
    params: AgentIdParams,
    body: CreateAllowanceBodySchema,
    response: z.object({ allowance: CardanoAllowanceSchema, review: AllowanceReviewSchema }),
  }),
  topUpAgentAllowance: endpoint({
    method: "POST",
    path: "/v1/agents/:agentId/allowance/top-up",
    auth: "user",
    summary:
      "Build an owner spend that adds `budget` to the active allowance (same limits, same window). Check with checkCardanoAllowanceOwnerSpendTx (action top_up).",
    params: AgentIdParams,
    body: TopUpAllowanceBodySchema,
    response: z.object({ allowance: CardanoAllowanceSchema, review: AllowanceReviewSchema }),
  }),
  revokeAgentAllowance: endpoint({
    method: "POST",
    path: "/v1/agents/:agentId/allowance/revoke",
    auth: "user",
    summary:
      "Build the owner spend that returns everything in the allowance to the wallet. After it is submitted the agent's fee float is returned too and the agent key is destroyed. Check with checkCardanoAllowanceOwnerSpendTx (action revoke).",
    params: AgentIdParams,
    response: z.object({ allowance: CardanoAllowanceSchema, review: AllowanceReviewSchema }),
  }),
  submitAgentAllowance: endpoint({
    method: "POST",
    path: "/v1/agents/:agentId/allowance/submit",
    auth: "user",
    summary:
      "Submit the passkey-stamped signature of the pending allowance transaction (create, top-up or revoke): re-verified, stamp checked like an approval, claimed once, witnessed, submitted and tracked. 409 when `bodyHash` is not the pending build.",
    params: AgentIdParams,
    body: z.object({
      bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
      signRequest: StampedTurnkeyRequestSchema,
    }),
    response: z.object({ allowance: CardanoAllowanceSchema }),
  }),
  listAgentAllowanceSpends: endpoint({
    method: "GET",
    path: "/v1/agents/:agentId/allowance/spends",
    auth: "user",
    summary: "Payments the agent made from its allowance, newest first.",
    params: AgentIdParams,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
    response: z.object({ spends: z.array(AllowanceSpendSchema) }),
  }),
  updateAgentPolicy: endpoint({
    method: "PUT",
    path: "/v1/agents/:agentId/policy",
    auth: "user",
    summary:
      "Replace the policy (optimistic locking via expectedVersion). Switching to autonomous additionally requires the passkey-stamped Turnkey policy update (ADR-001).",
    params: AgentIdParams,
    body: AgentPolicyUpdateSchema.extend({
      turnkeyPolicyRequest: StampedTurnkeyRequestSchema.optional(),
    }),
    response: z.object({ policy: AgentPolicySchema }),
  }),

  // --- agent connection (OAuth consent happens in the app) ------------------
  claimAgentConnection: endpoint({
    method: "POST",
    path: "/v1/agent-connections/claim",
    auth: "user",
    summary: "User entered/scanned the code shown on the MCP authorize page.",
    body: z.object({ userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/) }),
    response: z.object({ connection: AgentConnectionSchema }),
  }),
  approveAgentConnection: endpoint({
    method: "POST",
    path: "/v1/agent-connections/:connectionId/approve",
    auth: "user",
    summary:
      "Create the agent with the default policy (always_ask, spending disabled) narrowed to the chosen wallets/networks.",
    params: z.object({ connectionId: z.uuid() }),
    body: z.object({
      name: z.string().min(1).max(64),
      walletIds: z.array(z.uuid()).min(1),
      networks: z.array(NetworkIdSchema).min(1),
    }),
    response: z.object({ connection: AgentConnectionSchema, agent: AgentSchema }),
  }),
  rejectAgentConnection: endpoint({
    method: "POST",
    path: "/v1/agent-connections/:connectionId/reject",
    auth: "user",
    summary: "Decline the connection.",
    params: z.object({ connectionId: z.uuid() }),
    response: z.object({ connection: AgentConnectionSchema }),
  }),

  // --- approvals -------------------------------------------------------------
  listApprovals: endpoint({
    method: "GET",
    path: "/v1/approvals",
    auth: "user",
    summary: "Approval requests, newest first.",
    query: z.object({
      status: ApprovalStatusSchema.optional(),
      limit: PageLimitSchema,
      cursor: CursorSchema.optional(),
    }),
    response: z.object({
      approvals: z.array(ApprovalRequestSchema),
      nextCursor: CursorSchema.nullable(),
    }),
  }),
  getApproval: endpoint({
    method: "GET",
    path: "/v1/approvals/:approvalId",
    auth: "user",
    summary:
      "Everything needed to review: request, canonical payload, unsigned tx, policy reasons, agent. The unsigned tx is rebuilt on fetch when the stored one is near expiry (Solana blockhashes live ~60-90 s); payloadHash never changes, and approve must sign the latest built tx.",
    params: ApprovalIdParams,
    response: z.object({
      approval: ApprovalRequestSchema,
      review: SigningReviewSchema,
      agent: AgentSchema.nullable(),
      /** pay_x402 only: delivery to the seller and its verified receipt. */
      x402: X402DeliverySchema.optional(),
    }),
  }),
  approveApproval: endpoint({
    method: "POST",
    path: "/v1/approvals/:approvalId/approve",
    auth: "user",
    summary:
      "Approve = sign. The passkey-stamped sign request must sign exactly the reviewed unsigned transaction and quote the same payloadHash.",
    params: ApprovalIdParams,
    body: SignedSubmissionSchema,
    response: z.object({
      approval: ApprovalRequestSchema,
      request: TransactionRequestResultSchema,
    }),
  }),
  rejectApproval: endpoint({
    method: "POST",
    path: "/v1/approvals/:approvalId/reject",
    auth: "user",
    summary: "Reject the request.",
    params: ApprovalIdParams,
    body: z.object({ reason: z.string().max(280).optional() }),
    response: z.object({
      approval: ApprovalRequestSchema,
      request: TransactionRequestResultSchema,
    }),
  }),

  // --- Masumi agent registry (Cardano; read-only, public chain data) ----------
  listMasumiAgents: endpoint({
    method: "GET",
    path: "/v1/masumi/agents",
    auth: "user",
    summary:
      "Discover live agents registered in the Masumi registry (V2 policy) of this deployment's Cardano network, newest first. Metadata strings are third-party content. UPSTREAM_UNAVAILABLE (502) when the registry cannot be read or is not configured.",
    query: MasumiAgentSearchQuerySchema,
    response: MasumiAgentSearchResultSchema,
  }),
  getMasumiAgent: endpoint({
    method: "GET",
    path: "/v1/masumi/agents/:agentIdentifier",
    auth: "user",
    summary: "One registry entry by agentIdentifier (policy id + asset name).",
    params: z.object({ agentIdentifier: MasumiAgentIdentifierSchema }),
    response: MasumiAgentResolutionSchema,
  }),

  // --- plugins ----------------------------------------------------------------
  listPlugins: endpoint({
    method: "GET",
    path: "/v1/plugins",
    auth: "user",
    summary: "Registry with the user's enablement state.",
    response: z.object({
      plugins: z.array(
        z.object({
          manifest: PluginManifestSchema,
          enabled: z.boolean(),
          /** False when the deployment lacks the plugin's required config. */
          configured: z.boolean(),
        }),
      ),
    }),
  }),
  setPluginEnabled: endpoint({
    method: "PUT",
    path: "/v1/plugins/:pluginId",
    auth: "user",
    summary: "Enable/disable a plugin for this user.",
    params: z.object({ pluginId: PluginIdSchema }),
    body: z.object({ enabled: z.boolean() }),
    response: z.object({ pluginId: PluginIdSchema, enabled: z.boolean() }),
  }),

  // --- on-ramp ---------------------------------------------------------------
  quoteOnramp: endpoint({
    method: "POST",
    path: "/v1/onramp/quote",
    auth: "user",
    summary: "Fiat -> crypto quote (Transak sandbox in development).",
    body: z.object({
      fiat: FiatValueSchema,
      network: NetworkIdSchema,
      assetId: AssetIdSchema,
      walletId: z.uuid(),
    }),
    response: z.object({ quote: OnrampQuoteSchema }),
  }),
  createOnrampSession: endpoint({
    method: "POST",
    path: "/v1/onramp/session",
    auth: "user",
    summary: "Create a hosted on-ramp session; the app opens `url` in a browser.",
    body: z.object({ quoteId: z.string(), walletId: z.uuid() }),
    response: z.object({
      sessionId: z.string(),
      url: z.url({ protocol: /^https$/ }),
      expiresAt: IsoDateTimeSchema,
      simulated: z.boolean(),
    }),
  }),
  onrampWebhook: endpoint({
    method: "POST",
    path: "/v1/webhooks/onramp/:provider",
    auth: "webhook",
    summary:
      "Provider callbacks. Signature verified on the raw body; deduplicated by (provider, event_id).",
    params: z.object({ provider: z.enum(["transak"]) }),
    body: z.unknown(),
    response: OkSchema,
  }),

  // --- notifications --------------------------------------------------------
  registerDevice: endpoint({
    method: "POST",
    path: "/v1/notifications/devices",
    auth: "user",
    summary: "Register an Expo push token (idempotent per token).",
    body: z.object({
      expoPushToken: z.string().regex(/^(Exponent|Expo)PushToken\[.+\]$/),
      platform: z.enum(["ios", "android"]),
      deviceName: z.string().max(64).optional(),
    }),
    response: z.object({ deviceId: z.uuid() }),
  }),
  unregisterDevice: endpoint({
    method: "DELETE",
    path: "/v1/notifications/devices/:deviceId",
    auth: "user",
    summary: "Stop push to a device.",
    params: z.object({ deviceId: z.uuid() }),
    response: OkSchema,
  }),

  // --- internal: MCP server -> API ------------------------------------------
  internalCreateAgentConnection: endpoint({
    method: "POST",
    path: "/internal/v1/agent-connections",
    auth: "internal",
    summary:
      "Called from the MCP OAuth authorize page: create a pending connection with a user code the user confirms in the app.",
    body: z.object({
      oauthClientId: z.string().min(1),
      clientName: z.string().min(1).max(128),
      clientUri: z.url().nullable(),
      redirectUri: z.url(),
      scopes: z.array(z.string()),
    }),
    response: z.object({ connection: AgentConnectionSchema }),
  }),
  internalGetAgentConnection: endpoint({
    method: "GET",
    path: "/internal/v1/agent-connections/:connectionId",
    auth: "internal",
    summary:
      "Poll a connection; once approved, MCP completes the OAuth grant with {userId, agentId}.",
    params: z.object({ connectionId: z.uuid() }),
    response: z.object({ connection: AgentConnectionSchema, userId: z.uuid().nullable() }),
  }),
  internalGetAgentContext: endpoint({
    method: "GET",
    path: "/internal/v1/agents/:agentId/context",
    auth: "internal",
    summary: "Agent, policy and the wallets it may see. Fails with FORBIDDEN if revoked/expired.",
    params: AgentIdParams,
    response: AgentContextSchema,
  }),
  internalGetAgentPortfolio: endpoint({
    method: "GET",
    path: "/internal/v1/agents/:agentId/portfolio",
    auth: "internal",
    summary: "get_balance on behalf of an agent (policy-filtered).",
    params: AgentIdParams,
    query: PortfolioQuery,
    response: mcpTools.get_balance.output,
  }),
  internalListAgentTransactions: endpoint({
    method: "GET",
    path: "/internal/v1/agents/:agentId/transactions",
    auth: "internal",
    summary: "get_transactions on behalf of an agent (policy-filtered).",
    params: AgentIdParams,
    query: TransactionsQuery,
    response: mcpTools.get_transactions.output,
  }),
  internalCreateTransactionRequest: endpoint({
    method: "POST",
    path: "/internal/v1/agents/:agentId/transaction-requests",
    auth: "internal",
    summary:
      "send / swap / pay_x402 on behalf of an agent: validate, value, evaluate policy, reserve spend, and either execute (autonomous) or create an approval and push-notify the user.",
    idempotent: true,
    params: AgentIdParams,
    body: AgentTransactionRequestBodySchema,
    response: z.object({ request: TransactionRequestResultSchema }),
  }),
  internalGetTransactionRequest: endpoint({
    method: "GET",
    path: "/internal/v1/agents/:agentId/transaction-requests/:requestId",
    auth: "internal",
    summary: "get_approval_status. Only requests created by this agent are visible.",
    params: z.object({ agentId: z.uuid(), requestId: z.uuid() }),
    response: z.object({ request: TransactionRequestResultSchema }),
  }),
  internalFindMasumiAgents: endpoint({
    method: "GET",
    path: "/internal/v1/agents/:agentId/masumi/agents",
    auth: "internal",
    summary:
      "find_agents on behalf of an agent: Masumi registry discovery (same query and result as listMasumiAgents).",
    params: AgentIdParams,
    query: MasumiAgentSearchQuerySchema,
    response: MasumiAgentSearchResultSchema,
  }),
  internalVerifyMasumiAgent: endpoint({
    method: "POST",
    path: "/internal/v1/agents/:agentId/masumi/verify",
    auth: "internal",
    summary:
      "verify_agent on behalf of an agent: check a registry identity (live NFT held by a key, canonical escrow source, public https endpoint covering resourceUrl, and the NFT holder = sellerAddress when given). Fail closed. pay_x402 repeats the check against the key that signs the seller's terms.",
    params: AgentIdParams,
    body: MasumiAgentVerifyBodySchema,
    response: MasumiAgentVerificationSchema,
  }),
  internalGetX402Payment: endpoint({
    method: "POST",
    path: "/internal/v1/agents/:agentId/transaction-requests/:requestId/x402-payment",
    auth: "internal",
    summary:
      "The signed payment of a pay_x402 request, as the header the MCP worker sends when it retries the resource. Only for the agent's own request once it is signed (409 before). Cardano: the request moves to BROADCAST under the transaction id derived from the signed bytes, and the API follows it on chain; repeating the call returns the same header (the same transaction cannot be spent twice).",
    params: z.object({ agentId: z.uuid(), requestId: z.uuid() }),
    response: z.object({
      payment: z.object({
        resourceUrl: z.url(),
        method: z.enum(["GET", "POST"]),
        header: z.object({
          name: z.enum(["PAYMENT-SIGNATURE", "X-PAYMENT"]),
          value: z.string().min(1).max(65_536),
        }),
        /** Transaction id the payment will have on chain, when known before settlement. */
        txHash: z.string().nullable(),
      }),
    }),
  }),
  internalReportX402Delivery: endpoint({
    method: "POST",
    path: "/internal/v1/agents/:agentId/transaction-requests/:requestId/x402-delivery",
    auth: "internal",
    summary:
      "Outcome of the paid retry, reported by the MCP worker. Recorded for display and audit only: settlement is decided by the chain (a transaction id that differs from the signed one is flagged, never adopted).",
    params: z.object({ agentId: z.uuid(), requestId: z.uuid() }),
    body: z.strictObject({
      httpStatus: z.number().int().min(100).max(599),
      /** `success` of the PAYMENT-RESPONSE header, null when the header was absent. */
      settled: z.boolean().nullable(),
      /** `transaction` of the PAYMENT-RESPONSE header. */
      transaction: z.string().max(128).nullable(),
      errorReason: z.string().max(200).nullable(),
      /**
       * The seller's X-Delivery-Receipt header (verbatim, capped) and the SHA-256 the MCP
       * worker computed itself over the exact body bytes it received (null when it could
       * not read the whole body). The API verifies the receipt; the seller's own hash is
       * never trusted alone.
       */
      receipt: z
        .strictObject({
          header: z.string().min(1).max(X402_RECEIPT_MAX_HEADER_BYTES).nullable(),
          contentSha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        })
        .optional(),
    }),
    response: z.object({ request: TransactionRequestResultSchema }),
  }),
} as const;

export type Api = typeof api;
export type EndpointName = keyof Api;
type Field<E, K extends string> =
  E extends Record<K, infer S extends z.ZodType> ? z.infer<S> : never;
type InputField<E, K extends string> =
  E extends Record<K, infer S extends z.ZodType> ? z.input<S> : never;
export type EndpointBody<N extends EndpointName> = InputField<Api[N], "body">;
export type EndpointQuery<N extends EndpointName> = InputField<Api[N], "query">;
export type EndpointParams<N extends EndpointName> = Field<Api[N], "params">;
export type EndpointResponse<N extends EndpointName> = Field<Api[N], "response">;

/** Substitute `:param` segments. Throws when a parameter is missing. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}
