// Metro config for the pnpm monorepo.
// expo/metro-config (SDK 52+) detects the workspace root automatically: it adds the
// root to watchFolders and resolves symlinked workspace packages (@zyropay/shared,
// @zyropay/ui) that export TypeScript source, which Metro then transpiles.
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

/*
 * Web only: @turnkey/core (TurnkeyBridge.web.tsx) picks its passkey and key-storage backend
 * at runtime and `require`s the React Native ones only when it runs inside React Native.
 * In the browser it uses WebAuthn and IndexedDB, so the native modules are dead code there;
 * resolve them to an empty module instead of bundling native-module shims.
 */
const NATIVE_ONLY_ON_WEB = new Set([
  "@turnkey/react-native-passkey-stamper",
  "react-native-passkey",
  "react-native-passkeys",
  "react-native-keychain",
]);
/*
 * Web only: zod's classic entry re-exports `locales` (every translation, ~270 KB minified)
 * as a namespace. Metro does not tree-shake it away, and ZyroPay never uses z.locales, so
 * the namespace is resolved to a shim that only carries English (src/shims/zod-locales-en.ts).
 */
const ZOD_LOCALES_SHIM = path.join(__dirname, "src", "shims", "zod-locales-en.ts");
const isZodClassicEntry = (origin) =>
  /[\\/]zod[\\/]v4[\\/](classic[\\/]external|mini[\\/]external|core[\\/]index)\.(c?js|mjs)$/.test(
    origin ?? "",
  );

const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && NATIVE_ONLY_ON_WEB.has(moduleName)) return { type: "empty" };
  if (
    platform === "web" &&
    /^\.\.\/locales\/index\.(c?js|mjs)$/.test(moduleName) &&
    isZodClassicEntry(context.originModulePath)
  )
    return { type: "sourceFile", filePath: ZOD_LOCALES_SHIM };
  const resolved = (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
  // tslib's package "exports" send Metro's web build to modules/index.js, an ESM wrapper that
  // destructures the CJS build's default export, which Metro's interop leaves undefined
  // ("Cannot destructure property '__extends' of 'tslib.default'"; reached through
  // @turnkey/core -> @walletconnect). Use the same version's plain ES module build instead.
  if (
    platform === "web" &&
    moduleName === "tslib" &&
    resolved.type === "sourceFile" &&
    /[\\/]tslib[\\/]modules[\\/]index\.js$/.test(resolved.filePath)
  ) {
    // tslib 2.x ships tslib.es6.mjs, tslib 1.x only tslib.es6.js.
    const dir = path.join(resolved.filePath, "..", "..");
    const esm = ["tslib.es6.mjs", "tslib.es6.js"]
      .map((f) => path.join(dir, f))
      .find((f) => fs.existsSync(f));
    if (esm) return { type: "sourceFile", filePath: esm };
  }
  return resolved;
};

module.exports = config;
