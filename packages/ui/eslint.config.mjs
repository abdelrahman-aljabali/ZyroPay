import { zyropayEslint } from "@zyropay/config/eslint";

// Repo-wide strict type-aware rules; Node build scripts are plain .mjs outside the TS project.
export default [
  { ignores: ["scripts/**"] },
  ...zyropayEslint({ tsconfigRootDir: import.meta.dirname }),
];
