import type { Agent, CardanoAllowance } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import {
  AddressInput,
  Card,
  formatFiat,
  Icon,
  KeyValueRow,
  LoadingSkeleton,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SecondaryButton,
  SecurityWarning,
  SegmentedControl,
  shortenAddress,
  spacing,
  Text,
  TextButton,
  TextField,
  ToggleRow,
} from "@zyropay/ui";
import { useAgent, useAgentAllowance, useAgentRequests, useWallets } from "@/api/hooks";
import { autoPayBlocker } from "@/components/AllowanceCard";
import { useAllowanceSigning } from "@/components/AllowanceSigning";
import { QueryView } from "@/components/QueryView";
import { useAdaPriceState } from "@/hooks/useAdaPrice";
import {
  ada,
  amountKeystrokes,
  checkAllowanceDraft,
  conversionPreview,
  convertAmount,
  defaultAllowanceDraft,
  draftFromAllowance,
  EXPIRY_CHOICES,
  isAllowancePayee,
  isLiveAllowance,
  MAX_PAYEES,
  suggestedPayees,
  type AllowanceDraft,
  type DraftField,
  type FiatCurrency,
  type MoneyUnit,
} from "@/lib/allowance";
import { firstParam } from "@/lib/utils";

const UNIT_LABEL: Readonly<Record<MoneyUnit, string>> = { EUR: "€ EUR", ADA: "ADA", USD: "$ USD" };

/** Auto-pay on Cardano: set up the agent's on-chain allowance (one passkey tap). */
export default function AutoPayScreen() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const agent = useAgent(id);
  const allowance = useAgentAllowance(id);
  return (
    <Screen testID="autopay-setup">
      <QueryView query={agent} loading={<LoadingSkeleton height={400} radius={24} />}>
        {(a) =>
          allowance.isPending ? (
            <LoadingSkeleton height={400} radius={24} />
          ) : (
            <AutoPaySetup
              key={`${a.id}:${allowance.data?.id ?? "new"}`}
              agent={a}
              existing={allowance.data ?? null}
            />
          )
        }
      </QueryView>
    </Screen>
  );
}

function back(agentId: string) {
  if (router.canGoBack()) router.back();
  else router.replace(`/agents/${agentId}`);
}

function AutoPaySetup({
  agent,
  existing,
}: {
  readonly agent: Agent;
  readonly existing: CardanoAllowance | null;
}) {
  const wallets = useWallets();
  const requests = useAgentRequests(agent.id);
  const cardanoWallets = useMemo(
    () =>
      (wallets.data ?? []).filter(
        (w) =>
          agent.policy.allowedWalletIds.includes(w.id) &&
          w.addresses.some((x) => x.family === "cardano" && x.address.startsWith("addr_test1")),
      ),
    [wallets.data, agent.policy.allowedWalletIds],
  );
  const suggestions = useMemo(
    () =>
      suggestedPayees(
        agent.policy.recipientAllowlist,
        (requests.data?.items ?? []).map((i) => i.request),
      ),
    [agent.policy.recipientAllowlist, requests.data],
  );
  const pending = existing?.status === "pending_create" ? existing : null;
  const [draft, setDraft] = useState<AllowanceDraft>(() =>
    pending !== null
      ? draftFromAllowance(pending)
      : defaultAllowanceDraft({
          walletId: null,
          currency: "EUR",
          payees: suggestions.map((s) => s.address),
        }),
  );
  // The wallet and the suggestions may arrive after the first render.
  const walletId =
    draft.walletId ?? (cardanoWallets.length === 1 ? (cardanoWallets[0]?.id ?? null) : null);
  const [touchedPayees, setTouchedPayees] = useState(pending !== null);
  const payees = touchedPayees
    ? draft.payees
    : [...new Set([...draft.payees, ...suggestions.map((s) => s.address)])].slice(0, MAX_PAYEES);
  const effective: AllowanceDraft = { ...draft, walletId, payees };
  const [extra, setExtra] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const fiatCurrency: FiatCurrency = draft.unit === "USD" ? "USD" : "EUR";
  const eur = useAdaPriceState("EUR");
  const usd = useAdaPriceState("USD");
  const prices = { EUR: eur.price, USD: usd.price };
  const price = prices[fiatCurrency];
  // No EUR price (some environments price in USD only): start in USD instead, once known.
  const [unitTouched, setUnitTouched] = useState(pending !== null);
  if (
    !unitTouched &&
    draft.unit === "EUR" &&
    eur.settled &&
    eur.price === null &&
    usd.price !== null
  ) {
    setUnitTouched(true);
    setDraft((d) => ({ ...d, unit: "USD" }));
  }
  const check = checkAllowanceDraft(effective, price?.value ?? null);
  const signing = useAllowanceSigning(agent.id, (action) => {
    if (action === "create") back(agent.id);
  });
  const blocker = autoPayBlocker(agent);
  const live =
    existing !== null && isLiveAllowance(existing) && existing.status !== "pending_create";

  const set = (patch: Partial<AllowanceDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };
  const issue = (field: DraftField, severity: "error" | "warning" = "error") =>
    check.issues.find((i) => i.field === field && i.severity === severity)?.message ?? null;
  const shownError = (field: DraftField) => (attempted || field !== "payees" ? issue(field) : null);

  const amountField = (key: "budget" | "perPayment" | "perDay", label: string, note: string) => {
    const preview = conversionPreview(draft[key], draft.unit, price);
    return (
      <TextField
        label={label}
        value={draft[key]}
        onChangeText={(t) => {
          set({ [key]: amountKeystrokes(t) });
        }}
        keyboardType="decimal-pad"
        placeholder="0"
        error={draft[key] === "" && !attempted ? null : shownError(key)}
        hint={preview !== null ? `${preview} · ${note}` : note}
        accessibilityLabel={`${label}, in ${draft.unit}`}
        testID={`autopay-${key}`}
      />
    );
  };

  const candidate = extra.trim();
  const candidateOk = isAllowancePayee(candidate) && !payees.includes(candidate);
  const labelOf = (addr: string) =>
    suggestions.find((s) => s.address === addr)?.label ?? "Cardano address";
  const listed = [...new Set([...suggestions.map((s) => s.address), ...payees])];

  if (live)
    return (
      <View style={{ gap: spacing.xl }}>
        <ScreenHeader
          title="Auto-pay on Cardano"
          subtitle={agent.name}
          size="inline"
          onBack={() => {
            back(agent.id);
          }}
        />
        <SecurityWarning
          severity="info"
          title="Auto-pay is already set up"
          message="This agent has an allowance. Top it up or revoke it from the agent's page."
        />
        <SecondaryButton
          label="Back to the agent"
          onPress={() => {
            back(agent.id);
          }}
        />
      </View>
    );

  return (
    <View style={{ gap: spacing.xl }}>
      <ScreenHeader
        title="Auto-pay on Cardano"
        subtitle={agent.name}
        size="inline"
        onBack={() => {
          back(agent.id);
        }}
      />

      <Card style={{ gap: spacing.sm }} testID="autopay-intro">
        <Row gap={spacing.sm}>
          <Icon name="shieldCheck" size={18} />
          <Text variant="calloutStrong" style={{ flex: 1 }}>
            Limits enforced by Cardano
          </Text>
        </Row>
        <Text variant="footnote" tone="secondary">
          Payments within these limits go through without asking you. Cardano itself enforces the
          limits — not ZyroPay. Anything above them still comes to you.
        </Text>
        <Text variant="caption" tone="secondary">
          The budget is locked in your own allowance contract. Only you can take it back, with one
          tap, at any time. Cardano Preprod only; the contract is not audited.
        </Text>
      </Card>

      {blocker !== null ? (
        <View testID="autopay-blocked">
          <SecurityWarning
            severity="warning"
            title="Not available for this agent yet"
            message={blocker}
          >
            <TextButton
              label="Open Permissions"
              icon="sliders"
              onPress={() => {
                router.push({ pathname: "/agents/[id]/policy", params: { id: agent.id } });
              }}
            />
          </SecurityWarning>
        </View>
      ) : null}

      <Section title="Wallet">
        {cardanoWallets.length === 0 ? (
          <SecurityWarning
            severity="info"
            title="No Cardano wallet shared"
            message="Share a wallet that has a Cardano account with this agent (Permissions → Wallets), or add a Cardano account to your wallet."
          />
        ) : cardanoWallets.length === 1 ? (
          <Card style={{ paddingVertical: spacing.sm }}>
            <KeyValueRow label="Funded from" value={cardanoWallets[0]?.name ?? "Wallet"} />
          </Card>
        ) : (
          <SegmentedControl
            options={cardanoWallets.map((w) => ({ value: w.id, label: w.name }))}
            value={walletId ?? ""}
            onChange={(v) => {
              set({ walletId: v });
            }}
            testID="autopay-wallet"
          />
        )}
        {shownError("wallet") !== null && cardanoWallets.length > 1 ? (
          <Text variant="caption" tone="danger">
            {shownError("wallet")}
          </Text>
        ) : null}
      </Section>

      <Section title="Limits">
        <SegmentedControl
          options={(["EUR", "ADA", "USD"] as const).map((u) => ({
            value: u,
            label: UNIT_LABEL[u],
          }))}
          value={draft.unit}
          onChange={(unit) => {
            setUnitTouched(true);
            setDraft((d) => {
              // Keep the amounts when switching units: convert them at the live price (via ADA).
              const from = d.unit === "ADA" ? null : prices[d.unit];
              const to = unit === "ADA" ? null : prices[unit];
              if ((d.unit !== "ADA" && from === null) || (unit !== "ADA" && to === null))
                return { ...d, unit };
              const conv = (v: string) =>
                convertAmount(convertAmount(v, d.unit, "ADA", from), "ADA", unit, to);
              return {
                ...d,
                unit,
                budget: conv(d.budget),
                perPayment: conv(d.perPayment),
                perDay: conv(d.perDay),
              };
            });
          }}
          testID="autopay-unit"
        />
        {amountField("budget", "Budget", "locked in the allowance")}
        {amountField("perPayment", "Max per payment", "bigger payments come to you")}
        {amountField("perDay", "Max per day", "resets every 24 hours")}
        {issue("perDay", "warning") !== null ? (
          <Text variant="caption" tone="caution" testID="autopay-warning">
            {issue("perDay", "warning")}
          </Text>
        ) : null}
        <Text variant="caption" tone="secondary" testID="autopay-price">
          {draft.unit === "ADA"
            ? "Amounts in ADA are exact."
            : price !== null
              ? `At ${formatFiat(price.value, price.currency)} per ADA now. ZyroPay converts once, when you confirm; you sign the exact ADA amounts.`
              : "The ADA price is unavailable right now. ZyroPay converts when you confirm; you'll see and sign the exact ADA amounts."}
        </Text>
      </Section>

      <Section title="Payees">
        <Card style={{ paddingVertical: spacing.xs }}>
          <ToggleRow
            title="Any payee"
            subtitle={
              draft.payeeMode === "any"
                ? "The agent can pay anyone within the limits."
                : "Only the payees below."
            }
            value={draft.payeeMode === "any"}
            onValueChange={(on) => {
              set({ payeeMode: on ? "any" : "list" });
            }}
            testID="autopay-any-payee"
          />
          {draft.payeeMode === "list"
            ? listed.map((addr) => (
                <ToggleRow
                  key={addr}
                  title={labelOf(addr)}
                  subtitle={shortenAddress(addr, 12, 6)}
                  value={payees.includes(addr)}
                  onValueChange={(on) => {
                    setTouchedPayees(true);
                    set({
                      payees: on
                        ? [...payees.filter((x) => x !== addr), addr]
                        : payees.filter((x) => x !== addr),
                    });
                  }}
                  testID={`autopay-payee-${addr.slice(-8)}`}
                />
              ))
            : null}
        </Card>
        {draft.payeeMode === "any" ? (
          <SecurityWarning
            severity="warning"
            title="Any payee"
            message="If the agent (or ZyroPay's server) were compromised, the limits would still hold, but the money could go anywhere. A list is safer."
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            {listed.length === 0 ? (
              <Text variant="caption" tone="secondary">
                No Cardano recipients or x402 sellers for this agent yet. Add the seller's address.
              </Text>
            ) : null}
            <AddressInput
              value={extra}
              onChangeText={setExtra}
              valid={candidate === "" ? null : candidateOk}
              errorMessage={
                payees.includes(candidate)
                  ? "Already on the list."
                  : "Not a Cardano Preprod address (addr_test1…)."
              }
              placeholder="addr_test1…"
              label="Add a payee"
              testID="autopay-payee-input"
            />
            <SecondaryButton
              label="Add payee"
              icon="plus"
              disabled={!candidateOk || payees.length >= MAX_PAYEES}
              onPress={() => {
                setTouchedPayees(true);
                set({ payees: [...payees, candidate] });
                setExtra("");
              }}
              testID="autopay-payee-add"
            />
            {shownError("payees") !== null ? (
              <Text variant="caption" tone="danger" testID="autopay-payees-error">
                {shownError("payees")}
              </Text>
            ) : (
              <Text variant="caption" tone="secondary">
                {`Up to ${String(MAX_PAYEES)} payees. Cardano checks each payment's recipient against this list.`}
              </Text>
            )}
          </View>
        )}
      </Section>

      <Section title="Expires">
        <SegmentedControl
          options={EXPIRY_CHOICES.map((d) => ({ value: String(d), label: `${String(d)} days` }))}
          value={String(draft.expiresInDays)}
          onChange={(v) => {
            set({ expiresInDays: Number(v) });
          }}
          testID="autopay-expiry"
        />
        <Text variant="caption" tone="secondary">
          After that, payments come to you again. Revoke to get what's left back.
        </Text>
      </Section>

      <View style={{ gap: spacing.md }}>
        <TextButton
          label={showAdvanced ? "Hide advanced" : "Advanced: agent's ADA for fees"}
          icon="sliders"
          onPress={() => {
            setShowAdvanced((v) => !v);
          }}
          testID="autopay-advanced"
        />
        {showAdvanced || issue("float") !== null ? (
          <TextField
            label="Agent's ADA for fees"
            value={draft.floatAda}
            onChangeText={(t) => {
              set({ floatAda: amountKeystrokes(t) });
            }}
            keyboardType="decimal-pad"
            error={issue("float")}
            hint="Sent to the agent's own key to pay network fees (about 0.3 ADA a payment). Comes back when you revoke. 3 to 20 ADA."
            testID="autopay-float"
          />
        ) : null}
      </View>

      <Card style={{ paddingVertical: spacing.sm }} testID="autopay-summary">
        <KeyValueRow
          label="You lock"
          value={check.lovelace.budget !== null ? ada(check.lovelace.budget) : "—"}
          emphasis
        />
        <KeyValueRow
          label="Agent's fee ADA"
          value={check.lovelace.float !== null ? ada(check.lovelace.float) : "—"}
        />
        <KeyValueRow label="Network" value="Cardano Preprod" />
      </Card>

      {signing.errorView}
      {attempted && !check.ok ? (
        <SecurityWarning
          severity="warning"
          title="Fix before continuing"
          message={check.issues
            .filter((i) => i.severity === "error")
            .map((i) => i.message)
            .join(" ")}
        />
      ) : null}
      {!signing.signable ? (
        <SecurityWarning
          severity="info"
          title="Passkey needed"
          message={signing.unavailableReason ?? "Signing with your passkey isn't available here."}
        />
      ) : null}
      <PrimaryButton
        label="Review and sign"
        icon="passkey"
        disabled={blocker !== null || cardanoWallets.length === 0 || signing.busy}
        loading={signing.preparing === "create"}
        onPress={() => {
          setAttempted(true);
          if (check.body === null) return;
          void signing.start({ action: "create", body: check.body }, { create: check.body });
        }}
        accessibilityHint="Builds the allowance transaction for you to check and sign"
        testID="autopay-continue"
      />
      <Text variant="caption" tone="secondary" align="center">
        One passkey tap. Nothing moves until you sign.
      </Text>

      {signing.reviewSheet}
    </View>
  );
}
