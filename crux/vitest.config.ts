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
    ],
    root: __dirname,
  },
});
