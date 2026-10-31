import Svg, { Path, Rect } from "react-native-svg";
import { useTheme } from "../theme/ThemeProvider";

/**
 * The ZyroPay mark: eight teardrop petals in a pinwheel (the founder's logo), black on a
 * white rounded square. Geometry is copied from assets/brand/zyropay-mark.svg, the source
 * of truth (a unit test keeps the two identical); app icons, splash, favicon and PWA icons
 * are rendered from that file by apps/mobile/scripts/generate-icons.mjs.
 */
export const ZYRO_MARK_PATHS = {
  /** The white tile (100×100 grid, same corner radius as the old badge). */
  tile: { x: 0, y: 0, width: 100, height: 100, rx: 28 },
  /** All eight petals as one path (each petal is the first rotated in exact 45° steps). */
  glyph:
    "M61.26 44.18C64.99 46.67 64.19 61.98 63.63 70.09A6.93 6.93 0 0 0 77.35 71.84C78.58 65.30 65.67 46.26 61.26 44.18ZM62.08 53.85C62.95 58.25 51.56 68.50 45.43 73.84A6.93 6.93 0 0 0 53.90 84.79C59.38 81.03 63.72 58.44 62.08 53.85ZM55.82 61.26C53.33 64.99 38.02 64.19 29.91 63.63A6.93 6.93 0 0 0 28.16 77.35C34.70 78.58 53.74 65.67 55.82 61.26ZM46.15 62.08C41.75 62.95 31.50 51.56 26.16 45.43A6.93 6.93 0 0 0 15.21 53.90C18.97 59.38 41.56 63.72 46.15 62.08ZM38.74 55.82C35.01 53.33 35.81 38.02 36.37 29.91A6.93 6.93 0 0 0 22.65 28.16C21.42 34.70 34.33 53.74 38.74 55.82ZM37.92 46.15C37.05 41.75 48.44 31.50 54.57 26.16A6.93 6.93 0 0 0 46.10 15.21C40.62 18.97 36.28 41.56 37.92 46.15ZM44.18 38.74C46.67 35.01 61.98 35.81 70.09 36.37A6.93 6.93 0 0 0 71.84 22.65C65.30 21.42 46.26 34.33 44.18 38.74ZM53.85 37.92C58.25 37.05 68.50 48.44 73.84 54.57A6.93 6.93 0 0 0 84.79 46.10C81.03 40.62 58.44 36.28 53.85 37.92Z",
} as const;

/** Mark ink and tile colours. The tile stays white in both themes; the mark is never recoloured. */
export const ZYRO_MARK_INK = "#000000";
export const ZYRO_MARK_TILE = "#FFFFFF";

/** A rounded square inset by `inset` on the 100-unit grid, as a path. */
function roundedSquare(inset: number, r: number): string {
  const a = inset;
  const b = 100 - inset;
  return `M${String(a + r)} ${String(a)}H${String(b - r)}A${String(r)} ${String(r)} 0 0 1 ${String(b)} ${String(a + r)}V${String(b - r)}A${String(r)} ${String(r)} 0 0 1 ${String(b - r)} ${String(b)}H${String(a + r)}A${String(r)} ${String(r)} 0 0 1 ${String(a)} ${String(b - r)}V${String(a + r)}A${String(r)} ${String(r)} 0 0 1 ${String(a + r)} ${String(a)}Z`;
}

export interface ZyroMarkProps {
  readonly size?: number;
  /** "tile": black petals on the white rounded square. "glyph": the petals alone. */
  readonly variant?: "tile" | "glyph";
  /** Glyph variant only: the petals' colour (defaults to the theme's ink). */
  readonly color?: string;
}

export function ZyroMark({ size = 40, variant = "tile", color }: ZyroMarkProps) {
  const { colors, scheme } = useTheme();
  if (variant === "glyph") {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        accessibilityRole="image"
        accessibilityLabel="ZyroPay"
      >
        <Path d={ZYRO_MARK_PATHS.glyph} fill={color ?? colors.text} />
      </Svg>
    );
  }
  // On a white page the white tile needs a hairline to keep its shape; on dark it stands out.
  const edge = scheme === "light";
  // Stroke width in grid units for a ~1 px line at this size, drawn inside the tile.
  const stroke = Math.max(100 / size, 0.5);
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      accessibilityRole="image"
      accessibilityLabel="ZyroPay"
    >
      <Rect {...ZYRO_MARK_PATHS.tile} fill={ZYRO_MARK_TILE} />
      {edge ? (
        <Path
          d={roundedSquare(stroke / 2, ZYRO_MARK_PATHS.tile.rx - stroke / 2)}
          fill="none"
          stroke={colors.border}
          strokeWidth={stroke}
        />
      ) : null}
      <Path d={ZYRO_MARK_PATHS.glyph} fill={ZYRO_MARK_INK} />
    </Svg>
  );
}
