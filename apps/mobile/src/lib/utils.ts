import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { tapHaptic } from "@zyropay/ui";

/** Fresh idempotency key per logical action (matches IdempotencyKeySchema). */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}:${Crypto.randomUUID()}`;
}

/** Copy with a haptic tick; `copied` flips true for 1.5 s for inline feedback. */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((text: string) => {
    Clipboard.setStringAsync(text)
      .then(() => {
        tapHaptic("success");
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopied(false);
        }, 1500);
      })
      .catch(() => {
        tapHaptic("error");
      });
  }, []);
  return { copied, copy };
}

export async function readClipboard(): Promise<string> {
  try {
    return (await Clipboard.getStringAsync()).trim();
  } catch {
    return "";
  }
}

export function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
