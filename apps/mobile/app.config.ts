import type { ConfigContext, ExpoConfig } from "expo/config";

/*
 * Dynamic app config. Everything environment-specific comes from env vars
 * (see the repo-root .env.example). Nothing secret belongs here: this file is
 * evaluated at build time and parts of it ship inside the app binary.
 *
 * Passkeys need a development build (not Expo Go) plus a relying-party domain:
 *  - iOS:     associatedDomains "webcredentials:<PASSKEY_RP_ID>" + the domain
 *             serving /.well-known/apple-app-site-association (template in
 *             well-known/apple-app-site-association) with "<APPLE_TEAM_ID>.<bundle id>".
 *  - Android: the domain serving /.well-known/assetlinks.json (template in
 *             well-known/assetlinks.json) with the package name and the SHA-256 of
 *             the signing certificate (`eas credentials` or Play App Signing).
 */

const env = process.env;

const variant = env.APP_VARIANT ?? "development"; // development | preview | production
const bundleId = env.IOS_BUNDLE_ID ?? "app.zyropay.mobile";
const androidPackage = env.ANDROID_PACKAGE_NAME ?? "app.zyropay.mobile";
const rpId = env.EXPO_PUBLIC_PASSKEY_RP_ID ?? env.PASSKEY_RP_ID ?? "";
const appleTeamId = env.APPLE_TEAM_ID ?? "";
const projectId = env.EXPO_PROJECT_ID ?? "";
const scheme = env.EXPO_PUBLIC_DEEP_LINK_SCHEME ?? env.APP_DEEP_LINK_SCHEME ?? "zyropay";

const suffix = variant === "production" ? "" : variant === "preview" ? ".preview" : ".dev";
const nameSuffix = variant === "production" ? "" : variant === "preview" ? " (Preview)" : " (Dev)";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `ZyroPay${nameSuffix}`,
  slug: "zyropay",
  owner: env.EXPO_OWNER,
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme,
  // "automatic" keeps Settings > Appearance > System working; the app itself starts light
  // (src/state/prefs.ts) and pins native UI to the chosen scheme (src/lib/color-scheme.ts).
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "appVersion" },
  ...(projectId
    ? {
        updates: {
          url: `https://u.expo.dev/${projectId}`,
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
        },
      }
    : {}),
  ios: {
    bundleIdentifier: `${bundleId}${suffix}`,
    supportsTablet: false,
    ...(appleTeamId ? { appleTeamId } : {}),
    associatedDomains: rpId ? [`webcredentials:${rpId}`, `applinks:${rpId}`] : [],
    infoPlist: {
      NSFaceIDUsageDescription: "ZyroPay uses Face ID with your passkey to approve payments.",
      NSSupportsLiveActivities: true,
      ITSAppUsesNonExemptEncryption: false,
    },
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: `${androidPackage}${suffix}`,
    adaptiveIcon: {
      // Black petals on white, like the in-app mark (scripts/generate-icons.mjs).
      backgroundColor: "#FFFFFF",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: true,
    // App Links for zyropay approval links on the RP domain (assetlinks.json must list this package).
    intentFilters: rpId
      ? [
          {
            action: "VIEW",
            autoVerify: true,
            data: [{ scheme: "https", host: rpId, pathPrefix: "/approvals" }],
            category: ["BROWSABLE", "DEFAULT"],
          },
        ]
      : [],
  },
  // Web (PWA, mobile-first): a single-page app exported as static files (apps/web-host).
  // public/index.html is the HTML template, public/manifest.webmanifest the PWA manifest.
  web: {
    bundler: "metro",
    output: "single",
    name: `ZyroPay${nameSuffix}`,
    shortName: "ZyroPay",
    description: "Self-custodial crypto wallet with passkeys, and payments for your AI agents.",
    lang: "en",
    // theme-color starts light in public/index.html; the app updates it for a Dark choice.
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        // Always light: ZyroPay opens in light mode whatever the OS setting.
        image: "./assets/images/splash-icon.png",
        imageWidth: 88,
        backgroundColor: "#FFFFFF",
      },
    ],
    ["expo-secure-store", { faceIDPermission: "ZyroPay uses Face ID to protect your session." }],
    ["expo-notifications", { icon: "./assets/images/notification-icon.png", color: "#111111" }],
    "expo-sqlite",
    [
      "expo-camera",
      {
        // Only QR scanning of wallet addresses ("Watch an address"); no photos, no audio.
        cameraPermission: "ZyroPay uses the camera to scan wallet address QR codes.",
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-widgets",
      {
        // Live Activity for pending approvals (src/lib/live-activity). No home-screen widgets yet.
        groupIdentifier: `group.${bundleId}${suffix}`,
        enablePushNotifications: false,
        widgets: [],
      },
    ],
    [
      "expo-build-properties",
      {
        // Passkeys: iOS 16+ (ASAuthorization platform passkeys); Android 9+ (Credential Manager).
        ios: { deploymentTarget: "16.4" },
        android: { minSdkVersion: 28 },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    variant,
    ...(projectId ? { eas: { projectId } } : {}),
  },
});
