// Must load first: Turnkey key generation needs crypto.getRandomValues on Hermes.
import "react-native-get-random-values";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { EmptyState, ThemeProvider, useTheme } from "@zyropay/ui";
import { isApiError } from "@/api";
import { AppEffects } from "@/components/AppEffects";
import { SimulatedBanner } from "@/components/SimulatedBanner";
import { WebFrame } from "@/components/WebFrame";
import { env } from "@/lib/env";
import { useApplyColorScheme } from "@/lib/color-scheme";
import { useAppFonts } from "@/lib/fonts";
import { initMonitoring } from "@/lib/monitoring";
import { SignerProvider } from "@/lib/turnkey";
import { prefsStore, sessionStore, usePrefs, useSession } from "@/state";

initMonitoring();
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        !isApiError(error, "UNAUTHENTICATED") &&
        !isApiError(error, "INVALID_RESPONSE") &&
        count < 2,
      staleTime: 15_000,
    },
  },
});

// Refetch on app foreground (TanStack's focus concept for React Native).
AppState.addEventListener("change", (status) => {
  if (Platform.OS !== "web") focusManager.setFocused(status === "active");
});

function usePrefsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => prefsStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    const unsub = prefsStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    setHydrated(prefsStore.persist.hasHydrated());
    return unsub;
  }, [hydrated]);
  return hydrated;
}

function RootNavigator() {
  const theme = useTheme();
  const status = useSession((s) => s.status);
  const onboardingComplete = usePrefs((s) => s.onboardingComplete);
  const signedIn = status === "signedIn";
  const inApp = signedIn && onboardingComplete;
  const navTheme = theme.scheme === "dark" ? DarkTheme : DefaultTheme;

  return (
    <NavThemeProvider
      value={{
        ...navTheme,
        colors: {
          ...navTheme.colors,
          background: theme.colors.background,
          card: theme.colors.background,
          text: theme.colors.text,
          primary: theme.colors.text,
          border: theme.colors.border,
        },
      }}
    >
      <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <SimulatedBanner />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.background },
          }}
        >
          <Stack.Protected guard={inApp}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="send" options={{ presentation: "modal" }} />
            <Stack.Screen name="topup" options={{ presentation: "modal" }} />
            <Stack.Screen name="plugins" />
          </Stack.Protected>
          <Stack.Protected guard={!inApp}>
            <Stack.Screen name="onboarding" />
          </Stack.Protected>
        </Stack>
        {inApp ? <AppEffects /> : null}
      </View>
    </NavThemeProvider>
  );
}

/** Applies the resolved theme outside React: native appearance, or the web document. */
function ColorSchemeSync() {
  const { preference, scheme } = useTheme();
  useApplyColorScheme(preference, scheme);
  return null;
}

function ThemedApp({ fontsReady }: { readonly fontsReady: boolean }) {
  const preference = usePrefs((s) => s.theme);
  return (
    <ThemeProvider preference={preference} fontsLoaded={fontsReady}>
      <ColorSchemeSync />
      <WebFrame>
        <SignerProvider>{env.mocksRefused ? <MocksRefused /> : <RootNavigator />}</SignerProvider>
      </WebFrame>
    </ThemeProvider>
  );
}

function MocksRefused() {
  const { colors } = useTheme();
  return (
    <View
      style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: colors.background }}
    >
      <EmptyState
        icon="warning"
        title="Simulated data is disabled in production"
        message="This build sets EXPO_PUBLIC_USE_MOCKS=1 with EXPO_PUBLIC_ZYROPAY_MODE=production. Mock data is never allowed next to real funds. Rebuild without mocks."
      />
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useAppFonts();
  const prefsHydrated = usePrefsHydrated();
  const sessionStatus = useSession((s) => s.status);

  useEffect(() => {
    void sessionStore.getState().hydrate();
  }, []);

  const fontsSettled = fontsLoaded || fontError !== null;
  const ready = fontsSettled && prefsHydrated && sessionStatus !== "loading";

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemedApp fontsReady={fontsLoaded} />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
