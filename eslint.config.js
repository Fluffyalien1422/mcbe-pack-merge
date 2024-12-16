// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**/*", "docs/**/*"],
    extends: [eslint.configs.recommended],
    rules: {
      eqeqeq: "error",
    },
  },
  {
    files: ["**/*.ts"],
    ignores: ["dist/**/*"],
    extends: tseslint.configs.strictTypeChecked,
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  }
);
