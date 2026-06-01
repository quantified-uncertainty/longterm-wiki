// Flat ESLint config — incremental adoption per QUA-388.
//
// Phases 1 & 2 shipped together:
//   - install + flat config + type-aware parsing
//   - `@typescript-eslint/no-floating-promises` enabled as error
// Phase 3+: each new rule lands as its own follow-up PR.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/web/public/**',
      'apps/web/.next/**',
      // shadcn/ui generated components
      'apps/web/src/components/ui/**',
      // Build artifacts and caches
      '.git/**',
      '.claude/**',
      'docker/**',
      'public/**',
      'dev/**',
      // Drizzle migration metadata is generated.
      'apps/wiki-server/drizzle/meta/**',
      // Test fixtures and snapshot data have intentionally weird shapes.
      '**/__fixtures__/**',
      '**/__snapshots__/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware linting via a dedicated tsconfig that covers every
        // source file across the monorepo. The per-app tsconfigs are kept
        // narrower for build/typecheck ergonomics; this one exists so
        // ESLint sees every file consistently.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      // Registered so existing `// eslint-disable-next-line react-hooks/*`
      // comments resolve against a known plugin. No rules are enabled in
      // Phase 1 — adopting react-hooks rules is out of scope for QUA-388.
      'react-hooks': reactHooks,
    },
    linterOptions: {
      // Existing `// eslint-disable-next-line <rule>` comments anticipate
      // rules that this incremental adoption hasn't enabled yet
      // (`@typescript-eslint/no-explicit-any`, `no-console`, etc.). Turning
      // this off avoids flagging them as unused while phases 3+ catch up.
      // Re-enable once the referenced rules are active.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // QUA-388 Phase 2: catches the highest-hit-rate pattern from the
      // PR-review survey — unhandled promises that silently swallow
      // errors. Either `await`, `void`, or `.catch(...)` the result.
      // See `.claude/rules/error-handling.md` for the in-repo policy on
      // when each is appropriate.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
