import { networksForMode, type NetworkId, type ZyroPayMode } from "@zyropay/shared";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

/*
 * Non-secret device preferences, persisted to a key-value store
 * (expo-sqlite/kv-store in the app, in-memory in tests).
 */

export type ThemePreference = "system" | "light" | "dark";

export interface PrefsData {
  readonly theme: ThemePreference;
  readonly currency: string;
  readonly hideBalances: boolean;
  /** Default network for send/receive; always within the build's mode. */
  readonly preferredNetwork: NetworkId | null;
  readonly onboardingComplete: boolean;
  readonly notificationsPrompted: boolean;
  readonly analyticsOptIn: boolean;
}

export interface PrefsState extends PrefsData {
  setTheme: (theme: ThemePreference) => void;
  setCurrency: (currency: string) => void;
  toggleHideBalances: () => void;
  setPreferredNetwork: (network: NetworkId | null) => void;
  completeOnboarding: () => void;
  setNotificationsPrompted: () => void;
  setAnalyticsOptIn: (value: boolean) => void;
  reset: () => void;
}

/**
 * ZyroPay opens in light mode on a fresh install, whatever the OS setting. Dark and
 * "System" (follow the OS) stay one tap away in Settings > Appearance, and the choice is
 * persisted.
 */
const DEFAULT_PREFS: PrefsData = {
  theme: "light",
  currency: "USD",
  hideBalances: false,
  preferredNetwork: null,
  onboardingComplete: false,
  notificationsPrompted: false,
  analyticsOptIn: false,
};

export function createPrefsStore(storage: StateStorage, mode: ZyroPayMode) {
  const allowed = networksForMode(mode);
  return createStore<PrefsState>()(
    persist(
      (set) => ({
        ...DEFAULT_PREFS,
        setTheme: (theme) => {
          set({ theme });
        },
        setCurrency: (currency) => {
          set({ currency });
        },
        toggleHideBalances: () => {
          set((s) => ({ hideBalances: !s.hideBalances }));
        },
        setPreferredNetwork: (network) => {
          // Strict mainnet/testnet separation: a network outside this build's mode is refused.
          if (network !== null && !allowed.includes(network)) return;
          set({ preferredNetwork: network });
        },
        completeOnboarding: () => {
          set({ onboardingComplete: true });
        },
        setNotificationsPrompted: () => {
          set({ notificationsPrompted: true });
        },
        setAnalyticsOptIn: (value) => {
          set({ analyticsOptIn: value });
        },
        reset: () => {
          set({ ...DEFAULT_PREFS });
        },
      }),
      {
        name: "zyropay.prefs.v1",
        storage: createJSONStorage(() => storage),
        // v2: light became the default. v1 stored the old default "system" for everyone who
        // never opened Appearance, so a v1 "system" is read as "light"; light and dark were
        // explicit choices and are kept. v3: the never-used `hiddenWalletIds` is dropped.
        version: 3,
        migrate: (persisted, version) => {
          const { hiddenWalletIds: _dropped, ...p } = (persisted ?? {}) as Partial<PrefsData> & {
            hiddenWalletIds?: unknown;
          };
          if (version < 2 && p.theme === "system") return { ...p, theme: "light" };
          return p;
        },
        partialize: (s): PrefsData => ({
          theme: s.theme,
          currency: s.currency,
          hideBalances: s.hideBalances,
          preferredNetwork: s.preferredNetwork,
          onboardingComplete: s.onboardingComplete,
          notificationsPrompted: s.notificationsPrompted,
          analyticsOptIn: s.analyticsOptIn,
        }),
        // Never rehydrate a network from the other side of the mainnet/testnet divide.
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<PrefsData>;
          const preferredNetwork =
            p.preferredNetwork != null && allowed.includes(p.preferredNetwork)
              ? p.preferredNetwork
              : null;
          return { ...current, ...p, preferredNetwork };
        },
      },
    ),
  );
}
