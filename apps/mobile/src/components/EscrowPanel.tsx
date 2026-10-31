import type { NetworkId, SigningReview, X402Escrow, X402EscrowAction } from "@zyropay/shared";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import {
  Card,
  ConfirmationSheet,
  formatCountdown,
  Icon,
  KeyValueRow,
  PrimaryButton,
  Row,
  SecondaryButton,
  SecurityWarning,
  shortenAddress,
  spacing,
  tapHaptic,
  Text,
  TextButton,
  useTheme,
} from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";
import { usePrepareEscrowAction, useSubmitEscrowAction, useX402Escrow } from "@/api/hooks";
import {
  adaLabel,
  checkEscrowReviewIntegrity,
  deadlineValue,
  ESCROW_ACTION_COPY,
  escrowActions,
  escrowErrorMessage,
  escrowProofNotice,
  type EscrowProofNotice,
  escrowSpendRows,
  escrowTxLinks,
  escrowView,
} from "@/lib/escrow";
import { deviceVerifiedLine, stampForReview, type DeviceVerification } from "@/lib/review";
import { useSigner } from "@/lib/turnkey";
import { explorerLink } from "@/lib/x402";
import { useSession } from "@/state";
import { StepMark } from "./ApprovalProgress";

function useNow(tickMs: number | null): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (tickMs === null) return;
    const t = setInterval(() => {
      setNow(new Date());
    }, tickMs);
    return () => {
      clearInterval(t);
    };
  }, [tickMs]);
  return now;
}

/**
 * Proof before release: what the agent received vs the result the seller recorded on
 * Cardano. A failed proof carries the recommended refund action as its call to action.
 */
function ProofCard({
  notice,
  simulated,
  action,
}: {
  readonly notice: EscrowProofNotice;
  readonly simulated: boolean;
  /** The refund button (wired to the escrow actions), when the proof recommends one. */
  readonly action: ReactNode;
}) {
  const { colors } = useTheme();
  const ink =
    notice.tone === "success"
      ? colors.success
      : notice.tone === "danger"
        ? colors.dangerText
        : colors.textSecondary;
  return (
    <Card
      style={{
        gap: spacing.sm,
        ...(notice.tone === "danger" ? { backgroundColor: colors.dangerSoft } : {}),
      }}
      testID={`escrow-proof-${notice.state}`}
    >
      <View accessibilityRole="summary" accessibilityLiveRegion="polite" style={{ gap: 2 }}>
        <Text variant="caption" tone="secondary">
          Proof
        </Text>
        <Row gap={spacing.sm}>
          <Icon
            name={
              notice.tone === "success"
                ? "shieldCheck"
                : notice.tone === "danger"
                  ? "warning"
                  : "clock"
            }
            size={18}
            color={ink}
          />
          <Text variant="calloutStrong" style={{ color: ink, flex: 1 }} testID="escrow-proof-title">
            {notice.title}
          </Text>
        </Row>
        <Text variant="footnote" tone="secondary" testID="escrow-proof-message">
          {notice.message}
        </Text>
      </View>
      {notice.resultTxUrl !== null ? (
        simulated ? (
          <Text variant="footnote" tone="secondary">
            Simulated: the result transaction is not on chain.
          </Text>
        ) : (
          <TextButton
            label="View the result on Cardanoscan"
            icon="external"
            accessibilityHint="Opens the seller's result transaction in the Cardano explorer"
            onPress={() => {
              void WebBrowser.openBrowserAsync(notice.resultTxUrl ?? "");
            }}
            testID="escrow-proof-tx"
          />
        )
      ) : null}
      {action}
    </Card>
  );
}

function failureText(e: unknown): string {
  return isApiError(e) ? escrowErrorMessage(e) : errorMessage(e);
}

/**
 * After an x402 payment locked in Masumi escrow was approved: where the escrow is (locked,
 * delivered, released / refund requested, authorized, refunded), followed live while it can
 * change, with the buyer's refund actions. Each action: the API builds the escrow spend,
 * the app checks it and shows it, the passkey stamps its body hash, the API submits it.
 */
export function EscrowPanel({
  requestId,
  network,
  initial,
  simulated,
}: {
  readonly requestId: string;
  readonly network: NetworkId;
  readonly initial: X402Escrow;
  readonly simulated: boolean;
}) {
  const { colors } = useTheme();
  const query = useX402Escrow(requestId, initial);
  const escrow = query.data ?? initial;
  const prepare = usePrepareEscrowAction();
  const submit = useSubmitEscrowAction();
  const signer = useSigner();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const [sheet, setSheet] = useState<{
    action: X402EscrowAction;
    review: SigningReview;
    verified?: DeviceVerification | undefined;
  } | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const actions0 = escrowActions(escrow);
  const now = useNow(actions0.withdrawableAt !== null ? 1000 : 30_000);
  const view = escrowView(escrow, now);
  const actions = escrowActions(escrow, now);
  const links = escrowTxLinks(network, escrow);
  const proof = escrowProofNotice(network, escrow, now);
  const signable = signer.kind !== "unavailable";
  const preparing = prepare.isPending ? prepare.variables.action : null;

  // The withdrawal countdown ran out: ask the API again so the button appears.
  const withdrawAt = actions.withdrawableAt;
  useEffect(() => {
    if (withdrawAt === null) return;
    const ms = new Date(withdrawAt).getTime() - Date.now();
    const t = setTimeout(
      () => {
        void query.refetch();
      },
      Math.max(0, ms) + 1500,
    );
    return () => {
      clearTimeout(t);
    };
  }, [withdrawAt, query]);

  const start = async (action: X402EscrowAction) => {
    setError(null);
    setDone(null);
    try {
      const res = await prepare.mutateAsync({ requestId, action });
      const integrity = checkEscrowReviewIntegrity(res.review, action, res.escrow);
      if (!integrity.ok) {
        setError(`Do not sign: ${integrity.problems.join(" ")}`);
        return;
      }
      setSheet({ action, review: res.review, verified: integrity.verified });
    } catch (e) {
      setError(failureText(e));
    }
  };

  const confirm = async () => {
    if (sheet === null) return;
    const { action, review } = sheet;
    setSigning(true);
    setError(null);
    try {
      const integrity = checkEscrowReviewIntegrity(review, action, escrow);
      if (!integrity.ok) throw new Error(integrity.problems.join(" "));
      const raw = review.rawPayload;
      if (raw === undefined) throw new Error("The Cardano signing payload is missing.");
      const signRequest = await stampForReview(signer, review, orgId);
      await submit.mutateAsync({
        requestId,
        action,
        body: { payloadHash: review.payloadHash, bodyHash: raw.payload, signRequest },
      });
      tapHaptic("success");
      setDone(ESCROW_ACTION_COPY[action].done);
      setSheet(null);
    } catch (e) {
      tapHaptic("error");
      setError(failureText(e));
      setSheet(null);
    } finally {
      setSigning(false);
    }
  };

  const busy = !signable || preparing !== null || signing;
  const withdrawButton = (
    <PrimaryButton
      label={ESCROW_ACTION_COPY.withdraw_refund.button}
      icon="arrowDownLeft"
      disabled={busy}
      loading={preparing === "withdraw_refund"}
      onPress={() => {
        void start("withdraw_refund");
      }}
      testID="escrow-withdraw-refund"
    />
  );
  const requestButton = (
    <SecondaryButton
      label={ESCROW_ACTION_COPY.request_refund.button}
      icon="refresh"
      disabled={busy}
      loading={preparing === "request_refund"}
      onPress={() => {
        void start("request_refund");
      }}
      testID="escrow-request-refund"
    />
  );
  // A failed proof puts its recommended refund in the proof card, as a red primary action.
  const cta =
    proof?.action === "request_refund" && actions.requestRefund
      ? "request_refund"
      : proof?.action === "withdraw_refund" && actions.withdrawRefund
        ? "withdraw_refund"
        : null;
  const ctaButton =
    cta === null ? null : (
      <PrimaryButton
        label={ESCROW_ACTION_COPY[cta].button}
        icon={cta === "withdraw_refund" ? "arrowDownLeft" : "refresh"}
        destructive
        disabled={busy}
        loading={preparing === cta}
        onPress={() => {
          void start(cta);
        }}
        testID={cta === "withdraw_refund" ? "escrow-withdraw-refund" : "escrow-request-refund"}
      />
    );

  const ink =
    view.tone === "danger"
      ? colors.dangerText
      : view.tone === "success"
        ? colors.success
        : colors.text;

  return (
    <View style={{ gap: spacing.md }} testID="escrow-panel">
      <Card style={{ gap: spacing.md }} testID={`escrow-state-${escrow.state}`}>
        <View
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          style={{ gap: spacing.xxs }}
        >
          <Text variant="caption" tone="secondary">
            Escrow (Masumi)
          </Text>
          <Text variant="calloutStrong" style={{ color: ink }} testID="escrow-title">
            {view.title}
          </Text>
          <Text variant="footnote" tone="secondary" testID="escrow-message">
            {view.message}
          </Text>
        </View>
        <View style={{ height: 1, backgroundColor: colors.separator }} />
        <View style={{ gap: spacing.sm }}>
          {view.steps.map((s) => {
            const url = explorerLink(network, s.txHash);
            return (
              <View key={s.key} testID={`escrow-step-${s.key}-${s.status}`}>
                <Row gap={spacing.md} align="flex-start">
                  <StepMark status={s.status} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text
                      variant={s.status === "active" ? "calloutStrong" : "callout"}
                      tone={s.status === "todo" ? "secondary" : "primary"}
                      style={s.status === "failed" ? { color: colors.dangerText } : undefined}
                    >
                      {s.label}
                    </Text>
                    {s.detail ? (
                      <Text variant="footnote" tone="secondary">
                        {s.detail}
                      </Text>
                    ) : null}
                    {url && !simulated ? (
                      <TextButton
                        label="View transaction"
                        icon="external"
                        accessibilityHint={`Opens “${s.label}” in the Cardano explorer`}
                        onPress={() => {
                          void WebBrowser.openBrowserAsync(url);
                        }}
                        testID={`escrow-step-${s.key}-tx`}
                      />
                    ) : null}
                  </View>
                </Row>
              </View>
            );
          })}
        </View>
      </Card>

      {proof !== null ? (
        <ProofCard notice={proof} simulated={simulated} action={ctaButton} />
      ) : null}

      {actions.pendingNote ? (
        <SecurityWarning
          severity={actions.pendingNote.tone === "danger" ? "warning" : "info"}
          title={actions.pendingNote.tone === "danger" ? "Didn't go through" : "On its way"}
          message={actions.pendingNote.text}
        />
      ) : null}
      {done !== null && actions.pendingNote === null ? (
        <Text variant="footnote" tone="success" testID="escrow-done">
          {done}
        </Text>
      ) : null}
      {error !== null ? (
        <View testID="escrow-error">
          <SecurityWarning severity="danger" title="Nothing was signed" message={error} />
        </View>
      ) : null}

      {actions.withdrawRefund && cta !== "withdraw_refund" ? withdrawButton : null}
      {actions.requestRefund && cta !== "request_refund" ? requestButton : null}
      {actions.withdrawableAt !== null ? (
        <Text variant="footnote" tone="secondary" align="center" testID="escrow-withdraw-countdown">
          {`If nothing is delivered, you can withdraw your refund in ${formatCountdown(new Date(actions.withdrawableAt).getTime() - now.getTime())}.`}
        </Text>
      ) : null}
      {(actions.requestRefund || actions.withdrawRefund) && !signable ? (
        <Text variant="footnote" tone="secondary">
          {signer.unavailableReason ?? "Signing with your passkey isn't available here."}
        </Text>
      ) : null}

      <Card style={{ paddingVertical: spacing.sm }} testID="escrow-details">
        <KeyValueRow
          label="Seller"
          value={
            <Text variant="mono" align="right" accessibilityLabel={escrow.sellerAddress}>
              {shortenAddress(escrow.sellerAddress, 10, 6)}
            </Text>
          }
        />
        <KeyValueRow label="Locked" value={adaLabel(escrow.lockedLovelace)} />
        {escrow.collateralLovelace !== "0" ? (
          <KeyValueRow label="Deposit" value={`${adaLabel(escrow.collateralLovelace)}, returned`} />
        ) : null}
        <KeyValueRow label="Deliver by" value={deadlineValue(escrow.deadlines.submitResult, now)} />
        <KeyValueRow label="Released after" value={deadlineValue(escrow.deadlines.unlock, now)} />
        {links.map((l) => (
          <KeyValueRow
            key={l.key}
            label={l.label}
            value={
              simulated ? (
                <Text
                  variant="callout"
                  tone="secondary"
                  align="right"
                  accessibilityLabel={`${l.label}: simulated, not on chain`}
                >
                  Simulated
                </Text>
              ) : (
                <TextButton
                  label="View"
                  icon="external"
                  accessibilityHint={`Opens the ${l.label.toLowerCase()} in the Cardano explorer`}
                  onPress={() => {
                    void WebBrowser.openBrowserAsync(l.url);
                  }}
                  testID={`escrow-link-${l.key}`}
                />
              )
            }
          />
        ))}
      </Card>
      {simulated ? (
        <Text variant="footnote" tone="secondary" align="center" testID="escrow-simulated">
          Simulated Escrow: nothing is locked on Cardano, and Refunds move no funds.
        </Text>
      ) : null}

      {sheet !== null ? (
        <ConfirmationSheet
          visible
          icon="passkey"
          title={ESCROW_ACTION_COPY[sheet.action].title}
          message={ESCROW_ACTION_COPY[sheet.action].message}
          rows={escrowSpendRows(sheet.review) ?? []}
          confirmLabel="Sign with passkey"
          loading={signing}
          onConfirm={() => {
            void confirm();
          }}
          onCancel={() => {
            setSheet(null);
          }}
          testID="escrow-sheet"
        >
          {sheet.review.request.simulated ? (
            <Text variant="footnote" tone="secondary">
              Simulated: the passkey stamp is simulated and nothing is sent to Cardano.
            </Text>
          ) : null}
          {sheet.verified ? (
            <Text variant="footnote" tone="secondary" testID="escrow-device-verified">
              {deviceVerifiedLine(sheet.verified, "")}
            </Text>
          ) : null}
        </ConfirmationSheet>
      ) : null}
    </View>
  );
}
