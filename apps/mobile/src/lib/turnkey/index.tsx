import Constants, { ExecutionEnvironment } from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { ComponentType, ReactNode } from "react";
import { env, isTurnkeyConfigured } from "@/lib/env";
import {
  devMockTurnkeySigner,
  SignerContext,
  simulatedSigner,
  unavailableSigner,
  type PasskeySigner,
} from "./signer";

export * from "./signer";

/** True inside the Expo Go client, which lacks the passkey/Turnkey native modules. */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** ADR-003: shown on the import screen in Expo Go (no passkey module, no Turnkey import). */
export const EXPO_GO_IMPORT_REASON =
  "Import needs the ZyroPay app build (not available in Expo Go). Expo Go has no passkey module, so it can't encrypt your phrase to Turnkey and sign the import.";

type Choice =
  { readonly kind: "turnkey" } | { readonly kind: "static"; readonly signer: PasskeySigner };

const DEV_CREDENTIAL_KEY = "zyropay.devPasskeyCredential";

/** Stable per-install `dev-*` credential for the local MockTurnkey (development only). */
async function devCredential(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEV_CREDENTIAL_KEY);
  if (existing !== null && existing.startsWith("dev-")) return existing;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const id = `dev-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  await SecureStore.setItemAsync(DEV_CREDENTIAL_KEY, id);
  return id;
}

function choose(): Choice {
  if (env.mocksActive) return { kind: "static", signer: simulatedSigner() };
  if (Platform.OS === "web") return chooseWeb();
  if (isTurnkeyConfigured() && !isExpoGo) return { kind: "turnkey" };
  if (env.devMockPasskey)
    return {
      kind: "static",
      signer: devMockTurnkeySigner(devCredential, env.turnkey.apiBaseUrl),
    };
  if (!isTurnkeyConfigured()) {
    return {
      kind: "static",
      signer: unavailableSigner(
        "Turnkey is not configured. Set EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID, EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID and EXPO_PUBLIC_PASSKEY_RP_ID.",
      ),
    };
  }
  if (isExpoGo) {
    return {
      kind: "static",
      signer: unavailableSigner(
        "Passkeys need a development build. Expo Go does not include the passkey module.",
        EXPO_GO_IMPORT_REASON,
      ),
    };
  }
  return { kind: "turnkey" };
}

/** Web (PWA): real Turnkey through @turnkey/core (TurnkeyBridge.web.tsx), browser passkeys. */
function chooseWeb(): Choice {
  if (!isTurnkeyConfigured())
    return {
      kind: "static",
      signer: unavailableSigner(
        "Turnkey is not configured for the web. Set EXPO_PUBLIC_TURNKEY_ORGANIZATION_ID, EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID and EXPO_PUBLIC_PASSKEY_RP_ID (the site's host, e.g. localhost).",
      ),
    };
  if (!browserSupportsPasskeys())
    return {
      kind: "static",
      signer: unavailableSigner(
        "This browser can't use passkeys here. Open ZyroPay over https (or http://localhost) in a current browser.",
      ),
    };
  return { kind: "turnkey" };
}

/** WebAuthn needs a secure context (https or http://localhost) and PublicKeyCredential. */
function browserSupportsPasskeys(): boolean {
  if (typeof window === "undefined") return true; // static render: decided in the browser
  return window.isSecureContext && typeof window.PublicKeyCredential === "function";
}

const choice = choose();

/** Provides the PasskeySigner. The Turnkey module is only loaded when it can actually run. */
export function SignerProvider({ children }: { readonly children: ReactNode }) {
  if (choice.kind === "static")
    return <SignerContext.Provider value={choice.signer}>{children}</SignerContext.Provider>;
  // Lazy require: importing the Wallet Kit in Expo Go would crash on missing native modules.
  // Metro resolves TurnkeyBridge.web.tsx (@turnkey/core) for the web build.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Bridge = (require("./TurnkeyBridge") as { default: ComponentType<{ children: ReactNode }> })
    .default;
  return <Bridge>{children}</Bridge>;
}

export const signerKind = choice.kind === "turnkey" ? "turnkey" : choice.signer.kind;
