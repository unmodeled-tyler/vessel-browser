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
      "no-empty": "error",
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
  {
    files: ["src/main/network/downloads.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
  {
    // External code should import from `src/main/ai/page-actions/*.ts` sub-modules
    // directly rather than reaching through the barrel. Functions that still
    // live in page-actions.ts itself (executeAction, clickResolvedSelector,
    // isDangerousAction, scrollPage, etc.) are the only ones the barrel is
    // allowed to export.
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    ignores: ["src/main/ai/page-actions.ts", "src/main/ai/page-actions/**/*"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value=/(^|\\/)page-actions$/]",
          message:
            "Import from a `page-actions/*.ts` sub-module directly (e.g. `../ai/page-actions/navigation`). Only `src/main/ai/page-actions.ts` and its own sub-modules may use the barrel.",
        },
      ],
    },
  },
  prettierConfig,
);
