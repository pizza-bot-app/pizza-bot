// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/** Fast, non-type-checked linting plus package-layer import guards. */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-server/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.d.ts",
      ".worktrees/**",
      ".claude/worktrees/**",
      "apps/desktop-shell/out/**",
      "apps/web/dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: [
      "apps/{api-server,cli,agent-daemon,desktop-shell}/**/*.{ts,mjs,js}",
      "packages/**/*.{ts,mjs}",
      "plugins/**/*.{js,mjs,ts}",
      "scripts/**/*.{js,mjs}",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The frontend may use transport SDKs but not runtime engines or model bindings.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "deepagents",
                "@langchain/langgraph",
                "@langchain/langgraph/*",
                "@langchain/aws",
              ],
              message:
                "The frontend speaks the wire only. It MAY import @langchain/langgraph-sdk (the transport), but NOT the runtime graph engine (deepagents / @langchain/langgraph core) or a model binding — those stay behind the api-server. See AGENTS.md 'Layering discipline'.",
            },
          ],
        },
      ],
    },
  },
  {
    // Core may import LangChain types, but no runtime engine, provider, or Node API.
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "deepagents",
                "@langchain/langgraph",
                "@langchain/langgraph/*",
                "@langchain/aws",
                "ai",
                "node:*",
              ],
              message:
                "core may reference @langchain/core TYPES only. The runtime graph engine (deepagents / @langchain/langgraph) stays in runtime-langgraph. See AGENTS.md 'Layering discipline'.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-imports": "off",
    },
  },
);
