import {
  chainFamilyOf,
  getNetwork,
  isValidAddress,
  isValueMovingTool,
  MCP_TOOL_NAMES,
  mcpTools,
  networksForMode,
  PLUGIN_REGISTRY,
  type Agent,
  type ChainFamily,
  type McpToolName,
} from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  AddressInput,
  Card,
  formatFiatMinor,
  IconButton,
  ListRow,
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
import { apiClient, errorMessage, isApiError, withSessionHint } from "@/api";
import { useAgent, usePortfolio, useUpdateAgentPolicy, useWallets } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { AutonomousSetupError, nativeUsdPrices, prepareAutonomous } from "@/lib/autonomous";
import { env } from "@/lib/env";
import {
  addTrustedAgent,
  shortAgentIdentifier,
  TRUSTED_AGENT_ERROR,
  type TrustedAgentInputError,
} from "@/lib/masumi";
import { offersSwap, swapUnavailableReason } from "@/lib/plugins";
import {
  centsToDollars,
  dollarsToCents,
  draftFromPolicy,
  escrowThresholdFromInput,
  escrowThresholdToInput,
  makeAllowlistEntry,
  validateDraft,
  type PolicyDraft,
} from "@/lib/policy-draft";
import { useSigner } from "@/lib/turnkey";
import { firstParam } from "@/lib/utils";
import { useSession } from "@/state";

const NETWORKS = networksForMode(env.mode);
/** Masumi escrow (and its registry check) lives on Cardano only. */
const CARDANO_NETWORKS = NETWORKS.filter((n) => chainFamilyOf(n) === "cardano");

const FAMILY_NAME: Readonly<Record<ChainFamily, string>> = {
  solana: "Solana",
  evm: "EVM",
  cardano: "Cardano",
};
const FAMILY_PLACEHOLDER: Readonly<Record<ChainFamily, string>> = {
  solana: "Solana address",
  evm: "0x…",
  cardano: env.mode === "production" ? "addr1…" : "addr_test1…",
};
const FAMILIES: readonly ChainFamily[] = ["solana", "evm", "cardano"];

const TOOL_LABELS: Readonly<Record<McpToolName, string>> = {
  get_balance: "Read balances",
  get_wallets: "Read wallets and addresses",
  get_transactions: "Read transaction history",
  send: "Request transfers",
  swap: "Request swaps",
  pay_x402: "Pay for web resources (x402)",
  get_approval_status: "Check request status",
  get_agent_policy: "Read its own permissions",
};

export default function PolicyScreen() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const agent = useAgent(id);
  return (
    <Screen testID="policy-editor">
      <QueryView query={agent} loading={<LoadingSkeleton height={400} radius={24} />}>
        {(a) => <PolicyEditor key={`${a.id}:${String(a.policy.version)}`} agent={a} />}
      </QueryView>
    </Screen>
  );
}

/** Policy editor: Always Ask vs Autonomous, tools, plugins, limits, recipients, scope. */
function PolicyEditor({ agent }: { readonly agent: Agent }) {
  const signer = useSigner();
  const wallets = useWallets();
  const portfolio = usePortfolio();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const update = useUpdateAgentPolicy(agent.id);
  const [setup, setSetup] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFromPolicy(agent.policy));
  const [limits, setLimits] = useState({
    per: centsToDollars(agent.policy.limits.perTransactionUsdMinor),
    daily: centsToDollars(agent.policy.limits.dailyUsdMinor),
    monthly: centsToDollars(agent.policy.limits.monthlyUsdMinor),
  });
  const [escrow, setEscrow] = useState(() =>
    escrowThresholdToInput(agent.policy.x402EscrowAboveUsdMinor),
  );
  const [trustedInput, setTrustedInput] = useState("");
  const [trustedError, setTrustedError] = useState<TrustedAgentInputError | null>(null);
  // Start the picker on the first network this agent may use (Cardano for an ADA-only agent).
  const [family, setFamily] = useState<ChainFamily>(() => {
    const first = agent.policy.allowedNetworks[0];
    return first === undefined ? "solana" : chainFamilyOf(first);
  });
  const [recipientNote, setRecipientNote] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const requireRegistered = draft.requireRegisteredAgent ?? false;
  const trusted = draft.trustedAgentIdentifiers ?? [];
  const set = (patch: Partial<PolicyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };
  const toggleIn = <T,>(list: readonly T[], item: T, on: boolean): T[] =>
    on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item);

  let limitError: string | null = null;
  let effective: PolicyDraft = draft;
  try {
    effective = {
      ...draft,
      limits: {
        perTransactionUsdMinor: dollarsToCents(limits.per),
        dailyUsdMinor: dollarsToCents(limits.daily),
        monthlyUsdMinor: dollarsToCents(limits.monthly),
      },
    };
  } catch {
    limitError = "Limits must be plain dollar amounts, like 25 or 12.50.";
  }
  let escrowError: string | null = null;
  try {
    effective = { ...effective, x402EscrowAboveUsdMinor: escrowThresholdFromInput(escrow) };
  } catch {
    escrowError = "The escrow threshold must be a plain dollar amount, like 5 or 2.50.";
  }
  const issues = limitError || escrowError ? [] : validateDraft(effective);
  // ADR-001 D6: switching to autonomous first sets up the delegated signer with the passkey.
  const needsSetup = draft.mode === "autonomous" && agent.policy.mode !== "autonomous";
  // Fail closed: no passkey signer (Turnkey not configured, Expo Go) => no autonomous mode.
  const autonomousBlocked = needsSetup && signer.kind === "unavailable";
  const candidate = makeAllowlistEntry(family, newAddress, newLabel);
  const duplicate =
    candidate !== null &&
    draft.recipientAllowlist.some(
      (x) => x.family === candidate.family && x.address === candidate.address,
    );
  const escrowOn = escrow.on;
  const escrowEverything =
    escrow.on && (escrowError !== null || effective.x402EscrowAboveUsdMinor === "0");
  // Escrow (and the registry check) need a Cardano network the agent may use.
  const cardanoAllowed = draft.allowedNetworks.some((n) => chainFamilyOf(n) === "cardano");
  const needsCardano =
    (escrowOn || requireRegistered) && !cardanoAllowed && CARDANO_NETWORKS.length > 0;
  // Testnet builds have no swap route: explain it where swaps would be allowed.
  const noSwap = swapUnavailableReason();

  const save = async () => {
    if (limitError || escrowError || issues.length > 0 || autonomousBlocked || setup.busy) return;
    setSetup({ busy: true, error: null });
    let extra = {};
    try {
      if (needsSetup) {
        extra = await prepareAutonomous({
          call: (name, input) => apiClient.call(name, input),
          signer,
          organizationId: orgId,
          policy: effective,
          nativeUsdPrice: nativeUsdPrices(portfolio.data),
        });
      }
    } catch (e) {
      setSetup({
        busy: false,
        error: e instanceof AutonomousSetupError ? withSessionHint(e.message) : errorMessage(e),
      });
      return;
    }
    setSetup({ busy: false, error: null });
    update.mutate(
      { expectedVersion: agent.policy.version, policy: effective, ...extra },
      {
        onSuccess: () => {
          // Opened from a deep link (web), there is no screen to go back to.
          if (router.canGoBack()) router.back();
          else router.replace(`/agents/${agent.id}`);
        },
      },
    );
  };

  const limitField = (key: "per" | "daily" | "monthly", label: string) => (
    <TextField
      label={label}
      value={limits[key]}
      onChangeText={(t) => {
        setLimits((l) => ({ ...l, [key]: t.replace(/[^0-9.]/g, "") }));
      }}
      keyboardType="decimal-pad"
      placeholder="0"
      hint="US dollars"
      testID={`limit-${key}`}
    />
  );

  return (
    <View style={{ gap: spacing.xl }}>
      <ScreenHeader
        title="Permissions"
        subtitle={agent.name}
        size="inline"
        onBack={() => {
          router.back();
        }}
      />

      <Section title="Mode">
        <SegmentedControl
          options={[
            { value: "always_ask", label: "Always ask" },
            { value: "autonomous", label: "Autonomous" },
          ]}
          value={draft.mode}
          onChange={(mode) => {
            set({ mode });
          }}
          testID="policy-mode"
        />
        <Text variant="callout" tone="secondary">
          {draft.mode === "always_ask"
            ? "Every payment waits for you to approve it with your passkey. ZyroPay holds no signing ability at all."
            : "Payments inside your limits go through without asking. You grant ZyroPay's server a revocable, limited signing permission for this; Turnkey enforces a per-payment cap and ZyroPay enforces the dollar limits."}
        </Text>
        {autonomousBlocked ? (
          <SecurityWarning
            severity="info"
            title="Passkey needed"
            message={`Turning on autonomous mode needs your passkey to create a limited signing permission. ${signer.unavailableReason ?? ""}`}
          />
        ) : needsSetup ? (
          <Text variant="caption" tone="secondary" testID="autonomous-setup-note">
            Saving asks for your passkey twice: once to add ZyroPay's limited signing key to your
            wallet, once to set its per-payment cap. If you used autonomous mode before, it also
            asks to remove the old key. You can remove it any time.
          </Text>
        ) : null}
        {draft.mode === "autonomous" && draft.allowedTools.includes("swap") ? (
          <Text variant="caption" tone="secondary">
            Swaps always ask, even in autonomous mode: a swap router can move more than the amount
            shown.
          </Text>
        ) : null}
      </Section>

      <Card style={{ paddingVertical: spacing.xs }}>
        <ToggleRow
          title="Allow spending"
          subtitle={
            draft.spendingEnabled
              ? "On: the agent can ask to pay, within the rules below."
              : "Off: the agent can only read."
          }
          value={draft.spendingEnabled}
          onValueChange={(v) => {
            set({ spendingEnabled: v });
          }}
          testID="policy-spending"
        />
      </Card>

      {agent.policy.allowedNetworks.includes("cardano-preprod") ? (
        <Card style={{ paddingVertical: spacing.xs }}>
          <ListRow
            icon="bolt"
            title="Auto-pay on Cardano"
            subtitle="An on-chain allowance: small ADA payments without a tap, limits enforced by Cardano"
            onPress={() => {
              router.push(`/agents/${agent.id}/autopay`);
            }}
            testID="policy-autopay"
          />
        </Card>
      ) : null}

      {draft.mode === "autonomous" ? (
        <Section title="Limits">
          {limitField("per", "Per payment")}
          {limitField("daily", "Per day")}
          {limitField("monthly", "Per month")}
          <SegmentedControl
            options={[
              { value: "require_approval", label: "Above limits: ask me" },
              { value: "deny", label: "Refuse" },
            ]}
            value={draft.overLimitBehavior}
            onChange={(v) => {
              set({ overLimitBehavior: v });
            }}
          />
          {limitError ? (
            <Text variant="caption" tone="danger">
              {limitError}
            </Text>
          ) : (
            <Text variant="caption" tone="secondary">
              {`Up to ${formatFiatMinor(effective.limits.perTransactionUsdMinor, "USD")} each, ${formatFiatMinor(effective.limits.dailyUsdMinor, "USD")} a day. If a price is unavailable, the payment asks you.${env.mode === "production" ? "" : " Testnet SOL, ETH, ADA and USDC count at mainnet prices."}`}
            </Text>
          )}
        </Section>
      ) : null}

      {draft.allowedTools.includes("pay_x402") ? (
        <Section title="Escrow">
          <Card style={{ paddingVertical: spacing.xs }}>
            <ToggleRow
              title="Require Escrow for x402 payments"
              subtitle={
                !escrow.on
                  ? "Off"
                  : escrowEverything
                    ? "Every x402 payment"
                    : `Above ${formatFiatMinor(effective.x402EscrowAboveUsdMinor ?? "0", "USD")}`
              }
              value={escrow.on}
              onValueChange={(on) => {
                setEscrow((e) => ({ ...e, on }));
              }}
              testID="policy-escrow"
            />
          </Card>
          {escrow.on ? (
            <TextField
              label="Only above (optional)"
              value={escrow.dollars}
              onChangeText={(t) => {
                setEscrow((e) => ({ ...e, dollars: t.replace(/[^0-9.]/g, "") }));
              }}
              keyboardType="decimal-pad"
              placeholder="Any amount"
              hint="US dollars. Leave empty to require Escrow for every x402 payment."
              testID="policy-escrow-threshold"
            />
          ) : null}
          {escrowError ? (
            <Text variant="caption" tone="danger" testID="policy-escrow-error">
              {escrowError}
            </Text>
          ) : (
            <Text variant="caption" tone="secondary">
              {escrow.on
                ? `${escrowEverything ? "x402 payments" : "Bigger x402 payments"} must be locked in Masumi Escrow on Cardano: the seller is paid only after delivering, and you can get a Refund if they don't. A payment without Escrow ${escrowEverything ? "" : "above this amount "}${draft.overLimitBehavior === "deny" && draft.mode === "autonomous" ? "is refused" : "asks you first"}${escrowEverything ? "" : "; one without a price counts as above"}.`
                : "Off: agents may pay x402 sellers directly. Turn on so the seller is paid only after delivering, with a Refund if they don't."}
            </Text>
          )}
        </Section>
      ) : null}

      {draft.allowedTools.includes("pay_x402") && needsCardano ? (
        <View testID="policy-escrow-needs-cardano">
          <SecurityWarning
            severity="warning"
            title="Cardano isn't allowed for this agent"
            message="Escrow and the registry check run on Cardano. Allow a Cardano network under Wallets and networks, or this agent can't make Escrow payments."
          >
            <TextButton
              label={`Allow ${getNetwork(CARDANO_NETWORKS[0] ?? "cardano-preprod").displayName}`}
              icon="plus"
              onPress={() => {
                const n = CARDANO_NETWORKS[0];
                if (n !== undefined) set({ allowedNetworks: [...draft.allowedNetworks, n] });
              }}
              testID="policy-allow-cardano"
            />
          </SecurityWarning>
        </View>
      ) : null}

      {draft.allowedTools.includes("pay_x402") ? (
        <Section title="Sellers">
          <Card style={{ paddingVertical: spacing.xs }}>
            <ToggleRow
              title="Only pay registered Masumi agents"
              subtitle={requireRegistered ? "On" : "Off"}
              value={requireRegistered}
              onValueChange={(on) => {
                set({ requireRegisteredAgent: on });
              }}
              testID="policy-require-registered"
            />
          </Card>
          <Text variant="caption" tone="secondary">
            {requireRegistered
              ? `Before an x402 payment, ZyroPay checks on Cardano that the seller holds its Masumi registry NFT. Payments to other sellers are refused.${escrowEverything ? " Only Escrow payments carry this proof, so direct x402 payments are refused too." : ""}`
              : "Off: agents may pay any x402 seller. Turn on to pay only sellers registered on Masumi, the agent registry on Cardano."}
          </Text>
          {requireRegistered && !escrowEverything ? (
            <View testID="policy-registered-needs-escrow">
              <SecurityWarning
                severity="info"
                title="Direct payments will be refused"
                message="Only Escrow payments carry the registry proof. Require Escrow for every x402 payment so this agent's payments aren't refused."
              >
                <TextButton
                  label="Require Escrow for every payment"
                  icon="shieldCheck"
                  onPress={() => {
                    setEscrow({ on: true, dollars: "" });
                  }}
                  testID="policy-registered-escrow-fix"
                />
              </SecurityWarning>
            </View>
          ) : null}
          {requireRegistered ? (
            <View style={{ gap: spacing.md }} testID="policy-trusted-agents">
              <Text variant="calloutStrong">Trusted agents (optional)</Text>
              <Text variant="caption" tone="secondary">
                Empty: any registered agent. Add agent identifiers to pay only those agents.
              </Text>
              <TextButton
                label="Find agents in Discover"
                icon="search"
                onPress={() => {
                  router.push("/agents/discover");
                }}
                accessibilityHint="Opens the Masumi agent registry; copy an identifier there"
                testID="policy-trusted-discover"
              />
              {trusted.map((id) => (
                <Row key={id} justify="space-between">
                  <Text variant="mono" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>
                    {shortAgentIdentifier(id, 12, 8)}
                  </Text>
                  <IconButton
                    icon="trash"
                    variant="plain"
                    accessibilityLabel={`Remove trusted agent ${shortAgentIdentifier(id)}`}
                    onPress={() => {
                      set({ trustedAgentIdentifiers: trusted.filter((x) => x !== id) });
                    }}
                  />
                </Row>
              ))}
              <TextField
                label="Agent identifier"
                value={trustedInput}
                onChangeText={(t) => {
                  setTrustedInput(t);
                  setTrustedError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Paste a 120-character identifier"
                error={trustedError ? TRUSTED_AGENT_ERROR[trustedError] : null}
                testID="policy-trusted-input"
              />
              <SecondaryButton
                label="Add trusted agent"
                icon="plus"
                disabled={trustedInput.trim() === ""}
                onPress={() => {
                  const next = addTrustedAgent(trusted, trustedInput);
                  setTrustedError(next.error);
                  if (next.error === null) {
                    set({ trustedAgentIdentifiers: next.list });
                    setTrustedInput("");
                  }
                }}
                testID="policy-trusted-add"
              />
            </View>
          ) : null}
        </Section>
      ) : null}

      <Section title="Recipients">
        <Card style={{ paddingVertical: spacing.xs }}>
          <ToggleRow
            title="Only allowed addresses"
            subtitle="Recommended. Payments elsewhere are refused."
            value={draft.restrictRecipients}
            onValueChange={(v) => {
              set({ restrictRecipients: v });
            }}
            testID="policy-restrict"
          />
        </Card>
        {draft.restrictRecipients && draft.recipientAllowlist.length === 0 ? (
          <Text variant="caption" tone="secondary" testID="allowlist-empty">
            {draft.allowedTools.includes("pay_x402")
              ? "No addresses yet: every payment is refused until you add one below. For x402, add the seller's address (with Escrow, the address it is paid out to)."
              : "No addresses yet: every payment is refused until you add one below."}
          </Text>
        ) : null}
        {draft.recipientAllowlist.map((r) => (
          <Row key={`${r.family}:${r.address}`} justify="space-between">
            <View style={{ flex: 1 }}>
              <Text variant="calloutStrong">
                {r.label ??
                  (r.family === "solana"
                    ? "Solana address"
                    : r.family === "cardano"
                      ? "Cardano address"
                      : "EVM address")}
              </Text>
              <Text variant="mono" tone="secondary">
                {shortenAddress(r.address, 6, 6)}
              </Text>
            </View>
            <IconButton
              icon="trash"
              variant="plain"
              accessibilityLabel={`Remove ${r.label ?? r.address}`}
              onPress={() => {
                set({ recipientAllowlist: draft.recipientAllowlist.filter((x) => x !== r) });
              }}
            />
          </Row>
        ))}
        {draft.restrictRecipients ? (
          <View style={{ gap: spacing.md }}>
            <SegmentedControl
              options={FAMILIES.map((f) => ({ value: f, label: FAMILY_NAME[f] }))}
              value={family}
              onChange={(f) => {
                setFamily(f);
                setRecipientNote(null);
              }}
              testID="allowlist-family"
            />
            <AddressInput
              value={newAddress}
              onChangeText={(t) => {
                setNewAddress(t);
                // A pasted address of another chain switches the picker instead of failing.
                const other = FAMILIES.find((f) => f !== family && isValidAddress(f, t.trim()));
                if (!isValidAddress(family, t.trim()) && other !== undefined) {
                  setFamily(other);
                  setRecipientNote(
                    `Looks like a ${FAMILY_NAME[other]} address: switched to ${FAMILY_NAME[other]}.`,
                  );
                } else setRecipientNote(null);
              }}
              valid={newAddress === "" ? null : candidate !== null && !duplicate}
              errorMessage={
                duplicate
                  ? "Already on the list."
                  : `Not a valid ${FAMILY_NAME[family]} address.${family === "cardano" ? " Use a wallet address (addr…), not a script." : ""}`
              }
              placeholder={FAMILY_PLACEHOLDER[family]}
              label={`${FAMILY_NAME[family]} address`}
              testID="allowlist-address"
            />
            {recipientNote !== null ? (
              <Text variant="caption" tone="secondary" testID="allowlist-note">
                {recipientNote}
              </Text>
            ) : null}
            <TextField
              label="Label (optional)"
              value={newLabel}
              onChangeText={setNewLabel}
              maxLength={64}
            />
            <SecondaryButton
              label="Add recipient"
              icon="plus"
              disabled={candidate === null || duplicate || draft.recipientAllowlist.length >= 200}
              onPress={() => {
                if (!candidate || duplicate) return;
                set({ recipientAllowlist: [...draft.recipientAllowlist, candidate] });
                setNewAddress("");
                setNewLabel("");
                setRecipientNote(null);
              }}
              testID="allowlist-add"
            />
          </View>
        ) : null}
      </Section>

      <Section title="Tools">
        <Card style={{ paddingVertical: spacing.xs }}>
          {MCP_TOOL_NAMES.map((t) => (
            <ToggleRow
              key={t}
              title={TOOL_LABELS[t]}
              subtitle={
                t === "swap" && noSwap !== null
                  ? noSwap
                  : isValueMovingTool(t)
                    ? "Moves money"
                    : mcpTools[t].description
              }
              value={draft.allowedTools.includes(t)}
              onValueChange={(on) => {
                set({ allowedTools: toggleIn(draft.allowedTools, t, on) });
              }}
              testID={`tool-${t}`}
            />
          ))}
        </Card>
      </Section>

      <Section title="Plugins">
        <Card style={{ paddingVertical: spacing.xs }}>
          {PLUGIN_REGISTRY.map((p) => (
            <ToggleRow
              key={p.id}
              title={p.name}
              subtitle={
                p.status === "coming_soon"
                  ? "Coming soon"
                  : offersSwap(p) && noSwap !== null
                    ? "Solana mainnet only: not on test networks"
                    : `${p.riskCategory} risk`
              }
              disabled={p.status === "coming_soon" || (offersSwap(p) && noSwap !== null)}
              value={draft.allowedProtocols.includes(p.id)}
              onValueChange={(on) => {
                set({ allowedProtocols: toggleIn(draft.allowedProtocols, p.id, on) });
              }}
            />
          ))}
        </Card>
      </Section>

      <Section title="Wallets and networks">
        <Card style={{ paddingVertical: spacing.xs }}>
          {wallets.data?.map((w) => (
            <ToggleRow
              key={w.id}
              title={w.name}
              value={draft.allowedWalletIds.includes(w.id)}
              onValueChange={(on) => {
                set({ allowedWalletIds: toggleIn(draft.allowedWalletIds, w.id, on) });
              }}
            />
          ))}
          {NETWORKS.map((n) => (
            <ToggleRow
              key={n}
              title={getNetwork(n).displayName}
              value={draft.allowedNetworks.includes(n)}
              onValueChange={(on) => {
                set({ allowedNetworks: toggleIn(draft.allowedNetworks, n, on) });
              }}
            />
          ))}
        </Card>
      </Section>

      {issues.length > 0 ? (
        <SecurityWarning
          severity="warning"
          title="Fix before saving"
          message={issues.map((i) => i.message).join(" ")}
        />
      ) : null}
      {setup.error !== null ? (
        <SecurityWarning
          severity="danger"
          title="Autonomous mode wasn't turned on"
          message={setup.error}
        />
      ) : null}
      {update.isError ? (
        <SecurityWarning
          severity="danger"
          title={
            isApiError(update.error, "VERSION_CONFLICT") ? "Changed elsewhere" : "Couldn't save"
          }
          message={
            isApiError(update.error, "VERSION_CONFLICT")
              ? "These permissions were changed on another device. Go back and open them again."
              : errorMessage(update.error)
          }
        />
      ) : null}
      <PrimaryButton
        label="Save permissions"
        disabled={
          limitError !== null || escrowError !== null || issues.length > 0 || autonomousBlocked
        }
        loading={update.isPending || setup.busy}
        onPress={() => {
          void save();
        }}
        testID="policy-save"
      />
    </View>
  );
}
