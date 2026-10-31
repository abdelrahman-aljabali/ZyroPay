// Babel config: Expo's preset, plus (web only) the vendor dynamic-import inliner that keeps
// @turnkey/core and its dependencies out of the first-load JS (see the plugin's header).
module.exports = function babelConfig(api) {
  const platform = api.caller((caller) => caller?.platform);
  return {
    presets: ["babel-preset-expo"],
    plugins: platform === "web" ? [require.resolve("./scripts/babel-inline-vendor-imports")] : [],
  };
};
