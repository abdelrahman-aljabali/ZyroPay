import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { useFonts } from "expo-font";

/**
 * Native: load the Inter TTFs through expo-font. The web build uses fonts.web.ts instead
 * (subset WOFF2 files declared and preloaded in public/index.html).
 */
export function useAppFonts(): readonly [loaded: boolean, error: Error | null] {
  return useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
}
