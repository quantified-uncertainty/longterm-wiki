/**
 * Tests for the review marker validator.
 *
 * Tests runCheck() subprocess behavior.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`${cmd} 2>&1`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', exitCode: e.status ?? 1 };
  }
}

describe('validate-review-marker', () => {
  it('runs without crashing', () => {
    const result = run('npx tsx crux/validate/validate-review-marker.ts');
    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toContain('Checking PR review status');
  });

  it('reports diff size and thresholds', () => {
    const result = run('npx tsx crux/validate/validate-review-marker.ts');
    expect(result.stdout).toContain('Diff size:');
    expect(result.stdout).toContain('Thresholds:');
  });
});
