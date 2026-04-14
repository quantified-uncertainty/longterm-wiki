/**
 * Tests for validate-tsconfig-aliases.
 *
 * The validator keeps @wiki-server/* alias key sets identical between
 * crux/tsconfig.json and apps/web/tsconfig.json. Drift causes fake
 * TS errors in the crux tsc check (QUA-483).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { diffAliases } from './validate-tsconfig-aliases.ts';

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
  describe('diffAliases (pure function)', () => {
    it('returns empty drift when both sets are identical', () => {
      const a = new Set(['@wiki-server/foo-route', '@wiki-server/bar-route']);
      const b = new Set(['@wiki-server/foo-route', '@wiki-server/bar-route']);
      expect(diffAliases(a, b)).toEqual({ onlyInCrux: [], onlyInAppsWeb: [] });
    });

    it('detects keys missing from crux', () => {
      const crux = new Set(['@wiki-server/foo-route']);
      const appsWeb = new Set(['@wiki-server/foo-route', '@wiki-server/bar-route']);
      expect(diffAliases(crux, appsWeb)).toEqual({
        onlyInCrux: [],
        onlyInAppsWeb: ['@wiki-server/bar-route'],
      });
    });

    it('detects keys missing from apps/web', () => {
      const crux = new Set(['@wiki-server/foo-route', '@wiki-server/bar-route']);
      const appsWeb = new Set(['@wiki-server/foo-route']);
      expect(diffAliases(crux, appsWeb)).toEqual({
        onlyInCrux: ['@wiki-server/bar-route'],
        onlyInAppsWeb: [],
      });
    });

    it('detects drift in both directions', () => {
      const crux = new Set(['@wiki-server/foo-route', '@wiki-server/baz-route']);
      const appsWeb = new Set(['@wiki-server/foo-route', '@wiki-server/bar-route']);
      expect(diffAliases(crux, appsWeb)).toEqual({
        onlyInCrux: ['@wiki-server/baz-route'],
        onlyInAppsWeb: ['@wiki-server/bar-route'],
      });
    });

    it('sorts violation lists for stable output', () => {
      const crux = new Set<string>();
      const appsWeb = new Set([
        '@wiki-server/zeta-route',
        '@wiki-server/alpha-route',
        '@wiki-server/mu-route',
      ]);
      expect(diffAliases(crux, appsWeb).onlyInAppsWeb).toEqual([
        '@wiki-server/alpha-route',
        '@wiki-server/mu-route',
        '@wiki-server/zeta-route',
      ]);
    });

    it('returns empty drift for two empty sets', () => {
      expect(diffAliases(new Set(), new Set())).toEqual({ onlyInCrux: [], onlyInAppsWeb: [] });
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
