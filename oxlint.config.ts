import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: { ...core.env, node: true },
  extends: [core],
  ignorePatterns: [
    ...core.ignorePatterns,
    ".runtime/**",
    "data/**",
    "vendor/**",
  ],
  options: { typeAware: true },
  overrides: [
    ...core.overrides,
    {
      files: [
        "verify/attestation.ts",
        "verify/schema.ts",
        "verify/claim-type.ts",
        "src/config.ts",
        "src/server.ts",
      ],
      // Existing validators are ordered refusal checklists. Keep their checks together for auditing.
      // Application workflow/HTTP helpers retain the core maximum of 20.
      rules: { complexity: ["error", 60] },
    },
    {
      files: ["test/**"],
      // HTTP responses and malformed fixtures are asserted at runtime in these tests.
      rules: {
        // node:test owns the scheduled test promises and reports their failures.
        "no-void": ["error", { allowAsStatement: true }],
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
    {
      files: ["**/*.js", "**/*.mjs"],
      // These standalone browser/operator scripts have no TypeScript program.
      // Syntax/security rules still apply; TS sources retain the type-aware rules.
      rules: {
        "typescript/no-base-to-string": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
    {
      files: ["verify/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                message:
                  "The standalone verifier must never import issuer code.",
                regex: "(^|/)src/",
              },
            ],
          },
        ],
      },
    },
  ],
  rules: {
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    // Named declarations keep stack traces readable and allow helpers below their callers.
    // State transitions and remote writes are deliberately ordered, including retries.
    "no-await-in-loop": "off",
    // Failed-precondition branches remain first, even when an else is also present.
    "no-negated-condition": "off",
    "no-nested-ternary": "off",
    // TypeScript checks direct use before declaration; helper closures may be declared below callers.
    "no-use-before-define": "off",
    "prefer-named-capture-group": "off",
    // Node callback APIs require Promise constructors; numbered captures are destructured.
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    // Event-loop boundaries and the serial operation queue intentionally use catch/then.
    "promise/prefer-await-to-then": "off",
    // Promise-returning interface implementations need not manufacture an await.
    "require-await": "off",
    "typescript/consistent-return": "off",
    // Both interface methods and function properties are used to model existing package APIs.
    "typescript/method-signature-style": "off",
    // Return types and no-misused-promises check callbacks; guard returns may return void.
    "typescript/no-confusing-void-expression": "off",
    // Defensive string conversions are retained at database and display boundaries.
    "typescript/no-unnecessary-type-conversion": "off",
    "typescript/parameter-properties": "off",
    // Empty user input intentionally falls back; do not turn || into ?? automatically.
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/promise-function-async": "off",
    "typescript/return-await": ["error", "in-try-catch"],
    // Runtime guards remain useful for decoded data and indexed dictionaries.
    "typescript/strict-boolean-expressions": "off",
    "typescript/strict-void-return": "off",
    // Methods, local helpers and short conditional expressions are permitted.
    "unicorn/consistent-function-scoping": "off",
    // Standard-library named imports and constructor parameter properties remain idiomatic.
    "unicorn/import-style": "off",
    // Awaiting a typed result before selecting a field is unambiguous in this codebase.
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-negated-condition": "off",
  },
});
