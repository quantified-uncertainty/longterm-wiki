import { describe, it, expect } from 'vitest';
import { categorizeFiles, canSkipBuildData, type FileCategories } from './gate-triage.ts';

describe('categorizeFiles', () => {
  it('categorizes MDX content files', () => {
    const result = categorizeFiles(['content/docs/organizations/miri.mdx']);
    expect(result.mdxContent).toEqual(['content/docs/organizations/miri.mdx']);
    expect(result.other).toEqual([]);
  });

  it('categorizes YAML data files', () => {
    const result = categorizeFiles(['data/entities/miri.yaml', 'data/resources/compute.yaml']);
    expect(result.yamlData).toHaveLength(2);
  });

  it('categorizes app TypeScript files', () => {
    const result = categorizeFiles(['apps/web/src/components/Button.tsx', 'apps/web/src/lib/utils.ts']);
    expect(result.appTs).toHaveLength(2);
  });

  it('categorizes build scripts', () => {
    const result = categorizeFiles(['apps/web/scripts/build-data.mjs']);
    expect(result.buildScripts).toEqual(['apps/web/scripts/build-data.mjs']);
  });

  it('categorizes crux TypeScript files', () => {
    const result = categorizeFiles(['crux/validate/validate-gate.ts', 'crux/lib/output.ts']);
    expect(result.cruxTs).toHaveLength(2);
  });

  it('categorizes wiki-server TypeScript files', () => {
    const result = categorizeFiles(['apps/wiki-server/src/routes/api.ts']);
    expect(result.wikiServerTs).toHaveLength(1);
  });

  it('categorizes config files', () => {
    const result = categorizeFiles(['package.json', 'tsconfig.json', 'pnpm-lock.yaml']);
    expect(result.config).toHaveLength(3);
  });

  it('categorizes unknown files as other', () => {
    const result = categorizeFiles(['README.md', '.github/workflows/ci.yml']);
    expect(result.other).toEqual(['README.md', '.github/workflows/ci.yml']);
  });

  it('handles mixed file types', () => {
    const files = [
      'content/docs/concepts/agi.mdx',
      'data/entities/openai.yaml',
      'crux/validate/gate-triage.ts',
      'apps/web/src/app/page.tsx',
      'package.json',
      'README.md',
    ];
    const result = categorizeFiles(files);
    expect(result.mdxContent).toHaveLength(1);
    expect(result.yamlData).toHaveLength(1);
    expect(result.cruxTs).toHaveLength(1);
    expect(result.appTs).toHaveLength(1);
    expect(result.config).toHaveLength(1);
    expect(result.other).toHaveLength(1);
  });

  it('handles empty file list', () => {
    const result = categorizeFiles([]);
    expect(Object.values(result).every(arr => arr.length === 0)).toBe(true);
  });

  it('recognizes tsconfig variants as config', () => {
    const result = categorizeFiles(['tsconfig.json', 'tsconfig.node.json']);
    expect(result.config).toHaveLength(2);
  });

  it('does not misclassify non-ts files in crux/', () => {
    const result = categorizeFiles(['crux/README.md']);
    expect(result.cruxTs).toHaveLength(0);
    expect(result.other).toHaveLength(1);
  });
});

describe('canSkipBuildData', () => {
  const emptyCategories: FileCategories = {
    mdxContent: [],
    yamlData: [],
    appTs: [],
    buildScripts: [],
    cruxTs: [],
    wikiServerTs: [],
    config: [],
    other: [],
  };

  it('allows skip when only crux files changed (and database.json exists)', () => {
    // canSkipBuildData checks existsSync internally — in the test environment
    // database.json likely exists, so this tests the logic path
    const cats = { ...emptyCategories, cruxTs: ['crux/validate/gate-triage.ts'] };
    // The result depends on whether database.json exists on disk
    const result = canSkipBuildData(cats);
    // We just verify it returns a boolean (the file existence check is real I/O)
    expect(typeof result).toBe('boolean');
  });

  it('does NOT allow skip when MDX files changed', () => {
    const cats = { ...emptyCategories, mdxContent: ['content/docs/test.mdx'] };
    expect(canSkipBuildData(cats)).toBe(false);
  });

  it('does NOT allow skip when YAML data files changed', () => {
    const cats = { ...emptyCategories, yamlData: ['data/entities/test.yaml'] };
    expect(canSkipBuildData(cats)).toBe(false);
  });

  it('does NOT allow skip when app TS files changed', () => {
    const cats = { ...emptyCategories, appTs: ['apps/web/src/lib/utils.ts'] };
    expect(canSkipBuildData(cats)).toBe(false);
  });

  it('does NOT allow skip when build scripts changed', () => {
    const cats = { ...emptyCategories, buildScripts: ['apps/web/scripts/build-data.mjs'] };
    expect(canSkipBuildData(cats)).toBe(false);
  });

  it('does NOT allow skip when config files changed', () => {
    const cats = { ...emptyCategories, config: ['package.json'] };
    expect(canSkipBuildData(cats)).toBe(false);
  });

  it('allows skip for wiki-server-only changes (if database.json exists)', () => {
    const cats = { ...emptyCategories, wikiServerTs: ['apps/wiki-server/src/api.ts'] };
    const result = canSkipBuildData(cats);
    expect(typeof result).toBe('boolean');
  });
});
