import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/*.cjs", "**/*.js", "out/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-unused-expressions": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-unused-vars": "off",
      "no-console": ["error", { allow: ["warn", "error", "info", "debug"] }],
    },
  },
  {
    files: ["src/preload/content-script.ts", "src/main/ai/page-actions.ts"],
    rules: {
      "no-console": "warn",
      "no-useless-escape": "off",
      "no-empty": "off",
    },
  },
  {
    files: ["src/shared/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["src/renderer/src/lib/markdown.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
  prettierConfig,
);
