import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import {
  AddressText,
  Card,
  EmptyState,
  ErrorState,
  formatCountdown,
  KeyValueRow,
  LoadingSkeleton,
  NetworkBadge,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SecondaryButton,
  SecurityWarning,
  shortenAddress,
  SimulatedBadge,
  spacing,
  tapHaptic,
  Text,
  useCountdown,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useCancelRequest, useQuoteSend, useSubmitSend } from "@/api/hooks";
import {
  checkReviewIntegrity,
  deviceVerifiedLine,
  stampForReview,
  summarizeReview,
} from "@/lib/review";
import { checkAmount } from "@/lib/send";
import { useSigner } from "@/lib/turnkey";
import { newIdempotencyKey } from "@/lib/utils";
import { useSession } from "@/state";
import { useSendFlow } from "@/state/flows";

/** Send 4/5 — fee quote + summary, then passkey signature. */
export default function SendReview() {
  const flow = useSendFlow();
  const quote = useQuoteSend();
  const submit = useSubmitSend();
  const cancel = useCancelRequest();
  const signer = useSigner();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);
  const { balance, to, amount, review } = flow;
  const remaining = useCountdown(review?.payload.expiresAt ?? "1970-01-01T00:00:00.000Z");

  const requestQuote = () => {
    if (!balance) return;
    const check = checkAmount(balance, amount);
    if (!check.ok) return;
    const key = flow.idempotencyKey ?? newIdempotencyKey("send");
    quote.mutate(
      {
        walletId: balance.walletId,
        network: balance.network,
        to,
        assetId: balance.asset.id,
        amount: check.baseUnits,
        decimals: balance.asset.decimals,
        idempotencyKey: key,
      },
      {
        onSuccess: (r) => {
          flow.setQuote(key, r);
        },
      },
    );
  };

  useEffect(() => {
    if (requested.current || review) return;
    requested.current = true;
    requestQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quote once on entry
  }, []);

  if (!balance) {
    return (
      <Screen>
        <EmptyState
          icon="arrowUp"
          title="Start again"
          actionLabel="Choose asset"
          onAction={() => {
            router.replace("/send");
          }}
        />
      </Screen>
    );
  }

  const sign = async () => {
    if (!review) return;
    setError(null);
    const integrity = checkReviewIntegrity(review);
    if (!integrity.ok) {
      setError(integrity.problems.join(" "));
      return;
    }
    setSigning(true);
    try {
      const signRequest = await stampForReview(signer, review, orgId);
      const result = await submit.mutateAsync({
        requestId: review.request.id,
        body: { payloadHash: review.payloadHash, signRequest },
      });
      tapHaptic("success");
      flow.setResult(result);
      router.replace("/send/status");
    } catch (e) {
      tapHaptic("error");
      setError(errorMessage(e));
    } finally {
      setSigning(false);
    }
  };

  const s = review ? summarizeReview(review, balance.asset.symbol) : null;
  const expired = review !== null && remaining <= 0;
  const integrity = review ? checkReviewIntegrity(review) : null;

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="send-review"
      footer={
        review ? (
          <>
            <PrimaryButton
              label={expired ? "Quote expired" : "Confirm with passkey"}
              icon="passkey"
              loading={signing}
              disabled={expired || signer.kind === "unavailable" || integrity?.ok !== true}
              onPress={() => {
                void sign();
              }}
              testID="send-confirm"
            />
            {expired ? (
              <SecondaryButton
                label="Get a new quote"
                onPress={() => {
                  flow.setAmount(amount);
                  requestQuote();
                }}
              />
            ) : (
              <SecondaryButton
                label="Cancel"
                disabled={signing}
                onPress={() => {
                  cancel.mutate(review.request.id);
                  flow.reset();
                  router.dismissAll();
                }}
              />
            )}
          </>
        ) : null
      }
    >
      <ScreenHeader
        title="Review"
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      {quote.isPending ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="callout" tone="secondary">
            Getting a fee quote…
          </Text>
          <LoadingSkeleton height={260} radius={24} />
        </View>
      ) : quote.isError && !review ? (
        <ErrorState
          title="Couldn't prepare this payment"
          message={errorMessage(quote.error)}
          onRetry={requestQuote}
        />
      ) : review && s ? (
        <View style={{ gap: spacing.xl }}>
          <View style={{ alignItems: "center", gap: spacing.xs }}>
            <Text variant="label" tone="secondary">
              You send
            </Text>
            <Text
              variant="title"
              style={{ fontVariant: ["tabular-nums"] }}
              testID="send-review-amount"
            >
              {s.amountLabel}
            </Text>
            {s.fiatLabel ? (
              <Text variant="callout" tone="secondary">
                {s.fiatLabel}
              </Text>
            ) : null}
            {review.request.simulated ? <SimulatedBadge /> : null}
          </View>
          <Card style={{ paddingVertical: spacing.sm }}>
            <KeyValueRow
              label="To"
              value={<AddressText address={review.payload.to} align="right" />}
            />
            <KeyValueRow label="From" value={shortenAddress(review.payload.from, 6, 6)} />
            <KeyValueRow
              label="Network"
              value={<NetworkBadge network={review.payload.network} />}
            />
            <KeyValueRow label="Network fee" value={s.feeLabel} />
            <KeyValueRow
              label="Quote valid for"
              value={expired ? "Expired" : formatCountdown(remaining)}
            />
          </Card>
          {review.warnings.map((w) => (
            <SecurityWarning
              key={w.code}
              severity={w.code === "SIMULATED" || w.code === "TESTNET" ? "info" : "warning"}
              title={w.code.replace(/_/g, " ").toLowerCase()}
              message={w.message}
            />
          ))}
          {integrity?.ok && integrity.verified ? (
            <Text variant="footnote" tone="secondary" testID="send-device-verified">
              {deviceVerifiedLine(integrity.verified, s.amountLabel)}
            </Text>
          ) : null}
          {integrity && !integrity.ok ? (
            <SecurityWarning
              severity="danger"
              title="Do not sign"
              message={integrity.problems.join(" ")}
            />
          ) : null}
          {signer.kind === "unavailable" ? (
            <SecurityWarning
              severity="info"
              title="Signing unavailable"
              message={signer.unavailableReason ?? undefined}
            />
          ) : null}
          {error ? <SecurityWarning severity="danger" title="Not sent" message={error} /> : null}
        </View>
      ) : null}
    </Screen>
  );
}
