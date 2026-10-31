import { useEffect } from "react";
import { Appearance } from "react-native";
import type { ColorScheme, ThemePreference } from "@zyropay/ui";

/**
 * Native: pins the app's own appearance (system tab bar, alerts, keyboard, date pickers) to
 * the in-app choice, so a light ZyroPay never shows a dark native tab bar on a phone set
 * to dark. "System" hands control back to the OS ("unspecified"), and the theme then
 * follows it live through useColorScheme.
 */
export function useApplyColorScheme(preference: ThemePreference, _scheme: ColorScheme): void {
  useEffect(() => {
    Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
  }, [preference]);
}
