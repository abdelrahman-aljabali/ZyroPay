import { Canvas, Circle, Line, Path, Skia, vec } from "@shopify/react-native-skia";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { formatDateTime, formatFiat, Row, spacing, Text, useTheme } from "@zyropay/ui";
import type { PriceHistory } from "@zyropay/shared";

/*
 * Skia line chart. Prices are decimal strings; they are converted to numbers
 * here for PLOTTING ONLY (pixel positions). Every price shown as text is the
 * original string, formatted without floating point.
 */

export interface PriceChartProps {
  /** Only an available series is drawn; the screen shows "unavailable" itself. */
  readonly history: Extract<PriceHistory, { status: "available" }>;
  readonly height?: number;
}

export function PriceChart({ history, height = 180 }: PriceChartProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const points = history.points;
  const first = points[0];
  const last = points[points.length - 1];

  const { path, coords } = useMemo(() => {
    const p = Skia.Path.Make();
    const xy: { x: number; y: number }[] = [];
    if (points.length < 2 || width === 0) return { path: p, coords: xy };
    const values = points.map((pt) => Number(pt.price));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pad = 8;
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      xy.push({ x, y });
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    });
    return { path: p, coords: xy };
  }, [points, width, height]);

  const up = first && last ? Number(last.price) >= Number(first.price) : true;
  const stroke = up ? colors.success : colors.danger;

  const pick = (x: number) => {
    if (coords.length === 0) return;
    const i = Math.round((Math.max(0, Math.min(width, x)) / width) * (coords.length - 1));
    setSelected(i);
  };
  const clear = () => {
    setSelected(null);
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      scheduleOnRN(pick, e.x);
    })
    .onUpdate((e) => {
      scheduleOnRN(pick, e.x);
    })
    .onFinalize(() => {
      scheduleOnRN(clear);
    });

  const active = selected === null ? last : points[selected];
  const dot = selected === null ? coords[coords.length - 1] : coords[selected];

  if (points.length < 2) {
    return (
      <Text variant="callout" tone="secondary">
        Not enough price data for a chart.
      </Text>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Row justify="space-between">
        <Text variant="headline" style={{ fontVariant: ["tabular-nums"] }}>
          {active ? formatFiat(active.price, history.currency) : ""}
        </Text>
        <Text variant="caption" tone="secondary">
          {active ? formatDateTime(active.t) : ""}
        </Text>
      </Row>
      <GestureDetector gesture={pan}>
        <View
          onLayout={(e) => {
            setWidth(e.nativeEvent.layout.width);
          }}
          style={{ height }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Price chart, ${history.range}. From ${first ? formatFiat(first.price, history.currency) : ""} to ${last ? formatFiat(last.price, history.currency) : ""}.`}
        >
          {width > 0 ? (
            <Canvas style={{ width, height }}>
              <Path
                path={path}
                style="stroke"
                strokeWidth={2.25}
                color={stroke}
                strokeJoin="round"
                strokeCap="round"
              />
              {selected !== null && dot ? (
                <Line
                  p1={vec(dot.x, 0)}
                  p2={vec(dot.x, height)}
                  color={colors.border}
                  strokeWidth={1}
                />
              ) : null}
              {dot ? <Circle cx={dot.x} cy={dot.y} r={4.5} color={stroke} /> : null}
            </Canvas>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}
