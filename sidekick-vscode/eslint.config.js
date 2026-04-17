const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/webview/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "sidekick-shared",
              message:
                "Webview code must not import the package root. Use 'sidekick-shared/browser' for pure helpers, or a named subpath for types/phrases.",
            },
            {
              name: "sidekick-shared/node",
              message:
                "Webview code must not import Node-only subpaths. This pulls node:fs/node:path into the browser bundle.",
            },
            {
              name: "sidekick-shared/dist/pricingCatalog",
              message:
                "Use 'sidekick-shared/node' for pricing hydration; that path is intentionally Node-only and must never be imported from a webview.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["out/", "node_modules/", "*.config.js"],
  }
);
