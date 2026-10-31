import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect } from "react";
import { EmptyState, PrimaryButton, Screen, SecondaryButton, SimulatedBadge } from "@zyropay/ui";
import { useTopUpFlow } from "@/state/flows";

/**
 * Top up 4/4 — after the provider checkout. The on-ramp result arrives by
 * webhook on the API; the app refreshes balances and history and the user is
 * notified when funds land. We never claim success from the browser return.
 */
export default function TopUpStatus() {
  const { simulated, sessionId, reset } = useTopUpFlow();
  const qc = useQueryClient();

  useEffect(() => {
    const id = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
      void qc.invalidateQueries({ queryKey: ["transactions"] });
    }, 10_000);
    return () => {
      clearInterval(id);
    };
  }, [qc]);

  const done = () => {
    reset();
    router.dismissAll();
  };

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="topup-status"
      footer={
        <>
          <PrimaryButton label="Done" onPress={done} testID="topup-done" />
          <SecondaryButton
            label="Back to checkout"
            onPress={() => {
              router.back();
            }}
          />
        </>
      }
    >
      <EmptyState
        icon="clock"
        title={sessionId ? "Processing your purchase" : "Checkout closed"}
        message={
          simulated
            ? "Simulated checkout: no payment was made and no funds will arrive."
            : "If you completed the payment, funds usually arrive within minutes. We'll update your balance and notify you."
        }
      />
      {simulated ? <SimulatedBadge /> : null}
    </Screen>
  );
}
