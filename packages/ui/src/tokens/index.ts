export * from "./colors";

/** 4-pt spacing scale. */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;
export type SpacingToken = keyof typeof spacing;

/** Horizontal gutter for every screen. */
export const screenGutter = spacing.xl;

export const radii = {
  xs: 8,
  sm: 10,
  md: 16,
  /** Icon tiles and small controls inside cards. */
  tile: 12,
  card: 24,
  sheet: 28,
  pill: 999,
} as const;

export const sizes = {
  /** Pill buttons. */
  buttonHeight: 56,
  buttonHeightCompact: 44,
  iconButton: 44,
  /** Minimum touch target (Apple HIG / Material). */
  touchTarget: 44,
  searchHeight: 40,
  avatar: 40,
  avatarLarge: 56,
  /** Settings-style leading icon tile. */
  iconTile: 30,
  /** List rows (asset, transaction, settings). */
  rowHeight: 60,
} as const;

/**
 * Font families. Inter is loaded with expo-font; when it is unavailable the
 * ThemeProvider falls back to the platform system font (`undefined`).
 */
export const fontFamilies = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;
export type FontWeightToken = keyof typeof fontFamilies;

export interface TypeStyle {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly weight: FontWeightToken;
  /** Tabular digits so amounts do not jitter while animating. */
  readonly tabular?: boolean;
}

/**
 * Type scale (Inter). Display sizes track tighter (about -0.03 to -0.04 em) the
 * way optical-size display cuts do; text sizes stay near zero tracking so
 * small copy keeps its counters open. Steps are at least ~1.15x apart.
 */
export const typography = {
  balance: { fontSize: 64, lineHeight: 68, letterSpacing: -2.6, weight: "bold", tabular: true },
  display: { fontSize: 40, lineHeight: 44, letterSpacing: -1.4, weight: "bold" },
  title: { fontSize: 34, lineHeight: 40, letterSpacing: -1.1, weight: "bold" },
  headline: { fontSize: 22, lineHeight: 28, letterSpacing: -0.55, weight: "semibold" },
  /** Section headers inside a screen (quieter than headline). */
  section: { fontSize: 20, lineHeight: 26, letterSpacing: -0.45, weight: "semibold" },
  amount: { fontSize: 17, lineHeight: 22, letterSpacing: -0.3, weight: "semibold", tabular: true },
  bodyStrong: { fontSize: 17, lineHeight: 24, letterSpacing: -0.3, weight: "semibold" },
  body: { fontSize: 17, lineHeight: 24, letterSpacing: -0.3, weight: "regular" },
  callout: { fontSize: 15, lineHeight: 21, letterSpacing: -0.15, weight: "regular" },
  calloutStrong: { fontSize: 15, lineHeight: 21, letterSpacing: -0.15, weight: "semibold" },
  label: { fontSize: 14, lineHeight: 18, letterSpacing: -0.1, weight: "medium" },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: -0.05, weight: "regular" },
  caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0, weight: "medium" },
  mono: { fontSize: 14, lineHeight: 20, letterSpacing: 0.1, weight: "regular", tabular: true },
} as const satisfies Record<string, TypeStyle>;
export type TypographyToken = keyof typeof typography;

export const motion = {
  /** Spring for presses and toggles. */
  spring: { damping: 18, stiffness: 240, mass: 0.9 },
  durationFast: 140,
  durationBase: 220,
  durationSlow: 420,
  /** Press-and-hold to approve. */
  approveHoldMs: 900,
  /** Press-and-hold to peek at a hidden balance. */
  peekHoldMs: 220,
  pressedScale: 0.97,
  /** Rows and large cards scale less than buttons. */
  pressedScaleSubtle: 0.985,
  /** Strong ease-out for entrances (cubic-bezier(0.23, 1, 0.32, 1)). */
  easeOut: [0.23, 1, 0.32, 1] as const,
  /** iOS-like sheet curve (cubic-bezier(0.32, 0.72, 0, 1)). */
  easeSheet: [0.32, 0.72, 0, 1] as const,
} as const;
