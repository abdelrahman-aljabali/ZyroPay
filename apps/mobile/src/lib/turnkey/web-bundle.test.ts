import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The web bundle keeps @turnkey/core out of the first load (TurnkeyBridge.web.tsx imports
 * web-signer.ts lazily). That only works while vendor `import()`s are inlined by
 * scripts/babel-inline-vendor-imports.js; these tests pin the plugin's behaviour.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const appRequire = createRequire(new URL("../../../package.json", import.meta.url));
const babelRequire = createRequire(appRequire.resolve("babel-preset-expo"));
const babel = babelRequire("@babel/core") as {
  transformSync(code: string, opts: Record<string, unknown>): { code: string } | null;
};
const plugin: unknown = appRequire("./scripts/babel-inline-vendor-imports.js");

function transform(code: string, filename: string): string {
  const out = babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [plugin],
  });
  return out?.code ?? "";
}

describe("babel-inline-vendor-imports", () => {
  it("turns import() inside node_modules into a lazy require", () => {
    const code = transform(
      'export const load = () => import("./web/manager.mjs");',
      "/x/node_modules/@turnkey/core/dist/__wallet__/base.mjs",
    );
    expect(code).not.toContain("import(");
    expect(code).toContain(
      "Promise.resolve().then(() => (m => m && m.__esModule ? m : Object.assign({",
    );
    expect(code).toContain('require("./web/manager.mjs")');
  });

  it("keeps import() in app code, so web-signer stays its own chunk", () => {
    const code = transform(
      'export const load = () => import("./web-signer");',
      `${here}TurnkeyBridge.web.tsx`,
    );
    expect(code).toContain('import("./web-signer")');
  });

  it("leaves non-literal specifiers alone", () => {
    const code = transform("export const load = (x) => import(x);", "/x/node_modules/p/index.js");
    expect(code).toContain("import(x)");
  });
});
