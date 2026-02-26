/**
 * Tests for the --scope=content flag integration across the build pipeline.
 *
 * These are integration tests that verify:
 * 1. build-data.mjs respects --scope=content
 * 2. validate-gate.ts respects --scope=content
 * 3. assign-ids.mjs respects --skip
 * 4. The scope flag parses correctly in various edge cases
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../..');
const APP_DIR = join(REPO_ROOT, 'apps/web');

/** Run a command and return combined stdout+stderr + exit code */
function run(cmd: string, cwd: string = REPO_ROOT): { stdout: string; exitCode: number } {
  // Redirect stderr to stdout so we capture all output (pnpm banners go to stderr)
  const fullCmd = `${cmd} 2>&1`;
  try {
    const stdout = execSync(fullCmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', CI: '' },
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', exitCode: e.status ?? 1 };
  }
}

describe('--scope=content flag', () => {
  describe('build-data.mjs --scope=content', () => {
    it('prints content-only banner and skips expensive steps', () => {
      const result = run(
        'node --import tsx/esm scripts/build-data.mjs --scope=content',
        APP_DIR
      );

      expect(result.exitCode).toBe(0);

      // Should print the content-only banner
      expect(result.stdout).toContain('content-only scope');

      // Should skip these expensive steps
      expect(result.stdout).toContain('blockIR: skipped (content-only scope)');
      expect(result.stdout).toContain('riskSnapshots: skipped (content-only scope)');
      expect(result.stdout).toContain('redundancy: skipped (content-only scope)');
      expect(result.stdout).toContain('linkSync: skipped (content-only scope)');
      expect(result.stdout).toContain('changeHistory: skipped (content-only scope)');
      expect(result.stdout).toContain('prItems: skipped (content-only scope)');
      expect(result.stdout).toContain('Link health: skipped (content-only scope)');
      expect(result.stdout).toContain('LLM files: skipped (content-only scope)');

      // Should still run core data steps
      expect(result.stdout).toContain('entities:');
      expect(result.stdout).toContain('backlinks:');
      expect(result.stdout).toContain('tagIndex:');
      expect(result.stdout).toContain('contentLinks:');
      expect(result.stdout).toContain('hallucinationRisk:');
      expect(result.stdout).toContain('relatedGraph:');
      expect(result.stdout).toContain('Written:');
    }, 120_000);

    it('full build (no --scope) does NOT skip steps', () => {
      const result = run(
        'node --import tsx/esm scripts/build-data.mjs | head -5',
        APP_DIR
      );

      // Should NOT print content-only banner
      expect(result.stdout).not.toContain('content-only scope');
    }, 30_000);
  });

  describe('assign-ids.mjs --skip', () => {
    it('exits immediately with skip message', () => {
      const result = run('node scripts/assign-ids.mjs --skip', APP_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('assign-ids: skipped (--skip flag)');
    }, 30_000);
  });

  describe('validate gate --scope=content', () => {
    it('runs only content-relevant checks', () => {
      // --no-cache ensures gate re-runs even if stamp matches HEAD
      const result = run(
        'pnpm crux validate gate --scope=content --no-cache',
        REPO_ROOT
      );

      expect(result.exitCode).toBe(0);

      // Should print content-only header
      expect(result.stdout).toContain('content-only scope');

      // Should run unified-blocking and yaml-schema
      expect(result.stdout).toContain('Unified blocking rules');
      expect(result.stdout).toContain('YAML schema');

      // Should NOT run these full-mode steps
      expect(result.stdout).not.toContain('Build data layer');
      expect(result.stdout).not.toContain('Assign entity IDs');
      expect(result.stdout).not.toContain('Run tests');
      expect(result.stdout).not.toContain('TypeScript type check');
    }, 120_000);
  });

  describe('scope flag edge cases (unit-level)', () => {
    it('parses --scope=content correctly', () => {
      // Simulate the parsing logic used in both build-data.mjs and validate-gate.ts
      const args = ['--fix', '--scope=content', '--no-cache'];
      const scope = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
      expect(scope).toBe('content');
    });

    it('returns empty string when no scope flag', () => {
      const args = ['--fix', '--no-cache'];
      const scope = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
      expect(scope).toBe('');
    });

    it('handles --scope= with no value', () => {
      const args = ['--scope='];
      const scope = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
      expect(scope).toBe('');
    });

    it('handles --scope=unknown gracefully (treated as full)', () => {
      const args = ['--scope=unknown'];
      const scope = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
      const contentOnly = scope === 'content';
      expect(contentOnly).toBe(false);
    });

    it('does not confuse --scope-content with --scope=content', () => {
      const args = ['--scope-content'];
      const scope = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
      expect(scope).toBe('');
    });
  });
});
