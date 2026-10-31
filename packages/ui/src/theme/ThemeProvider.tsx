import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, useColorScheme, type TextStyle } from "react-native";
import {
  colorsFor,
  fontFamilies,
  typography,
  type ColorScheme,
  type ColorTokens,
  type FontWeightToken,
  type TypographyToken,
} from "../tokens";

export type ThemePreference = "system" | "light" | "dark";

export interface Theme {
  readonly scheme: ColorScheme;
  readonly preference: ThemePreference;
  readonly colors: ColorTokens;
  /** True when the OS asks for reduced motion; components skip non-essential animation. */
  readonly reducedMotion: boolean;
  /** Text style for a typography token, with Inter or the system fallback applied. */
  readonly type: (token: TypographyToken) => TextStyle;
  readonly fontFamily: (weight: FontWeightToken) => string | undefined;
}

const SYSTEM_WEIGHTS: Readonly<Record<FontWeightToken, TextStyle["fontWeight"]>> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};

function buildTheme(
  scheme: ColorScheme,
  preference: ThemePreference,
  reducedMotion: boolean,
  fontsLoaded: boolean,
): Theme {
  const fontFamily = (weight: FontWeightToken): string | undefined =>
    fontsLoaded ? fontFamilies[weight] : undefined;
  const cache = new Map<TypographyToken, TextStyle>();
  const type = (token: TypographyToken): TextStyle => {
    const cached = cache.get(token);
    if (cached) return cached;
    const spec = typography[token];
    const family = fontFamily(spec.weight);
    const style: TextStyle = {
      fontSize: spec.fontSize,
      lineHeight: spec.lineHeight,
      letterSpacing: spec.letterSpacing,
      // With Inter loaded the family encodes the weight; system fonts need fontWeight.
      ...(family === undefined
        ? { fontWeight: SYSTEM_WEIGHTS[spec.weight] }
        : { fontFamily: family }),
      ...("tabular" in spec ? { fontVariant: ["tabular-nums"] } : {}),
    };
    cache.set(token, style);
    return style;
  };
  return { scheme, preference, colors: colorsFor(scheme), reducedMotion, type, fontFamily };
}

const ThemeContext = createContext<Theme>(buildTheme("light", "light", false, false));

export interface ThemeProviderProps {
  /** Light unless the user picked Dark or System (ZyroPay does not follow the OS by default). */
  readonly preference?: ThemePreference;
  /** Whether the Inter font files finished loading; otherwise the system font is used. */
  readonly fontsLoaded?: boolean;
  readonly children: ReactNode;
}

export function ThemeProvider({
  preference = "light",
  fontsLoaded = false,
  children,
}: ThemeProviderProps) {
  const system = useColorScheme();
  const reducedMotion = useReducedMotionSetting();
  const scheme: ColorScheme =
    preference === "system" ? (system === "dark" ? "dark" : "light") : preference;
  const theme = useMemo(
    () => buildTheme(scheme, preference, reducedMotion, fontsLoaded),
    [scheme, preference, reducedMotion, fontsLoaded],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Follows the OS "Reduce Motion" setting live. */
export function useReducedMotionSetting(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
