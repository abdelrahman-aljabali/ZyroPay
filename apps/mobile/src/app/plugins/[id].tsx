import { getNetwork } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { View } from "react-native";
import {
  Card,
  ConfirmationSheet,
  EmptyState,
  Icon,
  LoadingSkeleton,
  PluginLogo,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SecondaryButton,
  SecurityWarning,
  spacing,
  StatusPill,
  Text,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { usePlugins, useSetPluginEnabled } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import {
  CATEGORY_ICON,
  offersSwap,
  PERMISSION_COPY,
  pluginCategory,
  swapUnavailableReason,
} from "@/lib/plugins";
import { firstParam } from "@/lib/utils";

/** Plugin detail: what it does, permissions, risk, networks, enable/disable. */
export default function PluginDetail() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const plugins = usePlugins();
  const setEnabled = useSetPluginEnabled();
  const [confirming, setConfirming] = useState(false);

  return (
    <Screen testID="plugin-detail">
      <QueryView query={plugins} loading={<LoadingSkeleton height={300} radius={24} />}>
        {(list) => {
          const item = list.find((p) => p.manifest.id === id);
          if (!item) return <EmptyState icon="plug" title="Plugin not found" />;
          const m = item.manifest;
          const comingSoon = m.status === "coming_soon";
          // Testnet builds: Jupiter has no route, so say so instead of offering a swap.
          const noSwap = offersSwap(m) ? swapUnavailableReason() : null;
          const openHomepage = () => {
            void WebBrowser.openBrowserAsync(m.homepage);
          };
          return (
            <View style={{ gap: spacing.xl }}>
              <ScreenHeader
                title={m.name}
                subtitle={m.description}
                size="inline"
                onBack={() => {
                  router.back();
                }}
              />
              <Row gap={spacing.md} align="center">
                <PluginLogo
                  pluginId={m.id}
                  size={56}
                  fallbackIcon={CATEGORY_ICON[pluginCategory(m)]}
                  onOpenHomepage={openHomepage}
                  homepageLabel={`${m.name} website`}
                  testID="plugin-logo"
                />
                <Row gap={spacing.sm} style={{ flex: 1, flexWrap: "wrap" }}>
                  <StatusPill
                    label={item.enabled ? "Enabled" : comingSoon ? "Coming soon" : "Not enabled"}
                    tone={item.enabled ? "success" : "neutral"}
                  />
                  <StatusPill
                    label={`${m.riskCategory} risk`}
                    tone={
                      m.riskCategory === "critical"
                        ? "danger"
                        : m.riskCategory === "high"
                          ? "caution"
                          : "neutral"
                    }
                  />
                  {!comingSoon && !item.configured && noSwap === null ? (
                    <StatusPill label="Not configured on this server" tone="caution" />
                  ) : null}
                </Row>
              </Row>

              <Section title="Permissions">
                <Card style={{ gap: spacing.lg }}>
                  {m.requiredPermissions.map((perm) => (
                    <Row key={perm} align="flex-start" gap={spacing.md}>
                      <Icon
                        name={perm === "spend_funds" || perm === "leverage" ? "warning" : "shield"}
                        size={20}
                      />
                      <View style={{ flex: 1, gap: spacing.xxs }}>
                        <Text variant="calloutStrong">{PERMISSION_COPY[perm].title}</Text>
                        <Text variant="caption" tone="secondary">
                          {PERMISSION_COPY[perm].body}
                        </Text>
                      </View>
                    </Row>
                  ))}
                </Card>
              </Section>

              <Section title="Actions">
                <Card style={{ gap: spacing.md }}>
                  {m.tools.map((t) => (
                    <View key={t.name} style={{ gap: spacing.xxs }}>
                      <Text variant="calloutStrong">{t.name}</Text>
                      <Text variant="caption" tone="secondary">
                        {t.description}
                        {t.mcpTool
                          ? ` Agents call it with “${t.mcpTool}”.`
                          : " Not available to agents yet."}
                      </Text>
                    </View>
                  ))}
                </Card>
              </Section>

              <Section title="Networks">
                <Text variant="callout" tone="secondary">
                  {m.networks.length > 0
                    ? m.networks.map((n) => getNetwork(n).displayName).join(", ")
                    : "No supported ZyroPay network yet."}
                </Text>
              </Section>

              {noSwap !== null ? (
                <SecurityWarning
                  severity="info"
                  title="No swaps on test networks"
                  message={noSwap}
                />
              ) : null}

              {m.notes.map((note) => (
                <SecurityWarning key={note} severity="info" title="Note" message={note} />
              ))}

              {setEnabled.isError ? (
                <SecurityWarning
                  severity="danger"
                  title="Couldn't update"
                  message={errorMessage(setEnabled.error)}
                />
              ) : null}

              {comingSoon ? null : item.enabled ? (
                <SecondaryButton
                  label="Disable"
                  destructive
                  loading={setEnabled.isPending}
                  onPress={() => {
                    setEnabled.mutate({ pluginId: m.id, enabled: false });
                  }}
                  testID="plugin-disable"
                />
              ) : (
                <PrimaryButton
                  label="Enable"
                  disabled={!item.configured || noSwap !== null}
                  onPress={() => {
                    setConfirming(true);
                  }}
                  testID="plugin-enable"
                />
              )}
              <SecondaryButton label="Website" icon="external" onPress={openHomepage} />
              <Text variant="caption" tone="secondary">
                Enabling a plugin makes it available. Each agent still needs it allowed in its own
                permissions.
              </Text>

              <ConfirmationSheet
                visible={confirming}
                title={`Enable ${m.name}?`}
                message="It will be able to:"
                rows={m.requiredPermissions.map((p) => ({
                  label: PERMISSION_COPY[p].title,
                  value: "Yes",
                }))}
                confirmLabel="Enable"
                loading={setEnabled.isPending}
                onCancel={() => {
                  setConfirming(false);
                }}
                onConfirm={() => {
                  setEnabled.mutate(
                    { pluginId: m.id, enabled: true },
                    {
                      onSettled: () => {
                        setConfirming(false);
                      },
                    },
                  );
                }}
                testID="plugin-enable-sheet"
              />
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
