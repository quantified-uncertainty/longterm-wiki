/**
 * Tests for the checklist-required validator.
 *
 * Tests the parseDiffStat logic and runCheck() behavior via subprocess.
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

describe('validate-checklist-required', () => {
  it('runs without crashing', () => {
    const result = run('npx tsx crux/validate/validate-checklist-required.ts');
    // Should either pass (within thresholds or checklist exists) or fail cleanly
    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toContain('Checking checklist requirement');
  });

  it('reports diff size and thresholds', () => {
    const result = run('npx tsx crux/validate/validate-checklist-required.ts');
    expect(result.stdout).toContain('Diff size:');
    expect(result.stdout).toContain('Thresholds:');
    expect(result.stdout).toContain('>3 files or >200 lines');
  });

  it('reports checklist existence', () => {
    const result = run('npx tsx crux/validate/validate-checklist-required.ts');
    expect(result.stdout).toMatch(/Checklist: (exists|not found)/);
  });
});
