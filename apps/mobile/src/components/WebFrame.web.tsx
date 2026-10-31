import { Icon, spacing, Text, useTheme } from "@zyropay/ui";
import { createElement, useEffect, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";
import { usePasskeyBlockedInFrame } from "@/lib/embed";
import { startEmbedBridge } from "@/lib/embed-runtime";

/** Phone-width column of the PWA. Wider windows centre it on a quieter backdrop. */
export const WEB_FRAME_MAX_WIDTH = 480;

/**
 * Web only: ZyroPay is designed for a phone. On a phone the column fills the screen; on a
 * tablet or desktop it stays phone-width and is centred, with hairline edges.
 */
export function WebFrame({ children }: { readonly children: ReactNode }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const framed = width > WEB_FRAME_MAX_WIDTH;
  useEffect(() => {
    startEmbedBridge();
  }, []);
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        backgroundColor: framed ? colors.surface : colors.background,
      }}
    >
      <View
        style={{
          flex: 1,
          width: "100%",
          maxWidth: WEB_FRAME_MAX_WIDTH,
          overflow: "hidden",
          backgroundColor: colors.background,
          ...(framed
            ? { borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border }
            : null),
        }}
      >
        <FullScreenPasskeyNotice />
        {children}
      </View>
    </View>
  );
}

/**
 * Shown only inside an iframe (the landing page), after the browser refused a passkey
 * prompt there or when the frame cannot use WebAuthn at all. A real link with
 * target="_top" reopens the same page as the top-level page, where passkeys work; the
 * click is the user activation browsers require for a frame to navigate the top window.
 */
function FullScreenPasskeyNotice() {
  const { colors, fontFamily } = useTheme();
  const blocked = usePasskeyBlockedInFrame();
  if (!blocked) return null;
  return (
    <View
      testID="embed-passkey-notice"
      style={{
        // Above the navigator, whose screens are stacked layers that would cover the link.
        position: "relative",
        zIndex: 10,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderColor: colors.border,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        gap: spacing.sm,
      }}
    >
      <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
        <Icon name="lock" size={16} color={colors.text} />
        <Text variant="footnote" style={{ flex: 1 }}>
          Your browser does not allow passkeys inside this preview.
        </Text>
      </View>
      {createElement(
        "a",
        {
          href: window.location.href,
          target: "_top",
          rel: "noopener",
          "data-testid": "embed-open-full-screen",
          style: {
            fontFamily: fontFamily("semibold") ?? "system-ui, sans-serif",
            fontWeight: 600,
            fontSize: 15,
            lineHeight: "21px",
            textAlign: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 44,
            borderRadius: 999,
            backgroundColor: colors.primary,
            color: colors.onPrimary,
            textDecoration: "none",
            padding: `${String(spacing.sm)}px ${String(spacing.lg)}px`,
          },
        },
        "Open ZyroPay in full screen to use your passkey",
      )}
    </View>
  );
}
