/**
 * ZyroPay colour tokens. Monochrome by design: black/white surfaces, one gray
 * elevation step, semantic green/red only for money direction and risk.
 * No gradients anywhere in the system.
 */
export interface ColorTokens {
  readonly background: string;
  readonly surface: string;
  /** Pressed / selected surface, one step from `surface`. */
  readonly surfaceStrong: string;
  readonly text: string;
  readonly textSecondary: string;
  /** Hairline separators and input borders. */
  readonly border: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly success: string;
  readonly danger: string;
  /** `danger` for small text on a `surface` card: keeps 4.5:1 there (light `danger` is 4.3:1). */
  readonly dangerText: string;
  /** Low-emphasis tints behind success/danger content. */
  readonly successSoft: string;
  readonly dangerSoft: string;
  /** Amber is reserved for testnet and "simulated data" labels. */
  readonly caution: string;
  readonly cautionSoft: string;
  readonly skeleton: string;
  /** Separators between rows inside a surface card (one step darker than surface). */
  readonly separator: string;
  /** Controls and tiles sitting on a surface card (one step lighter than surface). */
  readonly surfaceRaised: string;
  readonly scrim: string;
}

export const lightColors: ColorTokens = {
  background: "#FFFFFF",
  surface: "#F2F2F2",
  surfaceStrong: "#E5E5E7",
  text: "#111111",
  textSecondary: "#6E6E73",
  border: "#E3E3E6",
  primary: "#111111",
  onPrimary: "#FFFFFF",
  success: "#127548",
  danger: "#D93025",
  dangerText: "#C5221F",
  successSoft: "#E7F4EE",
  dangerSoft: "#FCEAE9",
  caution: "#8A5800",
  cautionSoft: "#FFF4DC",
  skeleton: "#ECECEE",
  separator: "#DEDEE2",
  surfaceRaised: "#FFFFFF",
  scrim: "rgba(0,0,0,0.32)",
};

export const darkColors: ColorTokens = {
  background: "#000000",
  surface: "#1C1C1E",
  surfaceStrong: "#2C2C2E",
  text: "#FFFFFF",
  textSecondary: "#8E8E93",
  border: "#2C2C2E",
  primary: "#FFFFFF",
  onPrimary: "#000000",
  success: "#30D158",
  danger: "#FF453A",
  dangerText: "#FF453A",
  successSoft: "#0F2A1A",
  dangerSoft: "#33110F",
  caution: "#FFC145",
  cautionSoft: "#2E2410",
  skeleton: "#242426",
  separator: "#323235",
  surfaceRaised: "#2C2C2E",
  scrim: "rgba(0,0,0,0.6)",
};

export type ColorScheme = "light" | "dark";

export function colorsFor(scheme: ColorScheme): ColorTokens {
  return scheme === "dark" ? darkColors : lightColors;
}
