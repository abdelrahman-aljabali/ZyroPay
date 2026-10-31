import { zyropayEslint } from "@zyropay/config/eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Repo-wide strict type-aware rules + React Hooks rules for the Expo app.
export default [
  {
    ignores: [
      ".expo/**",
      "dist/**",
      "android/**",
      "ios/**",
      "expo-env.d.ts",
      "scripts/**",
      "screenshots/**",
      "e2e-web/.build/**",
      "e2e-web/.results/**",
      "e2e-web/*.mjs",
      // Plain browser script served as-is before the bundle (no module, no TS).
      "public/theme-boot.js",
    ],
  },
  ...zyropayEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["**/*.tsx", "**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Metro config is CommonJS run by Node.
    files: ["metro.config.js", "babel.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Vitest asymmetric matchers (expect.stringMatching) are typed as any.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-unsafe-assignment": "off" },
  },
];
