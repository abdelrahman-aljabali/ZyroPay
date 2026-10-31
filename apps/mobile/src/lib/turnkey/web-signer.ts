import { StamperType, TurnkeyClient } from "@turnkey/core";
import {
  decryptExportBundle,
  encryptPrivateKeyToBundle,
  encryptWalletToBundle,
  generateP256KeyPair,
} from "@turnkey/crypto";
import { CARDANO_TURNKEY_ACCOUNT, type StampedTurnkeyRequest } from "@zyropay/shared";
import { env } from "@/lib/env";
import { formatExportedKey } from "@/lib/import/private-key";
import {
  DEFAULT_WALLET,
  DELEGATED_USER_NAME,
  delegatedAccessHttp,
  privateKeyImportParams,
  removeStaleDelegatedAccess,
  reportedAccounts,
  turnkeyName,
} from "./bridge-common";
import { walletAccountParams, type PasskeySigner } from "./signer";
import {
  stampCreatePolicies,
  stampSignRawPayload,
  stampSignTransaction,
  stampWhoami,
} from "./web-requests";

/*
 * Real Turnkey on the web (ADR-001), the browser twin of TurnkeyBridge.tsx.
 *
 * Loaded lazily (dynamic import from TurnkeyBridge.web.tsx): @turnkey/core pulls in viem,
 * ethers and WalletConnect (about 1.7 MB of minified JS) that the first page never needs.
 *
 * SDK: @turnkey/core 2.12.2, Turnkey's framework-agnostic TypeScript frontend SDK and the
 * same core that @turnkey/react-native-wallet-kit 2.3.9 wraps on iOS/Android. On the web it
 * stamps with @turnkey/webauthn-stamper (navigator.credentials.get; header X-Stamp-Webauthn,
 * challenge = UTF-8 bytes of sha256hex(body): exactly what @zyropay/wallet verifies) and
 * keeps its session key as a NON-EXTRACTABLE P-256 CryptoKey in IndexedDB.
 *
 * Sign-up and login go through the Turnkey Auth Proxy (authproxy.turnkey.com,
 * X-Auth-Proxy-Config-Id): no ZyroPay backend and no parent-org API key is involved, so the
 * browser bundle never holds a Turnkey secret. The Auth Proxy only answers origins listed
 * under "Allowed Origins" in its dashboard config (docs/DEPLOY.md).
 *
 * WebAuthn rules: the rpId (EXPO_PUBLIC_PASSKEY_RP_ID) must equal the page's host or a
 * registrable parent of it ("localhost" for http://localhost:<port>, "app.example.com" or
 * "example.com" for https://app.example.com). Browsers allow WebAuthn only in secure
 * contexts: https, or http://localhost.
 *
 * Every value-moving request (send, approval, policy envelope, wallet creation, import,
 * export) is stamped with StamperType.Passkey. Read-only queries (whoami for
 * POST /v1/auth/session, wallet account reads) use the session key (ADR-001 D2).
 */

let clientPromise: Promise<TurnkeyClient> | null = null;

function client(): Promise<TurnkeyClient> {
  clientPromise ??= (async () => {
    const c = new TurnkeyClient({
      apiBaseUrl: env.turnkey.apiBaseUrl,
      organizationId: env.turnkey.organizationId,
      authProxyConfigId: env.turnkey.authProxyConfigId,
      defaultStamperType: StamperType.ApiKey,
      passkeyConfig: {
        rpId: env.turnkey.rpId,
        timeout: 60_000,
        userVerification: "preferred",
      },
    });
    await c.init();
    return c;
  })().catch((error: unknown) => {
    clientPromise = null; // let the next call retry
    throw error;
  });
  return clientPromise;
}

async function whoami(): Promise<StampedTurnkeyRequest> {
  // Read-only query: a session-key stamp (X-Stamp) is acceptable per ADR-001 D2.
  return stampWhoami((await client()).httpClient);
}

/** The Turnkey user id of the signed-in passkey user (needed by the import enclave). */
async function sessionUserId(): Promise<string> {
  const session = await (await client()).getSession();
  if (!session?.userId) throw new Error("Sign in again: the Turnkey session has expired");
  return session.userId;
}

/** @public Loaded with a dynamic import by TurnkeyBridge.web.tsx. */
export const webSigner: PasskeySigner = {
  kind: "turnkey",
  unavailableReason: null,
  importUnavailableReason: null,
  async signUp({ displayName }) {
    const c = await client();
    await c.signUpWithPasskey({
      passkeyDisplayName: displayName,
      createSubOrgParams: {
        userName: displayName,
        customWallet: {
          walletName: DEFAULT_WALLET.walletName,
          walletAccounts: DEFAULT_WALLET.walletAccounts.map((a) => ({ ...a })),
        },
      },
    });
    return whoami();
  },
  async logIn() {
    await (await client()).loginWithPasskey();
    return whoami();
  },
  async stampSignTransaction(input) {
    return stampSignTransaction((await client()).httpClient, input);
  },
  async stampSignRawPayload(input) {
    return stampSignRawPayload((await client()).httpClient, input);
  },
  async addCardanoAccount({ organizationId, turnkeyWalletId }) {
    const c = await client();
    await c.httpClient.createWalletAccounts(
      {
        organizationId,
        walletId: turnkeyWalletId,
        accounts: [{ ...CARDANO_TURNKEY_ACCOUNT }],
        timestampMs: String(Date.now()),
      },
      StamperType.Passkey,
    );
  },
  async createDelegatedUser({ organizationId, publicKey }) {
    // ADR-001 D6: the end user's own passkey creates the non-root API-key user.
    const user = await (
      await client()
    ).fetchOrCreateP256ApiKeyUser({
      publicKey,
      organizationId,
      createParams: { userName: DELEGATED_USER_NAME, apiKeyName: DELEGATED_USER_NAME },
      stampWith: StamperType.Passkey,
    });
    return user.userId;
  },
  async removeStaleDelegatedAccess(input) {
    const http = delegatedAccessHttp((await client()).httpClient, StamperType.Passkey);
    return removeStaleDelegatedAccess(http, input);
  },
  async stampCreatePolicies(input) {
    return stampCreatePolicies((await client()).httpClient, input);
  },
  async exportRecoveryPhrase({ turnkeyWalletId, organizationId }) {
    // Ephemeral P-256 target key: Turnkey's enclave encrypts the phrase to it and it is
    // decrypted here, in memory. Neither the key nor the phrase is stored anywhere.
    const { privateKey, publicKeyUncompressed } = generateP256KeyPair();
    const bundle = await (
      await client()
    ).exportWallet({
      walletId: turnkeyWalletId,
      targetPublicKey: publicKeyUncompressed,
      organizationId,
      stampWith: StamperType.Passkey,
    });
    return decryptExportBundle({
      exportBundle: bundle,
      embeddedKey: privateKey,
      organizationId,
      returnMnemonic: true,
      keyFormat: "HEXADECIMAL",
    });
  },
  async createWallet({ organizationId, name, family }) {
    return (await client()).createWallet({
      walletName: name,
      accounts: [walletAccountParams(family)],
      organizationId,
      stampWith: StamperType.Passkey,
    });
  },
  async importWallet({ organizationId, name, mnemonic, families }) {
    const c = await client();
    const userId = await sessionUserId();
    // ADR-003: INIT_IMPORT_WALLET (passkey) -> HPKE-encrypt the phrase to the enclave's
    // signed import bundle IN THE BROWSER -> IMPORT_WALLET (passkey). Only ciphertext leaves.
    const init = await c.httpClient.initImportWallet(
      { organizationId, userId },
      StamperType.Passkey,
    );
    const encryptedBundle = await encryptWalletToBundle({
      mnemonic,
      importBundle: init.importBundle,
      userId,
      organizationId,
    });
    const walletId = await c.importWallet({
      encryptedBundle,
      walletName: turnkeyName(name),
      accounts: families.map((f) => walletAccountParams(f)),
      organizationId,
      userId,
      stampWith: StamperType.Passkey,
    });
    const res = await c.httpClient.getWalletAccounts(
      { organizationId, walletId },
      StamperType.ApiKey,
    );
    return { turnkeyWalletId: walletId, accounts: reportedAccounts(res.accounts) };
  },
  async importPrivateKey({ organizationId, name, privateKey, family }) {
    const c = await client();
    const userId = await sessionUserId();
    const params = privateKeyImportParams(family);
    const init = await c.httpClient.initImportPrivateKey(
      { organizationId, userId },
      StamperType.Passkey,
    );
    const encryptedBundle = await encryptPrivateKeyToBundle({
      privateKey,
      keyFormat: params.keyFormat,
      importBundle: init.importBundle,
      userId,
      organizationId,
    });
    const privateKeyId = await c.importPrivateKey({
      encryptedBundle,
      privateKeyName: turnkeyName(name),
      addressFormats: [...params.addressFormats],
      curve: params.curve,
      organizationId,
      userId,
      stampWith: StamperType.Passkey,
    });
    const res = await c.httpClient.getPrivateKey(
      { organizationId, privateKeyId },
      StamperType.ApiKey,
    );
    return { turnkeyWalletId: privateKeyId, accounts: reportedAccounts(res.privateKey.addresses) };
  },
  async exportPrivateKey({ organizationId, turnkeyPrivateKeyId, family }) {
    if (family !== "solana" && family !== "evm")
      throw new Error("Only Solana and EVM keys can be imported or exported");
    const { privateKey, publicKeyUncompressed } = generateP256KeyPair();
    const bundle = await (
      await client()
    ).exportPrivateKey({
      privateKeyId: turnkeyPrivateKeyId,
      targetPublicKey: publicKeyUncompressed,
      organizationId,
      stampWith: StamperType.Passkey,
    });
    const hex = await decryptExportBundle({
      exportBundle: bundle,
      embeddedKey: privateKey,
      organizationId,
      returnMnemonic: false,
      keyFormat: "HEXADECIMAL",
    });
    return formatExportedKey(hex, family);
  },
  async logOut() {
    // Clears the Turnkey session and deletes its IndexedDB session key.
    await (await client()).logout();
  },
};

/**
 * Initialise the client (and its IndexedDB session key store) before the first passkey
 * prompt, so the WebAuthn call stays close to the user's tap (Safari requires a gesture).
 *
 * @public Loaded with a dynamic import by TurnkeyBridge.web.tsx.
 */
export function prewarm(): Promise<void> {
  return client().then(
    () => undefined,
    () => undefined,
  );
}
