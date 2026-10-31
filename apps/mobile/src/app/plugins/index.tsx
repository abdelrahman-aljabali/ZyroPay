import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import {
  Card,
  CardSkeleton,
  Chip,
  EmptyState,
  IconTile,
  Row,
  StatusPill,
  Text,
  TextButton,
  PluginCard,
  Screen,
  ScreenHeader,
  SearchField,
  Section,
  SegmentedControl,
  spacing,
} from "@zyropay/ui";
import { usePlugins } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import {
  CATEGORY_ICON,
  MASUMI_ESCROW_LISTING,
  masumiListingMatches,
  PLUGIN_CATEGORIES,
  pluginDescription,
  pluginCategory,
  swapUnavailableReason,
  type PluginCategory,
} from "@/lib/plugins";

/** Plugin marketplace (shared registry + the user's enablement). */
export default function Plugins() {
  const plugins = usePlugins();
  const [tab, setTab] = useState<"all" | "installed">("all");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PluginCategory | null>(null);

  return (
    <Screen testID="plugins-screen">
      <ScreenHeader
        title="Plugins"
        subtitle="Protocols your agents can use. Each one only works where you allow it."
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <SegmentedControl
        options={[
          { value: "all", label: "Marketplace" },
          { value: "installed", label: "Enabled" },
        ]}
        value={tab}
        onChange={setTab}
        testID="plugins-tab"
      />
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search plugins"
        testID="plugins-search"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.xl }}
        style={{ marginHorizontal: -spacing.xl, paddingHorizontal: spacing.xl }}
        accessibilityLabel="Filter by category"
      >
        <Chip
          label="All"
          selected={category === null}
          onPress={() => {
            setCategory(null);
          }}
        />
        {PLUGIN_CATEGORIES.map((c) => (
          <Chip
            key={c}
            label={c}
            selected={category === c}
            onPress={() => {
              setCategory(c);
            }}
            testID={`plugins-category-${c}`}
          />
        ))}
      </ScrollView>
      <QueryView query={plugins} loading={<CardSkeleton rows={3} height={132} />}>
        {(list) => {
          const q = query.trim().toLowerCase();
          const shown = list
            .filter((p) => tab === "all" || p.enabled)
            .filter((p) => category === null || pluginCategory(p.manifest) === category)
            .filter(
              (p) =>
                q === "" ||
                p.manifest.name.toLowerCase().includes(q) ||
                pluginDescription(p.manifest).toLowerCase().includes(q),
            );
          // Masumi escrow sits next to x402 (it is x402's escrow on Cardano), not a plugin of its own.
          const x402 = list.find((p) => p.manifest.id === "x402");
          const showMasumi =
            x402 !== undefined &&
            (tab === "all" || x402.enabled) &&
            (category === null || category === "Payments") &&
            masumiListingMatches(query);
          if (shown.length === 0 && !showMasumi) {
            return (
              <EmptyState
                variant="card"
                icon="plug"
                title={tab === "installed" ? "No plugins enabled" : "No matches"}
                message={
                  tab === "installed"
                    ? swapUnavailableReason() === null
                      ? "Enable a plugin to let agents pay with x402 or swap with Jupiter."
                      : "Enable a plugin to let agents pay with x402."
                    : undefined
                }
              />
            );
          }
          const available = shown.filter((p) => p.manifest.status !== "coming_soon");
          const soon = shown.filter((p) => p.manifest.status === "coming_soon");
          const card = (p: (typeof shown)[number]) => (
            <PluginCard
              key={p.manifest.id}
              manifest={{ ...p.manifest, description: pluginDescription(p.manifest) }}
              enabled={p.enabled}
              configured={p.configured}
              category={pluginCategory(p.manifest)}
              icon={CATEGORY_ICON[pluginCategory(p.manifest)]}
              onPress={() => {
                router.push({ pathname: "/plugins/[id]", params: { id: p.manifest.id } });
              }}
              testID={`plugin-card-${p.manifest.id}`}
            />
          );
          const availableCards = available.flatMap((p) =>
            p.manifest.id === "x402" && showMasumi
              ? [card(p), <MasumiEscrowCard key="masumi-escrow" />]
              : [card(p)],
          );
          if (showMasumi && !available.some((p) => p.manifest.id === "x402"))
            availableCards.unshift(<MasumiEscrowCard key="masumi-escrow" />);
          return (
            <View style={{ gap: spacing.xxl }}>
              {availableCards.length > 0 ? (
                <Section title="Available" meta={String(available.length)}>
                  <View style={{ gap: spacing.md }}>{availableCards}</View>
                </Section>
              ) : null}
              {soon.length > 0 ? (
                <Section title="Coming soon" meta={String(soon.length)}>
                  <View style={{ gap: spacing.md }}>{soon.map(card)}</View>
                </Section>
              ) : null}
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}

/** Masumi escrow next to x402: what it does and a way to the agents that take it. */
function MasumiEscrowCard() {
  return (
    <Card style={{ gap: spacing.md }} testID="plugin-card-masumi-escrow">
      <Row align="flex-start">
        <IconTile icon="shieldCheck" size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {MASUMI_ESCROW_LISTING.name}
          </Text>
          <Text variant="footnote" tone="secondary" numberOfLines={2}>
            {MASUMI_ESCROW_LISTING.line}
          </Text>
        </View>
      </Row>
      <Row gap={spacing.sm} justify="space-between">
        <StatusPill label="Part of x402" tone="neutral" />
        <TextButton
          label="Discover agents"
          icon="chevronRight"
          onPress={() => {
            router.push("/agents/discover");
          }}
          testID="plugins-discover-agents"
        />
      </Row>
    </Card>
  );
}
