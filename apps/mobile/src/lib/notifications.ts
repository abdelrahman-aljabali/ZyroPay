import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { apiClient } from "@/api";
import { pushRouteFromData } from "@/lib/push-data";
import { isExpoGo } from "@/lib/turnkey";

/*
 * Push. The payload is the shared PushData (type, ids, deep link; see
 * src/lib/push-data.ts); a tap opens the screen its deep link names. Polling
 * (APPROVAL_POLL_MS) is the fallback whenever push is denied, unsupported
 * (simulators, Expo Go on Android) or late.
 */

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
});

export type PushRegistration =
  | { readonly status: "registered"; readonly deviceId: string }
  | { readonly status: "denied" }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

export async function getPushPermission(): Promise<Notifications.PermissionStatus> {
  if (Platform.OS === "web") return Notifications.PermissionStatus.UNDETERMINED;
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

export async function registerForPush(): Promise<PushRegistration> {
  if (Platform.OS === "web")
    return { status: "unsupported", reason: "Push is not available on web." };
  if (!Device.isDevice) return { status: "unsupported", reason: "Push needs a physical device." };
  if (isExpoGo && Platform.OS === "android")
    return {
      status: "unsupported",
      reason: "Expo Go on Android has no remote push. Use a development build.",
    };
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("approvals", {
        name: "Approval requests",
        importance: Notifications.AndroidImportance.HIGH,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== Notifications.PermissionStatus.GRANTED) {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== Notifications.PermissionStatus.GRANTED) return { status: "denied" };
    const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
    const projectId = extra?.eas?.projectId;
    if (!projectId)
      return { status: "unsupported", reason: "EXPO_PROJECT_ID is not set for this build." };
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    const res = await apiClient.call("registerDevice", {
      body: {
        expoPushToken: token.data,
        platform: Platform.OS === "ios" ? "ios" : "android",
        ...(Device.deviceName ? { deviceName: Device.deviceName.slice(0, 64) } : {}),
      },
    });
    return { status: "registered", deviceId: res.deviceId };
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : "Push registration failed" };
  }
}

/** Opens the screen a tapped notification links to (warm and cold start). */
export function useApprovalNotificationRouting(enabled: boolean): void {
  useEffect(() => {
    // Expo web (visual QA only) has no notification responses.
    if (!enabled || Platform.OS === "web") return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const route = pushRouteFromData(response?.notification.request.content.data);
      if (route === null) return;
      switch (route.screen) {
        case "approval":
          router.push({ pathname: "/approvals/[id]", params: { id: route.approvalId } });
          return;
        case "approvals":
          router.push("/approvals");
          return;
        case "activity":
          router.push("/activity");
          return;
        case "agent":
          router.push({ pathname: "/agents/[id]", params: { id: route.agentId } });
          return;
        case "settings":
          router.push("/settings");
          return;
      }
    };
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      sub.remove();
    };
  }, [enabled]);
}
