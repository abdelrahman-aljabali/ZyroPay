import * as ScreenCapture from "expo-screen-capture";

/** iOS/Android can block or detect capture; the web build cannot (screen-capture.web.ts). */
export const SCREEN_CAPTURE_BLOCKED: boolean = true;

/** Android: FLAG_SECURE (no screenshots/recording). iOS: hides content from recordings. */
export const usePreventScreenCapture = ScreenCapture.usePreventScreenCapture;

export function addScreenshotListener(listener: () => void): { remove: () => void } {
  return ScreenCapture.addScreenshotListener(listener);
}
