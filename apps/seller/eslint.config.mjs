import { zyropayEslint } from "@zyropay/config/eslint";

export default [
  // Local secrets and one-off scripts (git-ignored) are never linted.
  { ignores: [".secrets/**", ".local/**"] },
  ...zyropayEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    // Tests read untyped JSON responses; keep production code fully strict.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
];
