import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { collectTsFiles } from './file-walker.ts';

describe('collectTsFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'file-walker-test-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'src', '__tests__'));
    mkdirSync(join(root, 'src', 'sub'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'dist'));

    writeFileSync(join(root, 'src', 'a.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'b.tsx'), 'export {};');
    writeFileSync(join(root, 'src', 'c.test.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'd.test.tsx'), 'export {};');
    writeFileSync(join(root, 'src', 'sub', 'e.ts'), 'export {};');
    writeFileSync(join(root, 'src', '__tests__', 'fixture.ts'), 'export {};');
    writeFileSync(join(root, 'node_modules', 'lib.ts'), 'export {};');
    writeFileSync(join(root, 'dist', 'compiled.ts'), 'export {};');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds .ts files recursively', () => {
    const files = collectTsFiles(root).map((p) => basename(p)).sort();
    expect(files).toEqual(['a.ts', 'e.ts']);
  });

  it('includes .tsx files when includeTsx is true', () => {
    const files = collectTsFiles(root, { includeTsx: true }).map((p) => basename(p)).sort();
    expect(files).toEqual(['a.ts', 'b.tsx', 'e.ts']);
  });

  it('skips .test.ts and .test.tsx files', () => {
    const files = collectTsFiles(root, { includeTsx: true }).map((p) => basename(p));
    expect(files).not.toContain('c.test.ts');
    expect(files).not.toContain('d.test.tsx');
  });

  it('skips __tests__, node_modules, dist directories', () => {
    const files = collectTsFiles(root).map((p) => basename(p));
    expect(files).not.toContain('fixture.ts');
    expect(files).not.toContain('lib.ts');
    expect(files).not.toContain('compiled.ts');
  });

  it('returns empty array on missing directory', () => {
    const missing = join(root, 'does-not-exist');
    expect(collectTsFiles(missing)).toEqual([]);
  });
});
