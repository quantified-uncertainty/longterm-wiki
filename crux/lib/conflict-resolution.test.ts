import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanConflictMarkers } from './conflict-resolution.ts';

describe('scanConflictMarkers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `conflict-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty array for clean files', () => {
    const file1 = join(tempDir, 'clean.ts');
    const file2 = join(tempDir, 'clean.md');
    writeFileSync(file1, 'const x = 1;\nexport default x;\n');
    writeFileSync(file2, '# Hello\n\nWorld\n');

    const result = scanConflictMarkers([file1, file2]);
    expect(result).toEqual([]);
  });

  it('detects files with <<<<<<< markers', () => {
    const file = join(tempDir, 'conflict.ts');
    writeFileSync(
      file,
      'const x = 1;\n<<<<<<< HEAD\nconst y = 2;\n=======\nconst y = 3;\n>>>>>>> main\n',
    );

    const result = scanConflictMarkers([file]);
    expect(result).toEqual([file]);
  });

  it('detects files with only ======= markers', () => {
    const file = join(tempDir, 'partial.ts');
    writeFileSync(file, 'const x = 1;\n=======\nconst y = 3;\n');

    const result = scanConflictMarkers([file]);
    expect(result).toEqual([file]);
  });

  it('detects files with only >>>>>>> markers', () => {
    const file = join(tempDir, 'partial2.ts');
    writeFileSync(file, 'const x = 1;\n>>>>>>> main\n');

    const result = scanConflictMarkers([file]);
    expect(result).toEqual([file]);
  });

  it('only flags markers at start of line', () => {
    const file = join(tempDir, 'inline.ts');
    // These markers are not at the start of lines — should not be detected
    writeFileSync(file, 'const x = "<<<<<<< HEAD";\nconst y = "=======";\n');

    const result = scanConflictMarkers([file]);
    expect(result).toEqual([]);
  });

  it('handles nonexistent files gracefully', () => {
    const result = scanConflictMarkers([
      join(tempDir, 'does-not-exist.ts'),
    ]);
    expect(result).toEqual([]);
  });

  it('handles mix of clean and conflicted files', () => {
    const clean = join(tempDir, 'clean.ts');
    const dirty = join(tempDir, 'dirty.ts');
    writeFileSync(clean, 'const x = 1;\n');
    writeFileSync(dirty, '<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> main\n');

    const result = scanConflictMarkers([clean, dirty]);
    expect(result).toEqual([dirty]);
  });

  it('returns empty array for empty input', () => {
    const result = scanConflictMarkers([]);
    expect(result).toEqual([]);
  });
});

describe('fingerprint format', () => {
  it('fingerprint pattern matches expected format', () => {
    // Fingerprints are 8 hex chars + "+" + 8 hex chars
    const fingerprint = 'abc12345+def67890';
    expect(/^[0-9a-f]{8}\+[0-9a-f]{8}$/.test(fingerprint)).toBe(true);
  });

  it('fingerprint pattern rejects invalid formats', () => {
    expect(/^[0-9a-f]{8}\+[0-9a-f]{8}$/.test('short+short')).toBe(false);
    expect(/^[0-9a-f]{8}\+[0-9a-f]{8}$/.test('abc12345-def67890')).toBe(false);
    expect(/^[0-9a-f]{8}\+[0-9a-f]{8}$/.test('')).toBe(false);
  });
});

describe('restrictToMergeFiles logic (unit test of the concept)', () => {
  it('identifies files outside the allowlist', () => {
    const mergeAffected = new Set([
      'content/docs/page-a.mdx',
      'data/entities/orgs.yaml',
    ]);

    const agentChanged = [
      'content/docs/page-a.mdx', // allowed
      'data/entities/orgs.yaml', // allowed
      'crux/lib/something.ts', // NOT in merge set
      'apps/web/src/app/page.tsx', // NOT in merge set
    ];

    const unauthorized = agentChanged.filter((f) => !mergeAffected.has(f));
    expect(unauthorized).toEqual([
      'crux/lib/something.ts',
      'apps/web/src/app/page.tsx',
    ]);
  });

  it('allows all files when all are in the merge set', () => {
    const mergeAffected = new Set([
      'content/docs/page-a.mdx',
      'data/entities/orgs.yaml',
    ]);

    const agentChanged = [
      'content/docs/page-a.mdx',
      'data/entities/orgs.yaml',
    ];

    const unauthorized = agentChanged.filter((f) => !mergeAffected.has(f));
    expect(unauthorized).toEqual([]);
  });

  it('identifies all files as unauthorized when merge set is empty', () => {
    const mergeAffected = new Set<string>();
    const agentChanged = ['some/file.ts'];

    const unauthorized = agentChanged.filter((f) => !mergeAffected.has(f));
    expect(unauthorized).toEqual(['some/file.ts']);
  });
});
