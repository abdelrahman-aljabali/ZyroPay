import type { ReactNode } from "react";
import { reportFramedPasskeyError } from "../embed-runtime";
import { SignerContext, type PasskeySigner } from "./signer";
import type * as WebSigner from "./web-signer";

/*
 * Web signer provider: a thin, lazily loading stand-in for web-signer.ts.
 *
 * The real implementation (@turnkey/core, which pulls in viem, ethers and WalletConnect) is
 * loaded with a dynamic import, which Metro's web export splits into its own chunk. The
 * first page (welcome, sign-in) therefore never downloads or parses it.
 *
 * Loading starts:
 *  - when a screen that can sign mounts (`useSigner()` calls `preload()`), so the chunk and
 *    the Turnkey client are ready before the user taps (Safari wants WebAuthn close to the
 *    tap's user activation);
 *  - at the latest on the first signer call, which awaits it.
 */

type WebSignerModule = typeof WebSigner;

let loading: Promise<WebSignerModule> | null = null;

function load(): Promise<WebSignerModule> {
  loading ??= import("./web-signer").catch((error: unknown) => {
    loading = null; // a flaky network must not break signing for the rest of the session
    throw error;
  });
  return loading;
}

type AsyncMethods = {
  [
    K in keyof PasskeySigner as PasskeySigner[K] extends (...args: never[]) => Promise<unknown>
      ? K
      : never
  ]: PasskeySigner[K];
};

function forward<K extends keyof AsyncMethods>(name: K): AsyncMethods[K] {
  const fn = async (...args: unknown[]) => {
    const { webSigner } = await load();
    const target = webSigner[name] as (...a: unknown[]) => Promise<unknown>;
    try {
      return await target.apply(webSigner, args);
    } catch (error) {
      // Inside the landing page's iframe the browser may refuse the passkey prompt.
      reportFramedPasskeyError(error);
      throw error;
    }
  };
  return fn as unknown as AsyncMethods[K];
}

const lazySigner: PasskeySigner = {
  kind: "turnkey",
  unavailableReason: null,
  importUnavailableReason: null,
  preload() {
    void load()
      .then((m) => m.prewarm())
      .catch(() => undefined);
  },
  signUp: forward("signUp"),
  logIn: forward("logIn"),
  stampSignTransaction: forward("stampSignTransaction"),
  stampSignRawPayload: forward("stampSignRawPayload"),
  addCardanoAccount: forward("addCardanoAccount"),
  exportRecoveryPhrase: forward("exportRecoveryPhrase"),
  createDelegatedUser: forward("createDelegatedUser"),
  removeStaleDelegatedAccess: forward("removeStaleDelegatedAccess"),
  stampCreatePolicies: forward("stampCreatePolicies"),
  createWallet: forward("createWallet"),
  importWallet: forward("importWallet"),
  importPrivateKey: forward("importPrivateKey"),
  exportPrivateKey: forward("exportPrivateKey"),
  logOut: forward("logOut"),
};

export default function TurnkeyBridge({ children }: { readonly children: ReactNode }) {
  return <SignerContext.Provider value={lazySigner}>{children}</SignerContext.Provider>;
}
