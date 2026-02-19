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
    ],
    // creator.test.ts imports source-fetching.ts which eagerly loads
    // better-sqlite3 native bindings via knowledge-db.ts at module scope.
    // Exclude until knowledge-db uses lazy initialization.
    exclude: [
      'authoring/creator/creator.test.ts',
    ],
    root: __dirname,
  },
});
