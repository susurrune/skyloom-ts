// ESLint 9 flat config. Replaces the missing config that made `npm run lint` a
// silent no-op. Scope: src/ TypeScript. We run WITHOUT type-aware linting (no
// parserOptions.project) so it's fast and doesn't need a second TS program;
// the strict tsconfig already does the type checking.
//
// Philosophy: errors catch real bugs (unused vars, unsafe patterns); the large
// existing `any` surface and a few stylistic rules are warnings so the gate is
// honest without forcing a mass rewrite to go green. Tighten over time.

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', module: 'writable',
        require: 'readonly', exports: 'writable', global: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly',
        FormData: 'readonly', Blob: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        performance: 'readonly', NodeJS: 'readonly', BufferEncoding: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // ── Real-bug errors ──
      'no-unused-vars': 'off', // superseded by the TS-aware version below
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-cond-assign': ['error', 'except-parens'],

      // ── Debt warnings (honest, not blocking) ──
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'warn',
    },
  },
];
