import type { MasumiAgentSummary as MasumiAgent } from "@zyropay/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import {
  BottomSheet,
  breakAnywhere,
  Card,
  CardSkeleton,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  KeyValueRow,
  motion,
  PressableScale,
  radii,
  Row,
  Screen,
  ScreenHeader,
  SearchField,
  Section,
  SecondaryButton,
  spacing,
  Text,
  useTheme,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useMasumiAgents } from "@/api/hooks";
import { MasumiBadges } from "@/components/Masumi";
import {
  endpointHost,
  filterMasumiAgents,
  formatMasumiPricing,
  masumiFacets,
  plainText,
  registeredLabel,
} from "@/lib/masumi";
import { useCopy } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 300;
const LIMIT = 50;

/**
 * Discover agents: search the Masumi agent registry on Cardano for agents your own agent
 * can hire and pay with escrow through ZyroPay. Listings are third-party: names and
 * descriptions render as plain text, the endpoint only as its host (never a link).
 */
export default function DiscoverAgents() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [capability, setCapability] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [open, setOpen] = useState<MasumiAgent | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(input.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [input]);

  // Unfiltered (search only) result for the chips, so a chip doesn't vanish when picked.
  const base = useMasumiAgents({ ...(q !== "" ? { q } : {}), limit: LIMIT });
  const filtered = useMasumiAgents({
    ...(q !== "" ? { q } : {}),
    ...(capability !== null ? { capability } : {}),
    ...(tag !== null ? { tag } : {}),
    limit: LIMIT,
  });
  const facets = masumiFacets(base.data?.agents ?? []);
  const anyFilter = capability !== null || tag !== null;

  return (
    <Screen
      testID="discover-screen"
      refreshing={filtered.isRefetching}
      onRefresh={() => {
        void filtered.refetch();
      }}
    >
      <ScreenHeader
        title="Discover agents"
        subtitle="Agents registered on Masumi, the agent registry on Cardano, that your agent can hire."
        size="inline"
        onBack={() => {
          if (router.canGoBack()) router.back();
          else router.replace("/agents");
        }}
      />
      <SearchField
        value={input}
        onChangeText={setInput}
        placeholder="Search agents"
        testID="discover-search"
      />
      {facets.capabilities.length + facets.tags.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.xl }}
          style={{ marginHorizontal: -spacing.xl, paddingHorizontal: spacing.xl, flexGrow: 0 }}
          accessibilityLabel="Filter by capability or tag"
        >
          <Chip
            label="All"
            selected={!anyFilter}
            onPress={() => {
              setCapability(null);
              setTag(null);
            }}
            testID="discover-filter-all"
          />
          {facets.capabilities.map((c) => (
            <Chip
              key={`c:${c}`}
              label={c}
              selected={capability === c}
              onPress={() => {
                setCapability(capability === c ? null : c);
              }}
              testID={`discover-capability-${c}`}
            />
          ))}
          {facets.tags.map((t) => (
            <Chip
              key={`t:${t}`}
              label={`#${t}`}
              selected={tag === t}
              onPress={() => {
                setTag(tag === t ? null : t);
              }}
              testID={`discover-tag-${t}`}
            />
          ))}
        </ScrollView>
      ) : null}

      {filtered.isPending ? (
        <CardSkeleton rows={3} height={150} />
      ) : filtered.isError ? (
        <ErrorState
          title="Couldn't reach the registry"
          message={errorMessage(filtered.error)}
          onRetry={() => {
            void filtered.refetch();
          }}
        />
      ) : (
        (() => {
          // The API filters; this mirrors it so a stale page never shows a non-matching card.
          const agents = filterMasumiAgents(filtered.data.agents, { capability, tag });
          if (agents.length === 0)
            return (
              <EmptyState
                variant="card"
                icon="search"
                title="No agents found"
                message={
                  q !== "" || anyFilter
                    ? "No registered agent matches. Try another word or clear the filters."
                    : "No agents are registered on Masumi on this network yet."
                }
              />
            );
          return (
            <Section
              title="Registered agents"
              meta={String(agents.length)}
              footer={`Listings come from the Masumi registry on Cardano. Names and descriptions are the sellers' own words.${filtered.data.truncated ? ` Showing matches from the first ${String(filtered.data.scanned)} entries.` : ""}`}
            >
              <View style={{ gap: spacing.md }} testID="discover-results">
                {agents.map((a) => (
                  <AgentListing
                    key={a.agentIdentifier}
                    agent={a}
                    onPress={() => {
                      setOpen(a);
                    }}
                  />
                ))}
              </View>
            </Section>
          );
        })()
      )}

      <BottomSheet
        visible={open !== null}
        onDismiss={() => {
          setOpen(null);
        }}
        testID="discover-sheet"
      >
        {open ? <AgentDetail agent={open} /> : null}
      </BottomSheet>
    </Screen>
  );
}

function AgentListing({
  agent,
  onPress,
}: {
  readonly agent: MasumiAgent;
  readonly onPress: () => void;
}) {
  const name = plainText(agent.name, 80) || "Unnamed agent";
  const host = endpointHost(agent.apiBaseUrl);
  const registered = registeredLabel(agent.registeredAt);
  const meta = [host, registered].filter((x): x is string => x !== null).join(" · ");
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={`${name}, ${formatMasumiPricing(agent.pricing)}, registered on Masumi${agent.masumiEscrow ? ", escrow-protected" : ""}`}
      accessibilityHint="Shows the agent's details"
      scaleTo={motion.pressedScaleSubtle}
      testID={`discover-agent-${agent.agentIdentifier.slice(-8)}`}
    >
      <Card style={{ gap: spacing.sm }}>
        <Row align="flex-start" justify="space-between">
          <Text variant="bodyStrong" numberOfLines={2} style={{ flex: 1 }}>
            {name}
          </Text>
          <Text
            variant="calloutStrong"
            numberOfLines={1}
            style={{ maxWidth: "45%", fontVariant: ["tabular-nums"] }}
            testID="discover-agent-price"
          >
            {formatMasumiPricing(agent.pricing)}
          </Text>
        </Row>
        {agent.description !== null && agent.description.trim() !== "" ? (
          <Text variant="footnote" tone="secondary" numberOfLines={3}>
            {plainText(agent.description, 220)}
          </Text>
        ) : null}
        <MasumiBadges escrow={agent.masumiEscrow} />
        {meta !== "" ? (
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </Card>
    </PressableScale>
  );
}

function AgentDetail({ agent }: { readonly agent: MasumiAgent }) {
  const { colors } = useTheme();
  const { copied, copy } = useCopy();
  const name = plainText(agent.name, 80) || "Unnamed agent";
  const host = endpointHost(agent.apiBaseUrl);
  const registered = registeredLabel(agent.registeredAt);
  const tags = agent.tags.map((t) => plainText(t, 32)).filter((t) => t !== "");
  return (
    <View style={{ gap: spacing.lg }} testID="discover-detail">
      <View style={{ gap: spacing.sm }}>
        <Text variant="headline" accessibilityRole="header">
          {name}
        </Text>
        <MasumiBadges escrow={agent.masumiEscrow} />
      </View>
      {agent.description !== null && agent.description.trim() !== "" ? (
        <Text variant="callout" tone="secondary">
          {plainText(agent.description, 1000)}
        </Text>
      ) : null}

      <Card style={{ paddingVertical: spacing.xs }}>
        <KeyValueRow label="Price" value={formatMasumiPricing(agent.pricing)} emphasis />
        {agent.capability ? (
          <KeyValueRow
            label="Capability"
            value={`${plainText(agent.capability.name, 60)} ${plainText(agent.capability.version, 20)}`.trim()}
          />
        ) : null}
        <KeyValueRow label="Endpoint" value={host ?? "Not a web address"} />
        {registered ? (
          <KeyValueRow label="Registered" value={registered.replace(/^Registered /, "")} />
        ) : null}
        {tags.length > 0 ? <KeyValueRow label="Tags" value={tags.join(", ")} /> : null}
      </Card>

      <View style={{ gap: spacing.sm }}>
        <Text variant="calloutStrong">Agent identifier</Text>
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: radii.md,
            padding: spacing.md,
          }}
        >
          <Text variant="mono" selectable style={breakAnywhere} testID="discover-detail-id">
            {agent.agentIdentifier}
          </Text>
        </View>
        <SecondaryButton
          label={copied ? "Copied" : "Copy identifier"}
          icon={copied ? "check" : "copy"}
          onPress={() => {
            copy(agent.agentIdentifier);
          }}
          testID="discover-detail-copy"
        />
        <Text variant="footnote" tone="secondary">
          The policy id and asset name of the agent's registry NFT on Cardano. Paste it into an
          agent's permissions to trust this agent.
        </Text>
      </View>

      <View style={{ gap: spacing.sm }} testID="discover-detail-hire">
        <Row gap={spacing.sm}>
          <Icon name="sparkle" size={16} strokeWidth={2} color={colors.text} />
          <Text variant="calloutStrong">How your agent hires it</Text>
        </Row>
        <Text variant="callout" tone="secondary">
          {agent.masumiEscrow
            ? "Ask your AI agent (ChatGPT, Claude…) to use it. Through ZyroPay it finds this agent in the Masumi registry and pays over x402, with the payment locked in Masumi Escrow on Cardano: the seller is paid only after delivering, and you can get a Refund if it doesn't."
            : "Ask your AI agent (ChatGPT, Claude…) to use it. Through ZyroPay it finds this agent in the Masumi registry and pays over x402. This agent doesn't take Escrow payments, so it would be paid directly."}
        </Text>
        <Text variant="footnote" tone="secondary">
          Every payment follows your agent's permissions: it asks you first unless it fits your
          autonomous limits.
        </Text>
      </View>
    </View>
  );
}
