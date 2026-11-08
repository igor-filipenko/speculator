import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-test/**",
      "node_modules/**",
      "scripts/**",
      "eslint.config.js",
      "web/**",
      "server/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      // node:test describe/it/before/after return thenables; the runner awaits them.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        {
          type: "strategy",
          pattern: "src/strategy/mode/*",
          capture: ["elementName"],
        },
        {
          type: "market",
          pattern: "src/market/*",
          capture: ["elementName"],
        },
        // The rule skips files that match no element. This catch-all makes
        // engine, manager, and the other shared modules subject to the
        // private-file ban without restricting those modules themselves.
        {
          type: "src",
          pattern: "src/**",
        },
      ],
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              disallow: {
                to: {
                  element: {
                    type: ["strategy", "market"],
                    fileInternalPath: "!index.ts",
                  },
                },
              },
              message:
                "Import {{to.element.types.[0]}} {{to.element.captured.elementName}} only through index.ts.",
            },
            {
              from: { element: { type: ["strategy", "market"] } },
              allow: {
                to: {
                  element: {
                    type: "{{ from.element.types.[0] }}",
                    captured: {
                      elementName: "{{ from.element.captured.elementName }}",
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },
  // Disable ESLint rules that conflict with Prettier (must be last).
  eslintConfigPrettier,
);
