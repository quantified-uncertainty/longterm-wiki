/**
 * Additional tests for page-improver/utils.ts functions not covered
 * by utils.test.ts (which tests repairFrontmatter).
 *
 * Covers:
 *   - stripRelatedPagesSections: removes "Related Pages", "See Also", etc.
 *   - buildObjectivityContext: builds objectivity prompt context
 *   - getFilePath: converts page paths to filesystem paths
 */

import { describe, it, expect, vi } from 'vitest';

// Mock modules that access the file system or external services at import time
vi.mock('../../lib/output.ts', () => ({
  createPhaseLogger: vi.fn(() => vi.fn()),
}));

vi.mock('../../lib/api-keys.ts', () => ({
  SCRY_PUBLIC_KEY: undefined,
}));

vi.mock('../../lib/content-types.ts', () => ({
  loadPages: vi.fn(() => []),
  CRITICAL_RULES: [],
  QUALITY_RULES: [],
}));

import { stripRelatedPagesSections, buildObjectivityContext, getFilePath } from './utils.ts';
import type { PageData, AnalysisResult } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    id: 'test-page',
    title: 'Test Page',
    path: 'test/test-page',
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    currentState: 'good',
    gaps: [],
    improvements: [],
    objectivityIssues: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getFilePath
// ---------------------------------------------------------------------------

describe('getFilePath', () => {
  it('converts a page path to a .mdx filesystem path', () => {
    const result = getFilePath('knowledge-base/people/eliezer-yudkowsky');
    expect(result.replace(/\\/g, '/')).toMatch(
      /content\/docs\/knowledge-base\/people\/eliezer-yudkowsky\.mdx$/
    );
  });

  it('strips leading slashes before joining', () => {
    const withLeading = getFilePath('/knowledge-base/people/eliezer-yudkowsky');
    const withoutLeading = getFilePath('knowledge-base/people/eliezer-yudkowsky');
    expect(withLeading).toBe(withoutLeading);
  });

  it('strips trailing slashes before joining', () => {
    const withTrailing = getFilePath('knowledge-base/people/eliezer-yudkowsky/');
    const without = getFilePath('knowledge-base/people/eliezer-yudkowsky');
    expect(withTrailing).toBe(without);
  });

  it('handles a simple single-segment path', () => {
    const result = getFilePath('simple-page');
    expect(result.replace(/\\/g, '/')).toMatch(/content\/docs\/simple-page\.mdx$/);
  });
});

// ---------------------------------------------------------------------------
// stripRelatedPagesSections
// ---------------------------------------------------------------------------

describe('stripRelatedPagesSections', () => {
  it('removes "Related Pages" section', () => {
    const content = [
      '---',
      'title: Test',
      '---',
      '',
      '## Overview',
      '',
      'Some content.',
      '',
      '## Related Pages',
      '',
      '- [[Some Page]]',
      '- [[Another Page]]',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    expect(result).not.toContain('## Related Pages');
    expect(result).toContain('## Overview');
    expect(result).toContain('Some content.');
  });

  it('removes "See Also" section', () => {
    const content = [
      '## Introduction',
      '',
      'Content here.',
      '',
      '## See Also',
      '',
      '- [[Related Item]]',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    expect(result).not.toContain('## See Also');
    expect(result).toContain('## Introduction');
  });

  it('removes "Related Content" section', () => {
    const content = [
      '## Main Section',
      '',
      'Main content.',
      '',
      '## Related Content',
      '',
      'Some related content here.',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    expect(result).not.toContain('## Related Content');
    expect(result).toContain('## Main Section');
  });

  it('preserves sections that are NOT related sections', () => {
    const content = [
      '## Overview',
      '',
      'Overview content.',
      '',
      '## Details',
      '',
      'Details content.',
      '',
      '## Future Directions',
      '',
      'Future content.',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    expect(result).toContain('## Overview');
    expect(result).toContain('## Details');
    expect(result).toContain('## Future Directions');
  });

  it('removes the related section but preserves content after it', () => {
    const content = [
      '## Overview',
      '',
      'Overview text.',
      '',
      '## Related Pages',
      '',
      '- Link one',
      '',
      '## Conclusion',
      '',
      'Conclusion text.',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    expect(result).not.toContain('## Related Pages');
    expect(result).toContain('## Conclusion');
    expect(result).toContain('Conclusion text.');
  });

  it('does not crash on content with no headings', () => {
    const content = 'Just a flat body of text.\n\nNo sections here.';
    const result = stripRelatedPagesSections(content);
    expect(result.trim()).toBe(content.trim());
  });

  it('removes Backlinks import when no Backlinks usage remains after stripping', () => {
    const content = [
      "import { Backlinks } from '@components/wiki';",
      '',
      '## Main',
      '',
      'Content without Backlinks usage.',
      '',
      '## Related Pages',
      '',
      '- Related link',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    // Backlinks import should be removed since <Backlinks> is not used
    expect(result).not.toContain("import { Backlinks }");
  });

  it('preserves Backlinks import when <Backlinks> is still used', () => {
    const content = [
      "import { Backlinks } from '@components/wiki';",
      '',
      '## Main',
      '',
      'Content here.',
      '',
      '<Backlinks />',
      '',
      '## Related Pages',
      '',
      '- Related link',
    ].join('\n');

    const result = stripRelatedPagesSections(content);
    // Backlinks is still used in the page, so the import should remain
    expect(result).toContain('Backlinks');
  });

  it('ensures output ends with a single newline', () => {
    const content = '## Section\n\nContent.\n\n\n\n## Related Pages\n\n- Link\n';
    const result = stripRelatedPagesSections(content);
    expect(result.endsWith('\n')).toBe(true);
    // Should not have multiple trailing newlines
    expect(result.endsWith('\n\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildObjectivityContext
// ---------------------------------------------------------------------------

describe('buildObjectivityContext', () => {
  it('returns empty string when no objectivity issues and score >= 6', () => {
    const page = makePage({ ratings: { objectivity: 7 } });
    const analysis = makeAnalysis({ objectivityIssues: [] });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toBe('');
  });

  it('returns objectivity alert when score < 6', () => {
    const page = makePage({ ratings: { objectivity: 4 } });
    const analysis = makeAnalysis({ objectivityIssues: [] });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toContain('Objectivity Alert');
    expect(result).toContain('4/10');
  });

  it('includes objectivity issues in the context', () => {
    const page = makePage({ ratings: { objectivity: 8 } });
    const analysis = makeAnalysis({
      objectivityIssues: [
        'Uses evaluative language without data',
        'Omits criticism from major critics',
      ],
    });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toContain('Uses evaluative language without data');
    expect(result).toContain('Omits criticism from major critics');
  });

  it('includes both alert and issues when score < 6 and issues exist', () => {
    const page = makePage({ ratings: { objectivity: 3 } });
    const analysis = makeAnalysis({
      objectivityIssues: ['One-sided framing detected'],
    });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toContain('Objectivity Alert');
    expect(result).toContain('One-sided framing detected');
    // The threshold note should be in the alert section
    expect(result).toContain('3/10');
  });

  it('returns empty string when page has no ratings', () => {
    const page = makePage({ ratings: undefined });
    const analysis = makeAnalysis({ objectivityIssues: [] });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toBe('');
  });

  it('returns empty string when page has ratings but no objectivity score', () => {
    const page = makePage({ ratings: { rigor: 8 } });
    const analysis = makeAnalysis({ objectivityIssues: [] });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toBe('');
  });

  it('returns issue text even without low objectivity score', () => {
    const page = makePage({ ratings: { objectivity: 8 } });
    const analysis = makeAnalysis({
      objectivityIssues: ['Framing issue detected'],
    });

    const result = buildObjectivityContext(page, analysis);
    // Issues should be present even though score is above threshold
    expect(result).toContain('Framing issue detected');
    // But the alert header should NOT be present
    expect(result).not.toContain('Objectivity Alert');
    expect(result).toContain('Objectivity Issues Found in Analysis');
  });

  it('includes a fix instruction when issues are listed', () => {
    const page = makePage({});
    const analysis = makeAnalysis({
      objectivityIssues: ['Issue detected'],
    });

    const result = buildObjectivityContext(page, analysis);
    expect(result).toContain('Fix all of these objectivity issues');
  });
});
