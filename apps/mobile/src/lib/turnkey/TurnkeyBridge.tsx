import {
  StamperType,
  TurnkeyProvider,
  useTurnkey,
  type TurnkeyProviderConfig,
} from "@turnkey/react-native-wallet-kit";
import { CARDANO_TURNKEY_ACCOUNT, type StampedTurnkeyRequest } from "@zyropay/shared";
import { formatExportedKey } from "@/lib/import/private-key";
import { useMemo, type ReactNode } from "react";
import { env } from "@/lib/env";
import {
  SignerContext,
  turnkeySignBody,
  turnkeySignRawPayloadBody,
  unsignedHex,
  turnkeyTransactionType,
  walletAccountParams,
  type PasskeySigner,
} from "./signer";
import {
  DEFAULT_WALLET,
  DELEGATED_USER_NAME,
  delegatedAccessHttp,
  privateKeyImportParams,
  removeStaleDelegatedAccess,
  reportedAccounts,
  requirePasskeyStamp,
  toStamped,
  turnkeyName,
} from "./bridge-common";

/*
 * Real Turnkey integration (ADR-001). This module imports native code
 * (react-native-passkey, device-info, in-app browser), so it is only required
 * in development/production builds, never in Expo Go (see ./index.tsx).
 */

const config: TurnkeyProviderConfig = {
  organizationId: env.turnkey.organizationId,
  authProxyConfigId: env.turnkey.authProxyConfigId,
  apiBaseUrl: env.turnkey.apiBaseUrl,
  passkeyConfig: { rpId: env.turnkey.rpId, rpName: env.turnkey.rpName },
  // Reads use the device session key; every signature forces StamperType.Passkey below.
  defaultStamperType: StamperType.ApiKey,
  autoRefreshManagedState: true,
  auth: {
    passkey: true,
    otp: { email: false, sms: false },
    autoRefreshSession: true,
    createSuborgParams: {
      // ADR-001 D1: the passkey is the sub-org's only root (accounts: bridge-common.ts).
      passkeyAuth: {
        customWallet: {
          walletName: DEFAULT_WALLET.walletName,
          walletAccounts: DEFAULT_WALLET.walletAccounts.map((a) => ({ ...a })),
        },
      },
    },
  },
};

function Bridge({ children }: { readonly children: ReactNode }) {
  const tk = useTurnkey();

  const signer = useMemo<PasskeySigner>(() => {
    const whoami = async (): Promise<StampedTurnkeyRequest> => {
      const client = tk.httpClient;
      if (!client) throw new Error("Turnkey client is not ready");
      // Read-only query: a session-key stamp (X-Stamp) is acceptable per ADR-001 D2.
      return toStamped(await client.stampGetWhoami({}, StamperType.ApiKey));
    };
    return {
      kind: "turnkey",
      unavailableReason: null,
      async signUp({ displayName }) {
        await tk.signUpWithPasskey({ passkeyDisplayName: displayName });
        return whoami();
      },
      async logIn() {
        await tk.loginWithPasskey();
        return whoami();
      },
      async stampSignTransaction(input) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        const body = turnkeySignBody(input, String(Date.now()));
        // ADR-001 D2: force the passkey for every user-approved signature.
        const signed = await client.stampSignTransaction(
          {
            organizationId: input.organizationId,
            signWith: input.signWith,
            unsignedTransaction: unsignedHex(input.unsignedTransaction),
            type: turnkeyTransactionType(input.network),
            timestampMs: body.timestampMs,
          },
          StamperType.Passkey,
        );
        return requirePasskeyStamp(toStamped(signed));
      },
      async stampSignRawPayload(input) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        const body = turnkeySignRawPayloadBody(input, String(Date.now()));
        // Cardano body hash (ADR-002) or x402 EIP-712 digest; passkey only.
        const signed = await client.stampSignRawPayload(
          {
            organizationId: input.organizationId,
            signWith: body.parameters.signWith,
            payload: body.parameters.payload,
            encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
            hashFunction: body.parameters.hashFunction,
            timestampMs: body.timestampMs,
          },
          StamperType.Passkey,
        );
        return requirePasskeyStamp(toStamped(signed));
      },
      async addCardanoAccount({ organizationId, turnkeyWalletId }) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        // The user's own passkey adds the key to their sub-org; ZyroPay cannot (ADR-001 D1).
        await client.createWalletAccounts(
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
        // ADR-001 D6 (Turnkey "delegated access, frontend"): the end user's own passkey
        // creates the non-root API-key user. It starts with no permissions at all.
        const user = await tk.fetchOrCreateP256ApiKeyUser({
          publicKey,
          organizationId,
          createParams: { userName: DELEGATED_USER_NAME, apiKeyName: DELEGATED_USER_NAME },
          stampWith: StamperType.Passkey,
        });
        return user.userId;
      },
      async removeStaleDelegatedAccess(input) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        return removeStaleDelegatedAccess(delegatedAccessHttp(client, StamperType.Passkey), input);
      },
      async stampCreatePolicies({ organizationId, policies }) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        // Stamp only: the API verifies the envelope (consensus bound to the delegated user)
        // and forwards these exact bytes to Turnkey.
        const signed = await client.stampCreatePolicies(
          {
            organizationId,
            timestampMs: String(Date.now()),
            policies: policies.map((p) => ({ ...p })),
          },
          StamperType.Passkey,
        );
        return requirePasskeyStamp(toStamped(signed), "The policy envelope");
      },
      async exportRecoveryPhrase({ turnkeyWalletId, organizationId }) {
        // The kit generates an ephemeral P-256 key, exports to it and decrypts on device.
        return tk.exportWallet({
          walletId: turnkeyWalletId,
          organizationId,
          stampWith: StamperType.Passkey,
        });
      },
      async createWallet({ organizationId, name, family }) {
        // ADR-001: a new wallet is created by the user's passkey in the user's own
        // sub-organization; the API only registers the id after re-reading Turnkey.
        return tk.createWallet({
          walletName: name,
          accounts: [walletAccountParams(family)],
          organizationId,
          stampWith: StamperType.Passkey,
        });
      },
      importUnavailableReason: null,
      async importWallet({ organizationId, name, mnemonic, families }) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        // ADR-003: Wallet Kit 2.3 runs INIT_IMPORT_WALLET, verifies the enclave-signed import
        // bundle and HPKE-encrypts the phrase to it ON THE DEVICE (@turnkey/crypto
        // encryptWalletToBundle), then submits IMPORT_WALLET. Both are stamped with the
        // passkey; only the ciphertext leaves the device, and only to Turnkey.
        const walletId = await tk.importWallet({
          mnemonic,
          walletName: turnkeyName(name),
          accounts: families.map((f) => walletAccountParams(f)),
          organizationId,
          stampWith: StamperType.Passkey,
        });
        // Read-only query (session key is fine per ADR-001 D2): what Turnkey derived.
        const res = await client.getWalletAccounts(
          { organizationId, walletId },
          StamperType.ApiKey,
        );
        return { turnkeyWalletId: walletId, accounts: reportedAccounts(res.accounts) };
      },
      async importPrivateKey({ organizationId, name, privateKey, family }) {
        const client = tk.httpClient;
        if (!client) throw new Error("Turnkey client is not ready");
        // ADR-003: INIT_IMPORT_PRIVATE_KEY -> encryptPrivateKeyToBundle (on device) ->
        // IMPORT_PRIVATE_KEY, passkey-stamped.
        const privateKeyId = await tk.importPrivateKey({
          privateKey,
          privateKeyName: turnkeyName(name),
          ...privateKeyImportParams(family),
          addressFormats: [...privateKeyImportParams(family).addressFormats],
          organizationId,
          stampWith: StamperType.Passkey,
        });
        const res = await client.getPrivateKey(
          { organizationId, privateKeyId },
          StamperType.ApiKey,
        );
        return {
          turnkeyWalletId: privateKeyId,
          accounts: reportedAccounts(res.privateKey.addresses),
        };
      },
      async exportPrivateKey({ organizationId, turnkeyPrivateKeyId, family }) {
        if (family !== "solana" && family !== "evm")
          throw new Error("Only Solana and EVM keys can be imported or exported");
        const hex = await tk.exportPrivateKey({
          privateKeyId: turnkeyPrivateKeyId,
          organizationId,
          stampWith: StamperType.Passkey,
        });
        return formatExportedKey(hex, family);
      },
      async logOut() {
        await tk.logout();
      },
    };
  }, [tk]);

  return <SignerContext.Provider value={signer}>{children}</SignerContext.Provider>;
}

export default function TurnkeyBridge({ children }: { readonly children: ReactNode }) {
  return (
    <TurnkeyProvider config={config}>
      <Bridge>{children}</Bridge>
    </TurnkeyProvider>
  );
}
