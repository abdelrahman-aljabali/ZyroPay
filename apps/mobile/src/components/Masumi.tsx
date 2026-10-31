import { View } from "react-native";
import { Icon, radii, Row, spacing, Text, useTheme, type IconName } from "@zyropay/ui";
import type { SellerBadge } from "@/lib/masumi";

type Tone = "success" | "caution" | "danger" | "neutral";

/** Small pill with a leading icon (status chips on Masumi agent cards). */
function IconPill({
  icon,
  label,
  tone,
  testID,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly tone: Tone;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const bg =
    tone === "success"
      ? colors.successSoft
      : tone === "danger"
        ? colors.dangerSoft
        : tone === "caution"
          ? colors.cautionSoft
          : colors.surfaceStrong;
  const fg =
    tone === "success"
      ? colors.success
      : tone === "danger"
        ? colors.danger
        : tone === "caution"
          ? colors.caution
          : colors.text;
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        alignSelf: "flex-start",
        backgroundColor: bg,
        borderRadius: radii.pill,
        paddingLeft: spacing.xs + 2,
        paddingRight: spacing.sm,
        paddingVertical: 3,
      }}
    >
      <Icon name={icon} size={12} strokeWidth={2.4} color={fg} />
      <Text variant="caption" style={{ color: fg }}>
        {label}
      </Text>
    </View>
  );
}

/** "Registered on Masumi ✓" and, when the agent takes escrow payments, "Escrow-protected". */
export function MasumiBadges({ escrow }: { readonly escrow: boolean }) {
  return (
    <Row gap={spacing.xs} style={{ flexWrap: "wrap" }}>
      <IconPill
        icon="check"
        label="Registered on Masumi"
        tone="success"
        testID="masumi-registered"
      />
      {escrow ? (
        <IconPill
          icon="shieldCheck"
          label="Escrow-protected"
          tone="neutral"
          testID="masumi-escrow"
        />
      ) : null}
    </Row>
  );
}

const BADGE_ICON: Readonly<Record<SellerBadge["kind"], IconName>> = {
  registered: "shieldCheck",
  unregistered: "info",
  failed: "warning",
};

/** Seller identity line inside "What you're paying for" on an x402 approval. */
export function SellerIdentityLine({ badge }: { readonly badge: SellerBadge }) {
  const { colors } = useTheme();
  const fg =
    badge.tone === "success"
      ? colors.success
      : badge.tone === "danger"
        ? colors.danger
        : colors.caution;
  const bg =
    badge.tone === "success"
      ? colors.successSoft
      : badge.tone === "danger"
        ? colors.dangerSoft
        : colors.cautionSoft;
  return (
    <View
      testID={`approval-seller-${badge.kind}`}
      accessibilityLabel={`${badge.title}. ${badge.lines.join(" ")}`}
      style={{
        gap: 2,
        marginTop: spacing.xs,
        backgroundColor: bg,
        borderRadius: radii.sm,
        paddingHorizontal: spacing.sm + 2,
        paddingVertical: spacing.sm,
      }}
    >
      <Row gap={spacing.sm} align="flex-start">
        <View style={{ paddingTop: 2 }}>
          <Icon name={BADGE_ICON[badge.kind]} size={14} strokeWidth={2.2} color={fg} />
        </View>
        <Text variant="label" style={{ color: fg, flexShrink: 1 }} numberOfLines={2}>
          {badge.title}
        </Text>
      </Row>
      {badge.lines.map((line) => (
        <Text
          key={line}
          variant="footnote"
          tone={badge.tone === "danger" ? "primary" : "secondary"}
          style={{ paddingLeft: 14 + spacing.sm }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}
