import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@wiki-server/checker-model': path.resolve(
        __dirname,
        '../apps/wiki-server/src/routes/sourcing/checker-model.ts',
      ),
    },
  },
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
      'validate/**/*.test.ts',
      'wiki-server/**/*.test.ts',
      'evals/**/*.test.ts',
      'health/**/*.test.ts',
      'pr-patrol/**/*.test.ts',
      'tablebase/**/*.test.ts',
      'qa-sweep/**/*.test.ts',
      'resource-enrichment/**/*.test.ts',
      'system-cards/**/*.test.ts',
      'frameworks/**/*.test.ts',
      'scripts/**/*.test.ts',
      'git/**/*.test.ts',
    ],
    exclude: [],
    root: __dirname,
    // Run test files sequentially to prevent cross-file test contamination.
    // Some test files share mocked module state; parallel execution can cause
    // flaky failures from mock setup/teardown racing.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'lib/**/*.ts',
        'authoring/**/*.ts',
        'auto-update/**/*.ts',
        'commands/**/*.ts',
        'validate/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
      ],
    },
  },
});
