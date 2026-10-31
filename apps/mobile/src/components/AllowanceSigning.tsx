import type { AllowanceReview, CardanoAllowance } from "@zyropay/shared";
import { useState } from "react";
import { View } from "react-native";
import { ConfirmationSheet, SecurityWarning, spacing, tapHaptic, Text } from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";
import { usePrepareAllowance, useSubmitAllowance } from "@/api/hooks";
import {
  ALLOWANCE_ACTION_COPY,
  allowanceErrorMessage,
  allowanceReviewRows,
  allowanceVerifiedLine,
  checkAllowanceReview,
  type AllowanceAction,
  type AllowanceRequested,
  type AllowanceVerification,
} from "@/lib/allowance";
import { env } from "@/lib/env";
import { useSigner } from "@/lib/turnkey";
import { useSession } from "@/state";

/** Simulated (mock) reviews are not real Cardano transactions: the decode is skipped. */
function isSimulatedAllowanceReview(review: AllowanceReview): boolean {
  return env.mocksActive && review.unsignedTransaction.serialized.startsWith("84a0a0");
}

function allowanceFailureText(e: unknown): string {
  if (isApiError(e)) return allowanceErrorMessage(e) ?? errorMessage(e);
  return errorMessage(e);
}

export type PrepareInput = Parameters<ReturnType<typeof usePrepareAllowance>["mutateAsync"]>[0];

interface SheetState {
  readonly action: AllowanceAction;
  readonly review: AllowanceReview;
  readonly allowance: CardanoAllowance;
  readonly requested: AllowanceRequested | undefined;
  readonly verified: AllowanceVerification | undefined;
  readonly simulated: boolean;
}

/**
 * The allowance signing flow, shared by the setup screen and the allowance card (the same
 * pattern as the escrow refunds): the API builds the transaction, this device checks it
 * (checkAllowanceReview, which decodes it), the review sheet shows what it does, the passkey
 * stamps SIGN_RAW_PAYLOAD_V2 over its body hash, the API submits it.
 */
export function useAllowanceSigning(agentId: string, onDone?: (action: AllowanceAction) => void) {
  const prepare = usePrepareAllowance(agentId);
  const submit = useSubmitAllowance(agentId);
  const signer = useSigner();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const start = async (input: PrepareInput, requested?: AllowanceRequested) => {
    setError(null);
    setDone(null);
    try {
      const res = await prepare.mutateAsync(input);
      const simulated = isSimulatedAllowanceReview(res.review);
      const integrity = checkAllowanceReview(res.review, {
        action: input.action,
        allowance: res.allowance,
        simulated,
        ...(requested !== undefined ? { requested } : {}),
      });
      if (!integrity.ok) {
        tapHaptic("error");
        setError(`Do not sign: ${integrity.problems.join(" ")}`);
        return;
      }
      setSheet({
        action: input.action,
        review: res.review,
        allowance: res.allowance,
        requested,
        verified: integrity.verified,
        simulated,
      });
    } catch (e) {
      setError(allowanceFailureText(e));
    }
  };

  const confirm = async () => {
    if (sheet === null) return;
    setSigning(true);
    setError(null);
    try {
      // Checked again right before the passkey: the review may have expired meanwhile.
      const integrity = checkAllowanceReview(sheet.review, {
        action: sheet.action,
        allowance: sheet.allowance,
        simulated: sheet.simulated,
        ...(sheet.requested !== undefined ? { requested: sheet.requested } : {}),
      });
      if (!integrity.ok) throw new Error(integrity.problems.join(" "));
      const raw = sheet.review.rawPayload;
      const signRequest = await signer.stampSignRawPayload({
        organizationId: orgId,
        signWith: raw.signWith,
        payload: raw.payload,
      });
      await submit.mutateAsync({
        action: sheet.action,
        body: { bodyHash: raw.payload, signRequest },
      });
      tapHaptic("success");
      setDone(ALLOWANCE_ACTION_COPY[sheet.action].done);
      const action = sheet.action;
      setSheet(null);
      onDone?.(action);
    } catch (e) {
      tapHaptic("error");
      setError(allowanceFailureText(e));
      setSheet(null);
    } finally {
      setSigning(false);
    }
  };

  const reviewSheet =
    sheet === null ? null : (
      <ConfirmationSheet
        visible
        icon="passkey"
        title={ALLOWANCE_ACTION_COPY[sheet.action].title}
        message={ALLOWANCE_ACTION_COPY[sheet.action].message}
        rows={allowanceReviewRows(sheet.review, sheet.allowance)}
        confirmLabel="Sign with passkey"
        destructive={false}
        loading={signing}
        onConfirm={() => {
          void confirm();
        }}
        onCancel={() => {
          setSheet(null);
        }}
        testID="allowance-sheet"
      >
        <View style={{ gap: spacing.sm }}>
          {sheet.verified ? (
            <Text variant="footnote" tone="secondary" testID="allowance-device-verified">
              {allowanceVerifiedLine(sheet.verified)}
            </Text>
          ) : null}
          {env.mocksActive ? (
            <Text variant="footnote" tone="secondary" testID="allowance-simulated">
              Simulated: the passkey stamp is simulated and nothing is sent to Cardano.
            </Text>
          ) : null}
        </View>
      </ConfirmationSheet>
    );

  const errorView =
    error === null ? null : (
      <View testID="allowance-error">
        <SecurityWarning severity="danger" title="Nothing was signed" message={error} />
      </View>
    );

  return {
    start,
    preparing: prepare.isPending ? prepare.variables.action : null,
    signing,
    busy: prepare.isPending || signing || signer.kind === "unavailable",
    signable: signer.kind !== "unavailable",
    unavailableReason: signer.unavailableReason,
    error,
    done,
    clearDone: () => {
      setDone(null);
    },
    reviewSheet,
    errorView,
  };
}
