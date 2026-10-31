import { router } from "expo-router";
import { View } from "react-native";
import {
  ApprovalCard,
  CardSkeleton,
  EmptyState,
  IconButton,
  Screen,
  ScreenHeader,
  spacing,
  Text,
} from "@zyropay/ui";
import { useApproval, useApprovals } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { X402Purpose } from "@/components/X402Purpose";
import { useKnownSymbols } from "@/hooks/useKnownSymbols";
import { checkReviewIntegrity, riskOf, summarizeReview, symbolFor } from "@/lib/review";
import { x402Purpose } from "@/lib/x402";

function PendingItem({ id }: { readonly id: string }) {
  const detail = useApproval(id);
  const symbols = useKnownSymbols();
  if (detail.isPending) return <CardSkeleton rows={1} height={236} />;
  if (!detail.isSuccess) return null;
  const { review, agent, approval } = detail.data;
  const s = summarizeReview(review, symbolFor(review, symbols));
  const purpose = x402Purpose(review.payload);
  const risk = riskOf(review, checkReviewIntegrity(review, approval).ok);
  return (
    <ApprovalCard
      agentName={agent?.name ?? "You"}
      action={s.action}
      amountLabel={s.amountLabel}
      fiatLabel={s.fiatLabel}
      recipientLabel={s.recipientShort}
      recipientCaption={purpose ? "Seller" : "To"}
      purpose={purpose ? <X402Purpose purpose={purpose} /> : undefined}
      network={review.payload.network}
      expiresAt={approval.expiresAt}
      simulated={review.request.simulated}
      risk={risk}
      onPress={() => {
        router.push({ pathname: "/approvals/[id]", params: { id } });
      }}
      testID={`pending-approval-${id}`}
    />
  );
}

/** Pending approvals (push + 15 s polling fallback), newest first. */
export default function Approvals() {
  const pending = useApprovals("pending");
  const count = pending.data?.approvals.length;
  return (
    <Screen
      testID="approvals-screen"
      refreshing={pending.isRefetching}
      onRefresh={() => {
        void pending.refetch();
      }}
    >
      <ScreenHeader
        title="Approvals"
        subtitle={
          count === undefined
            ? undefined
            : count === 0
              ? "All caught up"
              : `${String(count)} waiting`
        }
        actions={
          <IconButton
            icon="clock"
            accessibilityLabel="Approval history"
            onPress={() => {
              router.push("/approvals/history");
            }}
            testID="approvals-history"
          />
        }
      />
      <QueryView
        query={pending}
        loading={<CardSkeleton rows={2} height={236} />}
        isEmpty={(d) => d.approvals.length === 0}
        empty={
          <EmptyState
            variant="card"
            icon="shieldCheck"
            title="Nothing waiting"
            message="When an agent asks to pay, the request appears here and you get a notification."
          />
        }
      >
        {(d) => (
          <View style={{ gap: spacing.md }}>
            {d.approvals.map((a) => (
              <PendingItem key={a.id} id={a.id} />
            ))}
          </View>
        )}
      </QueryView>
      <Text
        variant="footnote"
        tone="secondary"
        align="center"
        style={{ paddingHorizontal: spacing.lg }}
      >
        Nothing moves until you approve with your passkey.
      </Text>
    </Screen>
  );
}
