import type { ApprovalActivityProps } from "./ApprovalActivity";

/*
 * Web: Live Activities are iOS-only. This stub keeps @expo/ui/swift-ui and expo-widgets
 * (about 80 KB of minified JS that can never run in a browser) out of the web bundle.
 */

export function liveActivitiesSupported(): boolean {
  return false;
}

export function useApprovalLiveActivity(
  _props: ApprovalActivityProps | null,
  _deepLink: string | undefined,
): void {
  // No Live Activity on the web: the Approvals tab badge and polling cover the flow.
}

export type { ApprovalActivityProps };
