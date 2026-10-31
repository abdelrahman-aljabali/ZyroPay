/*
 * pnpm install hook.
 *
 * @react-three/fiber (apps/landing) declares Expo and React Native as *optional* peers for its
 * native renderer. Because Expo lives in this workspace (apps/mobile), pnpm otherwise resolves
 * and auto-installs a second React Native tree just for the web landing page. The landing page
 * only uses the DOM renderer, so those optional peers are dropped here. Nothing else is touched.
 */
const NATIVE_ONLY_PEERS = ["expo", "expo-asset", "expo-file-system", "expo-gl", "react-native"];

function readPackage(pkg) {
  if (pkg.name === "@react-three/fiber" || pkg.name === "@react-three/drei") {
    for (const name of NATIVE_ONLY_PEERS) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[name];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
