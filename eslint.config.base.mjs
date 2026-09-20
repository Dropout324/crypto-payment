// Shared flat-config base for every workspace project except apps/web (which
// has its own eslint-config-next-based config - see its eslint.config.mjs).
// Each of the other 12 projects imports this unchanged as
//   import base from '../../eslint.config.base.mjs';
//   export default base;
// A per-project config file is required either way - flat config does not
// search upward through a monorepo the way .eslintrc did - so this exists to
// give all 12 the same rules from one place rather than duplicating them.
//
// Deliberately NOT using typescript-eslint's type-checked rule sets
// (`recommendedTypeChecked`): those need each project's `parserOptions.project`
// pointed at a tsconfig whose `include` covers every linted file, including
// `test/**` - several projects' own tsconfig.json excludes `test` (it is a
// separate `tsc -b` root reserved for `vitest`, not the build). Getting that
// wired correctly per project was judged not worth it for this pass; the
// syntax-level `recommended` set (unused vars, no-explicit-any, floating
// promises via other lint-adjacent rules, etc.) already turns "lint runs but
// checks nothing" (the gap this closes) into a real gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      '**/node_modules/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Principle #8 (README) - "secrets are never logged" - is enforced by
      // routing every log line through @gateway/security's redact() /
      // @gateway/observability's logger, never `console`. A handful of call
      // sites predate that (or are a `main.ts` last-resort catch before the
      // logger could plausibly have started) and mark themselves with an
      // explicit `eslint-disable-next-line no-console` - this rule is what
      // makes that comment mean something instead of nothing.
      'no-console': 'error',
      // Unused destructured/catch-bound values are common and intentional in
      // this codebase (e.g. `catch { … }` re-throws without inspecting the
      // error) - only flag unused values that are trivially dead code.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // The domain layer leans on `unknown` + narrowing (see AppError,
      // redact()); `any` shows up occasionally at real boundary points
      // (third-party response shapes, Prisma JSON columns). Warn, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
