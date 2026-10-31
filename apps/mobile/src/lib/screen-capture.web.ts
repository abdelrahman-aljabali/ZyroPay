/*
 * Web build (PWA). Browsers give a page no way to block or detect screenshots, screen
 * recording or screen sharing, so these are no-ops and SCREEN_CAPTURE_BLOCKED is false:
 * the export and import screens then show <ScreenCaptureWarning /> instead.
 * Metro uses screen-capture.ts on iOS and Android.
 */
export const SCREEN_CAPTURE_BLOCKED = false;

export function usePreventScreenCapture(_key?: string): void {
  // Nothing can be prevented on the web.
}

export function addScreenshotListener(_listener: () => void): { remove: () => void } {
  return { remove: () => undefined };
}
