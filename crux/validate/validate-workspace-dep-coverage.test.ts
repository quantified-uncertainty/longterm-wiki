/**
 * Tests for the workspace dep coverage validator.
 *
 * Strategy:
 *   1. Regression test — the actual repo must pass (this is also the proof
 *      that the "fix gaps in the same PR" step of QUA-598 was done).
 *   2. Unit tests — build temp app trees with deliberate shapes and assert
 *      the validator classifies them correctly (undeclared → error,
 *      declared-unused → warning, subpath imports, dep-section coverage,
 *      comment/string false-positive resistance, etc.).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';

import {
  runCheck,
  extractWorkspaceImports,
} from './validate-workspace-dep-coverage.ts';

function makeScratchDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'workspace-dep-coverage-'));
}

/**
 * Default worker-check paths for app-focused tests: point at guaranteed-missing
 * locations so the worker scan is a no-op and doesn't pull in the real repo's
 * docker/worker manifest.
 */
const NO_WORKER = {
  workerPkgJson: '/nonexistent-worker-pkg-json',
  workerDockerfile: '/nonexistent-worker-dockerfile',
  workerSourceDir: '/nonexistent-crux-dir',
};

interface AppFixture {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** relative path under the app root (use 'src/foo.ts', 'scripts/build.mjs'). */
  files?: Record<string, string>;
  /** Optional raw content for package.json (overrides the JSON builder). */
  packageJsonOverride?: string;
}

function makeAppsDir(fixtures: AppFixture[]): string {
  const root = makeScratchDir();
  for (const app of fixtures) {
    const appDir = join(root, app.name);
    mkdirSync(appDir, { recursive: true });
    const pkgBody =
      app.packageJsonOverride ??
      JSON.stringify(
        {
          name: app.name,
          version: '0.0.0',
          private: true,
          dependencies: app.dependencies ?? {},
          devDependencies: app.devDependencies ?? {},
          peerDependencies: app.peerDependencies ?? {},
          optionalDependencies: app.optionalDependencies ?? {},
        },
        null,
        2
      );
    writeFileSync(join(appDir, 'package.json'), pkgBody);
    if (app.files) {
      for (const [relPath, content] of Object.entries(app.files)) {
        const full = join(appDir, relPath);
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
    // apps/*/src/ or scripts/ and will break the prod Docker build.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it('fails when an app imports a workspace package that is not declared', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        files: {
          'src/index.ts':
            `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';\n` +
            `normalizeUrlForDedup('https://example.com');\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
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
        files: {
          'src/index.ts':
            `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';\n` +
            `import { isSid } from '@longterm-wiki/id-utils';\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.apps[0].used).toEqual(
      new Set(['@longterm-wiki/url-utils', '@longterm-wiki/id-utils'])
    );
  });

  it('accepts declaration in devDependencies, peerDependencies, or optionalDependencies', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        devDependencies: { '@longterm-wiki/id-utils': 'workspace:*' },
        peerDependencies: { '@longterm-wiki/factbase': 'workspace:*' },
        optionalDependencies: { '@longterm-wiki/url-utils': 'workspace:*' },
        files: {
          'src/a.ts':
            `import { isSid } from '@longterm-wiki/id-utils';\n` +
            `import { serialize } from '@longterm-wiki/factbase';\n` +
            `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.apps[0].missing).toEqual([]);
  });

  it('strips subpaths when counting package usage', () => {
    // `@longterm-wiki/factbase/types` is an import from `@longterm-wiki/factbase`.
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: {
          '@longterm-wiki/factbase': 'workspace:*',
        },
        files: {
          'src/index.ts':
            `import type { FactSchema } from '@longterm-wiki/factbase/types';\n` +
            `import { serialize } from '@longterm-wiki/factbase';\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
    expect(result.apps[0].used).toEqual(new Set(['@longterm-wiki/factbase']));
  });

  it('scans apps/<name>/scripts/ in addition to src/', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        // Nothing declared — imports from scripts/ must still be caught.
        files: {
          'scripts/build.mjs':
            `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(false);
    expect(result.apps[0].missing).toEqual(['@longterm-wiki/url-utils']);
  });

  it('flags multi-app gaps independently', () => {
    scratch = makeAppsDir([
      {
        name: 'clean-app',
        dependencies: { '@longterm-wiki/id-utils': 'workspace:*' },
        files: { 'src/a.ts': `import { isSid } from '@longterm-wiki/id-utils';` },
      },
      {
        name: 'broken-app',
        files: { 'src/a.ts': `import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';` },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
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
        files: {
          'src/a.ts': `import { isSid } from '@longterm-wiki/id-utils';`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.apps[0].unused).toEqual(['@longterm-wiki/url-utils']);
  });

  it('ignores non-source files and nested node_modules', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        files: {
          // These files should NOT count toward the used set:
          'src/README.md': `See \`@longterm-wiki/url-utils\` for docs.\n`,
          'src/data.json': `{"pkg": "@longterm-wiki/url-utils"}\n`,
        },
      },
    ]);

    // Simulate a nested node_modules dir — scanner must skip it even if it
    // contains .ts files that reference workspace packages.
    const nm = join(scratch, 'my-app', 'src', 'node_modules', 'something');
    mkdirSync(nm, { recursive: true });
    writeFileSync(
      join(nm, 'index.ts'),
      `import { x } from '@longterm-wiki/url-utils';\n`
    );

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
    expect(result.apps[0].used.size).toBe(0);
  });

  it('does NOT false-positive on bare mentions in comments or strings', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        files: {
          'src/a.ts':
            `// See @longterm-wiki/this-does-not-exist for docs.\n` +
            `const doc = 'visit @longterm-wiki/not-a-real-package';\n` +
            `/* JSDoc: pulls from @longterm-wiki/also-fake */\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    // No real imports → passes, no missing entries.
    expect(result.passed).toBe(true);
    expect(result.apps[0].used.size).toBe(0);
  });

  it('handles apps with no src/ or scripts/ directory gracefully', () => {
    scratch = makeAppsDir([
      { name: 'stub-app' },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].used.size).toBe(0);
  });

  it('returns passed=true when the apps directory does not exist', () => {
    const result = runCheck({
      appsDir: join(os.tmpdir(), `nonexistent-${Date.now()}`),
      ...NO_WORKER,
    });
    expect(result.passed).toBe(true);
    expect(result.apps).toEqual([]);
  });

  it('detects require() and dynamic import() forms', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        files: {
          'src/a.cjs': `const { x } = require('@longterm-wiki/url-utils');\n`,
          'src/b.ts': `const mod = await import('@longterm-wiki/id-utils');\n`,
        },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(false);
    // Sorted alphabetically in the output.
    expect(result.apps[0].missing).toEqual([
      '@longterm-wiki/id-utils',
      '@longterm-wiki/url-utils',
    ]);
  });

  it('calls onWarn when package.json is malformed', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        packageJsonOverride: `{ "name": "my-app", "dependencies": [ broken `,
        files: {
          'src/a.ts': `import { x } from '@longterm-wiki/url-utils';`,
        },
      },
    ]);

    const warnings: string[] = [];
    const result = runCheck({
      appsDir: scratch,
      ...NO_WORKER,
      onWarn: (msg) => warnings.push(msg),
    });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/Malformed package.json/);
    // With no declared deps, the import is still flagged as missing.
    expect(result.passed).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Worker manifest tests — docker/worker/package.json vs crux/ imports.
  // QUA-605: the worker image copies all of crux/ wholesale, so imports
  // there must be declared in docker/worker/package.json (which is NOT a
  // pnpm workspace member).
  // ---------------------------------------------------------------------

  it('flags undeclared workspace imports from the worker source tree', () => {
    scratch = makeScratchDir();
    // Empty apps dir (points to a missing location, which the validator treats
    // as a no-op).
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({ name: 'worker', dependencies: {} })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    writeFileSync(
      join(cruxDir, 'lib', 'url.ts'),
      `import { normalizeUrl } from '@longterm-wiki/url-utils';\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: join(workerDir, 'package.json'),
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(false);
    const worker = result.apps.find((a) => a.app === 'docker/worker');
    expect(worker).toBeDefined();
    expect(worker?.missing).toEqual(['@longterm-wiki/url-utils']);
  });

  it('passes when worker manifest declares every crux-imported workspace pkg', () => {
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
        },
      })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    writeFileSync(
      join(cruxDir, 'lib', 'url.ts'),
      `import { normalizeUrl } from '@longterm-wiki/url-utils';\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: join(workerDir, 'package.json'),
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(true);
    const worker = result.apps.find((a) => a.app === 'docker/worker');
    expect(worker?.missing).toEqual([]);
    expect(worker?.used).toEqual(new Set(['@longterm-wiki/url-utils']));
  });

  it('excludes crux test files from the worker scan', () => {
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({ name: 'worker', dependencies: {} })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    mkdirSync(join(cruxDir, 'lib', '__tests__'), { recursive: true });
    // Test file imports url-utils — should NOT trigger a violation, since
    // tests don't run in the worker image.
    writeFileSync(
      join(cruxDir, 'lib', 'url.test.ts'),
      `import { normalizeUrl } from '@longterm-wiki/url-utils';\n`
    );
    writeFileSync(
      join(cruxDir, 'lib', '__tests__', 'another.ts'),
      `import { isSid } from '@longterm-wiki/id-utils';\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: join(workerDir, 'package.json'),
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(true);
    const worker = result.apps.find((a) => a.app === 'docker/worker');
    expect(worker?.used.size).toBe(0);
  });

  it('worker report uses docker/worker manifest path + file: protocol suggestion', () => {
    // Regression guard for the misleading "add to apps/docker/worker/package.json
    // with workspace:*" error that would lead a future contributor into
    // reproducing QUA-605 all over again.
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({ name: 'worker', dependencies: {} })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    writeFileSync(
      join(cruxDir, 'lib', 'url.ts'),
      `import { normalizeUrl } from '@longterm-wiki/url-utils';\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: join(workerDir, 'package.json'),
      workerSourceDir: cruxDir,
    });

    const worker = result.apps.find((a) => a.app === 'docker/worker');
    expect(worker?.manifestPath).toBe('docker/worker/package.json');
    expect(worker?.depSuggestion('@longterm-wiki/url-utils')).toBe(
      'file:./packages/url-utils'
    );
  });

  it('app report uses apps/<name>/package.json path + workspace:* suggestion', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        files: { 'src/a.ts': `import { x } from '@longterm-wiki/url-utils';` },
      },
    ]);

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    const app = result.apps[0];
    expect(app.manifestPath).toBe('apps/my-app/package.json');
    expect(app.depSuggestion('@longterm-wiki/url-utils')).toBe('workspace:*');
  });

  it('excludes *.spec.ts, *.test-d.ts, and tests/ directories from worker scan', () => {
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'package.json'),
      JSON.stringify({ name: 'worker', dependencies: {} })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    mkdirSync(join(cruxDir, 'tests'), { recursive: true });
    // All three should be excluded:
    writeFileSync(
      join(cruxDir, 'lib', 'x.spec.ts'),
      `import { a } from '@longterm-wiki/url-utils';\n`
    );
    writeFileSync(
      join(cruxDir, 'lib', 'y.test-d.ts'),
      `import { b } from '@longterm-wiki/id-utils';\n`
    );
    writeFileSync(
      join(cruxDir, 'tests', 'z.ts'),
      `import { c } from '@longterm-wiki/factbase';\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: join(workerDir, 'package.json'),
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(true);
    const worker = result.apps.find((a) => a.app === 'docker/worker');
    expect(worker?.used.size).toBe(0);
  });

  it('skips the worker check entirely when the manifest is missing', () => {
    scratch = makeScratchDir();
    const result = runCheck({
      appsDir: join(scratch, 'apps-missing'),
      workerPkgJson: join(scratch, 'worker-missing', 'package.json'),
      workerSourceDir: join(scratch, 'crux-missing'),
    });

    expect(result.passed).toBe(true);
    expect(result.apps.find((a) => a.app === 'docker/worker')).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Dockerfile COPY tests — every file:./packages/<pkg> dep in the worker
  // manifest must have a matching `COPY packages/<pkg>/` line in
  // Dockerfile.worker, or `pnpm install --prod` fails at image build.
  // QUA-654: the second half of the QUA-605 invariant.
  // ---------------------------------------------------------------------

  it('flags file: deps without a matching COPY line in Dockerfile.worker', () => {
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
          '@longterm-wiki/forgotten': 'file:./packages/forgotten',
        },
      })
    );

    // Crux imports are fine — this test isolates the COPY-line check.
    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    writeFileSync(
      join(cruxDir, 'lib', 'a.ts'),
      `import { x } from '@longterm-wiki/url-utils';\n` +
        `import { y } from '@longterm-wiki/forgotten';\n`
    );

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `COPY packages/url-utils/ ./packages/url-utils/\n` +
        // NOTE: forgotten/ COPY is missing on purpose.
        `COPY docker/worker/package.json ./\n` +
        `RUN pnpm install --prod\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(false);
    expect(result.dockerCopy).toBeDefined();
    expect(result.dockerCopy!.missingCopy).toEqual(['forgotten']);
    expect(result.dockerCopy!.fileDeps).toEqual(new Set(['url-utils', 'forgotten']));
    expect(result.dockerCopy!.copied).toEqual(new Set(['url-utils']));
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('passes when every worker file: dep has a matching COPY line', () => {
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
        },
      })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    writeFileSync(
      join(cruxDir, 'lib', 'a.ts'),
      `import { x } from '@longterm-wiki/url-utils';\n`
    );

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `COPY packages/url-utils/ ./packages/url-utils/\n` +
        `COPY docker/worker/package.json ./\n` +
        `RUN pnpm install --prod\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(true);
    expect(result.dockerCopy!.missingCopy).toEqual([]);
  });

  it('ignores workspace:* deps — only file: deps need a COPY line', () => {
    // Sanity: the Dockerfile COPY check should not fire for `workspace:*`
    // or `^1.0.0` deps, since those resolve via pnpm's workspace or npm
    // registry and don't need a local packages/<pkg>/ directory.
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
          // workspace:* and version-range deps should be ignored by the COPY check.
          '@longterm-wiki/hoisted': 'workspace:*',
          'zod': '^3.25.0',
        },
      })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(join(cruxDir, 'lib'), { recursive: true });
    writeFileSync(
      join(cruxDir, 'lib', 'a.ts'),
      `import { x } from '@longterm-wiki/url-utils';\n` +
        `import { y } from '@longterm-wiki/hoisted';\n`
    );

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `COPY packages/url-utils/ ./packages/url-utils/\n` +
        `RUN pnpm install --prod\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: cruxDir,
    });

    expect(result.dockerCopy!.fileDeps).toEqual(new Set(['url-utils']));
    expect(result.dockerCopy!.missingCopy).toEqual([]);
  });

  it('accepts COPY lines with --from/--chown flags before the path', () => {
    // Some Dockerfiles use `COPY --chown=user:group packages/foo/ ./packages/foo/`.
    // The parser must tolerate flag args before the source path.
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
        },
      })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(cruxDir, { recursive: true });

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `COPY --chown=node:node packages/url-utils/ ./packages/url-utils/\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: cruxDir,
    });

    expect(result.dockerCopy!.copied).toEqual(new Set(['url-utils']));
  });

  it('does not count COPY lines in comments', () => {
    // A commented-out COPY line must not satisfy the coverage check —
    // otherwise a reviewer commenting out a line to debug would silently
    // re-introduce the QUA-605 failure mode.
    scratch = makeScratchDir();
    const emptyApps = join(scratch, 'apps-missing');

    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
        },
      })
    );

    const cruxDir = join(scratch, 'crux');
    mkdirSync(cruxDir, { recursive: true });

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `# COPY packages/url-utils/ ./packages/url-utils/\n`
    );

    const result = runCheck({
      appsDir: emptyApps,
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: cruxDir,
    });

    expect(result.passed).toBe(false);
    expect(result.dockerCopy!.missingCopy).toEqual(['url-utils']);
  });

  it('skips the Dockerfile check entirely when the Dockerfile is missing', () => {
    scratch = makeScratchDir();
    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
        },
      })
    );

    const result = runCheck({
      appsDir: join(scratch, 'apps-missing'),
      workerPkgJson: workerPkg,
      workerDockerfile: join(scratch, 'Dockerfile.missing'),
      workerSourceDir: join(scratch, 'crux-missing'),
    });

    // No Dockerfile means no coverage report — don't generate false errors.
    expect(result.dockerCopy).toBeUndefined();
    expect(result.errors).toBe(0);
  });

  it('warns when a @longterm-wiki/foo file: dep points to packages/bar, tracks the file path', () => {
    // The file: path should match the package basename. A mismatch is a
    // configuration error; we warn via onWarn AND track coverage by the
    // file-path basename (what pnpm actually resolves against), not the
    // declared name. Tracking by declared name would print a misleading
    // "add COPY packages/<declared>" suggestion when the Dockerfile is
    // actually already correct for what the file: path points at.
    scratch = makeScratchDir();
    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/wrong-name',
        },
      })
    );

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `COPY packages/wrong-name/ ./packages/wrong-name/\n`
    );

    const warnings: string[] = [];
    const result = runCheck({
      appsDir: join(scratch, 'apps-missing'),
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: join(scratch, 'crux-missing'),
      onWarn: (m) => warnings.push(m),
    });

    expect(warnings.some((w) => /wrong-name/.test(w) && /url-utils/.test(w))).toBe(true);
    // Coverage tracks the file-path basename (what pnpm needs), so the
    // Dockerfile's `COPY packages/wrong-name/` correctly satisfies the dep.
    expect(result.dockerCopy!.fileDeps).toEqual(new Set(['wrong-name']));
    expect(result.dockerCopy!.missingCopy).toEqual([]);
  });

  it('ignores file: deps that do not point into packages/', () => {
    // `file:./some-other-dir` is valid pnpm syntax but not something this
    // validator handles — it's outside the packages/ tree so the COPY
    // invariant doesn't apply. Must not match FILE_DEP_RE.
    scratch = makeScratchDir();
    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/weird': 'file:./some-other-dir',
          '@longterm-wiki/bare': 'file:bare-sibling',
        },
      })
    );

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(dockerfile, `FROM node:20-slim AS deps\n`);

    const result = runCheck({
      appsDir: join(scratch, 'apps-missing'),
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: join(scratch, 'crux-missing'),
    });

    expect(result.dockerCopy!.fileDeps).toEqual(new Set());
    expect(result.dockerCopy!.missingCopy).toEqual([]);
  });

  it('accepts valueless BuildKit flags (--link, --parents) before the COPY source', () => {
    // `COPY --link packages/foo/ ./packages/foo/` is recommended for cache
    // optimization. The parser must accept flags with AND without `=value`.
    scratch = makeScratchDir();
    const workerDir = join(scratch, 'worker');
    mkdirSync(workerDir, { recursive: true });
    const workerPkg = join(workerDir, 'package.json');
    writeFileSync(
      workerPkg,
      JSON.stringify({
        name: 'worker',
        dependencies: {
          '@longterm-wiki/url-utils': 'file:./packages/url-utils',
          '@longterm-wiki/other': 'file:./packages/other',
        },
      })
    );

    const dockerfile = join(scratch, 'Dockerfile.worker');
    writeFileSync(
      dockerfile,
      `FROM node:20-slim AS deps\n` +
        `COPY --link packages/url-utils/ ./packages/url-utils/\n` +
        `COPY --link --chown=node:node packages/other/ ./packages/other/\n`
    );

    const result = runCheck({
      appsDir: join(scratch, 'apps-missing'),
      workerPkgJson: workerPkg,
      workerDockerfile: dockerfile,
      workerSourceDir: join(scratch, 'crux-missing'),
    });

    expect(result.dockerCopy!.copied).toEqual(new Set(['url-utils', 'other']));
    expect(result.dockerCopy!.missingCopy).toEqual([]);
  });

  it('skips symlinks without following them (no recursion loop)', () => {
    scratch = makeAppsDir([
      {
        name: 'my-app',
        dependencies: { '@longterm-wiki/id-utils': 'workspace:*' },
        files: {
          'src/a.ts': `import { isSid } from '@longterm-wiki/id-utils';`,
        },
      },
    ]);

    // Create a symlink that would cause infinite recursion if followed.
    try {
      symlinkSync(
        join(scratch, 'my-app', 'src'),
        join(scratch, 'my-app', 'src', 'self-loop')
      );
    } catch {
      // On some filesystems (e.g. CI without symlink perms) the test is a no-op.
      return;
    }

    const result = runCheck({ appsDir: scratch, ...NO_WORKER });
    expect(result.passed).toBe(true);
  });
});

describe('extractWorkspaceImports', () => {
  it('captures imports from import/from/require forms', () => {
    const source = [
      `import foo from '@longterm-wiki/a';`,
      `import { x } from '@longterm-wiki/b';`,
      `import('@longterm-wiki/c');`,
      `require('@longterm-wiki/d');`,
      `import type { T } from '@longterm-wiki/e';`,
    ].join('\n');

    expect(extractWorkspaceImports(source)).toEqual(
      new Set([
        '@longterm-wiki/a',
        '@longterm-wiki/b',
        '@longterm-wiki/c',
        '@longterm-wiki/d',
        '@longterm-wiki/e',
      ])
    );
  });

  it('does not capture comment or non-quoted mentions', () => {
    const source = [
      `// See @longterm-wiki/foo for help`,
      `/* @longterm-wiki/bar */`,
      `const pkg = \`@longterm-wiki/template-literal\`;  // backtick, not single/double quote anchor`,
    ].join('\n');

    expect(extractWorkspaceImports(source)).toEqual(new Set());
  });

  it('captures subpath imports as the parent package', () => {
    const source =
      `import { T } from '@longterm-wiki/factbase/types';\n` +
      `import { s } from '@longterm-wiki/factbase/serializer/v2';\n`;

    expect(extractWorkspaceImports(source)).toEqual(new Set(['@longterm-wiki/factbase']));
  });
});
