import { useMemo, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { formatDateTime, formatFiat, Row, spacing, Text, useTheme } from "@zyropay/ui";
import type { PriceChartProps } from "./PriceChart";

/*
 * Web fallback for the Skia chart (Expo web is a visual-QA target; CanvasKit is
 * not loaded there). Same geometry and colours, drawn with react-native-svg.
 * Prices become numbers for pixel positions only; text uses the exact strings.
 */
export function PriceChart({ history, height = 180 }: PriceChartProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const points = history.points;
  const first = points[0];
  const last = points[points.length - 1];

  const { d, coords } = useMemo(() => {
    const xy: { x: number; y: number }[] = [];
    if (points.length < 2 || width === 0) return { d: "", coords: xy };
    const values = points.map((pt) => Number(pt.price));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pad = 8;
    values.forEach((v, i) => {
      xy.push({
        x: (i / (values.length - 1)) * width,
        y: pad + (1 - (v - min) / span) * (height - pad * 2),
      });
    });
    return {
      d: xy.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" "),
      coords: xy,
    };
  }, [points, width, height]);

  if (points.length < 2) {
    return (
      <Text variant="callout" tone="secondary">
        Not enough price data for a chart.
      </Text>
    );
  }

  const up = first && last ? Number(last.price) >= Number(first.price) : true;
  const stroke = up ? colors.success : colors.danger;
  const active = selected === null ? last : points[selected];
  const dot = selected === null ? coords[coords.length - 1] : coords[selected];

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
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
        onPointerMove={(e) => {
          if (coords.length === 0 || width === 0) return;
          const x = e.nativeEvent.offsetX;
          setSelected(Math.round((Math.max(0, Math.min(width, x)) / width) * (coords.length - 1)));
        }}
        onPointerLeave={() => {
          setSelected(null);
        }}
        style={{ height }}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Price chart, ${history.range}. From ${first ? formatFiat(first.price, history.currency) : ""} to ${last ? formatFiat(last.price, history.currency) : ""}.`}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            <Path
              d={d}
              stroke={stroke}
              strokeWidth={2.25}
              fill="none"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {selected !== null && dot ? (
              <Line
                x1={dot.x}
                y1={0}
                x2={dot.x}
                y2={height}
                stroke={colors.border}
                strokeWidth={1}
              />
            ) : null}
            {dot ? <Circle cx={dot.x} cy={dot.y} r={4.5} fill={stroke} /> : null}
          </Svg>
        ) : null}
      </View>
    </View>
  );
}
