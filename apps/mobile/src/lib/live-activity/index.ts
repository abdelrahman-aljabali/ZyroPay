import { useEffect } from "react";
import { Platform } from "react-native";
import type { ApprovalActivityProps } from "./ApprovalActivity";
import { isExpoGo } from "@/lib/turnkey";

/*
 * Live Activity bridge. expo-widgets is iOS-only and absent from Expo Go, so
 * the module is required lazily and every failure degrades to "no Live
 * Activity" — the Approvals tab badge, push and polling still cover the flow.
 */

interface Factory {
  start(props: ApprovalActivityProps, url?: string): Instance;
  getInstances(): Instance[];
}
interface Instance {
  update(props: ApprovalActivityProps): Promise<void>;
  end(policy?: "default" | "immediate"): Promise<void>;
}

let factory: Factory | null | undefined;

function getFactory(): Factory | null {
  if (factory !== undefined) return factory;
  factory = null;
  if (Platform.OS !== "ios" || isExpoGo) return factory;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    factory = (require("./ApprovalActivity") as { default: Factory }).default;
  } catch {
    factory = null;
  }
  return factory;
}

export function liveActivitiesSupported(): boolean {
  return getFactory() !== null;
}

/** Keeps exactly one Live Activity in sync with the pending approvals. */
export function useApprovalLiveActivity(
  props: ApprovalActivityProps | null,
  deepLink: string | undefined,
): void {
  const key =
    props === null
      ? "none"
      : `${String(props.pendingCount)}|${props.agentName}|${props.summary}|${props.expiresLabel}`;
  useEffect(() => {
    const f = getFactory();
    if (!f) return;
    try {
      const existing = f.getInstances();
      if (props === null) {
        for (const i of existing) void i.end("immediate").catch(() => undefined);
        return;
      }
      const [first, ...rest] = existing;
      for (const i of rest) void i.end("immediate").catch(() => undefined);
      if (first) void first.update(props).catch(() => undefined);
      else f.start(props, deepLink);
    } catch {
      // ActivityKit can refuse (disabled by user, budget exhausted): ignore.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures props
  }, [key, deepLink]);
}

export type { ApprovalActivityProps };
