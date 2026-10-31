import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared flat config. Type-aware rules run through the TypeScript project service,
 * so every package's own tsconfig.json is used for the files it contains.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function zyropayEslint({ tsconfigRootDir }) {
  return tseslint.config(
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.wrangler/**",
        "**/.expo/**",
        "**/drizzle/**",
        "docs/research/**",
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.es2022 },
        parserOptions: {
          projectService: {
            allowDefaultProject: ["*.mjs", "*.js", "packages/config/*.js", "scripts/*.mjs"],
          },
          tsconfigRootDir,
        },
      },
      rules: {
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        // Money must never go through floating point. Forbid the obvious escape hatches.
        "no-restricted-globals": [
          "error",
          { name: "parseFloat", message: "Use @zyropay/shared money helpers (bigint)." },
        ],
        "no-restricted-properties": [
          "error",
          {
            object: "Number",
            property: "parseFloat",
            message: "Use @zyropay/shared money helpers.",
          },
        ],
      },
    },
    {
      files: ["**/*.js", "**/*.mjs"],
      ...tseslint.configs.disableTypeChecked,
      languageOptions: { globals: { ...globals.node } },
    },
    {
      files: ["**/*.test.ts"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/no-confusing-void-expression": "off",
      },
    },
  );
}
