import { zyropayEslint } from "@zyropay/config/eslint";
import globals from "globals";

export default [
  // .astro templates are checked by `astro check` (typecheck); ESLint covers the TS/TSX islands.
  { ignores: ["**/*.astro", ".astro/**", "qa/**"] },
  ...zyropayEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
