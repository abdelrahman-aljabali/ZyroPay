import { BrandMark, Text, useTheme, ZyroMark } from "@zyropay/ui";
import { useEffect } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { MARKETING_CHAIN_MARKS, type MarketingChainMark } from "./marketing/chain-marks";

/*
 * Welcome motif (DECORATIVE MARKETING ONLY): the ZyroPay mark with three slow orbits of
 * well-known chains' official marks, in their real colours, around it. It illustrates the wider crypto world; it is not a
 * list of supported networks (those come from `networksForMode` and are never shown
 * here), and it carries no text. Each ring turns very slowly, alternating direction, and
 * the marks counter-rotate to stay upright. Fully static under Reduce Motion, and
 * hidden from assistive tech.
 */

interface RingSpec {
  /** Radius as a fraction of the motif's size. */
  readonly radius: number;
  /** Mark diameter as a fraction of the motif's size. */
  readonly mark: number;
  /** One revolution, ms; the sign is the direction. */
  readonly periodMs: number;
  readonly opacity: number;
  readonly dashed: boolean;
  readonly count: number;
}

const RINGS: readonly RingSpec[] = [
  {
    radius: 0.215,
    mark: 0.1,
    periodMs: 90_000,
    opacity: 1,
    dashed: false,
    count: 5,
  },
  {
    radius: 0.335,
    mark: 0.08,
    periodMs: -130_000,
    opacity: 1,
    dashed: true,
    count: 7,
  },
  {
    radius: 0.45,
    mark: 0.07,
    periodMs: 180_000,
    // Slightly quieter outer ring for depth; the marks keep their colours.
    opacity: 0.9,
    dashed: false,
    count: 8,
  },
];

function ringsOf(marks: readonly MarketingChainMark[]): MarketingChainMark[][] {
  const out: MarketingChainMark[][] = [];
  let i = 0;
  for (const r of RINGS) {
    out.push(marks.slice(i, i + r.count));
    i += r.count;
  }
  return out;
}

/** One chain on a plain round plate: the official file, or a neutral monogram. */
function Mark({ mark, size }: { readonly mark: MarketingChainMark; readonly size: number }) {
  const { colors, scheme, type } = useTheme();
  const dark = scheme === "dark";
  if (mark.marks === null) {
    const letters = mark.monogram;
    return (
      <View style={{ padding: 3, borderRadius: 999, backgroundColor: colors.background }}>
        <View
          style={{
            width: size,
            height: size,
            borderRadius: 999,
            backgroundColor: colors.surfaceStrong,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              ...type("caption"),
              color: colors.textSecondary,
              fontSize: Math.max(7, Math.round(size * (letters.length >= 3 ? 0.26 : 0.4))),
              lineHeight: Math.round(size * 0.5),
              letterSpacing: -0.2,
            }}
            maxFontSizeMultiplier={1}
          >
            {letters}
          </Text>
        </View>
      </View>
    );
  }
  const white = !dark || mark.whitePlate === true;
  // A mark that is itself a disk (fill 1) needs no plate colour behind it.
  const plate = mark.fill >= 1 ? "transparent" : white ? "#FFFFFF" : colors.surfaceStrong;
  return (
    <View style={{ padding: 3, borderRadius: 999, backgroundColor: colors.background }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 999,
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
    </View>
  );
}

function Ring({
  spec,
  marks,
  size,
  progress,
  index,
}: {
  readonly spec: RingSpec;
  readonly marks: readonly MarketingChainMark[];
  readonly size: number;
  readonly progress: SharedValue<number>;
  readonly index: number;
}) {
  const { reducedMotion } = useTheme();
  const c = size / 2;
  const r = size * spec.radius;
  const markSize = Math.round(size * spec.mark);
  // One shared clock; each ring turns at its own speed and direction.
  const turns = 180_000 / spec.periodMs;
  const orbit = useAnimatedStyle(() => ({
    transform: [{ rotate: `${String(progress.value * 360 * turns)}deg` }],
  }));
  const upright = useAnimatedStyle(() => ({
    transform: [{ rotate: `${String(-progress.value * 360 * turns)}deg` }],
  }));
  // Offset each ring's start angle so marks never line up radially.
  const phase = index * 0.61;
  return (
    <Animated.View
      entering={
        reducedMotion
          ? undefined
          : FadeIn.delay(120 + index * 140)
              .duration(700)
              .easing(Easing.bezier(0.23, 1, 0.32, 1))
      }
      style={{ position: "absolute", width: size, height: size }}
    >
      <Animated.View
        style={[{ position: "absolute", width: size, height: size, opacity: spec.opacity }, orbit]}
      >
        {marks.map((m, i) => {
          const a = -Math.PI / 2 + phase + (2 * Math.PI * i) / Math.max(1, marks.length);
          return (
            <Animated.View
              key={m.id}
              style={[
                {
                  position: "absolute",
                  left: c + r * Math.cos(a) - markSize / 2 - 3,
                  top: c + r * Math.sin(a) - markSize / 2 - 3,
                },
                upright,
              ]}
            >
              <Mark mark={m} size={markSize} />
            </Animated.View>
          );
        })}
      </Animated.View>
    </Animated.View>
  );
}

export function OrbitHero({ size: requested }: { readonly size?: number }) {
  const { colors, reducedMotion } = useTheme();
  const { width, height } = useWindowDimensions();
  const size = requested ?? Math.round(Math.min(width - 48, height * 0.4, 340));
  // A single 180 s clock drives every ring (periods are expressed relative to it).
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withRepeat(
      withTiming(1, { duration: 180_000, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(progress);
    };
  }, [progress, reducedMotion]);

  const c = size / 2;
  const rings = ringsOf(MARKETING_CHAIN_MARKS);
  const center = Math.round(size * 0.21);

  return (
    <View
      style={{ width: size, height: size, alignSelf: "center" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      testID="orbit-hero"
    >
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        {RINGS.map((spec, i) => (
          <Circle
            key={i}
            cx={c}
            cy={c}
            r={size * spec.radius}
            stroke={colors.border}
            strokeWidth={1}
            strokeDasharray={spec.dashed ? "2 6" : undefined}
            strokeLinecap="round"
            fill="none"
          />
        ))}
      </Svg>
      {RINGS.map((spec, i) => (
        <Ring
          key={i}
          spec={spec}
          marks={rings[i] ?? []}
          size={size}
          progress={progress}
          index={i}
        />
      ))}
      <View style={{ position: "absolute", left: c - center / 2, top: c - center / 2 }}>
        <ZyroMark size={center} />
      </View>
    </View>
  );
}
