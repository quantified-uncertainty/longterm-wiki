/**
 * Tests for validate-verification-coverage.ts enforcement logic.
 *
 * Tests the three enforcement levels (advisory, soft, hard) and the --force override.
 * Since the validator runs as a script with process.exit(), we test the logic by
 * extracting it into testable functions — but the actual script behavior (exit codes)
 * is validated via subprocess execution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const MANIFEST_DIR = join(PROJECT_ROOT, 'data', 'tablebase-manifests');
const TEST_MANIFEST_DIR = join(PROJECT_ROOT, 'data', 'tablebase-manifests-test-backup');

function createManifest(name: string, content: Record<string, unknown>) {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  writeFileSync(join(MANIFEST_DIR, name), JSON.stringify(content, null, 2));
}

function cleanupManifests() {
  try { rmSync(MANIFEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

function backupManifests() {
  if (existsSync(MANIFEST_DIR)) {
    try {
      mkdirSync(TEST_MANIFEST_DIR, { recursive: true });
      for (const f of readdirSync(MANIFEST_DIR)) {
        writeFileSync(join(TEST_MANIFEST_DIR, f), readFileSync(join(MANIFEST_DIR, f)));
      }
    } catch { /* ok */ }
  }
}

function restoreManifests() {
  cleanupManifests();
  if (existsSync(TEST_MANIFEST_DIR)) {
    try {
      mkdirSync(MANIFEST_DIR, { recursive: true });
      for (const f of readdirSync(TEST_MANIFEST_DIR)) {
        writeFileSync(join(MANIFEST_DIR, f), readFileSync(join(TEST_MANIFEST_DIR, f)));
      }
      rmSync(TEST_MANIFEST_DIR, { recursive: true, force: true });
    } catch { /* ok */ }
  }
}

function runValidator(...args: string[]): { exitCode: number; output: string } {
  try {
    const output = execSync(
      `npx tsx crux/validate/validate-verification-coverage.ts ${args.join(' ')}`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { exitCode: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: err.status ?? 1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('validate-verification-coverage', () => {
  beforeEach(() => {
    backupManifests();
    cleanupManifests();
  });

  afterEach(() => {
    restoreManifests();
  });

  it('exits 0 when no manifests directory exists', () => {
    const result = runValidator('--enforcement=soft');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No tablebase-manifests/ directory');
  });

  it('exits 0 when all records have verification', () => {
    createManifest('test-verified.json', {
      table: 'personnel',
      recordCount: 3,
      submittedAt: '2026-04-04T00:00:00Z',
      verificationSummary: {
        withVerification: 3,
        withoutVerification: 0,
        verdicts: { verified: 3, contradicted: 0, unverifiable: 0, other: 0 },
      },
      records: [],
    });

    const result = runValidator('--enforcement=soft');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All TableBase submissions have verification');
  });

  it('exits 1 in soft enforcement when records lack verification', () => {
    createManifest('test-unverified.json', {
      table: 'personnel',
      recordCount: 5,
      submittedAt: '2026-04-04T00:00:00Z',
      verificationSummary: {
        withVerification: 2,
        withoutVerification: 3,
        verdicts: { verified: 2, contradicted: 0, unverifiable: 0, other: 0 },
      },
      records: [],
    });

    const result = runValidator('--enforcement=soft');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('3/5 personnel records submitted WITHOUT verification');
    expect(result.output).toContain('--force');
  });

  it('exits 0 in soft enforcement with --force override', () => {
    createManifest('test-unverified.json', {
      table: 'personnel',
      recordCount: 5,
      submittedAt: '2026-04-04T00:00:00Z',
      verificationSummary: {
        withVerification: 2,
        withoutVerification: 3,
        verdicts: { verified: 2, contradicted: 0, unverifiable: 0, other: 0 },
      },
      records: [],
    });

    const result = runValidator('--enforcement=soft', '--force');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('--force: verification warnings overridden');
  });

  it('exits 1 when records have contradicted verdicts', () => {
    createManifest('test-contradicted.json', {
      table: 'personnel',
      recordCount: 4,
      submittedAt: '2026-04-04T00:00:00Z',
      verificationSummary: {
        withVerification: 4,
        withoutVerification: 0,
        verdicts: { verified: 2, contradicted: 2, unverifiable: 0, other: 0 },
      },
      records: [],
    });

    const result = runValidator('--enforcement=soft');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('2 personnel records have CONTRADICTED verdicts');
  });

  it('advisory mode exits 0 even with unverified records', () => {
    createManifest('test-unverified.json', {
      table: 'personnel',
      recordCount: 5,
      submittedAt: '2026-04-04T00:00:00Z',
      verificationSummary: {
        withVerification: 0,
        withoutVerification: 5,
        verdicts: { verified: 0, contradicted: 0, unverifiable: 0, other: 0 },
      },
      records: [],
    });

    const result = runValidator('--enforcement=advisory');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('5/5 personnel records submitted WITHOUT verification');
  });
});
