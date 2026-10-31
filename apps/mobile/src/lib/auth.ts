import type { QueryClient } from "@tanstack/react-query";
import { apiClient } from "@/api";
import { env } from "@/lib/env";
import type { PasskeySigner } from "@/lib/turnkey";
import { sessionStore } from "@/state";

/*
 * Sign-up / login (ARCHITECTURE §2.1): the passkey creates or unlocks the
 * Turnkey sub-org, the app stamps `get_whoami`, and the API turns that stamped
 * request into a ZyroPay session. No ZyroPay system ever sees the passkey.
 */

export async function authenticate(
  signer: PasskeySigner,
  mode: "signUp" | "logIn",
  displayName?: string,
) {
  const whoamiRequest =
    mode === "signUp"
      ? await signer.signUp({ displayName: displayName ?? "ZyroPay" })
      : await signer.logIn();
  const res = await apiClient.call("createSession", {
    body: { whoamiRequest, ...(displayName ? { displayName } : {}) },
  });
  await sessionStore
    .getState()
    .signIn({ ...res.session, user: res.user, simulated: env.mocksActive });
  return res;
}

export async function signOut(signer: PasskeySigner, queryClient: QueryClient): Promise<void> {
  try {
    await apiClient.call("deleteSession", {});
  } catch {
    // Best effort: the local session is cleared regardless.
  }
  await signer.logOut().catch(() => undefined);
  await sessionStore.getState().signOut();
  queryClient.clear();
}
