import { zyropayEslint } from "@zyropay/config/eslint";

export default [
  ...zyropayEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    // Tests read untyped JSON responses; keep production code fully strict.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
];
