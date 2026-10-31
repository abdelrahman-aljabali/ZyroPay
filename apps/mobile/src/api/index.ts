import { env } from "@/lib/env";
import { sessionStore } from "@/state";
import { ApiClient, fetchTransport, type Transport } from "./client";
import { mockTransport } from "./mock/transport";

/*
 * The app's single API client. In DEV mock mode (EXPO_PUBLIC_USE_MOCKS=1, never
 * production) requests go to the simulated transport; otherwise to
 * EXPO_PUBLIC_API_URL. The client and its validation are identical in both.
 */

const transport: Transport = env.mocksActive ? mockTransport() : fetchTransport(env.apiUrl);

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const current = sessionStore.getState().session;
  if (current === null) return false;
  try {
    const res = await bare.call("refreshSession", { body: { refreshToken: current.refreshToken } });
    await sessionStore.getState().updateTokens(res.session);
    return true;
  } catch {
    await sessionStore.getState().signOut();
    return false;
  }
}

/** Client without refresh logic (used by refresh itself, to avoid recursion). */
const bare = new ApiClient({
  transport,
  getAccessToken: () => sessionStore.getState().session?.accessToken ?? null,
});

export const apiClient = new ApiClient({
  transport,
  getAccessToken: () => sessionStore.getState().session?.accessToken ?? null,
  refresh: () => {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },
});

export { errorMessage, isApiError, withSessionHint } from "./client";
