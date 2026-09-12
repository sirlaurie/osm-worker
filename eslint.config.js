import stylistic from "@stylistic/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  { ignores: [".build/**", ".wrangler/**"] },
  {
    files: [
      "worker/**/*.ts",
      "tests/**/*.ts",
      "tools/**/*.ts",
      "eslint.config.js",
    ],
    languageOptions: { parser },
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        {
          blankLine: "always",
          prev: "*",
          next: [
            "return",
            "if",
            "for",
            "while",
            "do",
            "switch",
            "try",
            "block-like",
          ],
        },
        {
          blankLine: "always",
          prev: ["block-like", "if", "for", "while", "do", "switch", "try"],
          next: "*",
        },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
      ],
    },
  },
];
