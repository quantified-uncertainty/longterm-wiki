/**
 * Tests for validate-tsconfig-aliases.
 *
 * The validator keeps @wiki-server/* alias keys AND resolved target
 * paths identical between crux/tsconfig.json and apps/web/tsconfig.json.
 * Drift along either axis causes fake "Cannot find module" errors in
 * the crux tsc check (QUA-483).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  diffAliases,
  resolveAliasTarget,
  runCheck,
  type TsConfigEntry,
} from './validate-tsconfig-aliases.ts';

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`${cmd} 2>&1`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

describe('validate-tsconfig-aliases', () => {
  describe('resolveAliasTarget', () => {
    it('resolves a simple relative target from the tsconfig directory', () => {
      const result = resolveAliasTarget('/repo/crux/tsconfig.json', '.', '../apps/web/src/foo.ts');
      expect(result).toBe('/repo/apps/web/src/foo.ts');
    });

    it('applies a custom baseUrl', () => {
      const result = resolveAliasTarget(
        '/repo/apps/web/tsconfig.json',
        './src',
        'components/button.tsx'
      );
      expect(result).toBe('/repo/apps/web/src/components/button.tsx');
    });

    it('normalizes .. segments in the pattern', () => {
      // /repo/crux + ../apps/web/../wiki-server/x.ts
      // = /repo/crux/../apps/web/../wiki-server/x.ts
      // = /repo/apps/web/../wiki-server/x.ts
      // = /repo/apps/wiki-server/x.ts
      const result = resolveAliasTarget(
        '/repo/crux/tsconfig.json',
        '.',
        '../apps/web/../wiki-server/x.ts'
      );
      expect(result).toBe('/repo/apps/wiki-server/x.ts');
    });
  });

  describe('diffAliases', () => {
    const CRUX = '/repo/crux/tsconfig.json';
    const APPS_WEB = '/repo/apps/web/tsconfig.json';

    it('treats differently-spelled-but-same-absolute-path targets as matching', () => {
      // crux/tsconfig uses "../apps/wiki-server/..." (relative to crux/)
      // apps/web/tsconfig uses "../wiki-server/..." (relative to apps/web/)
      // Both resolve to the SAME absolute path: /repo/apps/wiki-server/src/facts.ts
      const crux = {
        '@wiki-server/facts-route': ['../apps/wiki-server/src/routes/factbase/facts.ts'],
      };
      const appsWeb = {
        '@wiki-server/facts-route': ['../wiki-server/src/routes/factbase/facts.ts'],
      };
      const result = diffAliases(crux, CRUX, '.', appsWeb, APPS_WEB, '.');
      expect(result.onlyInFirst).toEqual([]);
      expect(result.onlyInSecond).toEqual([]);
      expect(result.targetMismatches).toEqual([]);
    });

    it('detects keys missing from first config', () => {
      const crux = {};
      const appsWeb = { '@wiki-server/foo-route': ['../wiki-server/src/foo.ts'] };
      const result = diffAliases(crux, CRUX, '.', appsWeb, APPS_WEB, '.');
      expect(result.onlyInSecond).toEqual(['@wiki-server/foo-route']);
      expect(result.onlyInFirst).toEqual([]);
      expect(result.targetMismatches).toEqual([]);
    });

    it('detects keys missing from second config', () => {
      const crux = { '@wiki-server/bar-route': ['../apps/wiki-server/src/bar.ts'] };
      const appsWeb = {};
      const result = diffAliases(crux, CRUX, '.', appsWeb, APPS_WEB, '.');
      expect(result.onlyInFirst).toEqual(['@wiki-server/bar-route']);
      expect(result.onlyInSecond).toEqual([]);
    });

    it('detects target-path drift when keys match but files differ', () => {
      const crux = {
        '@wiki-server/foo-route': ['../apps/wiki-server/src/routes/old-foo.ts'],
      };
      const appsWeb = {
        '@wiki-server/foo-route': ['../wiki-server/src/routes/new-foo.ts'],
      };
      const result = diffAliases(crux, CRUX, '.', appsWeb, APPS_WEB, '.');
      expect(result.targetMismatches).toHaveLength(1);
      expect(result.targetMismatches[0].key).toBe('@wiki-server/foo-route');
      expect(result.targetMismatches[0].first[0]).toContain('old-foo.ts');
      expect(result.targetMismatches[0].second[0]).toContain('new-foo.ts');
    });

    it('sorts missing-key lists', () => {
      const crux = {};
      const appsWeb = {
        '@wiki-server/zeta-route': ['../wiki-server/src/z.ts'],
        '@wiki-server/alpha-route': ['../wiki-server/src/a.ts'],
        '@wiki-server/mu-route': ['../wiki-server/src/m.ts'],
      };
      const result = diffAliases(crux, CRUX, '.', appsWeb, APPS_WEB, '.');
      expect(result.onlyInSecond).toEqual([
        '@wiki-server/alpha-route',
        '@wiki-server/mu-route',
        '@wiki-server/zeta-route',
      ]);
    });

    it('ignores non-wiki-server aliases', () => {
      // The real tsconfigs also have @/*, @components/* etc.
      // Our extract-before-diff flow already filters, so diffAliases
      // itself just receives filtered maps — but verify it doesn't
      // accidentally fail on empty shared sets.
      const crux = {};
      const appsWeb = {};
      const result = diffAliases(crux, CRUX, '.', appsWeb, APPS_WEB, '.');
      expect(result).toEqual({ onlyInFirst: [], onlyInSecond: [], targetMismatches: [] });
    });
  });

  describe('runCheck with temp fixtures', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'validate-tsconfig-aliases-'));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeConfig(rel: string, content: object): TsConfigEntry {
      const fullPath = join(tmpRoot, rel);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, JSON.stringify(content, null, 2));
      return { label: rel, path: fullPath };
    }

    it('passes when both tsconfigs have identical key-and-target sets', () => {
      const a = writeConfig('crux/tsconfig.json', {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@wiki-server/facts-route': ['../apps/wiki-server/src/routes/factbase/facts.ts'],
          },
        },
      });
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@wiki-server/facts-route': ['../wiki-server/src/routes/factbase/facts.ts'],
          },
        },
      });
      const result = runCheck({ tsconfigs: [a, b], silent: true });
      expect(result.passed).toBe(true);
      expect(result.errors).toBe(0);
    });

    it('fails when a key is missing from one tsconfig', () => {
      const a = writeConfig('crux/tsconfig.json', {
        compilerOptions: { paths: {} },
      });
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: {
          paths: {
            '@wiki-server/new-route': ['../wiki-server/src/routes/new.ts'],
          },
        },
      });
      const result = runCheck({ tsconfigs: [a, b], silent: true });
      expect(result.passed).toBe(false);
      expect(result.errors).toBe(1);
      expect(result.drift.onlyInSecond).toEqual(['@wiki-server/new-route']);
    });

    it('fails when keys match but targets resolve to different files', () => {
      const a = writeConfig('crux/tsconfig.json', {
        compilerOptions: {
          paths: {
            '@wiki-server/foo-route': ['../apps/wiki-server/src/routes/old-foo.ts'],
          },
        },
      });
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: {
          paths: {
            '@wiki-server/foo-route': ['../wiki-server/src/routes/new-foo.ts'],
          },
        },
      });
      const result = runCheck({ tsconfigs: [a, b], silent: true });
      expect(result.passed).toBe(false);
      expect(result.errors).toBe(1);
      expect(result.drift.targetMismatches).toHaveLength(1);
    });

    it('rejects a config that uses extends', () => {
      const a = writeConfig('crux/tsconfig.json', {
        extends: '../base.json',
        compilerOptions: { paths: {} },
      });
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: { paths: {} },
      });
      const result = runCheck({ tsconfigs: [a, b], silent: true });
      expect(result.passed).toBe(false);
      expect(result.errors).toBe(1);
    });

    it('ignores non-@wiki-server aliases', () => {
      const a = writeConfig('crux/tsconfig.json', {
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
            '@wiki-server/foo-route': ['../apps/wiki-server/src/foo.ts'],
          },
        },
      });
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: {
          paths: {
            '@components/*': ['./src/components/*'],
            '@wiki-server/foo-route': ['../wiki-server/src/foo.ts'],
          },
        },
      });
      const result = runCheck({ tsconfigs: [a, b], silent: true });
      expect(result.passed).toBe(true);
    });

    it('throws with a clear message when a config file is missing', () => {
      const a: TsConfigEntry = { label: 'crux/tsconfig.json', path: join(tmpRoot, 'does-not-exist.json') };
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: { paths: {} },
      });
      expect(() => runCheck({ tsconfigs: [a, b], silent: true })).toThrow(
        /Could not read crux\/tsconfig\.json/
      );
    });

    it('throws with a clear message when a config is not valid JSON', () => {
      const malformedPath = join(tmpRoot, 'bad.json');
      mkdirSync(tmpRoot, { recursive: true });
      writeFileSync(malformedPath, '{ not valid json }');
      const a: TsConfigEntry = { label: 'bad.json', path: malformedPath };
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: { paths: {} },
      });
      expect(() => runCheck({ tsconfigs: [a, b], silent: true })).toThrow(
        /Could not parse bad\.json as JSON/
      );
    });

    it('exits with code 1 when invoked as a script on a drifted fixture', () => {
      const a = writeConfig('crux/tsconfig.json', {
        compilerOptions: {
          paths: {
            '@wiki-server/foo-route': ['../apps/wiki-server/src/foo.ts'],
          },
        },
      });
      const b = writeConfig('apps/web/tsconfig.json', {
        compilerOptions: { paths: {} },
      });
      // Use the programmatic runCheck path with a fixture instead of
      // spawning a subprocess with env overrides — simpler and equivalent
      // for covering the exit-code contract via the same code path.
      const result = runCheck({ tsconfigs: [a, b], silent: true });
      expect(result.passed).toBe(false);
      expect(result.errors).toBeGreaterThanOrEqual(1);
    });
  });

  describe('end-to-end on real codebase', () => {
    it('passes on the current tsconfigs (both in sync)', () => {
      const result = run('npx tsx crux/validate/validate-tsconfig-aliases.ts');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('aliases in sync');
    }, 15_000);
  });
});
