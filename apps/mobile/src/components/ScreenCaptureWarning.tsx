import { SecurityWarning } from "@zyropay/ui";
import { View } from "react-native";
import { SCREEN_CAPTURE_BLOCKED } from "@/lib/screen-capture";

/**
 * Shown where a secret is on screen (export, import) when the platform cannot block screen
 * capture: always in the web build, never on iOS/Android.
 */
export function ScreenCaptureWarning() {
  if (SCREEN_CAPTURE_BLOCKED) return null;
  return (
    <View testID="screen-capture-warning">
      <SecurityWarning
        severity="warning"
        title="This browser can't block screenshots"
        message="Screenshots, screen recording, screen sharing and browser extensions can all see this page. Close other tabs and extensions, stop any screen sharing, and make sure no one is watching."
      />
    </View>
  );
}
