import { useId, useMemo } from "react";
import { SvgXml } from "react-native-svg";
import { BRAND_SVGS, type BrandSvgKey } from "./svgs.generated";

/** The background a mark sits on, which picks the brand's variant for it. */
export type BrandBackground = "light" | "dark";

export interface BrandMarkProps {
  readonly svg: BrandSvgKey;
  /** The mark is fitted, aspect ratio kept, inside a `box` x `box` square. */
  readonly box: number;
}

/**
 * One official brand file, rendered as provided: no recolouring, no cropping,
 * uniformly scaled to fit. Sources and rules: docs/BRAND_ASSETS.md.
 */
export function BrandMark({ svg, box }: BrandMarkProps) {
  const { xml, aspect } = BRAND_SVGS[svg];
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  // Gradient/clip ids (all prefixed "zp" by the build) are made unique per instance:
  // on web every inline SVG shares one document, and a url(#id) that resolves into a
  // hidden screen (a stacked route) would paint nothing.
  const source = useMemo(
    () => (xml.includes('id="') ? xml.replace(/(id="|url\(#)zp/g, `$1zp${instance}`) : xml),
    [xml, instance],
  );
  const width = aspect >= 1 ? box : box * aspect;
  const height = aspect >= 1 ? box / aspect : box;
  return <SvgXml xml={source} width={width} height={height} />;
}
