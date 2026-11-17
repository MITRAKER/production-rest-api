// @ts-check
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import prettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noRecursion from './eslint-rules/no-recursion.js';

/**
 * Lint configuration.
 *
 * Base: ESLint's recommended rules, typescript-eslint's strictest type-aware
 * presets, and SonarJS (bug and code-smell detection).
 *
 * On top of that, the NASA/JPL "Power of Ten" rules, adapted to TypeScript.
 * Each rule below is labeled with the Power of Ten rule it enforces.
 * LEARNING.md chapter 3 explains every one of them.
 *
 * Everything is an error, never a warning, and CI runs with --max-warnings 0.
 */

/** Selectors banned everywhere (rules 2 and 8). */
const bannedEverywhere = [
  {
    selector: 'WhileStatement',
    message:
      'Power of Ten rule 2: use a for loop with a fixed upper bound, or iterate a finite array.',
  },
  {
    selector: 'DoWhileStatement',
    message:
      'Power of Ten rule 2: use a for loop with a fixed upper bound, or iterate a finite array.',
  },
  {
    selector: 'ForInStatement',
    message:
      'Power of Ten rule 2: for...in also walks inherited properties. Iterate Object.keys() or Object.entries() instead.',
  },
  {
    selector: 'ForOfStatement[await=true]',
    message:
      'Power of Ten rule 2: for await...of can wait forever on an endless stream. Bound it explicitly.',
  },
  {
    selector: 'TSAsExpression[expression.type="TSAsExpression"]',
    message:
      'Power of Ten rule 8: a double type assertion (x as unknown as T) switches the type checker off.',
  },
];

/** Module-level mutable state (rule 6). Allowed in tests for the usual `let app` + beforeAll pattern. */
const bannedInSource = [
  {
    selector:
      'Program > VariableDeclaration[kind="let"], Program > ExportNamedDeclaration > VariableDeclaration[kind="let"]',
    message:
      'Power of Ten rule 6: no module-level mutable state. Use const, or keep the state inside a function or class.',
  },
];

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', 'src/generated/', 'prisma/migrations/']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  comments.recommended,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // An eslint-disable comment that no longer disables anything is an error.
      reportUnusedDisableDirectives: 'error',
    },
    plugins: { local: { rules: { 'no-recursion': noRecursion } } },
    rules: {
      // ---- Rule 1: simple control flow, no recursion -----------------------
      'local/no-recursion': 'error',
      'no-labels': 'error',
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'sonarjs/cognitive-complexity': ['error', 15],

      // ---- Rule 2: every loop has a fixed upper bound ----------------------
      // (while / do-while / for-in / for-await are banned via no-restricted-syntax)
      'no-restricted-syntax': ['error', ...bannedEverywhere, ...bannedInSource],
      'no-constant-condition': ['error', { checkLoops: 'all' }],
      'no-unmodified-loop-condition': 'error',

      // ---- Rule 3: bounded resources (no unbounded allocation) --------------
      // Not lintable: enforced by explicit limits in code (body size, string
      // lengths, pool size, timeouts) and by test/input-bounds.test.ts.

      // ---- Rule 4: functions fit on one printed page -----------------------
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],

      // ---- Rule 5: assertions --------------------------------------------
      // Not lintable: inputs are validated by Zod schemas at the boundary and
      // internal invariants use invariant() from src/lib/invariant.ts.

      // ---- Rule 6: smallest possible scope ---------------------------------
      'no-var': 'error',
      'prefer-const': 'error',
      'block-scoped-var': 'error',
      'no-implicit-globals': 'error',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/prefer-readonly': 'error',

      // ---- Rule 7: check every return value and every parameter -----------
      // (no-floating-promises and no-misused-promises come from strictTypeChecked)
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      'sonarjs/no-ignored-return': 'error',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // ---- Rule 8: no metaprogramming escape hatches ----------------------
      // (no-explicit-any, no-non-null-assertion, ban-ts-comment come from strictTypeChecked)
      'no-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',

      // ---- Rule 9: limit indirection and mutation --------------------------
      'no-param-reassign': ['error', { props: true }],
      'max-params': ['error', 4],
      'max-nested-callbacks': ['error', 3],

      // ---- Rule 10: zero warnings, all checks on ---------------------------
      // Every rule here is 'error'; CI runs eslint with --max-warnings 0 and
      // tsc with the strictest settings (see tsconfig.json).

      // ---- Style that helps readers ------------------------------------------
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    // Tests are "ground support equipment": same safety rules, relaxed size rules.
    files: ['test/**/*.ts'],
    rules: {
      // describe() blocks are long lists of small tests.
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      'max-nested-callbacks': ['error', 4],
      // `let app` assigned in beforeAll is the standard test pattern.
      'no-restricted-syntax': ['error', ...bannedEverywhere],
      // HTTP response bodies are untyped JSON (res.json() returns any);
      // the assertions themselves check their shape.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Fixture passwords and repeated URLs are expected in tests.
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/no-duplicate-string': 'off',
    },
  },

  {
    // RuleTester.run() creates the describe/it blocks, which SonarJS can't see.
    files: ['test/no-recursion-rule.test.ts'],
    rules: { 'sonarjs/no-empty-test-file': 'off' },
  },

  {
    // Plain JavaScript files (configs, scripts, the custom lint rule) are
    // type-checked by tsc through `checkJs`, not by type-aware lint rules.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must be last: turns off rules that would fight with Prettier's formatting.
  prettier,
]);
