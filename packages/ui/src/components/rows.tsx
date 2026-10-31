import {
  getNetwork,
  type Agent,
  type Balance,
  type NetworkId,
  type PluginManifest,
  type Transaction,
  type Wallet,
  type WatchWallet,
} from "@zyropay/shared";
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  useContext,
  type ReactNode,
} from "react";
import { Image, View } from "react-native";
import {
  chunkAddress,
  formatFiat,
  formatFiatMinor,
  formatRelativeTime,
  formatTokenAmount,
  formatUnitPrice,
  chainFamilyLabel,
  isMainnetPriced,
  MAINNET_PRICE_MARKER,
  shortenAddress,
  withPriceMarker,
  type PriceChange,
} from "../format";
import { AssetLogo, NetworkLogo, networkLogoKey, TokenLogo } from "../icons/CryptoLogo";
import { PluginLogo } from "../brand/PluginLogo";
import { Icon, type IconName } from "../icons/Icon";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radii, sizes, spacing, typography, type TypographyToken } from "../tokens";
import { StatusPill } from "./feedback";
import { breakAnywhere, Card, PressableScale, Row, Text } from "./primitives";

const MASK = "••••";

// ---------------------------------------------------------------------------
// Grouped lists (iOS inset-grouped style)
// ---------------------------------------------------------------------------

const GroupContext = createContext(false);

/** True inside a ListGroup: rows pad themselves and wash edge to edge when pressed. */
export function useInGroup(): boolean {
  return useContext(GroupContext);
}

export interface ListGroupProps {
  readonly children: ReactNode;
  /** Separator inset from the leading edge (aligns with row text, past the icon). */
  readonly inset?: number;
  readonly testID?: string;
}

/** Rounded surface holding rows with hairline separators between them. */
export function ListGroup({ children, inset, testID }: ListGroupProps) {
  const { colors } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <GroupContext.Provider value>
      <Card padded={false} testID={testID}>
        {items.map((child, i) => (
          <Fragment key={child.key ?? i}>
            {i > 0 ? (
              <View
                style={{
                  height: 1,
                  backgroundColor: colors.separator,
                  marginLeft: inset ?? spacing.lg,
                }}
              />
            ) : null}
            {child}
          </Fragment>
        ))}
      </Card>
    </GroupContext.Provider>
  );
}

/**
 * A full address set in groups of four so it wraps cleanly and can be read
 * back aloud; screen readers get it unbroken. Copy the raw value, not this text.
 */
export function AddressText({
  address,
  align = "left",
  testID,
}: {
  readonly address: string;
  readonly align?: "left" | "center" | "right";
  readonly testID?: string;
}) {
  return (
    <Text
      variant="mono"
      align={align}
      accessibilityLabel={address}
      testID={testID}
      style={[{ letterSpacing: 0.4 }, breakAnywhere]}
      selectable
    >
      {chunkAddress(address).join(" ")}
    </Text>
  );
}

/** Separator inset that lines up with text after a ListRow icon tile. */
export const ROW_TEXT_INSET = spacing.lg + sizes.iconTile + spacing.md;

// ---------------------------------------------------------------------------
// Avatars and icon tiles
// ---------------------------------------------------------------------------

export interface AvatarProps {
  readonly label: string;
  readonly icon?: IconName;
  readonly imageUrl?: string | null;
  readonly size?: number;
  readonly inverted?: boolean;
  /** Rounded square instead of a circle (wallets, agents, plugins). */
  readonly shape?: "circle" | "squircle";
}

/** Monochrome badge with initials or an icon. Remote images only when provided. */
export function Avatar({
  label,
  icon,
  imageUrl,
  size = sizes.avatar,
  inverted = false,
  shape = "circle",
}: AvatarProps) {
  const { colors } = useTheme();
  const bg = inverted ? colors.primary : colors.surfaceStrong;
  const fg = inverted ? colors.onPrimary : colors.text;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: shape === "circle" ? radii.pill : Math.round(size * 0.3),
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={{ width: size, height: size }} />
      ) : icon ? (
        <Icon name={icon} color={fg} size={Math.round(size * 0.5)} />
      ) : (
        <Text
          variant="bodyStrong"
          style={{
            color: fg,
            fontSize: Math.round(size * 0.4),
            lineHeight: Math.round(size * 0.5),
          }}
        >
          {label.slice(0, size >= 44 ? 2 : 1).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

/** Small rounded tile behind a settings-style row icon. */
export function IconTile({
  icon,
  tone = "neutral",
  size = sizes.iconTile,
}: {
  readonly icon: IconName;
  readonly tone?: "neutral" | "danger" | "inverse";
  readonly size?: number;
}) {
  const { colors } = useTheme();
  const bg =
    tone === "danger"
      ? colors.dangerSoft
      : tone === "inverse"
        ? colors.primary
        : colors.surfaceRaised;
  const fg =
    tone === "danger" ? colors.danger : tone === "inverse" ? colors.onPrimary : colors.text;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radii.xs,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} color={fg} size={Math.round(size * 0.58)} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// ListRow
// ---------------------------------------------------------------------------

export interface ListRowProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly icon?: IconName;
  /** Replace the icon tile with any leading element (logo, avatar). */
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly value?: string;
  readonly onPress?: () => void;
  readonly destructive?: boolean;
  readonly testID?: string;
  readonly accessibilityHint?: string;
}

/** Settings-style row: icon tile, title, optional value and chevron. */
export function ListRow({
  title,
  subtitle,
  icon,
  leading,
  trailing,
  value,
  onPress,
  destructive,
  testID,
  accessibilityHint,
}: ListRowProps) {
  const { colors } = useTheme();
  const inGroup = useInGroup();
  const content = (
    <Row
      style={{
        minHeight: subtitle ? 64 : 52,
        paddingVertical: spacing.sm + 2,
        paddingHorizontal: inGroup ? spacing.lg : 0,
      }}
    >
      {leading ??
        (icon ? <IconTile icon={icon} tone={destructive === true ? "danger" : "neutral"} /> : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" tone={destructive === true ? "danger" : "primary"} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="callout" tone="secondary" numberOfLines={1} style={{ maxWidth: "45%" }}>
          {value}
        </Text>
      ) : null}
      {trailing}
      {onPress && trailing === undefined && destructive !== true ? (
        <Icon name="chevronRight" size={16} strokeWidth={2} color={colors.textSecondary} />
      ) : null}
    </Row>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={value ? `${title}, ${value}` : title}
      accessibilityHint={accessibilityHint}
      testID={testID}
      scaleTo={1}
      highlight={colors.surfaceStrong}
    >
      {content}
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// Money rows
// ---------------------------------------------------------------------------

/** The network's full name: testnets say so ("Solana Devnet", "Base Sepolia"). */
function NetworkLine({
  network,
  prefix,
  suffix,
}: {
  readonly network: NetworkId;
  readonly prefix?: string;
  readonly suffix?: string;
}) {
  return (
    // Two lines: on a phone "Ethereum Sepolia · mainnet price" must wrap, not lose the marker.
    <Text variant="footnote" tone="secondary" numberOfLines={2}>
      {prefix ? `${prefix} · ` : ""}
      {getNetwork(network).displayName}
      {suffix ? ` · ${suffix}` : ""}
    </Text>
  );
}

/**
 * 24h price change: an arrow and a signed percentage, green up / red down. The arrow and
 * the sign carry the direction, so it never depends on colour alone.
 */
export function PriceChangeText({
  change,
  variant = "footnote",
  suffix,
  testID,
}: {
  readonly change: PriceChange;
  readonly variant?: TypographyToken;
  /** Quiet trailing context, e.g. "24h". */
  readonly suffix?: string;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const color =
    change.direction === "up"
      ? colors.success
      : change.direction === "down"
        ? colors.dangerText
        : colors.textSecondary;
  const size = Math.round(typography[variant].fontSize * 0.85);
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}
      accessible
      accessibilityLabel={`${change.spoken} in 24 hours`}
      testID={testID}
    >
      {change.direction !== "flat" ? (
        <Icon
          name={change.direction === "up" ? "arrowUp" : "arrowDown"}
          size={size}
          strokeWidth={2.4}
          color={color}
        />
      ) : null}
      <Text variant={variant} numberOfLines={1} style={{ color, fontVariant: ["tabular-nums"] }}>
        {change.percent}
      </Text>
      {suffix ? (
        <Text variant={variant} tone="secondary" numberOfLines={1}>
          {` ${suffix}`}
        </Text>
      ) : null}
    </View>
  );
}

/** Spoken summary of a unit price and its 24h change, for row accessibility labels. */
export function priceA11y(balance: Pick<Balance, "price">, change?: PriceChange | null): string {
  if (!balance.price) return "no price";
  const price = formatUnitPrice(balance.price.value, balance.price.currency);
  return `price ${price}${change ? `, ${change.spoken} in 24 hours` : ""}`;
}

/**
 * Unit price of an asset ("$2,432.05") with its 24h change when known. The change wraps
 * under the price on narrow rows instead of truncating it.
 */
export function PriceLine({
  price,
  change,
  marker,
  testID,
}: {
  readonly price: Balance["price"];
  readonly change?: PriceChange | null;
  /** Quiet trailing note, e.g. MAINNET_PRICE_MARKER where no network line carries it. */
  readonly marker?: string;
  readonly testID?: string;
}) {
  if (!price) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: spacing.sm,
      }}
      testID={testID}
    >
      <Text
        variant="footnote"
        numberOfLines={1}
        style={{ fontVariant: ["tabular-nums"], flexShrink: 1 }}
      >
        {formatUnitPrice(price.value, price.currency)}
      </Text>
      {change ? <PriceChangeText change={change} /> : null}
      {marker ? (
        <Text variant="footnote" tone="secondary" numberOfLines={1}>
          {marker}
        </Text>
      ) : null}
    </View>
  );
}

export interface AssetRowProps {
  readonly balance: Balance;
  /** 24h change of the unit price; omitted while unknown. */
  readonly change?: PriceChange | null;
  readonly hidden?: boolean;
  readonly onPress?: () => void;
  /** Spoken on the row; the visible "Simulated" badge sits on the list's section header. */
  readonly simulated?: boolean;
  readonly testID?: string;
}

/**
 * One holding: name, unit price (+ 24h change) and network on the left; holding value and
 * amount on the right. The price is public market data, so it stays visible when balances
 * are hidden.
 */
export function AssetRow({
  balance,
  change = null,
  hidden = false,
  onPress,
  simulated = false,
  testID,
}: AssetRowProps) {
  const { colors } = useTheme();
  const inGroup = useInGroup();
  const { asset } = balance;
  const amount = formatTokenAmount(balance.amount, asset.decimals, { symbol: asset.symbol });
  const value = balance.value ? formatFiat(balance.value.value, balance.value.currency) : null;
  const info = getNetwork(balance.network);
  const mainnetPriced = (balance.price !== null || value !== null) && isMainnetPriced(balance);
  const shownChange = balance.price ? change : null;
  const price = priceA11y(balance, shownChange);
  const a11y = hidden
    ? `${asset.name} on ${info.displayName}${info.isTestnet ? ", testnet" : ""}, ${price}${mainnetPriced ? " (mainnet price)" : ""}, balance hidden`
    : `${asset.name} on ${info.displayName}${info.isTestnet ? ", testnet" : ""}, ${price}${mainnetPriced ? " (mainnet price)" : ""}, holding ${amount}, ${value ?? "no value"}${simulated ? ", simulated" : ""}`;
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={a11y}
      testID={testID}
      scaleTo={inGroup ? 1 : motion.pressedScaleSubtle}
      highlight={inGroup ? colors.surfaceStrong : undefined}
    >
      <Row
        align="flex-start"
        style={{
          minHeight: 68,
          paddingVertical: spacing.md,
          paddingHorizontal: inGroup ? spacing.lg : 0,
        }}
      >
        <AssetLogo asset={asset} size={40} ringColor={inGroup ? colors.surface : undefined} />
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Row gap={spacing.sm}>
            <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
              {asset.name}
            </Text>
            {!asset.verified ? <StatusPill label="Unverified" tone="caution" /> : null}
          </Row>
          <PriceLine
            price={balance.price}
            change={shownChange}
            {...(testID ? { testID: `${testID}-price` } : {})}
          />
          <NetworkLine
            network={balance.network}
            {...(mainnetPriced ? { suffix: MAINNET_PRICE_MARKER } : {})}
          />
        </View>
        <View style={{ alignItems: "flex-end", gap: 2, flexShrink: 0, maxWidth: "45%" }}>
          <Text
            variant="amount"
            numberOfLines={1}
            tone={value === null && !hidden ? "secondary" : "primary"}
          >
            {hidden ? MASK : (value ?? "No price")}
          </Text>
          <Text
            variant="footnote"
            tone="secondary"
            numberOfLines={1}
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {hidden ? MASK : amount}
          </Text>
        </View>
      </Row>
    </PressableScale>
  );
}

export interface TransactionRowProps {
  readonly transaction: Transaction;
  /**
   * What the transaction was ("Paid for an API call", "Swapped SOL for USDC"): replaces the
   * default "Sent ADA" / "Received ADA" title and leads the accessibility label.
   */
  readonly label?: string | undefined;
  readonly hidden?: boolean;
  readonly onPress?: () => void;
  readonly now?: Date;
  readonly testID?: string;
}

export function TransactionRow({
  transaction: tx,
  label,
  hidden = false,
  onPress,
  now,
  testID,
}: TransactionRowProps) {
  const { colors } = useTheme();
  const inGroup = useInGroup();
  const incoming = tx.direction === "in";
  const verb = tx.direction === "in" ? "Received" : tx.direction === "out" ? "Sent" : "Moved";
  const counterparty = incoming ? tx.from : tx.to;
  const amount = formatTokenAmount(tx.amount, tx.asset.decimals, { symbol: tx.asset.symbol });
  const statusLabel =
    tx.status === "pending" ? "Pending" : tx.status === "failed" ? "Failed" : null;
  const sign = incoming ? "+" : tx.direction === "out" ? "−" : "";
  const when = formatRelativeTime(tx.timestamp, now);
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={`${label !== undefined ? `${label}, ` : `${verb} `}${hidden ? "amount hidden" : amount}${!hidden && tx.valueAtTime ? `, ${withPriceMarker(formatFiat(tx.valueAtTime.value, tx.valueAtTime.currency), tx.priceBasis)}` : ""}, ${incoming ? "from" : "to"} ${shortenAddress(counterparty)}, ${tx.status}, ${when}`}
      testID={testID}
      scaleTo={inGroup ? 1 : motion.pressedScaleSubtle}
      highlight={inGroup ? colors.surfaceStrong : undefined}
    >
      <Row
        style={{
          minHeight: 68,
          paddingVertical: spacing.md,
          paddingHorizontal: inGroup ? spacing.lg : 0,
        }}
      >
        <View style={{ width: 40, height: 40 }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: radii.pill,
              backgroundColor: inGroup ? colors.surfaceRaised : colors.surface,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              name={incoming ? "arrowDownLeft" : "arrowUpRight"}
              size={19}
              strokeWidth={2}
              color={tx.status === "failed" ? colors.danger : colors.text}
            />
          </View>
          <View
            style={{
              position: "absolute",
              right: -3,
              bottom: -3,
              padding: 1.5,
              borderRadius: radii.pill,
              backgroundColor: inGroup ? colors.surface : colors.background,
            }}
          >
            <TokenLogo symbol={tx.asset.symbol} size={16} logoUrl={tx.asset.logoUrl} />
          </View>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {label ?? `${verb} ${tx.asset.symbol}`}
          </Text>
          <Text variant="footnote" tone="secondary" numberOfLines={1}>
            {statusLabel ? (
              <Text variant="footnote" tone={tx.status === "failed" ? "danger" : "caution"}>
                {`${statusLabel} · `}
              </Text>
            ) : null}
            {`${incoming ? "From" : "To"} ${shortenAddress(counterparty)} · ${when}`}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Text
            variant="amount"
            style={{ color: incoming && !hidden ? colors.success : colors.text }}
            numberOfLines={1}
          >
            {hidden ? MASK : `${sign}${amount}`}
          </Text>
          {tx.valueAtTime && !hidden ? (
            <Text variant="footnote" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
              {formatFiat(tx.valueAtTime.value, tx.valueAtTime.currency)}
            </Text>
          ) : null}
        </View>
      </Row>
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

/** Overlapping chain marks, e.g. Ethereum + Base for one EVM address. */
export function NetworkStack({
  networks,
  size = 20,
  ringColor,
}: {
  readonly networks: readonly NetworkId[];
  readonly size?: number;
  readonly ringColor?: string;
}) {
  const { colors } = useTheme();
  return (
    <Row gap={0}>
      {networks.map((n, i) => (
        <View
          key={n}
          style={{
            marginLeft: i === 0 ? 0 : -size * 0.3,
            padding: 1.5,
            borderRadius: radii.pill,
            backgroundColor: ringColor ?? colors.surface,
          }}
        >
          <NetworkLogo network={n} size={size} />
        </View>
      ))}
    </Row>
  );
}

function familyNetworks(networks: readonly NetworkId[], family: string): NetworkId[] {
  return networks.filter((n) => getNetwork(n).family === family);
}

/** "Ethereum, Base · Testnet": short chain names, the testnet flag said once. */
export function networksLabel(networks: readonly NetworkId[]): string {
  if (networks.length === 0) return "";
  const names = networks.map((n) =>
    getNetwork(n).displayName.replace(/ (Devnet|Sepolia|Testnet|Preprod|Preview)$/, ""),
  );
  return `${names.join(", ")}${networks.some((n) => getNetwork(n).isTestnet) ? " · Testnet" : ""}`;
}

/** Round "•••" button pinned to a card's top-right corner (a sibling, never nested in the card's pressable). */
function MoreButton({
  label,
  onPress,
  onSurface,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly onSurface: boolean;
}) {
  const { colors } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={6}
      containerStyle={{ position: "absolute", top: spacing.lg, right: spacing.lg }}
      style={{
        width: 36,
        height: 36,
        borderRadius: radii.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: onSurface ? colors.surfaceRaised : colors.surface,
      }}
    >
      <Icon name="more" size={18} strokeWidth={2.2} />
    </PressableScale>
  );
}

export interface WalletCardProps {
  readonly wallet: Wallet;
  /** Pre-formatted total for this wallet, or null when unknown. */
  readonly totalLabel?: string | null;
  readonly hidden?: boolean;
  /** The build's networks (shared registry, filtered by mode); each address lists its family's. */
  readonly networks?: readonly NetworkId[];
  readonly onPress?: () => void;
  /** Opens the wallet's actions (rename, remove). */
  readonly onMore?: () => void;
  readonly testID?: string;
}

export function WalletCard({
  wallet,
  totalLabel,
  hidden = false,
  networks = [],
  onPress,
  onMore,
  testID,
}: WalletCardProps) {
  const { colors } = useTheme();
  const body = (
    <Card style={{ gap: spacing.lg }}>
      <Row align="center" style={{ paddingRight: onMore ? 44 : 0 }}>
        <Avatar label={wallet.name} icon="wallet" inverted shape="squircle" size={44} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {wallet.name}
          </Text>
          {totalLabel !== undefined ? (
            <Text variant="amount" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
              {hidden ? MASK : (totalLabel ?? "—")}
            </Text>
          ) : null}
        </View>
      </Row>
      <View style={{ gap: spacing.sm + 2 }}>
        {wallet.addresses.map((a) => {
          const nets = familyNetworks(networks, a.family);
          return (
            <Row key={a.id} gap={spacing.md}>
              {nets.length > 0 ? <NetworkStack networks={nets} size={20} /> : null}
              <Text variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                {nets.length > 0 ? networksLabel(nets) : chainFamilyLabel(a.family)}
              </Text>
              <Text variant="mono" style={{ color: colors.text }}>
                {shortenAddress(a.address, 4, 4)}
              </Text>
            </Row>
          );
        })}
      </View>
    </Card>
  );
  return (
    <View testID={onPress ? undefined : testID}>
      {onPress ? (
        <PressableScale
          onPress={onPress}
          accessibilityLabel={`Wallet ${wallet.name}${totalLabel && !hidden ? `, ${totalLabel}` : ""}`}
          testID={testID}
          scaleTo={motion.pressedScaleSubtle}
        >
          {body}
        </PressableScale>
      ) : (
        body
      )}
      {onMore ? (
        <MoreButton label={`More actions for ${wallet.name}`} onPress={onMore} onSurface />
      ) : null}
    </View>
  );
}

/** The exact label every watch-only surface carries. */
export const WATCH_ONLY_LABEL = "Watch only — can't send or be used by agents";

export interface WatchWalletCardProps {
  readonly wallet: WatchWallet;
  readonly totalLabel?: string | null;
  readonly hidden?: boolean;
  readonly networks?: readonly NetworkId[];
  readonly onPress?: () => void;
  readonly onMore?: () => void;
  readonly testID?: string;
}

/** Read-only address: dashed outline instead of a filled card, eye mark, and the watch-only label. */
export function WatchWalletCard({
  wallet,
  totalLabel,
  hidden = false,
  networks = [],
  onPress,
  onMore,
  testID,
}: WatchWalletCardProps) {
  const { colors } = useTheme();
  const nets = familyNetworks(networks, wallet.family);
  const body = (
    <View
      style={{
        borderRadius: radii.card,
        borderWidth: 1.5,
        borderColor: colors.border,
        borderStyle: "dashed",
        padding: spacing.lg,
        gap: spacing.lg,
      }}
    >
      <Row style={{ paddingRight: onMore ? 44 : 0 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 13,
            borderWidth: 1.5,
            borderColor: colors.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="eye" size={21} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {wallet.name}
          </Text>
          {totalLabel !== undefined ? (
            <Text variant="amount" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
              {hidden ? MASK : (totalLabel ?? "—")}
            </Text>
          ) : null}
        </View>
      </Row>
      <View style={{ gap: spacing.sm + 2 }}>
        <Row gap={spacing.md}>
          {nets.length > 0 ? (
            <NetworkStack networks={nets} size={20} ringColor={colors.background} />
          ) : null}
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
            {networksLabel(nets)}
          </Text>
          <Text variant="mono" style={{ color: colors.text }}>
            {shortenAddress(wallet.address, 4, 4)}
          </Text>
        </Row>
        <Row
          gap={spacing.sm}
          style={{
            alignSelf: "flex-start",
            backgroundColor: colors.surface,
            borderRadius: radii.pill,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.xs + 1,
          }}
        >
          <Icon name="lock" size={13} strokeWidth={2} color={colors.textSecondary} />
          <Text variant="caption" tone="secondary">
            {WATCH_ONLY_LABEL}
          </Text>
        </Row>
      </View>
    </View>
  );
  return (
    <View testID={onPress ? undefined : testID}>
      {onPress ? (
        <PressableScale
          onPress={onPress}
          accessibilityLabel={`${wallet.name}, watch only, can't send or be used by agents`}
          testID={testID}
          scaleTo={motion.pressedScaleSubtle}
        >
          {body}
        </PressableScale>
      ) : (
        body
      )}
      {onMore ? (
        <MoreButton label={`More actions for ${wallet.name}`} onPress={onMore} onSurface={false} />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Agents and plugins
// ---------------------------------------------------------------------------

/**
 * Neutral monochrome mark for an agent: its initial, set in the UI face. Assistant
 * logos (Claude, ChatGPT, Grok) are not used; why is in docs/BRAND_ASSETS.md.
 * Agent names come from the connecting client, so a logo here would also lend an
 * unverified client the look of the real assistant.
 */
export function AgentAvatar({
  name,
  size = 44,
}: {
  readonly name: string;
  readonly size?: number;
}) {
  return <Avatar label={name.slice(0, 1)} size={size} shape="squircle" inverted />;
}

export interface AgentCardProps {
  readonly agent: Agent;
  readonly onPress?: () => void;
  readonly pendingApprovals?: number;
  readonly now?: Date;
  readonly testID?: string;
}

export function AgentCard({ agent, onPress, pendingApprovals = 0, now, testID }: AgentCardProps) {
  const { colors } = useTheme();
  const revoked = agent.policy.revoked || agent.revokedAt !== null;
  const autonomous = agent.policy.mode === "autonomous";
  const mode = autonomous ? "Autonomous" : "Always ask";
  const limit =
    autonomous && agent.policy.spendingEnabled
      ? `${formatFiatMinor(agent.policy.limits.dailyUsdMinor, "USD")} a day`
      : agent.policy.spendingEnabled
        ? "Can request payments"
        : "Read only";
  const dot = revoked ? colors.danger : autonomous ? colors.caution : colors.success;
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={`Agent ${agent.name}, ${revoked ? "revoked" : `${mode}, ${limit}`}${pendingApprovals > 0 ? `, ${String(pendingApprovals)} waiting for approval` : ""}`}
      testID={testID}
      scaleTo={motion.pressedScaleSubtle}
    >
      <Card style={{ gap: spacing.md, opacity: revoked ? 0.72 : 1 }}>
        <Row>
          <AgentAvatar name={agent.name} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {agent.name}
            </Text>
            <Text variant="footnote" tone="secondary">
              {agent.lastUsedAt
                ? `Active ${formatRelativeTime(agent.lastUsedAt, now)}`
                : "Not used yet"}
            </Text>
          </View>
          {pendingApprovals > 0 ? (
            <StatusPill label={`${String(pendingApprovals)} waiting`} tone="caution" />
          ) : (
            <Icon name="chevronRight" size={16} strokeWidth={2} color={colors.textSecondary} />
          )}
        </Row>
        <View style={{ height: 1, backgroundColor: colors.separator }} />
        <Row gap={spacing.sm}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
            {revoked ? "Revoked · no access" : `${mode} · ${limit}`}
          </Text>
        </Row>
      </Card>
    </PressableScale>
  );
}

export interface PluginCardProps {
  readonly manifest: PluginManifest;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly onPress?: () => void;
  /** Category label from the app (Payments, Trading, Earn). */
  readonly category?: string;
  readonly icon?: IconName;
  readonly testID?: string;
}

const RISK_TONE = {
  low: "neutral",
  medium: "neutral",
  high: "caution",
  critical: "danger",
} as const;

const RISK_LABEL = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk",
} as const;

export function PluginCard({
  manifest,
  enabled,
  configured,
  onPress,
  category,
  icon = "plug",
  testID,
}: PluginCardProps) {
  const comingSoon = manifest.status === "coming_soon";
  // One mark per chain (mainnet and testnet share a logo).
  const networks = manifest.networks.filter(
    (n, i, all) => all.findIndex((m) => networkLogoKey(m) === networkLogoKey(n)) === i,
  );
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={`${manifest.name} plugin${category ? `, ${category}` : ""}${enabled ? ", enabled" : comingSoon ? ", coming soon" : ""}, ${RISK_LABEL[manifest.riskCategory]}`}
      testID={testID}
      scaleTo={motion.pressedScaleSubtle}
    >
      <Card style={{ gap: spacing.md }}>
        <Row align="flex-start">
          <PluginLogo pluginId={manifest.id} size={44} fallbackIcon={icon} />
          <View style={{ flex: 1, gap: 2 }}>
            <Row gap={spacing.sm}>
              <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                {manifest.name}
              </Text>
              {enabled ? <StatusPill label="On" tone="success" /> : null}
            </Row>
            <Text variant="footnote" tone="secondary" numberOfLines={2}>
              {manifest.description}
            </Text>
          </View>
        </Row>
        <Row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
          {category ? <StatusPill label={category} tone="neutral" /> : null}
          <StatusPill
            label={RISK_LABEL[manifest.riskCategory]}
            tone={RISK_TONE[manifest.riskCategory]}
          />
          {comingSoon ? <StatusPill label="Coming soon" tone="neutral" /> : null}
          {!comingSoon && !configured ? <StatusPill label="Needs setup" tone="caution" /> : null}
          <View style={{ flex: 1 }} />
          {networks.length > 0 ? <NetworkStack networks={networks.slice(0, 4)} size={18} /> : null}
        </Row>
      </Card>
    </PressableScale>
  );
}
