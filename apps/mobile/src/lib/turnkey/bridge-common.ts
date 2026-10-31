import {
  CARDANO_TURNKEY_ACCOUNT,
  isCardanoTurnkeyAccount,
  TURNKEY_POLICY_NAME_PREFIX,
  type ChainFamily,
  type StampedTurnkeyRequest,
} from "@zyropay/shared";
import type { ImportedWallet } from "./signer";

/*
 * Pieces shared by the native bridge (TurnkeyBridge.tsx, @turnkey/react-native-wallet-kit)
 * and the web bridge (TurnkeyBridge.web.tsx, @turnkey/core). Pure TypeScript: nothing
 * here imports a Turnkey SDK, so both platforms build the same requests.
 */

/**
 * ADR-001 D1: the passkey is the sub-org's only root. One Solana, one EVM and one Cardano
 * account (ADR-002: a compressed Ed25519 key at the CIP-1852 path).
 */
export const DEFAULT_WALLET = {
  walletName: "Main wallet",
  walletAccounts: [
    {
      curve: "CURVE_ED25519",
      pathFormat: "PATH_FORMAT_BIP32",
      path: "m/44'/501'/0'/0'",
      addressFormat: "ADDRESS_FORMAT_SOLANA",
    },
    {
      curve: "CURVE_SECP256K1",
      pathFormat: "PATH_FORMAT_BIP32",
      path: "m/44'/60'/0'/0/0",
      addressFormat: "ADDRESS_FORMAT_ETHEREUM",
    },
    { ...CARDANO_TURNKEY_ACCOUNT },
  ],
} as const;

/** Narrow a Turnkey SDK stamp result to the shared StampedTurnkeyRequest. */
export function toStamped(
  signed:
    | { body: string; stamp: { stampHeaderName: string; stampHeaderValue: string }; url: string }
    | undefined,
): StampedTurnkeyRequest {
  if (!signed) throw new Error("Turnkey did not return a stamped request");
  const name = signed.stamp.stampHeaderName;
  if (name !== "X-Stamp-Webauthn" && name !== "X-Stamp")
    throw new Error(`Unexpected stamp header ${name}`);
  return {
    url: signed.url,
    body: signed.body,
    stamp: { stampHeaderName: name, stampHeaderValue: signed.stamp.stampHeaderValue },
  };
}

/** ADR-001 D2: a value-moving signature must carry the passkey stamp. */
export function requirePasskeyStamp(
  stamped: StampedTurnkeyRequest,
  what = "Signature",
): StampedTurnkeyRequest {
  if (stamped.stamp.stampHeaderName !== "X-Stamp-Webauthn")
    throw new Error(`${what} was not stamped with the passkey`);
  return stamped;
}

/** Map Turnkey account rows (wallet accounts or private-key addresses) to chain families. */
export function reportedAccounts(
  rows: readonly {
    address?: string;
    addressFormat?: string;
    format?: string;
    path?: string;
    curve?: string;
    publicKey?: string;
  }[],
): ImportedWallet["accounts"] {
  const out: { family: ChainFamily; address: string }[] = [];
  for (const r of rows) {
    const format = r.addressFormat ?? r.format ?? "";
    const address = r.address ?? "";
    if (address === "") continue;
    if (isCardanoTurnkeyAccount({ addressFormat: format, path: r.path ?? "", curve: r.curve })) {
      out.push({ family: "cardano", address });
    } else if (format === "ADDRESS_FORMAT_SOLANA") {
      out.push({ family: "solana", address });
    } else if (format === "ADDRESS_FORMAT_ETHEREUM") {
      out.push({ family: "evm", address });
    }
  }
  return out;
}

/** Turnkey wallet names should be unique in an org; the ZyroPay label is sent separately. */
export function turnkeyName(name: string): string {
  return `${name.slice(0, 40)} (${Date.now().toString(36)})`;
}

/** Turnkey import parameters for one raw private key (ADR-003). */
export function privateKeyImportParams(family: "solana" | "evm") {
  return {
    addressFormats: [family === "solana" ? "ADDRESS_FORMAT_SOLANA" : "ADDRESS_FORMAT_ETHEREUM"],
    curve: family === "solana" ? "CURVE_ED25519" : "CURVE_SECP256K1",
    keyFormat: family === "solana" ? "SOLANA" : "HEXADECIMAL",
  } as const;
}

/** Turnkey user name of the delegated API-key user (ADR-001 D6). */
export const DELEGATED_USER_NAME = "zyropay-delegated";

/**
 * Read and delete access to the sub-org's policies and users. Implementations stamp the
 * deletions with the passkey (they are activities of the user's own root credential).
 */
export interface DelegatedAccessHttp {
  listPolicies(
    organizationId: string,
  ): Promise<readonly { policyId: string; policyName: string; consensus?: string }[]>;
  listUsers(
    organizationId: string,
  ): Promise<readonly { userId: string; userName: string; authenticators?: readonly unknown[] }[]>;
  deletePolicies(organizationId: string, policyIds: readonly string[]): Promise<void>;
  deleteUsers(organizationId: string, userIds: readonly string[]): Promise<void>;
}

/**
 * ADR-001 D8: what an earlier autonomous setup left in the sub-org. Revoking the last
 * autonomous agent destroys the delegated key on the server at once, but its Turnkey user
 * and policies stay until the user's passkey removes them. They are harmless (nobody holds
 * the key) but count against Turnkey's 5-policy limit, so a new envelope would be refused.
 * Only ZyroPay's own objects are picked: policies named `zyropay-delegated-*` whose consensus
 * is not the current delegated user, and users named `zyropay-delegated` other than it that
 * have no authenticator (a passkey user is never touched).
 */
export function staleDelegatedAccess(
  policies: Awaited<ReturnType<DelegatedAccessHttp["listPolicies"]>>,
  users: Awaited<ReturnType<DelegatedAccessHttp["listUsers"]>>,
  keepUserId: string,
): { policyIds: string[]; userIds: string[] } {
  return {
    policyIds: policies
      .filter(
        (p) =>
          p.policyName.startsWith(`${TURNKEY_POLICY_NAME_PREFIX}-`) &&
          !(p.consensus ?? "").includes(`'${keepUserId}'`),
      )
      .map((p) => p.policyId),
    userIds: users
      .filter(
        (u) =>
          u.userName === DELEGATED_USER_NAME &&
          u.userId !== keepUserId &&
          (u.authenticators ?? []).length === 0,
      )
      .map((u) => u.userId),
  };
}

/** The slice of a Turnkey SDK http client (core or Wallet Kit) the cleanup needs. */
interface TurnkeyHttpLike<S> {
  getPolicies(input: {
    organizationId?: string;
  }): Promise<{ policies: Awaited<ReturnType<DelegatedAccessHttp["listPolicies"]>> }>;
  getUsers(input: {
    organizationId?: string;
  }): Promise<{ users: Awaited<ReturnType<DelegatedAccessHttp["listUsers"]>> }>;
  deletePolicies(
    input: { organizationId?: string; policyIds: string[]; timestampMs?: string },
    stampWith?: S,
  ): Promise<unknown>;
  deleteUsers(
    input: { organizationId?: string; userIds: string[]; timestampMs?: string },
    stampWith?: S,
  ): Promise<unknown>;
}

/** Reads with the client's default (session) stamper, deletions stamped with `passkey`. */
export function delegatedAccessHttp<S>(http: TurnkeyHttpLike<S>, passkey: S): DelegatedAccessHttp {
  return {
    listPolicies: async (organizationId) => (await http.getPolicies({ organizationId })).policies,
    listUsers: async (organizationId) => (await http.getUsers({ organizationId })).users,
    deletePolicies: async (organizationId, policyIds) => {
      await http.deletePolicies(
        { organizationId, policyIds: [...policyIds], timestampMs: String(Date.now()) },
        passkey,
      );
    },
    deleteUsers: async (organizationId, userIds) => {
      await http.deleteUsers(
        { organizationId, userIds: [...userIds], timestampMs: String(Date.now()) },
        passkey,
      );
    },
  };
}

/** Delete the stale delegated access (policies first: they reference the user). */
export async function removeStaleDelegatedAccess(
  http: DelegatedAccessHttp,
  input: { organizationId: string; keepUserId: string },
): Promise<{ policies: number; users: number }> {
  const [policies, users] = await Promise.all([
    http.listPolicies(input.organizationId),
    http.listUsers(input.organizationId),
  ]);
  const stale = staleDelegatedAccess(policies, users, input.keepUserId);
  if (stale.policyIds.length > 0) await http.deletePolicies(input.organizationId, stale.policyIds);
  if (stale.userIds.length > 0) await http.deleteUsers(input.organizationId, stale.userIds);
  return { policies: stale.policyIds.length, users: stale.userIds.length };
}
