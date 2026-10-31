import type { ChainFamily, Signer, StampedTurnkeyRequest } from "@zyropay/shared";

export interface TurnkeyIdentity {
  readonly organizationId: string;
  readonly userId: string;
  readonly username: string;
}

export interface RootQuorum {
  readonly threshold: number;
  readonly userIds: readonly string[];
}

export interface TurnkeyWalletAccount {
  readonly turnkeyWalletId: string;
  readonly walletName: string;
  readonly family: ChainFamily;
  /**
   * Solana/EVM: the chain address. Cardano: Turnkey's account address for
   * ADDRESS_FORMAT_COMPRESSED, i.e. the 32-byte Ed25519 public key (hex); the API derives
   * the network's enterprise address from it (`cardanoEnterpriseAddress`).
   */
  readonly address: string;
  /** Cardano: the Ed25519 public key (hex), needed as `signWith` and for the vkey witness. */
  readonly publicKey?: string;
  readonly derivationPath: string;
}

export interface TurnkeyUserSummary {
  readonly userId: string;
  readonly userName: string;
  /** Compressed P-256 public keys of the user's API keys (lowercase hex). */
  readonly apiPublicKeys: readonly string[];
  readonly authenticatorCount: number;
}

export interface TurnkeyPolicySummary {
  readonly policyId: string;
  readonly effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  readonly consensus: string;
}

export interface DelegatedKey {
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * Read-side and forwarding operations the API needs besides the shared `Signer` port.
 * Reads use the parent-org API key, which can read but not write sub-organizations
 * (docs/ARCHITECTURE.md ADR-001, fact 1). Writes only ever forward user stamps.
 */
export interface TurnkeyDirectory {
  readonly simulated: boolean;
  /** Forward a stamped get_whoami (already checked with verifyWhoamiRequest). */
  whoami(request: StampedTurnkeyRequest): Promise<TurnkeyIdentity>;
  getRootQuorum(subOrganizationId: string): Promise<RootQuorum>;
  listWalletAccounts(subOrganizationId: string): Promise<TurnkeyWalletAccount[]>;
  /**
   * ADR-003: imported raw private keys (Turnkey private keys, not HD wallets) as accounts:
   * `turnkeyWalletId` is the private key id, `derivationPath` is
   * IMPORTED_KEY_DERIVATION_PATH. Solana and EVM addresses only.
   */
  listPrivateKeyAccounts(subOrganizationId: string): Promise<TurnkeyWalletAccount[]>;
  listUsers(subOrganizationId: string): Promise<TurnkeyUserSummary[]>;
  listPolicies(subOrganizationId: string): Promise<TurnkeyPolicySummary[]>;
  /** Forward a passkey-stamped CREATE_POLICIES activity; returns the new policy ids. */
  forwardCreatePolicies(request: StampedTurnkeyRequest): Promise<string[]>;
}

export type TurnkeyGateway = Signer & TurnkeyDirectory;

/** Resolves (decrypts) the delegated API key for a sub-organization; null if none is active. */
export type DelegatedKeyResolver = (subOrganizationId: string) => Promise<DelegatedKey | null>;
