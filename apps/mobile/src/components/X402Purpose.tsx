import { View } from "react-native";
import { breakAnywhere, Icon, radii, Row, spacing, Text, useTheme } from "@zyropay/ui";
import type { EscrowProtection } from "@/lib/escrow";
import type { SellerBadge } from "@/lib/masumi";
import { SellerIdentityLine } from "./Masumi";
import type { X402Purpose as Purpose } from "@/lib/x402";

/**
 * "What you're paying for" on an x402 approval: the seller's description (their words,
 * so quoted as theirs) and the resource's host and path. The full URL is under Details.
 */
export function X402Purpose({
  purpose,
  escrow = null,
  seller = null,
}: {
  readonly purpose: Purpose;
  /** Is the seller a registered Masumi agent (sellerBadge of the approval's sellerIdentity)? */
  readonly seller?: SellerBadge | null;
  /** Masumi escrow lock: how the payment is protected (escrowProtection). */
  readonly escrow?: EscrowProtection | null;
}) {
  const { colors } = useTheme();
  return (
    <View
      testID="approval-x402-resource"
      accessibilityLabel={`Paying for ${purpose.description ?? "a resource"} at ${purpose.host}${purpose.path}`}
      style={{
        gap: spacing.xs,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radii.md,
        padding: spacing.md,
      }}
    >
      <Text variant="caption" tone="secondary">
        {"What you're paying for"}
      </Text>
      {purpose.description ? (
        <Text variant="bodyStrong" numberOfLines={3} testID="approval-x402-description">
          {purpose.description}
        </Text>
      ) : (
        <Text variant="callout" tone="secondary">
          The seller did not describe it.
        </Text>
      )}
      <Row gap={spacing.sm} align="flex-start" style={{ paddingTop: spacing.xxs }}>
        <View style={{ paddingTop: 2 }}>
          <Icon name="globe" size={14} strokeWidth={2} color={colors.textSecondary} />
        </View>
        <View style={{ flexShrink: 1 }} testID="approval-x402-url">
          <Text variant="label" numberOfLines={1}>
            {purpose.host}
          </Text>
          {purpose.path === "/" ? null : (
            <Text variant="footnote" tone="secondary" numberOfLines={2} style={breakAnywhere}>
              {purpose.path}
            </Text>
          )}
        </View>
      </Row>
      {seller ? <SellerIdentityLine badge={seller} /> : null}
      {escrow ? <EscrowBlock escrow={escrow} /> : null}
    </View>
  );
}

/** "Protected by Escrow (Masumi)": who gets paid, when, and when a refund is possible. */
function EscrowBlock({ escrow }: { readonly escrow: EscrowProtection }) {
  const { colors } = useTheme();
  return (
    <View
      testID="approval-escrow"
      style={{
        gap: spacing.xs,
        marginTop: spacing.sm,
        paddingTop: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
      }}
    >
      <Row gap={spacing.sm}>
        <Icon name="shieldCheck" size={16} strokeWidth={2} color={colors.success} />
        <Text variant="calloutStrong" testID="approval-escrow-title">
          {escrow.title}
        </Text>
      </Row>
      {escrow.lines.map((line) => (
        <Text key={line} variant="footnote" tone="secondary">
          {line}
        </Text>
      ))}
      <Row gap={spacing.sm} style={{ paddingTop: spacing.xxs }}>
        <Text variant="footnote" tone="secondary">
          Seller
        </Text>
        <Text
          variant="mono"
          numberOfLines={1}
          style={{ flexShrink: 1 }}
          testID="approval-escrow-seller"
        >
          {escrow.seller}
        </Text>
      </Row>
    </View>
  );
}
