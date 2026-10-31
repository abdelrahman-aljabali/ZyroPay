import { zyropayEslint } from "@zyropay/config/eslint";
import globals from "globals";

export default [
  // .astro and .mdx are checked by `astro check` (typecheck); ESLint covers TS and the scripts.
  { ignores: ["**/*.astro", ".astro/**", "qa/**", "public/**"] },
  ...zyropayEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["scripts/**/*.mjs", "astro.config.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
];
