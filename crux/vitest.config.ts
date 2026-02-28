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
      'enrich/**/*.test.ts',
      'facts/**/*.test.ts',
      'entity/**/*.test.ts',
      'citations/**/*.test.ts',
      'claims/**/*.test.ts',
      'validate/**/*.test.ts',
      'wiki-server/**/*.test.ts',
      'evals/**/*.test.ts',
    ],
    root: __dirname,
    // Run test files sequentially to prevent cross-file test contamination.
    // Some test files share mocked module state; parallel execution can cause
    // flaky failures from mock setup/teardown racing.
    fileParallelism: false,
  },
});
