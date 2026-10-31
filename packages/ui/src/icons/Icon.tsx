/* eslint-disable @typescript-eslint/no-deprecated -- react-native-svg types Rect x/y through RN's deprecated
   TransformsStyle x/y; here they are SVG geometry attributes, not transforms. */
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { ReactElement } from "react";
import { Platform } from "react-native";
import { useTheme } from "../theme/ThemeProvider";

/**
 * ZyroPay icon set: 24×24 grid, 1.75 stroke, round caps. Drawn for this
 * product (no third-party icon font), so the visual language stays original.
 */
const ICONS = {
  arrowUp: <Path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <Path d="M12 5v14M6 13l6 6 6-6" />,
  arrowUpRight: <Path d="M7 17 17 7M9 7h8v8" />,
  arrowDownLeft: <Path d="M17 7 7 17M15 17H7V9" />,
  plus: <Path d="M12 5v14M5 12h14" />,
  minus: <Path d="M5 12h14" />,
  swap: <Path d="M7 7h11l-3-3M17 17H6l3 3" />,
  qr: (
    <>
      <Rect x="4" y="4" width="6" height="6" rx="1.5" />
      <Rect x="14" y="4" width="6" height="6" rx="1.5" />
      <Rect x="4" y="14" width="6" height="6" rx="1.5" />
      <Path d="M14 14h2v2M20 14v6h-6M17 18v2" />
    </>
  ),
  scan: (
    <Path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3M4 12h16" />
  ),
  copy: (
    <>
      <Rect x="8" y="8" width="12" height="12" rx="3" />
      <Path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  check: <Path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronRight: <Path d="m9 5 7 7-7 7" />,
  chevronLeft: <Path d="m15 5-7 7 7 7" />,
  chevronDown: <Path d="m5 9 7 7 7-7" />,
  close: <Path d="M6 6l12 12M18 6 6 18" />,
  eye: (
    <>
      <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <Path d="M4 4l16 16M10 6c.6-.3 1.3-.5 2-.5 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  ),
  shield: <Path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6l-7-3Z" />,
  shieldCheck: (
    <Path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6l-7-3ZM9 12l2.2 2.2L15.5 10" />
  ),
  bolt: <Path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  agent: (
    <>
      <Rect x="5" y="7" width="14" height="12" rx="4" />
      <Path d="M12 3v4M9.5 12.5v1M14.5 12.5v1M2.5 12v3M21.5 12v3" />
    </>
  ),
  sliders: <Path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  search: (
    <>
      <Circle cx="11" cy="11" r="6.5" />
      <Path d="m16 16 4 4" />
    </>
  ),
  warning: <Path d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17.2v.1" />,
  info: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 11v5.5M12 7.8v.1" />
    </>
  ),
  wallet: (
    <>
      <Rect x="3" y="6" width="18" height="13" rx="3.5" />
      <Path d="M3 10h18M16 14.5h1.5" />
    </>
  ),
  key: (
    <>
      <Circle cx="8" cy="15" r="4" />
      <Path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5" />
    </>
  ),
  passkey: (
    <>
      <Circle cx="9" cy="8" r="4" />
      <Path d="M2.5 20c.6-3.5 3.3-6 6.5-6 1.4 0 2.6.4 3.6 1.2M17.5 13a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM17.5 18v3.5M17.5 20h1.5" />
    </>
  ),
  bell: <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5l1.5-2ZM10 21h4" />,
  link: (
    <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  share: (
    <Path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12" />
  ),
  clock: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 7v5l3 2" />
    </>
  ),
  lock: (
    <>
      <Rect x="5" y="10.5" width="14" height="10" rx="3" />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  trash: <Path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />,
  plug: <Path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8ZM12 16.5V21" />,
  user: (
    <>
      <Circle cx="12" cy="8" r="4" />
      <Path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6" />
    </>
  ),
  globe: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z" />
    </>
  ),
  moon: <Path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  card: (
    <>
      <Rect x="3" y="5.5" width="18" height="13" rx="3" />
      <Path d="M3 10h18M7 15h3" />
    </>
  ),
  refresh: <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15" />,
  external: (
    <Path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  ),
  logout: (
    <Path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h10" />
  ),
  grid: (
    <>
      <Rect x="4" y="4" width="7" height="7" rx="2" />
      <Rect x="13" y="4" width="7" height="7" rx="2" />
      <Rect x="4" y="13" width="7" height="7" rx="2" />
      <Rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
  dot: <Circle cx="12" cy="12" r="3" />,
  pencil: (
    <Path d="M14.5 5.5 18.5 9.5M4 20l1-4.5L15.8 4.7a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4L8.5 19 4 20Z" />
  ),
  chevronUp: <Path d="m5 15 7-7 7 7" />,
  arrowRight: <Path d="M5 12h14M13 6l6 6-6 6" />,
  more: (
    <>
      <Circle cx="6" cy="12" r="1.2" />
      <Circle cx="12" cy="12" r="1.2" />
      <Circle cx="18" cy="12" r="1.2" />
    </>
  ),
  home: (
    <Path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19v-8.5Z" />
  ),
  settings: (
    <>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
    </>
  ),
  sparkle: (
    <Path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7ZM19 16c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z" />
  ),
  checkCircle: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="m8 12.3 2.7 2.7L16 9.6" />
    </>
  ),
  xCircle: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  camera: (
    <>
      <Path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2.2h5.6L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
      <Circle cx="12" cy="13" r="3.5" />
    </>
  ),
  clipboard: (
    <>
      <Rect x="6" y="4.5" width="12" height="16" rx="2.5" />
      <Path d="M9.5 4.5V3.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8v.7M9.5 10h5M9.5 14h5" />
    </>
  ),
  sun: (
    <>
      <Circle cx="12" cy="12" r="4" />
      <Path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" />
    </>
  ),
  device: (
    <>
      <Rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <Path d="M11 18.5h2" />
    </>
  ),
  layers: (
    <Path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4ZM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
  ),
  help: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17.2v.1" />
    </>
  ),
  document: (
    <Path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5ZM13.5 3.5V8H18M9 12.5h6M9 16h6" />
  ),
  // ADA: a centre and a ring of six nodes (Cardano's distributed motif, drawn in our style).
  ada: (
    <>
      <Circle cx="12" cy="12" r="2.5" />
      <Circle cx="12" cy="4.5" r="1.25" />
      <Circle cx="18.5" cy="8.25" r="1.25" />
      <Circle cx="18.5" cy="15.75" r="1.25" />
      <Circle cx="12" cy="19.5" r="1.25" />
      <Circle cx="5.5" cy="15.75" r="1.25" />
      <Circle cx="5.5" cy="8.25" r="1.25" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
  readonly strokeWidth?: number;
}

/** Decorative by default: the pressable around it carries the accessibility label. */
export function Icon({ name, size = 22, color, strokeWidth = 1.75 }: IconProps) {
  const { colors } = useTheme();
  const stroke = color ?? colors.text;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // react-native-web forwards unknown props to the DOM; these two are native-only.
      {...(Platform.OS === "web"
        ? { "aria-hidden": true }
        : { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" })}
    >
      {ICONS[name]}
    </Svg>
  );
}
