# Passkey association files (templates)

Host both files on the passkey relying-party domain (`PASSKEY_RP_ID`, also `EXPO_PUBLIC_PASSKEY_RP_ID`):

| File                         | URL                                                      | Content-Type                                        |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `apple-app-site-association` | `https://<RP_ID>/.well-known/apple-app-site-association` | `application/json`, no redirects, no `.json` suffix |
| `assetlinks.json`            | `https://<RP_ID>/.well-known/assetlinks.json`            | `application/json`                                  |

Replace before deploying:

- `APPLE_TEAM_ID` with your Apple Developer Team ID. Bundle ids must match `app.config.ts` (`IOS_BUNDLE_ID` + `.dev` / `.preview` suffix per `APP_VARIANT`).
- `sha256_cert_fingerprints` with the signing certificate SHA-256 of each Android build (`eas credentials -p android`, or Play Console → App signing for Play-distributed builds). `package_name` must match `ANDROID_PACKAGE_NAME` + suffix.

`app.config.ts` adds `webcredentials:<RP_ID>` (passkeys) and `applinks:<RP_ID>` (approval links) to iOS associated domains and an auto-verified Android intent filter for `https://<RP_ID>/approvals`. Passkeys only work in development/production builds, never in Expo Go.
