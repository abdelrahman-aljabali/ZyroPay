/*
 * Babel plugin (web builds only): turn `import(x)` inside node_modules into a lazy
 * `require(x)` wrapped in a promise.
 *
 * Why: Expo's web export (SDK 57, legacy chunk splitting) moves every module that two async
 * chunks share into `__common.js`, which the entry loads eagerly. @turnkey/core contains
 * its own `import()` calls (wallet managers, stampers, storage); their chunks share viem,
 * ethers, ox and @noble/* with our lazily imported `web-signer.ts`, so all of that landed
 * in `__common.js` and was downloaded on the first page anyway. With vendor `import()`s
 * inlined, the whole Turnkey graph is one async chunk that loads only when signing is needed.
 *
 * Semantics stay lazy: the module body still runs only when the promise callback runs.
 * App code (src/) keeps real `import()` code splitting.
 */
module.exports = function inlineVendorDynamicImports({ types: t }) {
  const interop = (requireCall) =>
    // (m => m && m.__esModule ? m : Object.assign({ default: m }, m))(require(x))
    t.callExpression(
      t.arrowFunctionExpression(
        [t.identifier("m")],
        t.conditionalExpression(
          t.logicalExpression(
            "&&",
            t.identifier("m"),
            t.memberExpression(t.identifier("m"), t.identifier("__esModule")),
          ),
          t.identifier("m"),
          t.callExpression(t.memberExpression(t.identifier("Object"), t.identifier("assign")), [
            t.objectExpression([t.objectProperty(t.identifier("default"), t.identifier("m"))]),
            t.identifier("m"),
          ]),
        ),
      ),
      [requireCall],
    );

  return {
    name: "inline-vendor-dynamic-imports",
    visitor: {
      CallExpression(path, state) {
        if (!path.get("callee").isImport()) return;
        const filename = state.filename ?? "";
        if (!/[\\/]node_modules[\\/]/.test(filename)) return;
        const [source] = path.node.arguments;
        if (!source || !t.isStringLiteral(source)) return;
        const lazy = t.arrowFunctionExpression(
          [],
          interop(t.callExpression(t.identifier("require"), [t.stringLiteral(source.value)])),
        );
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.memberExpression(t.identifier("Promise"), t.identifier("resolve")),
                [],
              ),
              t.identifier("then"),
            ),
            [lazy],
          ),
        );
      },
    },
  };
};
