import {
  CARDANO_TURNKEY_ACCOUNT,
  cardanoEnterpriseAddress,
  cardanoUnsignedBodyHash,
  createCanonicalPayload,
  defaultAgentPolicy,
  explorerTxUrl,
  getNetwork,
  MASUMI_ESCROW_ADDRESSES,
  minorUnitsToDecimal,
  nativeAsset,
  payloadHash,
  networksForMode,
  sha256Hex,
  PLUGIN_REGISTRY,
  toChecksumAddress,
  tokenAssetId,
  valueInUsdMinor,
  type Agent,
  type ApprovalRequest,
  type Asset,
  type Balance,
  type CanonicalTransactionPayload,
  type ChainFamily,
  type FiatValue,
  type NetworkId,
  type SigningReview,
  type Transaction,
  type TransactionRequest,
  type User,
  type Wallet,
  type WatchWallet,
} from "@zyropay/shared";

/*
 * DEV-ONLY SIMULATED FIXTURES. Every provider-shaped object carries
 * `simulated: true`, every value is contract-valid (the client re-validates it),
 * and only testnets appear. None of this is real money.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58-encode 32 deterministic bytes into a valid Solana address. */
export function fakeSolanaAddress(seed: number): string {
  const bytes = Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 17 + 7) % 256);
  if (bytes[0] === 0) bytes[0] = 1;
  let value = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = "";
  while (value > 0n) {
    out = (B58[Number(value % 58n)] ?? "1") + out;
    value /= 58n;
  }
  return out;
}

function fakeEvmAddress(seed: number): string {
  const hex = Array.from({ length: 40 }, (_, i) => ((seed * 7 + i * 13) % 16).toString(16)).join(
    "",
  );
  return toChecksumAddress(`0x${hex}`);
}

/** Deterministic UUIDv7-shaped ids (version 7, RFC 4122 variant). */
export function fakeId(kind: number, n: number): string {
  const k = kind.toString(16).padStart(4, "0");
  const tail = n.toString(16).padStart(12, "0");
  return `0192f3a1-${k}-7000-8000-${tail}`;
}

export function fakeHex(seed: number, bytes: number): string {
  return Array.from({ length: bytes * 2 }, (_, i) => ((seed * 11 + i * 5) % 16).toString(16)).join(
    "",
  );
}

const now = () => Date.now();
export const iso = (offsetMs: number) => new Date(now() + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const USER_ID = fakeId(1, 1);
const SUB_ORG = "simulated-suborg-0000";

const PRICES: Readonly<Record<string, string>> = {
  SOL: "142.18",
  ETH: "2611.40",
  USDC: "1.00",
  ADA: "0.52",
};

/** Simulated Ed25519 public key of the main wallet's Cardano account (never a real key). */
export const ADA_PUBLIC_KEY_MAIN = fakeHex(1, 32);

export const ADDR = {
  solMain: fakeSolanaAddress(1),
  evmMain: fakeEvmAddress(1),
  adaMain: cardanoEnterpriseAddress(ADA_PUBLIC_KEY_MAIN, "cardano-preprod"),
  solSavings: fakeSolanaAddress(2),
  evmSavings: fakeEvmAddress(2),
  friendSol: fakeSolanaAddress(9),
  friendEvm: fakeEvmAddress(9),
  friendAda: cardanoEnterpriseAddress(fakeHex(9, 32), "cardano-preprod"),
  merchantEvm: fakeEvmAddress(5),
  /** Simulated x402 seller on Cardano preprod (the "address intelligence" demo resource). */
  sellerAda: cardanoEnterpriseAddress(fakeHex(6, 32), "cardano-preprod"),
} as const;

/**
 * x402 terms as the API stores them in pluginData (@zyropay/integrations X402Terms), for a
 * simulated seller on a reserved `.example` host. v2: the description is in `resource`.
 */
export function x402Terms(opts: {
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  resourceUrl: string;
  description: string;
  extra: Record<string, string>;
}): NonNullable<CanonicalTransactionPayload["pluginData"]> {
  const accepted = {
    scheme: "exact",
    network: opts.network,
    amount: opts.amount,
    asset: opts.asset,
    payTo: opts.payTo,
    maxTimeoutSeconds: 300,
    extra: opts.extra,
  };
  return {
    x402Version: 2,
    scheme: "exact",
    network: opts.network,
    asset: opts.asset,
    payTo: opts.payTo,
    amount: opts.amount,
    maxTimeoutSeconds: 300,
    resourceUrl: opts.resourceUrl,
    method: "GET",
    accepted,
    resource: {
      url: opts.resourceUrl,
      description: opts.description,
      mimeType: "application/json",
    },
    riskCategory: "medium",
  };
}

/** Simulated Masumi escrow: the collateral (min-UTxO deposit) locked with the price. */
const ESCROW_COLLATERAL_LOVELACE = "1500000";
export const MASUMI_ESCROW_PREPROD = MASUMI_ESCROW_ADDRESSES["cardano-preprod"] ?? "";

/**
 * x402 terms of a payment into Masumi escrow (`assetTransferMethod: "masumi"`): pays the
 * canonical script, and pluginData.escrow binds the seller-signed terms (deadlines in POSIX
 * ms), as @zyropay/integrations masumiEscrowTermsOf reads them. Deadlines are relative to
 * when the fixtures were made (`offsets` in ms from now).
 */
function escrowX402Terms(opts: {
  price: string;
  resourceUrl: string;
  description: string;
  offsets: { payBy: number; submitResult: number; unlock: number; externalDisputeUnlock: number };
  seed: number;
}): NonNullable<CanonicalTransactionPayload["pluginData"]> {
  const at = (ms: number) => String(now() + ms);
  const base = x402Terms({
    network: "cardano:preprod",
    asset: "lovelace",
    payTo: MASUMI_ESCROW_PREPROD,
    amount: opts.price,
    resourceUrl: opts.resourceUrl,
    description: opts.description,
    extra: { assetTransferMethod: "masumi" },
  });
  return {
    ...base,
    escrow: {
      method: "masumi",
      escrowAddress: MASUMI_ESCROW_PREPROD,
      termsDigest: fakeHex(opts.seed + 700, 32),
      sellerAddress: ADDR.sellerAda,
      datumCbor: "d8799fff",
      lockedLovelace: (BigInt(opts.price) + BigInt(ESCROW_COLLATERAL_LOVELACE)).toString(),
      collateralLovelace: ESCROW_COLLATERAL_LOVELACE,
      coinsPerUtxoByte: "4310",
      inputHash: fakeHex(opts.seed + 800, 32),
      payByTime: at(opts.offsets.payBy),
      submitResultTime: at(opts.offsets.submitResult),
      unlockTime: at(opts.offsets.unlock),
      externalDisputeUnlockTime: at(opts.offsets.externalDisputeUnlock),
      cooldownPeriodMs: "60000",
    },
  };
}

const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_BASE_SEPOLIA = toChecksumAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
const DUST_MINT = fakeSolanaAddress(42);

export const ASSETS = {
  sol: nativeAsset("solana-devnet"),
  ethSepolia: nativeAsset("ethereum-sepolia"),
  ethBase: nativeAsset("base-sepolia"),
  ada: nativeAsset("cardano-preprod"),
  usdcSol: {
    id: tokenAssetId("solana-devnet", USDC_DEVNET_MINT),
    network: "solana-devnet",
    kind: "spl",
    address: USDC_DEVNET_MINT,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoUrl: null,
    verified: true,
  },
  usdcBase: {
    id: tokenAssetId("base-sepolia", USDC_BASE_SEPOLIA),
    network: "base-sepolia",
    kind: "erc20",
    address: USDC_BASE_SEPOLIA,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoUrl: null,
    verified: true,
  },
  dust: {
    id: tokenAssetId("solana-devnet", DUST_MINT),
    network: "solana-devnet",
    kind: "spl",
    address: DUST_MINT,
    symbol: "DUST",
    name: "Unknown airdrop",
    decimals: 9,
    logoUrl: null,
    verified: false,
  },
} as const satisfies Record<string, Asset>;

export function priceOf(asset: Asset): string | null {
  return asset.verified ? (PRICES[asset.symbol] ?? null) : null;
}

/** Exact bigint valuation (rounded up to the cent, as the API does). */
export function fiatValueOf(asset: Asset, amount: string): FiatValue | null {
  const price = priceOf(asset);
  if (price === null) return null;
  const cents = valueInUsdMinor({ amount, decimals: asset.decimals }, price);
  return { value: minorUnitsToDecimal(cents), currency: "USD" };
}

export function makeUser(): User {
  return {
    id: USER_ID,
    email: "demo@zyropay.dev",
    displayName: "Simulated user",
    turnkeySubOrganizationId: SUB_ORG,
    createdAt: iso(-40 * DAY),
  };
}

export const WALLET_MAIN = fakeId(2, 1);
const WALLET_SAVINGS = fakeId(2, 2);

export function makeWallets(): Wallet[] {
  const mk = (
    id: string,
    name: string,
    n: number,
    sol: string,
    evm: string,
    ada?: string,
  ): Wallet => ({
    id,
    userId: USER_ID,
    name,
    turnkeySubOrganizationId: SUB_ORG,
    turnkeyWalletId: `simulated-wallet-${n}`,
    createdAt: iso(-40 * DAY + n * HOUR),
    addresses: [
      {
        id: fakeId(3, n * 10 + 1),
        walletId: id,
        family: "solana",
        address: sol,
        derivationPath: "m/44'/501'/0'/0'",
        createdAt: iso(-40 * DAY),
      },
      {
        id: fakeId(3, n * 10 + 2),
        walletId: id,
        family: "evm",
        address: evm,
        derivationPath: "m/44'/60'/0'/0/0",
        createdAt: iso(-40 * DAY),
      },
      ...(ada === undefined
        ? []
        : [
            {
              id: fakeId(3, n * 10 + 3),
              walletId: id,
              family: "cardano" as const,
              address: ada,
              derivationPath: CARDANO_TURNKEY_ACCOUNT.path,
              createdAt: iso(-40 * DAY),
            },
          ]),
    ],
  });
  return [
    // The main wallet has a Cardano account; "Savings" predates Cardano support (no key).
    mk(WALLET_MAIN, "Main wallet", 1, ADDR.solMain, ADDR.evmMain, ADDR.adaMain),
    mk(WALLET_SAVINGS, "Savings", 2, ADDR.solSavings, ADDR.evmSavings),
  ];
}

function balance(walletId: string, address: string, asset: Asset, amount: string): Balance {
  const price = priceOf(asset);
  return {
    walletId,
    address,
    network: asset.network,
    asset,
    amount,
    price: price === null ? null : { value: price, currency: "USD" },
    value: fiatValueOf(asset, amount),
  };
}

export const balanceFor = balance;

/** One read-only (watch) address so the Wallets tab shows the watch-only treatment. */
const WATCH_TREASURY = fakeId(14, 1);
export const WATCH_ADDRESS = fakeEvmAddress(3); // distinct from every own and counterparty address

export function makeWatchWallets(): WatchWallet[] {
  return [
    {
      id: WATCH_TREASURY,
      userId: USER_ID,
      name: "Team treasury",
      family: "evm",
      network: "base-sepolia",
      address: WATCH_ADDRESS,
      watchOnly: true,
      createdAt: iso(-3 * DAY),
    },
  ];
}

export function makeWatchBalances(): Balance[] {
  return [
    balance(WATCH_TREASURY, WATCH_ADDRESS, ASSETS.ethBase, "420000000000000000"),
    balance(WATCH_TREASURY, WATCH_ADDRESS, ASSETS.usdcBase, "3150000000"),
  ];
}

export function makeBalances(): Balance[] {
  return [
    balance(WALLET_MAIN, ADDR.solMain, ASSETS.sol, "12500000000"),
    balance(WALLET_MAIN, ADDR.solMain, ASSETS.usdcSol, "250000000"),
    balance(WALLET_MAIN, ADDR.evmMain, ASSETS.ethSepolia, "800000000000000000"),
    balance(WALLET_MAIN, ADDR.evmMain, ASSETS.ethBase, "150000000000000000"),
    balance(WALLET_MAIN, ADDR.evmMain, ASSETS.usdcBase, "1200000000"),
    balance(WALLET_MAIN, ADDR.solMain, ASSETS.dust, "4200000000000"),
    balance(WALLET_MAIN, ADDR.adaMain, ASSETS.ada, "245500000"),
    balance(WALLET_SAVINGS, ADDR.solSavings, ASSETS.usdcSol, "5000000000"),
    balance(WALLET_SAVINGS, ADDR.evmSavings, ASSETS.ethSepolia, "2000000000000000000"),
    // The providers always report each network's native coin, funded or not.
    balance(WALLET_SAVINGS, ADDR.solSavings, ASSETS.sol, "0"),
    balance(WALLET_SAVINGS, ADDR.evmSavings, ASSETS.ethBase, "0"),
  ];
}

export function makeTransactions(): Transaction[] {
  const tx = (
    n: number,
    walletId: string,
    asset: Asset,
    direction: Transaction["direction"],
    from: string,
    to: string,
    amount: string,
    ago: number,
    status: Transaction["status"] = "confirmed",
  ): Transaction => {
    const network: NetworkId = asset.network;
    const family = getNetwork(network).family;
    const hash =
      family === "evm"
        ? `0x${fakeHex(n, 32)}`
        : family === "cardano"
          ? fakeHex(n, 32)
          : fakeSolanaAddress(100 + n) + fakeSolanaAddress(200 + n).slice(0, 44);
    return {
      id: fakeId(4, n),
      walletId,
      network,
      txHash: hash,
      direction,
      status,
      from,
      to,
      asset,
      amount,
      fee: direction === "in" ? null : FEES[family],
      valueAtTime: fiatValueOf(asset, amount),
      timestamp: iso(-ago),
      blockNumber: status === "pending" ? null : String(1_000_000 + n),
      transactionRequestId: null,
      explorerUrl: explorerTxUrl(network, hash),
      simulated: true,
    };
  };
  return [
    tx(
      1,
      WALLET_MAIN,
      ASSETS.usdcSol,
      "out",
      ADDR.solMain,
      ADDR.friendSol,
      "18500000",
      25 * MIN,
      "pending",
    ),
    tx(2, WALLET_MAIN, ASSETS.sol, "in", ADDR.friendSol, ADDR.solMain, "2000000000", 3 * HOUR),
    tx(3, WALLET_MAIN, ASSETS.usdcBase, "out", ADDR.evmMain, ADDR.merchantEvm, "100000", 9 * HOUR),
    tx(
      4,
      WALLET_MAIN,
      ASSETS.ethSepolia,
      "in",
      ADDR.friendEvm,
      ADDR.evmMain,
      "500000000000000000",
      2 * DAY,
    ),
    tx(
      5,
      WALLET_MAIN,
      ASSETS.ethBase,
      "out",
      ADDR.evmMain,
      ADDR.friendEvm,
      "20000000000000000",
      3 * DAY,
      "failed",
    ),
    tx(
      6,
      WALLET_SAVINGS,
      ASSETS.usdcSol,
      "in",
      ADDR.solMain,
      ADDR.solSavings,
      "5000000000",
      6 * DAY,
    ),
    tx(7, WALLET_MAIN, ASSETS.usdcSol, "in", ADDR.friendSol, ADDR.solMain, "268500000", 9 * DAY),
    tx(8, WALLET_MAIN, ASSETS.sol, "out", ADDR.solMain, ADDR.friendSol, "500000000", 14 * DAY),
    tx(9, WALLET_MAIN, ASSETS.ada, "in", ADDR.friendAda, ADDR.adaMain, "250000000", 4 * DAY),
    // x402 into Masumi escrow: a lock (price + deposit), and a refund back from the escrow.
    tx(
      10,
      WALLET_MAIN,
      ASSETS.ada,
      "out",
      ADDR.adaMain,
      MASUMI_ESCROW_PREPROD,
      "6500000",
      50 * MIN,
    ),
    tx(11, WALLET_MAIN, ASSETS.ada, "in", MASUMI_ESCROW_PREPROD, ADDR.adaMain, "3500000", 5 * DAY),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first, like the API
}

/** Typical network fee per family (simulated). */
const FEES: Readonly<Record<ChainFamily, string>> = {
  solana: "5000",
  evm: "21000000000000",
  cardano: "170000",
};

export const AGENT_CLAUDE = fakeId(5, 1);
export const AGENT_CHATGPT = fakeId(5, 2);
const AGENT_GROK = fakeId(5, 3);

export function makeAgents(): Agent[] {
  const base = defaultAgentPolicy();
  return [
    {
      id: AGENT_CLAUDE,
      userId: USER_ID,
      name: "Claude",
      oauthClientId: "simulated-claude",
      createdAt: iso(-12 * DAY),
      lastUsedAt: iso(-20 * MIN),
      revokedAt: null,
      policy: {
        ...base,
        spendingEnabled: true,
        allowedWalletIds: [WALLET_MAIN],
        allowedNetworks: ["solana-devnet", "base-sepolia"],
        allowedProtocols: ["x402"],
        recipientAllowlist: [{ family: "solana", address: ADDR.friendSol, label: "Alex" }],
        version: 3,
      },
    },
    {
      id: AGENT_CHATGPT,
      userId: USER_ID,
      name: "ChatGPT",
      oauthClientId: "simulated-chatgpt",
      createdAt: iso(-5 * DAY),
      lastUsedAt: iso(-2 * DAY),
      revokedAt: null,
      policy: {
        ...base,
        mode: "autonomous",
        spendingEnabled: true,
        allowedWalletIds: [WALLET_MAIN],
        // Cardano Preprod too: the auto-pay demo agent (an on-chain allowance pays the seller).
        allowedNetworks: ["base-sepolia", "cardano-preprod"],
        allowedTools: [
          "get_balance",
          "get_wallets",
          "get_transactions",
          "pay_x402",
          "get_approval_status",
          "get_agent_policy",
        ],
        allowedProtocols: ["x402"],
        restrictRecipients: false,
        recipientAllowlist: [
          { family: "cardano", address: ADDR.sellerAda, label: "Address Intelligence (x402)" },
        ],
        limits: { perTransactionUsdMinor: "500", dailyUsdMinor: "2000", monthlyUsdMinor: "20000" },
        version: 5,
      },
    },
    {
      id: AGENT_GROK,
      userId: USER_ID,
      name: "Grok",
      oauthClientId: "simulated-grok",
      createdAt: iso(-30 * DAY),
      lastUsedAt: iso(-21 * DAY),
      revokedAt: iso(-20 * DAY),
      policy: { ...base, revoked: true, version: 2 },
    },
  ];
}

export interface MockApproval {
  approval: ApprovalRequest;
  review: SigningReview;
  /**
   * Escrow payments only: how the simulated seller behaves (mock/escrow.ts). It records the
   * result `deliverAfterMs` after the lock confirmed, either the body it delivered ("match":
   * proof verified) or something else ("mismatch").
   */
  escrowSeller?: { deliverAfterMs: number | null; result: "match" | "mismatch" };
}

export function makeReview(
  n: number,
  opts: {
    agentId: string | null;
    tool: CanonicalTransactionPayload["tool"];
    asset: Asset;
    from: string;
    to: string;
    amount: string;
    plugin: string | null;
    expiresInMs: number;
    walletId: string;
    state: TransactionRequest["state"];
    pluginData?: CanonicalTransactionPayload["pluginData"];
  },
): SigningReview {
  const payload = createCanonicalPayload({
    version: 1,
    network: opts.asset.network,
    from: opts.from,
    to: opts.to,
    asset: { id: opts.asset.id, kind: opts.asset.kind, decimals: opts.asset.decimals },
    amount: opts.amount,
    feeCap: { evm: "60000000000000", solana: "10000", cardano: "1000000" }[
      getNetwork(opts.asset.network).family
    ],
    plugin: opts.plugin,
    tool: opts.tool,
    pluginData: opts.pluginData ?? null,
    nonce: fakeHex(n, 16),
    expiresAt: iso(opts.expiresInMs),
    idempotencyKey: `simulated-${n}-${Math.floor(now() / 1000)}`,
  });
  const hash = payloadHash(payload);
  const value = fiatValueOf(opts.asset, opts.amount);
  const request: TransactionRequest = {
    id: fakeId(6, n),
    walletId: opts.walletId,
    requester:
      opts.agentId === null
        ? { type: "user", userId: USER_ID }
        : { type: "agent", agentId: opts.agentId, userId: USER_ID },
    source: opts.tool,
    state: opts.state,
    payload,
    payloadHash: hash,
    valuationUsdMinor:
      value === null ? null : value.value.replace(".", "").replace(/^0+(?=\d)/, ""),
    value,
    policyDecision: opts.agentId === null ? null : "require_approval",
    policyReasons:
      opts.agentId === null
        ? []
        : [{ code: "ALWAYS_ASK", message: "This agent is set to Always Ask." }],
    txHash: null,
    failureReason: null,
    expiresAt: payload.expiresAt,
    createdAt: iso(-2 * MIN),
    updatedAt: iso(-2 * MIN),
    simulated: true,
  };
  const family = getNetwork(opts.asset.network).family;
  const feeAmount =
    family === "cardano" ? FEES.cardano : family === "evm" ? "42000000000000" : "5000";
  const native = nativeAsset(opts.asset.network);
  // Cardano (ADR-002): the passkey signs the body hash. The simulated "transaction" is the
  // smallest well-shaped unsigned tx (empty body), so its body hash is real.
  const cardanoUnsigned = "84a0a0f5f6";
  // x402 on EVM: the passkey signs an EIP-3009 authorization's EIP-712 digest. Shaped like
  // the API's; the digest is a simulated stand-in, not real EIP-712 (like the API's mock).
  const typedData =
    opts.plugin === "x402" && family === "evm"
      ? {
          kind: "eip712" as const,
          digest: `0x${sha256Hex(`simulated-eip712:${hash}`)}`,
          typedData: {
            domain: {
              name: "USD Coin",
              version: "2",
              chainId: getNetwork(opts.asset.network).evmChainId ?? 0,
              verifyingContract: opts.asset.address ?? "",
            },
            primaryType: "TransferWithAuthorization",
            message: {
              from: opts.from,
              to: opts.to,
              value: opts.amount,
              validAfter: "0",
              validBefore: String(Math.floor(Date.parse(payload.expiresAt) / 1000)),
              nonce: `0x${sha256Hex(`simulated-nonce:${hash}`)}`,
            },
          },
        }
      : undefined;
  return {
    request,
    payload,
    payloadHash: hash,
    unsignedTransaction:
      family === "cardano"
        ? { encoding: "hex", serialized: cardanoUnsigned }
        : typedData !== undefined
          ? { encoding: "hex", serialized: typedData.digest }
          : { encoding: "base64", serialized: "U0lNVUxBVEVELVVOU0lHTkVELVRYCg==" },
    ...(typedData !== undefined ? { typedData } : {}),
    ...(family === "cardano"
      ? {
          rawPayload: {
            kind: "cardano_tx_body_hash" as const,
            payload: cardanoUnsignedBodyHash(cardanoUnsigned) ?? "",
            signWith: ADA_PUBLIC_KEY_MAIN,
          },
        }
      : {}),
    estimatedFee: { amount: feeAmount, value: fiatValueOf(native, feeAmount) },
    value,
    warnings: [
      {
        code: "SIMULATED",
        message: "Simulated request from the development mock. Nothing will be signed or sent.",
      },
      {
        code: "TESTNET",
        message: `${getNetwork(opts.asset.network).displayName} is a test network.`,
      },
      ...(opts.to === ADDR.merchantEvm ||
      opts.to === ADDR.sellerAda ||
      (opts.to === MASUMI_ESCROW_PREPROD && opts.state === "PENDING_APPROVAL")
        ? [
            {
              code: "FIRST_TIME_RECIPIENT" as const,
              message: "You have never paid this address before.",
            },
          ]
        : []),
    ],
  };
}

export function makeApprovals(): MockApproval[] {
  const mk = (
    n: number,
    agentId: string,
    status: ApprovalRequest["status"],
    review: SigningReview,
    decidedAgo: number | null,
  ): MockApproval => ({
    review,
    approval: {
      id: fakeId(7, n),
      transactionRequestId: review.request.id,
      userId: USER_ID,
      agentId,
      status,
      payloadHash: review.payloadHash,
      expiresAt: review.request.expiresAt,
      decidedAt: decidedAgo === null ? null : iso(-decidedAgo),
      createdAt: iso(-(decidedAgo ?? 2 * MIN) - MIN),
    },
  });
  return [
    mk(
      1,
      AGENT_CLAUDE,
      "pending",
      makeReview(1, {
        agentId: AGENT_CLAUDE,
        tool: "send",
        asset: ASSETS.usdcSol,
        from: ADDR.solMain,
        to: ADDR.friendSol,
        amount: "25000000",
        plugin: null,
        expiresInMs: 9 * MIN,
        walletId: WALLET_MAIN,
        state: "PENDING_APPROVAL",
      }),
      null,
    ),
    mk(
      2,
      AGENT_CLAUDE,
      "pending",
      makeReview(2, {
        agentId: AGENT_CLAUDE,
        tool: "pay_x402",
        asset: ASSETS.usdcBase,
        from: ADDR.evmMain,
        to: ADDR.merchantEvm,
        amount: "150000",
        plugin: "x402",
        expiresInMs: 4 * MIN,
        walletId: WALLET_MAIN,
        state: "PENDING_APPROVAL",
        pluginData: x402Terms({
          network: "eip155:84532",
          asset: ASSETS.usdcBase.address,
          payTo: ADDR.merchantEvm,
          amount: "150000",
          resourceUrl: "https://api.example.com/reports/weekly",
          description: "Weekly market report",
          extra: { name: "USD Coin", version: "2" },
        }),
      }),
      null,
    ),
    // Cardano is never autonomous (ADR-002): an agent's ADA payment always lands here, and
    // approving it stamps SIGN_RAW_PAYLOAD_V2 over the reviewed body hash.
    mk(
      5,
      AGENT_CLAUDE,
      "pending",
      makeReview(5, {
        agentId: AGENT_CLAUDE,
        tool: "send",
        asset: ASSETS.ada,
        from: ADDR.adaMain,
        to: ADDR.friendAda,
        amount: "12500000",
        plugin: null,
        expiresInMs: 7 * MIN,
        walletId: WALLET_MAIN,
        state: "PENDING_APPROVAL",
      }),
      null,
    ),
    // The hackathon demo: Claude buys a report from an x402 seller for 2 tADA. Cardano
    // payments always need the passkey; after approval the mock walks the request through
    // SIGNING -> BROADCAST -> CONFIRMED (transport.ts) so the status timeline can be seen.
    mk(
      6,
      AGENT_CLAUDE,
      "pending",
      makeReview(6, {
        agentId: AGENT_CLAUDE,
        tool: "pay_x402",
        asset: ASSETS.ada,
        from: ADDR.adaMain,
        to: ADDR.sellerAda,
        amount: "2000000",
        plugin: "x402",
        expiresInMs: 5 * MIN,
        walletId: WALLET_MAIN,
        state: "PENDING_APPROVAL",
        pluginData: x402Terms({
          network: "cardano:preprod",
          asset: "lovelace",
          payTo: ADDR.sellerAda,
          amount: "2000000",
          resourceUrl: `https://address-intel.zyropay.online/v1/reports/address/${ADDR.friendAda}`,
          description: "Cardano address intelligence report",
          extra: { assetTransferMethod: "default" },
        }),
      }),
      null,
    ),
    // x402 into Masumi escrow: the 3 tADA are locked at the escrow script and released to the
    // seller only after it delivers; approving it walks lock -> result submitted (transport.ts).
    mk(
      7,
      AGENT_CLAUDE,
      "pending",
      makeReview(7, {
        agentId: AGENT_CLAUDE,
        tool: "pay_x402",
        asset: ASSETS.ada,
        from: ADDR.adaMain,
        to: MASUMI_ESCROW_PREPROD,
        amount: "3000000",
        plugin: "x402",
        expiresInMs: 6 * MIN,
        walletId: WALLET_MAIN,
        state: "PENDING_APPROVAL",
        pluginData: escrowX402Terms({
          price: "3000000",
          resourceUrl: `https://address-intel.zyropay.online/v1/audits/address/${ADDR.friendAda}`,
          description: "Cardano wallet risk audit",
          offsets: {
            payBy: 10 * MIN,
            submitResult: 40 * MIN,
            unlock: 2 * HOUR,
            externalDisputeUnlock: 4 * HOUR,
          },
          seed: 7,
        }),
      }),
      null,
    ),
    // An escrow payment approved earlier: locked, the seller hasn't delivered yet, so a
    // refund can be requested (then the simulated seller authorizes it, then withdraw).
    mk(
      8,
      AGENT_CLAUDE,
      "approved",
      makeReview(8, {
        agentId: AGENT_CLAUDE,
        tool: "pay_x402",
        asset: ASSETS.ada,
        from: ADDR.adaMain,
        to: MASUMI_ESCROW_PREPROD,
        amount: "5000000",
        plugin: "x402",
        expiresInMs: -50 * MIN,
        walletId: WALLET_MAIN,
        state: "CONFIRMED",
        pluginData: escrowX402Terms({
          price: "5000000",
          resourceUrl: "https://masumi-agent.zyropay.online/v1/datasets/stake-pools",
          description: "Stake pool performance dataset",
          offsets: {
            payBy: -45 * MIN,
            submitResult: 25 * MIN,
            unlock: 3 * HOUR,
            externalDisputeUnlock: 6 * HOUR,
          },
          seed: 8,
        }),
      }),
      50 * MIN,
    ),
    // Proof before release: an escrow payment whose seller recorded on Cardano exactly the
    // result the agent received (verified)...
    {
      ...mk(
        9,
        AGENT_CLAUDE,
        "approved",
        makeReview(9, {
          agentId: AGENT_CLAUDE,
          tool: "pay_x402",
          asset: ASSETS.ada,
          from: ADDR.adaMain,
          to: MASUMI_ESCROW_PREPROD,
          amount: "2000000",
          plugin: "x402",
          expiresInMs: -30 * MIN,
          walletId: WALLET_MAIN,
          state: "CONFIRMED",
          pluginData: escrowX402Terms({
            price: "2000000",
            resourceUrl: "https://token-intel.zyropay.online/v1/reports/token-holders",
            description: "Token holder distribution report",
            offsets: {
              payBy: -25 * MIN,
              submitResult: 20 * MIN,
              unlock: 3 * HOUR,
              externalDisputeUnlock: 6 * HOUR,
            },
            seed: 9,
          }),
        }),
        30 * MIN,
      ),
      escrowSeller: { deliverAfterMs: 0, result: "match" },
    },
    // ...and one whose recorded result differs from what was delivered (mismatch: refund).
    {
      ...mk(
        10,
        AGENT_CLAUDE,
        "approved",
        makeReview(10, {
          agentId: AGENT_CLAUDE,
          tool: "pay_x402",
          asset: ASSETS.ada,
          from: ADDR.adaMain,
          to: MASUMI_ESCROW_PREPROD,
          amount: "4000000",
          plugin: "x402",
          expiresInMs: -20 * MIN,
          walletId: WALLET_MAIN,
          state: "CONFIRMED",
          pluginData: escrowX402Terms({
            price: "4000000",
            resourceUrl: "https://masumi-agent.zyropay.online/v1/audits/contract/vesting",
            description: "Smart contract audit summary",
            offsets: {
              payBy: -15 * MIN,
              submitResult: 30 * MIN,
              unlock: 3 * HOUR,
              externalDisputeUnlock: 6 * HOUR,
            },
            seed: 10,
          }),
        }),
        20 * MIN,
      ),
      escrowSeller: { deliverAfterMs: 0, result: "mismatch" },
    },
    mk(
      3,
      AGENT_CLAUDE,
      "approved",
      makeReview(3, {
        agentId: AGENT_CLAUDE,
        tool: "send",
        asset: ASSETS.sol,
        from: ADDR.solMain,
        to: ADDR.friendSol,
        amount: "500000000",
        plugin: null,
        expiresInMs: -14 * DAY + 10 * MIN,
        walletId: WALLET_MAIN,
        state: "CONFIRMED",
      }),
      14 * DAY,
    ),
    mk(
      4,
      AGENT_GROK,
      "rejected",
      makeReview(4, {
        agentId: AGENT_GROK,
        tool: "send",
        asset: ASSETS.ethSepolia,
        from: ADDR.evmMain,
        to: ADDR.friendEvm,
        amount: "300000000000000000",
        plugin: null,
        expiresInMs: -21 * DAY + 10 * MIN,
        walletId: WALLET_MAIN,
        state: "REJECTED",
      }),
      21 * DAY,
    ),
  ];
}

export function makeReviewForSend(
  n: number,
  walletId: string,
  asset: Asset,
  from: string,
  to: string,
  amount: string,
): SigningReview {
  return makeReview(n, {
    agentId: null,
    tool: "app_send",
    asset,
    from,
    to,
    amount,
    plugin: null,
    expiresInMs: 10 * MIN,
    walletId,
    state: "CREATED",
  });
}

export function makePlugins(enabled: ReadonlySet<string>) {
  return PLUGIN_REGISTRY.map((manifest) => ({
    manifest,
    enabled: enabled.has(manifest.id),
    // Like a development API: a plugin is wired only where it runs on a test network, so
    // Jupiter (Solana mainnet only) is not configured and no swap is ever simulated.
    configured:
      manifest.status === "available" &&
      manifest.networks.some((n) => networksForMode("development").includes(n)),
  }));
}

export function assetById(id: string): Asset | undefined {
  return Object.values(ASSETS).find((a) => a.id === id);
}
