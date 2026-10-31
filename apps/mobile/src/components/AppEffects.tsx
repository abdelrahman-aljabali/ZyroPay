import { PermissionStatus } from "expo-notifications";
import { useEffect, useMemo } from "react";
import { useAgents, useApprovals } from "@/api/hooks";
import { env } from "@/lib/env";
import { useApprovalLiveActivity, type ApprovalActivityProps } from "@/lib/live-activity";
import {
  getPushPermission,
  registerForPush,
  useApprovalNotificationRouting,
} from "@/lib/notifications";

/**
 * Background effects for a signed-in session: push deep links, re-registering
 * the push token when permission already exists, and the pending-approval
 * Live Activity (iOS development/production builds only).
 */
export function AppEffects() {
  useApprovalNotificationRouting(true);

  useEffect(() => {
    void getPushPermission()
      .then((status) => (status === PermissionStatus.GRANTED ? registerForPush() : null))
      .catch(() => undefined);
  }, []);

  const pending = useApprovals("pending");
  const agents = useAgents();
  const list = pending.data?.approvals;
  const first = list?.[0];
  const pendingCount = list?.length ?? 0;

  // No amounts or recipients on the Lock Screen: it is visible to anyone holding the phone.
  const activityProps = useMemo<ApprovalActivityProps | null>(() => {
    if (!first) return null;
    const agentName = agents.data?.find((a) => a.id === first.agentId)?.name ?? "An agent";
    const expires = new Date(first.expiresAt);
    return {
      pendingCount: pendingCount,
      agentName,
      summary: "Payment request",
      expiresLabel: `Expires ${String(expires.getHours()).padStart(2, "0")}:${String(expires.getMinutes()).padStart(2, "0")}`,
    };
  }, [pendingCount, agents.data, first]);

  useApprovalLiveActivity(
    activityProps,
    first ? `${env.deepLinkScheme}://approvals/${first.id}` : undefined,
  );

  return null;
}
