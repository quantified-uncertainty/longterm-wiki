/**
 * Tests for the workspace dep coverage validator.
 *
 * Strategy:
 *   1. Regression test — the actual repo must pass (this is also the proof
 *      that the "fix gaps in the same PR" step of QUA-598 was done).
 *   2. Unit tests — build temp app trees with deliberate shapes and assert
 *      the validator classifies them correctly (undeclared → error,
 *      declared-unused → warning, subpath imports, type-only imports).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

import { runCheck } from './validate-workspace-dep-coverage.ts';

interface AppFixture {
  name: string;
  dependencies?: Record<string, string>;
  sources?: Record<string, string>; // relative path under src/ -> content
}

function makeAppsDir(fixtures: AppFixture[]): string {
  const root = join(
    os.tmpdir(),
    `workspace-dep-coverage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  for (const app of fixtures) {
    const appDir = join(root, app.name);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify(
        {
          name: app.name,
          version: '0.0.0',
          private: true,
          dependencies: app.dependencies ?? {},
        },
        null,
        2
      )
    );
    if (app.sources) {
      mkdirSync(join(appDir, 'src'), { recursive: true });
      for (const [relPath, content] of Object.entries(app.sources)) {
        const full = join(appDir, 'src', relPath);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
      }
    }
  }
  return root;
}

describe('validate-workspace-dep-coverage', () => {
  let scratch: string | null = null;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = null;
    }
  });

  it('current repo has no undeclared workspace imports', () => {
    // Regression test: if this fails, a real undeclared import snuck into
    // apps/*/src/ and will break the prod Docker build.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it('fails when an app imports a workspace package that is not declared', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {},
        sources: {
          'index.ts':
            `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';\n` +
            `normalizeUrlForDedup('https://example.com');\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].missing).toEqual(['@longterm-wiki/url-utils']);
  });

  it('passes when every used workspace import is declared', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {
          '@longterm-wiki/url-utils': 'workspace:*',
          '@longterm-wiki/id-utils': 'workspace:*',
        },
        sources: {
          'index.ts':
            `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';\n` +
            `import { isSid } from '@longterm-wiki/id-utils';\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.apps[0].used).toEqual(
      new Set(['@longterm-wiki/url-utils', '@longterm-wiki/id-utils'])
    );
  });

  it('strips subpaths when counting package usage', () => {
    // `@longterm-wiki/factbase/types` is an import from `@longterm-wiki/factbase`.
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {
          '@longterm-wiki/factbase': 'workspace:*',
        },
        sources: {
          'index.ts':
            `import type { FactSchema } from '@longterm-wiki/factbase/types';\n` +
            `import { serialize } from '@longterm-wiki/factbase';\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.apps[0].used).toEqual(new Set(['@longterm-wiki/factbase']));
  });

  it('flags multi-app gaps independently', () => {
    scratch = makeAppsDir([
      {
        name: 'clean-app',
        dependencies: { '@longterm-wiki/id-utils': 'workspace:*' },
        sources: { 'a.ts': `import { isSid } from '@longterm-wiki/id-utils';` },
      },
      {
        name: 'broken-app',
        dependencies: {},
        sources: { 'a.ts': `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';` },
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);

    const clean = result.apps.find((a) => a.app === 'clean-app');
    const broken = result.apps.find((a) => a.app === 'broken-app');
    expect(clean?.missing).toEqual([]);
    expect(broken?.missing).toEqual(['@longterm-wiki/url-utils']);
  });

  it('reports declared-but-unused workspace deps as a warning, not an error', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {
          '@longterm-wiki/url-utils': 'workspace:*',
          '@longterm-wiki/id-utils': 'workspace:*',
        },
        sources: {
          'a.ts': `import { isSid } from '@longterm-wiki/id-utils';`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.apps[0].unused).toEqual(['@longterm-wiki/url-utils']);
  });

  it('ignores non-source files and nested node_modules', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {},
        sources: {
          // These files should NOT count toward the used set:
          'README.md': `See \`@longterm-wiki/url-utils\` for docs.\n`,
          'data.json': `{"pkg": "@longterm-wiki/url-utils"}\n`,
        },
      },
    ]);

    // Simulate a nested node_modules symlink-style dir — scanner must skip it
    // even if it contains .ts files that reference workspace packages.
    const dir = join(scratch, 'my-app', 'src', 'node_modules', 'something');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.ts'),
      `import { x } from '@longterm-wiki/url-utils';\n`
    );

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.apps[0].used.size).toBe(0);
  });

  it('handles apps with no src/ directory gracefully', () => {
    scratch = makeAppsDir([
      {
        name: 'stub-app',
        dependencies: {},
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].used.size).toBe(0);
  });

  it('returns passed=true when the apps directory does not exist', () => {
    const result = runCheck({ appsDir: join(os.tmpdir(), `nonexistent-${Date.now()}`) });
    expect(result.passed).toBe(true);
    expect(result.apps).toEqual([]);
  });

  it('detects require() and dynamic import() forms', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {},
        sources: {
          'a.cjs': `const { x } = require('@longterm-wiki/url-utils');\n`,
          'b.ts': `const mod = await import('@longterm-wiki/id-utils');\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.apps[0].missing).toEqual(
      ['@longterm-wiki/id-utils', '@longterm-wiki/url-utils'].sort()
    );
  });
});
