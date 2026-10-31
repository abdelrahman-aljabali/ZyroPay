import { getNetwork, type Asset, type NetworkId } from "@zyropay/shared";
import { Image, Platform, StyleSheet, View } from "react-native";
import { BrandMark, type BrandBackground } from "../brand/BrandMark";
import type { BrandSvgKey } from "../brand/svgs.generated";
import { useTheme } from "../theme/ThemeProvider";
import { radii } from "../tokens";
import { Text } from "../components/primitives";

/*
 * Official marks for the assets and chains ZyroPay supports, bundled as vectors
 * (crisp at any size, no network fetch). Each is the brand's own file, uniformly
 * scaled on a plain round plate and never recoloured; sources and rules are in
 * docs/BRAND_ASSETS.md. A brand without a usable official mark (USDC: Circle's
 * Brand Use Policy bars commercial use), a new chain added to the shared
 * registry or an unlisted token falls back to a monogram, never an imitation.
 */

type LogoKey = "SOL" | "ETH" | "BASE" | "USDC" | "ADA";

interface ChainMark {
  readonly marks: Readonly<Record<BrandBackground, BrandSvgKey>>;
  /** Share of the plate's diameter the mark may fill (the rest is clear space). */
  readonly fill: number;
  /** Fixed plate colour when the brand prescribes one (Base: white ground). */
  readonly plate?: string;
}

const MARKS: Readonly<Record<LogoKey, ChainMark | null>> = {
  SOL: { marks: { light: "solana", dark: "solana" }, fill: 0.56 },
  ETH: { marks: { light: "ethereum-on-light", dark: "ethereum-on-dark" }, fill: 0.66 },
  // Base: "blue Square on a white ground ... in a circular mask, reduce to fifty percent".
  BASE: { marks: { light: "base", dark: "base" }, fill: 0.5, plate: "#FFFFFF" },
  USDC: null,
  ADA: { marks: { light: "cardano-on-light", dark: "cardano-on-dark" }, fill: 0.62 },
};

function isLogoKey(key: string): key is LogoKey {
  return key in MARKS;
}

/** Logo key for a token symbol (USDC, SOL, ETH, ADA...), or null for a monogram. */
export function tokenLogoKey(symbol: string): LogoKey | null {
  const s = symbol.toUpperCase();
  return isLogoKey(s) ? s : null;
}

/** Logo key for a network: by chain name first (Base is an ETH-native L2), then by native currency. */
export function networkLogoKey(network: NetworkId): LogoKey | null {
  const chain = network.split("-")[0]?.toUpperCase() ?? "";
  if (chain === "BASE") return "BASE";
  if (chain === "ETHEREUM") return "ETH";
  if (chain === "SOLANA") return "SOL";
  if (chain === "CARDANO") return "ADA";
  return tokenLogoKey(getNetwork(network).nativeCurrency.symbol);
}

function Mark({ logo, size, label }: { logo: LogoKey | null; size: number; label: string }) {
  const { colors, scheme } = useTheme();
  const mark = logo === null ? null : MARKS[logo];
  if (mark === null) {
    const text = label.slice(0, size >= 32 ? 4 : 1).toUpperCase();
    // Four letters need a smaller face to clear the curve (and the chain badge).
    const scale = text.length >= 4 ? 0.23 : 0.28;
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radii.pill,
          backgroundColor: colors.surfaceStrong,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          variant="caption"
          style={{
            fontSize: Math.max(9, Math.round(size * scale)),
            lineHeight: Math.max(11, Math.round(size * 0.36)),
            letterSpacing: -0.2,
          }}
          maxFontSizeMultiplier={1}
        >
          {text}
        </Text>
      </View>
    );
  }
  const dark = scheme === "dark";
  const plate = mark.plate ?? (dark ? colors.surfaceStrong : "#FFFFFF");
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radii.pill,
        backgroundColor: plate,
        // A hairline keeps a white plate distinct from a white page.
        borderWidth: plate === "#FFFFFF" && !dark ? StyleSheet.hairlineWidth : 0,
        borderColor: colors.border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <BrandMark svg={mark.marks[dark ? "dark" : "light"]} box={size * mark.fill} />
    </View>
  );
}

const hidden =
  Platform.OS === "web"
    ? { "aria-hidden": true as const }
    : {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants" as const,
      };

export interface TokenLogoProps {
  readonly symbol: string;
  readonly size?: number;
  readonly logoUrl?: string | null;
}

/** A token's mark. Decorative: the row around it names the asset. */
export function TokenLogo({ symbol, size = 40, logoUrl }: TokenLogoProps) {
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      {logoUrl ? (
        <Image
          source={{ uri: logoUrl }}
          style={{ width: size, height: size, borderRadius: radii.pill }}
        />
      ) : (
        <Mark logo={tokenLogoKey(symbol)} size={size} label={symbol} />
      )}
    </View>
  );
}

export interface NetworkLogoProps {
  readonly network: NetworkId;
  readonly size?: number;
}

/** A chain's mark, from the shared network registry (unknown chains get a monogram). */
export function NetworkLogo({ network, size = 24 }: NetworkLogoProps) {
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      <Mark logo={networkLogoKey(network)} size={size} label={getNetwork(network).displayName} />
    </View>
  );
}

export interface AssetLogoProps {
  readonly asset: Pick<Asset, "symbol" | "network" | "logoUrl">;
  readonly size?: number;
  /** Colour behind the chain badge's ring; match the surface the logo sits on. */
  readonly ringColor?: string;
}

/**
 * Token mark with a small chain badge when the chain is not implied by the
 * token (USDC on Solana, ETH on Base), like a wallet would show it.
 */
export function AssetLogo({ asset, size = 40, ringColor }: AssetLogoProps) {
  const { colors } = useTheme();
  const token = tokenLogoKey(asset.symbol);
  const chain = networkLogoKey(asset.network);
  const badge = token !== chain;
  const badgeSize = Math.round(size * 0.42);
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      <TokenLogo symbol={asset.symbol} size={size} logoUrl={asset.logoUrl} />
      {badge ? (
        <View
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            borderRadius: radii.pill,
            padding: 1.5,
            backgroundColor: ringColor ?? colors.background,
          }}
        >
          <NetworkLogo network={asset.network} size={badgeSize} />
        </View>
      ) : null}
    </View>
  );
}
