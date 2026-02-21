import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'authoring/**/*.test.ts',
      'auto-update/**/*.test.ts',
      'link-checker/**/*.test.ts',
      'commands/**/*.test.ts',
      'facts/**/*.test.ts',
      'entity/**/*.test.ts',
      'citations/**/*.test.ts',
      'validate/**/*.test.ts',
      'wiki-server/**/*.test.ts',
    ],
    root: __dirname,
    // Run test files sequentially to prevent SQLite cross-file contamination.
    // Multiple test files share a single on-disk SQLite DB (knowledge.db); parallel
    // execution causes one worker's beforeEach/afterEach cleanup to race with
    // another worker's seed step, producing flaky failures.
    fileParallelism: false,
  },
});
