import { getNetwork, isImportedKeyWallet, networksForMode } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import {
  ActionButton,
  AddressText,
  AssetRow,
  Avatar,
  CardSkeleton,
  chainFamilyLabel,
  formatShortDate,
  Icon,
  IconButton,
  ListGroup,
  ListRow,
  NetworkStack,
  PressableScale,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SimulatedBadge,
  spacing,
  Text,
  useTheme,
} from "@zyropay/ui";
import { usePortfolio, useWallet } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { WalletSheets, type WalletTarget } from "@/components/WalletSheets";
import { usePriceChanges } from "@/hooks/usePriceChanges";
import { listedBalances, pricedAssetIds } from "@/lib/asset-list";
import { env } from "@/lib/env";
import { firstParam, useCopy } from "@/lib/utils";
import { usePrefs } from "@/state";

const NETWORKS = networksForMode(env.mode);

/** Wallet detail: accounts (copy), quick actions, holdings, recovery export, rename and remove. */
export default function WalletDetail() {
  const params = useLocalSearchParams<{ id: string; created?: string; imported?: string }>();
  const id = firstParam(params.id);
  const justImported = firstParam(params.imported) === "1";
  const justCreated = firstParam(params.created) === "1" || justImported;
  const { colors, reducedMotion } = useTheme();
  const wallet = useWallet(id);
  const hidden = usePrefs((s) => s.hideBalances);
  const currency = usePrefs((s) => s.currency);
  const portfolio = usePortfolio({ walletId: id, currency });
  const holdings = useMemo(() => listedBalances(portfolio.data?.balances ?? []), [portfolio.data]);
  const priceChanges = usePriceChanges(
    useMemo(() => pricedAssetIds(holdings), [holdings]),
    currency,
  );
  const { copied, copy } = useCopy();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [target, setTarget] = useState<WalletTarget | null>(null);

  return (
    <Screen testID="wallet-detail">
      <QueryView query={wallet} loading={<CardSkeleton rows={2} height={180} />}>
        {(w) => (
          <View style={{ gap: spacing.xl }}>
            <ScreenHeader
              title=""
              size="inline"
              onBack={() => {
                router.back();
              }}
              actions={
                <IconButton
                  icon="more"
                  accessibilityLabel={`More actions for ${w.name}`}
                  onPress={() => {
                    setTarget({ kind: "wallet", id: w.id, name: w.name });
                  }}
                  testID="wallet-more"
                />
              }
            />
            {justCreated ? (
              <Animated.View entering={reducedMotion ? undefined : FadeInDown.duration(260)}>
                <Row
                  gap={spacing.sm}
                  style={{
                    backgroundColor: colors.successSoft,
                    borderRadius: 16,
                    padding: spacing.md,
                  }}
                >
                  <Icon name="checkCircle" size={20} color={colors.success} />
                  <Text variant="calloutStrong" style={{ color: colors.success, flex: 1 }}>
                    {justImported
                      ? env.mocksActive
                        ? "Wallet imported (simulated)"
                        : "Wallet imported with your passkey"
                      : "Wallet created with your passkey"}
                  </Text>
                </Row>
              </Animated.View>
            ) : null}
            <Row gap={spacing.lg}>
              <Avatar label={w.name} icon="wallet" inverted shape="squircle" size={56} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="headline" accessibilityRole="header" numberOfLines={2}>
                  {w.name}
                </Text>
                <Text variant="footnote" tone="secondary">
                  {`${isImportedKeyWallet(w) ? "Imported key" : "Passkey wallet"} · added ${formatShortDate(w.createdAt)}`}
                </Text>
              </View>
            </Row>

            <Row gap={spacing.sm}>
              <ActionButton
                icon="arrowDown"
                label="Receive"
                primary
                onPress={() => {
                  router.push({ pathname: "/wallets/[id]/receive", params: { id: w.id } });
                }}
                testID="wallet-receive"
              />
              <ActionButton
                icon="arrowUp"
                label="Send"
                onPress={() => {
                  router.push("/send");
                }}
              />
            </Row>

            <Section title="Accounts" footer="One EVM address works on every EVM chain listed.">
              <ListGroup>
                {w.addresses.map((a) => {
                  const nets = NETWORKS.filter((n) => getNetwork(n).family === a.family);
                  const label = nets.map((n) => getNetwork(n).displayName).join(", ");
                  const isCopied = copied && copiedAddress === a.address;
                  return (
                    <PressableScale
                      key={a.id}
                      onPress={() => {
                        setCopiedAddress(a.address);
                        copy(a.address);
                      }}
                      accessibilityLabel={
                        isCopied
                          ? "Copied"
                          : `Copy ${a.family === "evm" ? label : chainFamilyLabel(a.family)} address`
                      }
                      accessibilityHint={label}
                      scaleTo={1}
                      highlight={colors.surfaceStrong}
                      testID={`copy-address-${a.family}`}
                    >
                      <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                        <Row>
                          {nets.length > 0 ? <NetworkStack networks={nets} size={22} /> : null}
                          <Text variant="calloutStrong" style={{ flex: 1 }} numberOfLines={1}>
                            {label || chainFamilyLabel(a.family)}
                          </Text>
                          <Row gap={spacing.xs}>
                            <Icon
                              name={isCopied ? "check" : "copy"}
                              size={16}
                              color={isCopied ? colors.success : colors.textSecondary}
                            />
                            <Text
                              variant="label"
                              style={{ color: isCopied ? colors.success : colors.textSecondary }}
                            >
                              {isCopied ? "Copied" : "Copy"}
                            </Text>
                          </Row>
                        </Row>
                        <AddressText address={a.address} />
                        <Text variant="caption" tone="secondary">
                          {isImportedKeyWallet(w) ? "Imported private key" : a.derivationPath}
                        </Text>
                      </View>
                    </PressableScale>
                  );
                })}
              </ListGroup>
            </Section>

            <Section
              title="Holdings"
              badge={portfolio.data?.simulated === true ? <SimulatedBadge /> : undefined}
            >
              <QueryView
                query={portfolio}
                isEmpty={() => holdings.length === 0}
                empty={
                  <Text variant="callout" tone="secondary">
                    Nothing here yet. Receive funds to this wallet to see them.
                  </Text>
                }
              >
                {(p) => (
                  <ListGroup inset={72}>
                    {holdings.map((b) => (
                      <AssetRow
                        key={b.asset.id}
                        balance={b}
                        change={priceChanges.get(b.asset.id) ?? null}
                        hidden={hidden}
                        simulated={p.simulated}
                        onPress={() => {
                          router.push({
                            pathname: "/asset/[assetId]",
                            params: { assetId: b.asset.id },
                          });
                        }}
                        testID={`holding-row-${b.asset.symbol}-${b.network}`}
                      />
                    ))}
                  </ListGroup>
                )}
              </QueryView>
            </Section>

            <ListGroup inset={58}>
              <ListRow
                icon="key"
                title={isImportedKeyWallet(w) ? "Export private key" : "Export recovery phrase"}
                subtitle="Requires your passkey"
                onPress={() => {
                  router.push({ pathname: "/wallets/[id]/export", params: { id: w.id } });
                }}
                testID="wallet-export"
              />
              <ListRow
                icon="pencil"
                title="Rename"
                onPress={() => {
                  setTarget({ kind: "wallet", id: w.id, name: w.name });
                }}
                testID="wallet-rename"
              />
              <ListRow
                icon="trash"
                title="Remove from ZyroPay"
                subtitle="Keys stay in your Turnkey sub-organization"
                destructive
                onPress={() => {
                  setTarget({ kind: "wallet", id: w.id, name: w.name });
                }}
                testID="wallet-remove"
              />
            </ListGroup>
            <WalletSheets
              target={target}
              onClose={() => {
                setTarget(null);
              }}
              afterRemove={() => {
                router.back();
              }}
            />
          </View>
        )}
      </QueryView>
    </Screen>
  );
}
