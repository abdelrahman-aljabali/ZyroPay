import type { KnownPluginId } from "@zyropay/shared";
import { Platform, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { Icon, type IconName } from "../icons/Icon";
import { PressableScale } from "../components/primitives";
import { BrandMark, type BrandBackground } from "./BrandMark";
import type { BrandSvgKey } from "./svgs.generated";

/*
 * Official plugin logos, shown nominatively to identify the integration (never
 * as an endorsement). Per-brand provenance and the rules behind each entry are in
 * docs/BRAND_ASSETS.md; anything not listed here keeps the neutral category icon.
 */

interface PluginBrand {
  /** The brand's own variant for each background. `null`: none for that background, so it sits on a white plate. */
  readonly marks: Readonly<Record<BrandBackground, BrandSvgKey | null>>;
  /** Clear space kept on each side, as a fraction of the tile. */
  readonly clearSpace: number;
  /**
   * "identify": may sit anywhere the plugin is named.
   * "homepage-link": the owner's policy only allows the logo as a link to the
   * project's home page (LF Projects trademark policy, x402), so it shows only
   * where the tile opens that page; elsewhere the neutral icon is used.
   */
  readonly use: "identify" | "homepage-link";
}

const PLUGIN_BRANDS: Readonly<Partial<Record<KnownPluginId, PluginBrand>>> = {
  jupiter: {
    marks: { light: "jupiter-on-light", dark: "jupiter-on-dark" },
    clearSpace: 0.2,
    use: "identify",
  },
  kamino: {
    marks: { light: "kamino-on-light", dark: "kamino-on-dark" },
    clearSpace: 0.24,
    use: "identify",
  },
  aave: {
    marks: { light: "aave-on-light", dark: "aave-on-dark" },
    clearSpace: 0.2,
    use: "identify",
  },
  hyperliquid: {
    marks: { light: "hyperliquid-on-light", dark: "hyperliquid-on-dark" },
    clearSpace: 0.14,
    use: "identify",
  },
  x402: {
    marks: { light: "x402-on-light", dark: null },
    clearSpace: 0.16,
    use: "homepage-link",
  },
};

function brandFor(pluginId: string): PluginBrand | undefined {
  return (PLUGIN_BRANDS as Readonly<Record<string, PluginBrand | undefined>>)[pluginId];
}

/** True when this plugin shows its official logo in the given context. */
export function hasPluginLogo(pluginId: string, asHomepageLink = false): boolean {
  const brand = brandFor(pluginId);
  return brand !== undefined && (brand.use === "identify" || asHomepageLink);
}

const hidden =
  Platform.OS === "web"
    ? { "aria-hidden": true as const }
    : {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants" as const,
      };

export interface PluginLogoProps {
  readonly pluginId: string;
  readonly size?: number;
  /** Neutral icon for plugins without a usable official logo. */
  readonly fallbackIcon?: IconName;
  /**
   * Makes the tile a link to the plugin's home page (pass the opener). Required
   * for marks whose owner only allows the logo as a home-page link.
   */
  readonly onOpenHomepage?: () => void;
  /** Accessible name of the home-page link, e.g. "Jupiter website". */
  readonly homepageLabel?: string;
  readonly testID?: string;
}

/**
 * A plugin's logo tile. The mark keeps its clear space inside the tile and uses
 * the variant its brand provides for the tile colour (light tile in light mode,
 * dark tile in dark mode); a mark with no dark-background variant stays on a
 * white plate instead of being recoloured.
 */
export function PluginLogo({
  pluginId,
  size = 44,
  fallbackIcon = "plug",
  onOpenHomepage,
  homepageLabel,
  testID,
}: PluginLogoProps) {
  const { colors, scheme } = useTheme();
  const brand = brandFor(pluginId);
  const usable = brand !== undefined && (brand.use === "identify" || onOpenHomepage !== undefined);
  const wanted: BrandBackground = scheme === "dark" ? "dark" : "light";
  const svg = usable ? (brand.marks[wanted] ?? brand.marks.light) : null;
  const onPlate = usable && brand.marks[wanted] === null;
  const radius = Math.round(size * 0.3);

  const tile = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: onPlate ? "#FFFFFF" : colors.surfaceRaised,
        borderWidth: scheme === "dark" ? 0 : 1,
        borderColor: colors.border,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      {...hidden}
    >
      {usable && svg ? (
        <BrandMark svg={svg} box={size * (1 - 2 * brand.clearSpace)} />
      ) : (
        <Icon name={fallbackIcon} size={Math.round(size * 0.48)} color={colors.text} />
      )}
    </View>
  );

  if (!onOpenHomepage) return <View testID={testID}>{tile}</View>;
  return (
    <PressableScale
      onPress={onOpenHomepage}
      accessibilityRole="link"
      accessibilityLabel={homepageLabel ?? "Website"}
      testID={testID}
    >
      {tile}
    </PressableScale>
  );
}
