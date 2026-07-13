import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [".*/", "node_modules/", "skills/", "docs/", "pages/", "path/"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "src/**/*.mjs", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true,
      }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // False-positives on let-then-assign-in-try patterns where the initial
      // value is the catch-path fallback.
      "no-useless-assignment": "off",
      // A CLI tool legitimately matches ANSI escape sequences.
      "no-control-regex": "off",
    },
  },
];
