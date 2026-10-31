import {
  getPluginManifest,
  type SigningReview,
  type TransactionRequestResult,
} from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import {
  AddressText,
  ApprovalCard,
  breakAnywhere,
  Card,
  EmptyState,
  formatDateTime,
  hasPluginLogo,
  KeyValueRow,
  LoadingSkeleton,
  NetworkBadge,
  PluginLogo,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SecurityWarning,
  shortenAddress,
  SimulatedBadge,
  spacing,
  StatusPill,
  tapHaptic,
  Text,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useApproval, useApproveApproval, useRejectApproval } from "@/api/hooks";
import { ApprovalProgress } from "@/components/ApprovalProgress";
import { EscrowPanel } from "@/components/EscrowPanel";
import { allowanceFallback } from "@/lib/allowance";
import { QueryView } from "@/components/QueryView";
import { X402Purpose } from "@/components/X402Purpose";
import { useKnownSymbols } from "@/hooks/useKnownSymbols";
import { escrowProtection, escrowTermsOf, policyReasonText } from "@/lib/escrow";
import { sellerBadge } from "@/lib/masumi";
import {
  checkReviewIntegrity,
  deviceVerifiedLine,
  riskOf,
  stampForReview,
  summarizeReview,
  symbolFor,
} from "@/lib/review";
import { useSigner } from "@/lib/turnkey";
import { firstParam } from "@/lib/utils";
import { alwaysNeedsPasskey, deliveryNotice, requestProgress, x402Purpose } from "@/lib/x402";
import { useSession } from "@/state";

type Outcome =
  | { kind: "approved"; request: TransactionRequestResult; review: SigningReview }
  | { kind: "rejected" };

const CARDANO_PASSKEY_NOTE =
  "Cardano payments always ask for your passkey: Turnkey's signing policies can't read Cardano transactions, so ZyroPay never signs ADA for an agent on its own.";

/**
 * Approval detail. Approve = hold, then passkey: the app stamps
 * SIGN_TRANSACTION_V2 over exactly the reviewed unsigned bytes (Cardano:
 * SIGN_RAW_PAYLOAD_V2 over the reviewed body hash, ADR-002) with
 * StamperType.Passkey and the API verifies them (ADR-001 D2). Reject = swipe.
 */
export default function ApprovalDetail() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const detail = useApproval(id);
  const approve = useApproveApproval();
  const reject = useRejectApproval();
  const signer = useSigner();
  const symbols = useKnownSymbols();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const back = () => {
    router.back();
  };

  const onApprove = async () => {
    setError(null);
    setSigning(true);
    try {
      // ADR-001 D4: sign the latest unsigned bytes (Solana blockhashes are rebuilt near expiry).
      const fresh = await detail.refetch();
      if (!fresh.data) throw new Error("Couldn't load the latest version of this request.");
      const { review, approval } = fresh.data;
      const integrity = checkReviewIntegrity(review, approval);
      if (!integrity.ok) throw new Error(integrity.problems.join(" "));
      const signRequest = await stampForReview(signer, review, orgId);
      const res = await approve.mutateAsync({
        approvalId: approval.id,
        body: { payloadHash: review.payloadHash, signRequest },
      });
      tapHaptic("success");
      setOutcome({ kind: "approved", request: res.request, review });
    } catch (e) {
      tapHaptic("error");
      setError(errorMessage(e));
    } finally {
      setSigning(false);
    }
  };

  const onReject = () => {
    setError(null);
    reject.mutate(
      { approvalId: id },
      {
        onSuccess: () => {
          setOutcome({ kind: "rejected" });
        },
        onError: (e) => {
          setError(errorMessage(e));
        },
      },
    );
  };

  if (outcome?.kind === "approved") {
    const { request, review } = outcome;
    // The approve answer is a snapshot; the approval query keeps polling the request
    // (useApproval) until it settles, so prefer its copy once it shows the decision.
    const live =
      detail.data?.approval.status === "approved" &&
      detail.data.review.request.id === request.requestId
        ? detail.data.review.request
        : null;
    const txHash = live?.txHash ?? request.txHash;
    const escrowTerms = escrowTermsOf(review.payload);
    const progress = requestProgress({
      state: live?.state ?? request.state,
      network: review.payload.network,
      x402: review.payload.plugin === "x402",
      escrow: escrowTerms !== null,
      failureReason: live?.failureReason ?? null,
      txHash,
    });
    const s = summarizeReview(review, symbolFor(review, symbols));
    const purpose = x402Purpose(review.payload);
    const liveEscrow = detail.data?.x402?.escrow;
    return (
      <Screen
        edges={["top", "bottom"]}
        testID="approval-approved"
        footer={<PrimaryButton label="Done" onPress={back} testID="approval-done" />}
      >
        <EmptyState
          icon={
            progress.tone === "danger" ? "warning" : progress.tone === "success" ? "check" : "clock"
          }
          title={progress.title}
          message={
            purpose
              ? `${s.amountLabel}${s.fiatLabel ? ` (${s.fiatLabel})` : ""} for ${purpose.description ? `“${purpose.description}” from ` : ""}${purpose.host}${escrowTerms ? ", held in escrow until delivered" : ""}`
              : `${s.amountLabel} to ${s.recipientShort}`
          }
        />
        <ApprovalProgress
          progress={progress}
          showTitle={false}
          network={review.payload.network}
          txHash={txHash}
          simulated={request.simulated}
          delivery={deliveryNotice(live ? detail.data?.x402 : null)}
        />
        {liveEscrow ? (
          <EscrowPanel
            requestId={review.request.id}
            network={review.payload.network}
            initial={liveEscrow}
            simulated={request.simulated}
          />
        ) : null}
      </Screen>
    );
  }

  if (outcome?.kind === "rejected") {
    return (
      <Screen
        edges={["top", "bottom"]}
        testID="approval-rejected"
        footer={<PrimaryButton label="Done" onPress={back} testID="approval-done" />}
      >
        <EmptyState
          icon="close"
          title="Rejected"
          message="The agent was told no. Nothing was signed."
        />
      </Screen>
    );
  }

  return (
    <Screen testID="approval-detail">
      <ScreenHeader title="Review request" size="inline" onBack={back} />
      <QueryView query={detail} loading={<LoadingSkeleton height={260} radius={24} />}>
        {({ approval, review, agent, x402 }) => {
          const p = review.payload;
          const s = summarizeReview(review, symbolFor(review, symbols));
          const integrity = checkReviewIntegrity(review, approval);
          const pending = approval.status === "pending";
          const plugin = p.plugin ? getPluginManifest(p.plugin) : undefined;
          const purpose = x402Purpose(p);
          const escrowTerms = escrowTermsOf(p);
          const canSign = pending && integrity.ok && signer.kind !== "unavailable";
          // The agent has an auto-pay allowance, but this payment fell back to the passkey.
          const autoPayFallback = allowanceFallback(review.request.policyReasons);
          return (
            <View style={{ gap: spacing.xl }}>
              {pending ? (
                <ApprovalCard
                  agentName={agent?.name ?? "You"}
                  action={s.action}
                  amountLabel={s.amountLabel}
                  fiatLabel={s.fiatLabel}
                  recipientLabel={
                    escrowTerms ? shortenAddress(escrowTerms.sellerAddress, 6, 6) : s.recipientShort
                  }
                  recipientCaption={purpose ? "Seller" : "To"}
                  purpose={
                    purpose ? (
                      <X402Purpose
                        purpose={purpose}
                        escrow={escrowTerms ? escrowProtection(escrowTerms) : null}
                        seller={sellerBadge(x402?.sellerIdentity)}
                      />
                    ) : undefined
                  }
                  {...(alwaysNeedsPasskey(p.network) ? { note: CARDANO_PASSKEY_NOTE } : {})}
                  network={p.network}
                  expiresAt={approval.expiresAt}
                  simulated={review.request.simulated}
                  risk={riskOf(review, integrity.ok)}
                  busy={signing || approve.isPending || reject.isPending}
                  {...(canSign
                    ? {
                        onApprove: () => {
                          void onApprove();
                        },
                      }
                    : {})}
                  onReject={onReject}
                  testID="approval-card"
                />
              ) : (
                <Card style={{ gap: spacing.sm }}>
                  <StatusPill
                    label={approval.status.charAt(0).toUpperCase() + approval.status.slice(1)}
                    tone={
                      approval.status === "approved"
                        ? "success"
                        : approval.status === "rejected"
                          ? "danger"
                          : "neutral"
                    }
                  />
                  {purpose?.description ? (
                    <Text variant="bodyStrong">{purpose.description}</Text>
                  ) : null}
                  <Text variant="title">{s.amountLabel}</Text>
                  {approval.decidedAt ? (
                    <Text variant="callout" tone="secondary">
                      {`Decided ${formatDateTime(approval.decidedAt)}`}
                    </Text>
                  ) : null}
                </Card>
              )}
              {approval.status === "approved" ? (
                <ApprovalProgress
                  progress={requestProgress({
                    state: review.request.state,
                    network: p.network,
                    x402: p.plugin === "x402",
                    escrow: escrowTerms !== null,
                    failureReason: review.request.failureReason,
                    txHash: review.request.txHash,
                  })}
                  network={p.network}
                  txHash={review.request.txHash}
                  simulated={review.request.simulated}
                  delivery={deliveryNotice(x402)}
                />
              ) : null}
              {approval.status === "approved" && x402?.escrow ? (
                <EscrowPanel
                  requestId={review.request.id}
                  network={p.network}
                  initial={x402.escrow}
                  simulated={review.request.simulated}
                />
              ) : null}

              {pending && integrity.ok && integrity.verified ? (
                <Text variant="footnote" tone="secondary" testID="approval-device-verified">
                  {deviceVerifiedLine(integrity.verified, s.amountLabel)}
                </Text>
              ) : null}
              {/* The integrity check guards approving; a decided request has nothing to approve. */}
              {pending && !integrity.ok ? (
                <SecurityWarning
                  severity="danger"
                  title="Do not approve"
                  message={`This request failed ZyroPay's integrity check: ${integrity.problems.join(" ")}`}
                />
              ) : null}
              {pending && signer.kind === "unavailable" ? (
                <SecurityWarning
                  severity="info"
                  title="Signing unavailable"
                  message={signer.unavailableReason ?? undefined}
                />
              ) : null}
              {/* Testnet and Simulated are already on the card; the rest need words. */}
              {review.warnings
                .filter((w) => w.code !== "SIMULATED" && w.code !== "TESTNET")
                .map((w) => (
                  <SecurityWarning
                    key={w.code}
                    severity={w.code === "SIMULATED" || w.code === "TESTNET" ? "info" : "warning"}
                    title={
                      w.code === "FIRST_TIME_RECIPIENT"
                        ? "New recipient"
                        : w.code === "UNVERIFIED_TOKEN"
                          ? "Unverified token"
                          : w.code === "HIGH_FEE"
                            ? "High fee"
                            : w.code === "PRICE_UNAVAILABLE"
                              ? "No price"
                              : w.code === "TESTNET"
                                ? "Testnet"
                                : "Simulated"
                    }
                    message={w.message}
                  />
                ))}
              {error ? (
                <SecurityWarning severity="danger" title="Not approved" message={error} />
              ) : null}
              {autoPayFallback !== null && pending ? (
                <View testID="approval-autopay-fallback">
                  <SecurityWarning
                    severity="info"
                    title={`Auto-pay didn't cover this: ${autoPayFallback.title.charAt(0).toLowerCase()}${autoPayFallback.title.slice(1)}`}
                    message={`${autoPayFallback.message} Your on-chain allowance wasn't touched.`}
                  />
                </View>
              ) : null}

              <Section title="Details">
                <Card style={{ paddingVertical: spacing.sm }}>
                  <KeyValueRow label="Agent" value={agent?.name ?? "In-app"} emphasis />
                  <KeyValueRow label="Action" value={s.action} />
                  <KeyValueRow label="Amount" value={s.amountLabel} emphasis />
                  <KeyValueRow label="Value" value={s.fiatLabel ?? "No price available"} />
                  {escrowTerms ? (
                    <KeyValueRow
                      label="Seller"
                      value={<AddressText address={escrowTerms.sellerAddress} align="right" />}
                    />
                  ) : null}
                  <KeyValueRow
                    label={escrowTerms ? "Paid into (escrow)" : "To"}
                    value={<AddressText address={p.to} align="right" />}
                  />
                  <KeyValueRow label="From" value={shortenAddress(p.from, 6, 6)} />
                  <KeyValueRow label="Network" value={<NetworkBadge network={p.network} />} />
                  <KeyValueRow label="Tool" value={p.tool} />
                  <KeyValueRow
                    label="Plugin"
                    value={
                      plugin && hasPluginLogo(plugin.id) ? (
                        <Row gap={spacing.sm} style={{ alignSelf: "flex-end" }}>
                          <PluginLogo pluginId={plugin.id} size={22} />
                          <Text variant="callout">{plugin.name}</Text>
                        </Row>
                      ) : (
                        (plugin?.name ?? "None (plain transfer)")
                      )
                    }
                  />
                  <KeyValueRow label="Network fee" value={s.feeLabel} />
                  <KeyValueRow
                    label="Mode"
                    value={
                      agent
                        ? agent.policy.mode === "autonomous"
                          ? "Autonomous (over limit)"
                          : "Always ask"
                        : "Your send"
                    }
                  />
                  {review.request.policyReasons.length > 0 ? (
                    <KeyValueRow
                      label="Why you're asked"
                      value={review.request.policyReasons.map((r) => policyReasonText(r)).join(" ")}
                    />
                  ) : null}
                  {purpose ? (
                    <KeyValueRow
                      label="Resource"
                      value={
                        <Text
                          variant="footnote"
                          align="right"
                          selectable
                          style={breakAnywhere}
                          testID="approval-resource-url"
                        >
                          {purpose.url}
                        </Text>
                      }
                    />
                  ) : null}
                  <KeyValueRow label="Expires" value={formatDateTime(approval.expiresAt)} />
                  <KeyValueRow
                    label="Payload hash"
                    value={
                      <Text variant="mono" tone="secondary" align="right">
                        {shortenAddress(review.payloadHash, 8, 8)}
                      </Text>
                    }
                  />
                </Card>
                {review.request.simulated ? <SimulatedBadge /> : null}
              </Section>
            </View>
          );
        }}
      </QueryView>
    </Screen>
  );
}
