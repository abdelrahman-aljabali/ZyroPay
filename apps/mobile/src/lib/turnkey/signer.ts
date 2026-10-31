import type {
  ChainFamily,
  NetworkId,
  StampedTurnkeyRequest,
  TurnkeyPolicyIntent,
} from "@zyropay/shared";
import { CARDANO_TURNKEY_ACCOUNT, chainFamilyOf, sha256Hex } from "@zyropay/shared";
import { createContext, useContext, useEffect } from "react";
import { previewPhraseAddresses } from "@/lib/import/derive";
import { TEST_PHRASES, TEST_PRIVATE_KEYS } from "@/lib/import/fixtures";
import { checkPrivateKey } from "@/lib/import/private-key";

/*
 * Passkey signer abstraction over Turnkey (ADR-001).
 *
 *  - "turnkey":     @turnkey/react-native-wallet-kit in a development build with
 *                   EXPO_PUBLIC_TURNKEY_* configured. Every value-moving signature
 *                   is stamped with StamperType.Passkey (header X-Stamp-Webauthn).
 *  - "simulated":   DEV mock mode only. Produces a clearly fake stamp that only
 *                   the mock transport accepts; the UI labels it as simulated.
 *  - "unavailable": not configured / Expo Go. Auth screens explain why.
 */

export type SignerKind = "turnkey" | "simulated" | "unavailable";

export interface SignTransactionInput {
  /** The user's Turnkey sub-organization. */
  readonly organizationId: string;
  /** Wallet account address that must sign (review.payload.from). */
  readonly signWith: string;
  readonly unsignedTransaction: {
    readonly encoding: "base64" | "hex";
    readonly serialized: string;
  };
  readonly network: NetworkId;
}

/** Turnkey's hashing of a raw payload; neither variant hashes, the payload is what is signed. */
export type RawPayloadHashFunction = "HASH_FUNCTION_NOT_APPLICABLE" | "HASH_FUNCTION_NO_OP";

export interface SignRawPayloadInput {
  readonly organizationId: string;
  /**
   * Cardano: the account's Ed25519 public key (hex), from `review.rawPayload.signWith`.
   * x402 on EVM: the wallet address (`review.payload.from`).
   */
  readonly signWith: string;
  /**
   * 32 bytes (hex). Cardano: the body hash (`review.rawPayload.payload`). x402 on EVM: the
   * EIP-712 digest (`review.typedData.digest`).
   */
  readonly payload: string;
  /**
   * Cardano (Ed25519): HASH_FUNCTION_NOT_APPLICABLE, the default. x402 on EVM (secp256k1):
   * HASH_FUNCTION_NO_OP, because the digest is already the hash to sign.
   */
  readonly hashFunction?: RawPayloadHashFunction;
}

/** The exact ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2 body (what the passkey stamps). */
export function turnkeySignRawPayloadBody(input: SignRawPayloadInput, timestampMs: string) {
  return {
    parameters: {
      signWith: input.signWith,
      payload: input.payload,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL" as const,
      hashFunction: input.hashFunction ?? "HASH_FUNCTION_NOT_APPLICABLE",
    },
    organizationId: input.organizationId,
    timestampMs,
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  };
}

/** ADR-003: what Turnkey holds after an import (addresses as Turnkey reports them). */
export interface ImportedWallet {
  /** HD wallet id (phrase import) or private key id (key import): what POST /v1/wallets takes. */
  readonly turnkeyWalletId: string;
  /** Solana/EVM: address. Cardano: compressed Ed25519 public key (hex), per ADR-002. */
  readonly accounts: readonly { readonly family: ChainFamily; readonly address: string }[];
}

export interface PasskeySigner {
  readonly kind: SignerKind;
  readonly unavailableReason: string | null;
  /**
   * ADR-003: why this signer cannot import a phrase or key (null: it can). Expo Go, a
   * missing Turnkey config and the local dev passkey cannot; mock mode simulates it.
   */
  readonly importUnavailableReason: string | null;
  /**
   * Web only: start loading the (code-split) Turnkey implementation now, because a screen
   * that may sign has mounted. Never throws; signer calls await the load anyway.
   */
  preload?(): void;
  /** Create the passkey + sub-organization + default wallet via the Auth Proxy, then stamp whoami. */
  signUp(input: { displayName: string }): Promise<StampedTurnkeyRequest>;
  /** Passkey login, then stamp whoami for POST /v1/auth/session. */
  logIn(): Promise<StampedTurnkeyRequest>;
  /** Passkey-stamped SIGN_TRANSACTION_V2 over exactly the reviewed bytes. */
  stampSignTransaction(input: SignTransactionInput): Promise<StampedTurnkeyRequest>;
  /**
   * Passkey-stamped SIGN_RAW_PAYLOAD_V2. Cardano (ADR-002): over the transaction body hash
   * (HASH_FUNCTION_NOT_APPLICABLE: Ed25519 signs the message itself). x402 on EVM: over the
   * EIP-712 digest (HASH_FUNCTION_NO_OP).
   */
  stampSignRawPayload(input: SignRawPayloadInput): Promise<StampedTurnkeyRequest>;
  /**
   * ADR-002: add the Cardano account (compressed Ed25519 at the CIP-1852 path) to an
   * existing wallet with the user's own Turnkey credential. Then sync wallets via the API.
   */
  addCardanoAccount(input: { organizationId: string; turnkeyWalletId: string }): Promise<void>;
  /** Export the wallet's recovery phrase (passkey-gated, decrypted on device only). */
  exportRecoveryPhrase(input: { turnkeyWalletId: string; organizationId: string }): Promise<string>;
  /**
   * ADR-001 D6: with the user's passkey, create (or find) the non-root API-key user that
   * holds the API's delegated public key in the user's sub-org. Returns its Turnkey user id.
   */
  createDelegatedUser(input: { organizationId: string; publicKey: string }): Promise<string>;
  /**
   * ADR-001 D8: with the user's passkey, delete the Turnkey user and policies an earlier
   * autonomous setup left behind (everything named `zyropay-delegated` except `keepUserId`).
   * Resolves to how many were removed; nothing is prompted when there is nothing to remove.
   */
  removeStaleDelegatedAccess(input: {
    organizationId: string;
    keepUserId: string;
  }): Promise<{ policies: number; users: number }>;
  /**
   * ADR-001 D6: passkey-stamp (do not submit) the CREATE_POLICIES activity carrying the
   * policy envelope. The API verifies it and forwards it to Turnkey unmodified.
   */
  stampCreatePolicies(input: {
    organizationId: string;
    policies: readonly TurnkeyPolicyIntent[];
  }): Promise<StampedTurnkeyRequest>;
  /**
   * "Add wallet": create a new HD wallet with one account for `family` in the user's own
   * sub-organization, stamped with the passkey (ADR-001: the API cannot create wallets).
   * Resolves to the Turnkey wallet id, which the app then registers with POST /v1/wallets.
   */
  createWallet(input: {
    organizationId: string;
    name: string;
    family: ChainFamily;
  }): Promise<string>;
  /**
   * ADR-003: import a BIP-39 phrase as a new HD wallet in the user's sub-org. The phrase is
   * HPKE-encrypted ON THE DEVICE to Turnkey's import enclave (INIT_IMPORT_WALLET ->
   * encryptWalletToBundle -> IMPORT_WALLET, both activities stamped with the passkey) and
   * never sent anywhere else. `families` picks the accounts (walletAccountParams).
   */
  importWallet(input: {
    organizationId: string;
    name: string;
    mnemonic: string;
    families: readonly ChainFamily[];
  }): Promise<ImportedWallet>;
  /**
   * ADR-003: import one raw private key (EVM hex or Solana base58 keypair) as a Turnkey
   * private key, same encrypted path (INIT_IMPORT_PRIVATE_KEY -> IMPORT_PRIVATE_KEY).
   */
  importPrivateKey(input: {
    organizationId: string;
    name: string;
    privateKey: string;
    family: "solana" | "evm";
  }): Promise<ImportedWallet>;
  /**
   * Export an imported private key (passkey-gated, decrypted on device only). Resolves to
   * the key in the format the user imported it in (EVM 0x-hex, Solana base58 keypair).
   */
  exportPrivateKey(input: {
    organizationId: string;
    turnkeyPrivateKeyId: string;
    family: ChainFamily;
  }): Promise<string>;
  logOut(): Promise<void>;
}

/** Turnkey account parameters for a new wallet's first account, per chain family. */
export function walletAccountParams(family: ChainFamily): {
  curve: "CURVE_ED25519" | "CURVE_SECP256K1";
  pathFormat: "PATH_FORMAT_BIP32";
  path: string;
  addressFormat: "ADDRESS_FORMAT_SOLANA" | "ADDRESS_FORMAT_ETHEREUM" | "ADDRESS_FORMAT_COMPRESSED";
} {
  switch (family) {
    case "solana":
      return {
        curve: "CURVE_ED25519",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/501'/0'/0'",
        addressFormat: "ADDRESS_FORMAT_SOLANA",
      };
    case "evm":
      return {
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/60'/0'/0/0",
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
      };
    case "cardano":
      // ADR-002: compressed Ed25519 at the CIP-1852 path (the API derives the enterprise address).
      return { ...CARDANO_TURNKEY_ACCOUNT };
    default:
      throw new SignerUnavailableError(`Creating ${String(family)} wallets is not supported yet.`);
  }
}

/** Prefix of wallet ids the simulated signer creates (the mock transport accepts only these). */
export const SIMULATED_NEW_WALLET_PREFIX = "simulated-wallet-new-";
/** Prefix of wallet / private-key ids the simulated import produces (ADR-003, mock mode). */
export const SIMULATED_IMPORT_PREFIX = "simulated-import-";

/**
 * Mock mode only: what each simulated import "created", read by the mock transport when
 * the app registers it. Holds addresses only, never key material.
 */
export const simulatedImports = new Map<
  string,
  { readonly kind: "wallet" | "private_key"; readonly accounts: ImportedWallet["accounts"] }
>();

export class SignerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SignerUnavailableError";
  }
}

export function unavailableSigner(reason: string, importReason: string = reason): PasskeySigner {
  const fail = () => Promise.reject(new SignerUnavailableError(reason));
  return {
    kind: "unavailable",
    unavailableReason: reason,
    importUnavailableReason: importReason,
    importWallet: () => Promise.reject(new SignerUnavailableError(importReason)),
    importPrivateKey: () => Promise.reject(new SignerUnavailableError(importReason)),
    exportPrivateKey: fail,
    signUp: fail,
    logIn: fail,
    stampSignTransaction: fail,
    stampSignRawPayload: fail,
    addCardanoAccount: fail,
    exportRecoveryPhrase: fail,
    createDelegatedUser: fail,
    removeStaleDelegatedAccess: fail,
    stampCreatePolicies: fail,
    createWallet: fail,
    logOut: () => Promise.resolve(),
  };
}

export const SIMULATED_STAMP_VALUE = "SIMULATED-PASSKEY-STAMP-NOT-VALID-FOR-TURNKEY";

export function simulatedSigner(): PasskeySigner {
  const stamp = (url: string, body: unknown): StampedTurnkeyRequest => ({
    url,
    body: JSON.stringify(body),
    stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: SIMULATED_STAMP_VALUE },
  });
  const whoami = () =>
    stamp("https://api.turnkey.com/public/v1/query/whoami", {
      organizationId: "simulated-suborg-0000",
    });
  return {
    kind: "simulated",
    unavailableReason: null,
    importUnavailableReason: null,
    // ADR-003 mock mode: only the public test vectors are accepted, so a demo can never
    // take in a real secret; the result is labelled simulated by the screen.
    importWallet: async ({ mnemonic, families }) => {
      if (!TEST_PHRASES.includes(mnemonic))
        throw new SignerUnavailableError(
          "Simulated mode only imports the public BIP-39 test phrase. Never enter a real phrase here.",
        );
      const preview = await previewPhraseAddresses(mnemonic, families.filter(isPreviewFamily));
      const id = `${SIMULATED_IMPORT_PREFIX}wallet-${Date.now().toString(36)}`;
      const accounts = families.map((family) => {
        walletAccountParams(family);
        const address =
          family === "solana"
            ? (preview.solana ?? "")
            : family === "evm"
              ? (preview.evm ?? "")
              : sha256Hex(`simulated-cardano:${id}`);
        return { family, address };
      });
      simulatedImports.set(id, { kind: "wallet", accounts });
      return { turnkeyWalletId: id, accounts };
    },
    importPrivateKey: async ({ privateKey, family }) => {
      await Promise.resolve();
      if (!TEST_PRIVATE_KEYS.includes(privateKey))
        throw new SignerUnavailableError(
          "Simulated mode only imports the public test keys. Never enter a real key here.",
        );
      const checked = checkPrivateKey(privateKey);
      if (!checked.ok || checked.family !== family) throw new Error("Simulated key mismatch");
      const id = `${SIMULATED_IMPORT_PREFIX}key-${Date.now().toString(36)}`;
      const accounts = [{ family, address: checked.address }];
      simulatedImports.set(id, { kind: "private_key", accounts });
      return { turnkeyWalletId: id, accounts };
    },
    exportPrivateKey: () =>
      Promise.resolve("SIMULATED-PRIVATE-KEY-NOT-REAL-0000000000000000000000000000000000"),
    signUp: () => Promise.resolve(whoami()),
    logIn: () => Promise.resolve(whoami()),
    stampSignTransaction: (input) =>
      Promise.resolve(
        stamp(
          "https://api.turnkey.com/public/v1/submit/sign_transaction",
          turnkeySignBody(input, String(Date.now())),
        ),
      ),
    stampSignRawPayload: (input) =>
      Promise.resolve(
        stamp(
          "https://api.turnkey.com/public/v1/submit/sign_raw_payload",
          turnkeySignRawPayloadBody(input, String(Date.now())),
        ),
      ),
    // Mock transport wallets already carry a (simulated) Cardano account.
    addCardanoAccount: () => Promise.resolve(),
    exportRecoveryPhrase: () =>
      Promise.resolve(
        "simulated simulated simulated simulated simulated simulated simulated simulated simulated simulated simulated simulated",
      ),
    createDelegatedUser: ({ publicKey }) =>
      Promise.resolve(`simulated-delegated-${publicKey.slice(2, 14)}`),
    removeStaleDelegatedAccess: () => Promise.resolve({ policies: 0, users: 0 }),
    stampCreatePolicies: ({ organizationId, policies }) =>
      Promise.resolve(
        stamp(
          "https://api.turnkey.com/public/v1/submit/create_policies",
          createPoliciesBody(organizationId, policies, String(Date.now())),
        ),
      ),
    createWallet: ({ family }) => {
      walletAccountParams(family); // same "unsupported family" failure as the real signer
      return Promise.resolve(`${SIMULATED_NEW_WALLET_PREFIX}${family}-${Date.now().toString(36)}`);
    },
    logOut: () => Promise.resolve(),
  };
}

function utf8Base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * DEVELOPMENT ONLY: a passkey stand-in for a local API that runs MockTurnkey (no Turnkey
 * credentials). It produces WebAuthn-format stamps exactly like @zyropay/wallet's
 * `mockPasskeyStamp`, for a `dev-*` credential that MockTurnkey auto-provisions. No real
 * Turnkey accepts these stamps, and the env refuses this mode in production. Autonomous
 * setup and recovery-phrase export need real Turnkey, so they fail closed here.
 */
export function devMockTurnkeySigner(
  credentialId: () => Promise<string>,
  turnkeyApiBaseUrl = "https://api.turnkey.com",
): PasskeySigner {
  const stamp = async (path: string, body: unknown): Promise<StampedTurnkeyRequest> => {
    const credential = await credentialId();
    const text = JSON.stringify(body);
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: utf8Base64Url(sha256Hex(text)),
      origin: "https://mock.zyropay",
    });
    return {
      url: `${turnkeyApiBaseUrl}${path}`,
      body: text,
      stamp: {
        stampHeaderName: "X-Stamp-Webauthn",
        stampHeaderValue: JSON.stringify({
          authenticatorData: "bW9jaw",
          clientDataJson: utf8Base64Url(clientData),
          credentialId: credential,
          signature: sha256Hex(`mock-passkey:${credential}:${text}`),
        }),
      },
    };
  };
  const whoami = async () => {
    // MockTurnkey derives an auto-provisioned dev sub-org's id from the credential id.
    const organizationId = `mock-org-${sha256Hex(`org:${await credentialId()}`).slice(0, 16)}`;
    return stamp("/public/v1/query/whoami", { organizationId });
  };
  const needsTurnkey = () =>
    Promise.reject(
      new SignerUnavailableError(
        "This needs a real Turnkey passkey. The local dev passkey only signs sign-ins and payments.",
      ),
    );
  return {
    kind: "simulated",
    unavailableReason: null,
    importUnavailableReason:
      "Importing needs a real Turnkey passkey in the ZyroPay app build. The local dev passkey can't encrypt to Turnkey's import enclave.",
    importWallet: needsTurnkey,
    importPrivateKey: needsTurnkey,
    exportPrivateKey: needsTurnkey,
    signUp: whoami,
    logIn: whoami,
    stampSignTransaction: (input) =>
      stamp("/public/v1/submit/sign_transaction", turnkeySignBody(input, String(Date.now()))),
    stampSignRawPayload: (input) =>
      stamp(
        "/public/v1/submit/sign_raw_payload",
        turnkeySignRawPayloadBody(input, String(Date.now())),
      ),
    exportRecoveryPhrase: needsTurnkey,
    addCardanoAccount: needsTurnkey,
    createDelegatedUser: needsTurnkey,
    removeStaleDelegatedAccess: needsTurnkey,
    stampCreatePolicies: needsTurnkey,
    createWallet: needsTurnkey,
    logOut: () => Promise.resolve(),
  };
}

/** base64 -> lowercase hex, pure JS (Hermes has atob). */
export function base64ToHex(b64: string): string {
  const bin = atob(b64);
  let out = "";
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/** Turnkey expects the raw unsigned transaction as hex. */
export function unsignedHex(tx: SignTransactionInput["unsignedTransaction"]): string {
  return tx.encoding === "hex" ? tx.serialized.replace(/^0x/, "") : base64ToHex(tx.serialized);
}

export function turnkeyTransactionType(
  network: NetworkId,
): "TRANSACTION_TYPE_SOLANA" | "TRANSACTION_TYPE_ETHEREUM" {
  if (chainFamilyOf(network) === "cardano")
    throw new Error("Cardano is signed with SIGN_RAW_PAYLOAD (stampSignRawPayload)");
  return chainFamilyOf(network) === "solana"
    ? "TRANSACTION_TYPE_SOLANA"
    : "TRANSACTION_TYPE_ETHEREUM";
}

/** The exact ACTIVITY_TYPE_SIGN_TRANSACTION_V2 body (what the passkey stamps). */
export function turnkeySignBody(input: SignTransactionInput, timestampMs: string) {
  return {
    parameters: {
      signWith: input.signWith,
      unsignedTransaction: unsignedHex(input.unsignedTransaction),
      type: turnkeyTransactionType(input.network),
    },
    organizationId: input.organizationId,
    timestampMs,
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  };
}

/** The exact ACTIVITY_TYPE_CREATE_POLICIES body (what the passkey stamps). */
export function createPoliciesBody(
  organizationId: string,
  policies: readonly TurnkeyPolicyIntent[],
  timestampMs: string,
) {
  return {
    type: "ACTIVITY_TYPE_CREATE_POLICIES",
    timestampMs,
    organizationId,
    parameters: { policies: policies.map((p) => ({ ...p })) },
  };
}

function isPreviewFamily(f: ChainFamily): f is "solana" | "evm" {
  return f === "solana" || f === "evm";
}

export const SignerContext = createContext<PasskeySigner>(
  unavailableSigner("Signer not initialised"),
);

/** The signer. Mounting a screen that uses it preloads the lazy web implementation. */
export function useSigner(): PasskeySigner {
  const signer = useContext(SignerContext);
  useEffect(() => {
    signer.preload?.();
  }, [signer]);
  return signer;
}
