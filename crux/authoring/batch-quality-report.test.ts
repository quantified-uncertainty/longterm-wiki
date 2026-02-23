import { describe, it, expect } from 'vitest';

import {
  snapshotFromContent,
  computeDelta,
  generateQualityReport,
  formatMarkdownReport,
  type PageQualitySnapshot,
} from './batch-quality-report.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMdx = (opts: {
  quality?: number;
  readerImportance?: number;
  body?: string;
}) => {
  const fm: string[] = ['---', 'title: Test Page'];
  if (opts.quality != null) fm.push(`quality: ${opts.quality}`);
  if (opts.readerImportance != null) fm.push(`readerImportance: ${opts.readerImportance}`);
  fm.push('---');
  fm.push('');
  fm.push(opts.body ?? 'Some content here.');
  return fm.join('\n');
};

const makeSnapshot = (overrides: Partial<PageQualitySnapshot> = {}): PageQualitySnapshot => ({
  wordCount: 500,
  sectionCount: 4,
  footnoteCount: 5,
  tableCount: 2,
  diagramCount: 1,
  entityLinkCount: 3,
  externalLinks: 2,
  structuralScore: 30,
  qualityGrade: 60,
  readerImportance: 3,
  ...overrides,
});

// ---------------------------------------------------------------------------
// snapshotFromContent
// ---------------------------------------------------------------------------

describe('snapshotFromContent', () => {
  it('extracts basic metrics from MDX content', () => {
    const content = makeMdx({
      quality: 55,
      readerImportance: 3,
      body: [
        '## Overview',
        '',
        'This is a test page with some words. It has multiple sections.',
        '',
        '## Section Two',
        '',
        'More content here with additional words to count.',
        '',
        '| Col A | Col B |',
        '|-------|-------|',
        '| val1  | val2  |',
        '',
        'A footnote reference[^1].',
        '',
        '[^1]: Source citation here.',
      ].join('\n'),
    });

    const snapshot = snapshotFromContent(content);

    expect(snapshot.wordCount).toBeGreaterThan(10);
    expect(snapshot.sectionCount).toBe(2); // 2 h2 sections
    expect(snapshot.footnoteCount).toBe(1);
    expect(snapshot.tableCount).toBe(1);
    expect(snapshot.qualityGrade).toBe(55);
    expect(snapshot.readerImportance).toBe(3);
  });

  it('returns null quality grade when not in frontmatter', () => {
    const content = makeMdx({ body: 'Just content.' });
    const snapshot = snapshotFromContent(content);
    expect(snapshot.qualityGrade).toBeNull();
    expect(snapshot.readerImportance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------

describe('computeDelta', () => {
  it('computes positive deltas for improvements', () => {
    const before = makeSnapshot({ wordCount: 500, footnoteCount: 3, structuralScore: 25 });
    const after = makeSnapshot({ wordCount: 800, footnoteCount: 6, structuralScore: 35 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.pageId).toBe('test-page');
    expect(delta.delta.wordCount).toBe(300);
    expect(delta.delta.footnoteCount).toBe(3);
    expect(delta.delta.structuralScore).toBe(10);
    expect(delta.degraded).toBe(false);
    expect(delta.degradationReasons).toHaveLength(0);
  });

  it('flags degradation when word count drops >20%', () => {
    const before = makeSnapshot({ wordCount: 1000 });
    const after = makeSnapshot({ wordCount: 700 }); // 30% drop

    const delta = computeDelta('test-page', before, after);

    expect(delta.degraded).toBe(true);
    expect(delta.degradationReasons).toHaveLength(1);
    expect(delta.degradationReasons[0]).toContain('Word count dropped');
  });

  it('does not flag word count drop under 20%', () => {
    const before = makeSnapshot({ wordCount: 1000 });
    const after = makeSnapshot({ wordCount: 850 }); // 15% drop

    const delta = computeDelta('test-page', before, after);

    // Should not be flagged for word count alone
    expect(delta.degradationReasons.filter(r => r.includes('Word count'))).toHaveLength(0);
  });

  it('flags degradation when footnotes decrease', () => {
    const before = makeSnapshot({ footnoteCount: 10 });
    const after = makeSnapshot({ footnoteCount: 7 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.degraded).toBe(true);
    expect(delta.degradationReasons.some(r => r.includes('Footnotes decreased'))).toBe(true);
  });

  it('flags degradation when tables decrease', () => {
    const before = makeSnapshot({ tableCount: 3 });
    const after = makeSnapshot({ tableCount: 1 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.degraded).toBe(true);
    expect(delta.degradationReasons.some(r => r.includes('Tables decreased'))).toBe(true);
  });

  it('flags degradation when quality grade drops', () => {
    const before = makeSnapshot({ qualityGrade: 70 });
    const after = makeSnapshot({ qualityGrade: 55 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.degraded).toBe(true);
    expect(delta.degradationReasons.some(r => r.includes('Quality grade dropped'))).toBe(true);
    expect(delta.delta.qualityGrade).toBe(-15);
  });

  it('handles null quality grades gracefully', () => {
    const before = makeSnapshot({ qualityGrade: null });
    const after = makeSnapshot({ qualityGrade: 60 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.delta.qualityGrade).toBeNull();
    // Should not flag degradation since we can't compare
    expect(delta.degradationReasons.filter(r => r.includes('Quality grade'))).toHaveLength(0);
  });

  it('flags structural score drop >5 points', () => {
    const before = makeSnapshot({ structuralScore: 40 });
    const after = makeSnapshot({ structuralScore: 30 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.degraded).toBe(true);
    expect(delta.degradationReasons.some(r => r.includes('Structural score dropped'))).toBe(true);
  });

  it('does not flag exactly 20% word count drop (threshold is >20%)', () => {
    const before = makeSnapshot({ wordCount: 1000 });
    const after = makeSnapshot({ wordCount: 800 }); // exactly 20% drop

    const delta = computeDelta('test-page', before, after);

    expect(delta.degradationReasons.filter(r => r.includes('Word count'))).toHaveLength(0);
  });

  it('does not flag exactly -5 structural score drop (threshold is <-5)', () => {
    const before = makeSnapshot({ structuralScore: 30 });
    const after = makeSnapshot({ structuralScore: 25 }); // exactly -5

    const delta = computeDelta('test-page', before, after);

    expect(delta.degradationReasons.filter(r => r.includes('Structural score'))).toHaveLength(0);
  });

  it('handles zero before.wordCount without triggering drop', () => {
    const before = makeSnapshot({ wordCount: 0 });
    const after = makeSnapshot({ wordCount: 500 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.degradationReasons.filter(r => r.includes('Word count'))).toHaveLength(0);
    expect(delta.delta.wordCount).toBe(500);
  });

  it('accumulates multiple degradation reasons', () => {
    const before = makeSnapshot({ wordCount: 1000, footnoteCount: 10, tableCount: 3 });
    const after = makeSnapshot({ wordCount: 500, footnoteCount: 5, tableCount: 1 });

    const delta = computeDelta('test-page', before, after);

    expect(delta.degraded).toBe(true);
    expect(delta.degradationReasons.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// generateQualityReport
// ---------------------------------------------------------------------------

describe('generateQualityReport', () => {
  it('generates summary with correct counts', () => {
    const deltas = [
      // Improved: structural score went up
      computeDelta('page-a', makeSnapshot({ structuralScore: 20 }), makeSnapshot({ structuralScore: 30 })),
      // Degraded: footnotes decreased
      computeDelta('page-b', makeSnapshot({ footnoteCount: 10 }), makeSnapshot({ footnoteCount: 5 })),
      // Unchanged: nothing meaningful changed
      computeDelta('page-c', makeSnapshot(), makeSnapshot()),
    ];

    const report = generateQualityReport(deltas, {
      tier: 'standard',
      totalCost: 15.5,
      totalDuration: '5m30s',
    });

    expect(report.summary.totalPages).toBe(3);
    expect(report.summary.pagesImproved).toBe(1);
    expect(report.summary.pagesDegraded).toBe(1);
    expect(report.summary.pagesUnchanged).toBe(1);
    expect(report.tier).toBe('standard');
    expect(report.totalCost).toBe(15.5);
    expect(report.flaggedForReview).toContain('page-b');
    expect(report.flaggedForReview).not.toContain('page-a');
  });

  it('calculates citation totals correctly (only counts additions)', () => {
    const deltas = [
      computeDelta('page-a', makeSnapshot({ footnoteCount: 3 }), makeSnapshot({ footnoteCount: 7 })),  // +4
      computeDelta('page-b', makeSnapshot({ footnoteCount: 5 }), makeSnapshot({ footnoteCount: 2 })),  // -3 (not counted)
    ];

    const report = generateQualityReport(deltas, {
      tier: 'polish',
      totalCost: 5,
      totalDuration: '2m',
    });

    expect(report.summary.totalNewCitations).toBe(4); // Only counts positive additions
  });

  it('computes grade changes for pages with both grades', () => {
    const deltas = [
      computeDelta('page-a', makeSnapshot({ qualityGrade: 50 }), makeSnapshot({ qualityGrade: 70 })),  // improved
      computeDelta('page-b', makeSnapshot({ qualityGrade: 60 }), makeSnapshot({ qualityGrade: 60 })),  // unchanged
      computeDelta('page-c', makeSnapshot({ qualityGrade: 70 }), makeSnapshot({ qualityGrade: 55 })),  // degraded
      computeDelta('page-d', makeSnapshot({ qualityGrade: null }), makeSnapshot({ qualityGrade: 60 })), // excluded
    ];

    const report = generateQualityReport(deltas, {
      tier: 'deep',
      totalCost: 30,
      totalDuration: '15m',
    });

    expect(report.summary.gradeChanges.improved).toBe(1);
    expect(report.summary.gradeChanges.unchanged).toBe(1);
    expect(report.summary.gradeChanges.degraded).toBe(1);
  });

  it('handles empty deltas array', () => {
    const report = generateQualityReport([], {
      tier: 'standard',
      totalCost: 0,
      totalDuration: '0s',
    });

    expect(report.summary.totalPages).toBe(0);
    expect(report.summary.averageWordCountChange).toBe(0);
    expect(report.flaggedForReview).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatMarkdownReport
// ---------------------------------------------------------------------------

describe('formatMarkdownReport', () => {
  it('produces valid markdown with headers and table', () => {
    const deltas = [
      computeDelta('page-a', makeSnapshot({ structuralScore: 20, footnoteCount: 3 }), makeSnapshot({ structuralScore: 30, footnoteCount: 5 })),
      computeDelta('page-b', makeSnapshot({ footnoteCount: 10 }), makeSnapshot({ footnoteCount: 5 })),
    ];

    const report = generateQualityReport(deltas, {
      tier: 'standard',
      totalCost: 10,
      totalDuration: '3m',
    });

    const md = formatMarkdownReport(report);

    expect(md).toContain('# Batch Quality Report');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Per-Page Results');
    expect(md).toContain('page-a');
    expect(md).toContain('page-b');
    expect(md).toContain('| Page |');
  });

  it('includes flagged section when pages are degraded', () => {
    const deltas = [
      computeDelta('bad-page', makeSnapshot({ footnoteCount: 10, tableCount: 5 }), makeSnapshot({ footnoteCount: 3, tableCount: 1 })),
    ];

    const report = generateQualityReport(deltas, {
      tier: 'standard',
      totalCost: 5,
      totalDuration: '2m',
    });

    const md = formatMarkdownReport(report);

    expect(md).toContain('## Flagged for Manual Review');
    expect(md).toContain('bad-page');
    expect(md).toContain('Footnotes decreased');
    expect(md).toContain('Tables decreased');
    // Status should be consistently lowercase
    expect(md).toContain('| degraded |');
  });

  it('omits flagged section when no pages degraded', () => {
    const deltas = [
      computeDelta('good-page', makeSnapshot({ structuralScore: 20 }), makeSnapshot({ structuralScore: 30 })),
    ];

    const report = generateQualityReport(deltas, {
      tier: 'polish',
      totalCost: 3,
      totalDuration: '1m',
    });

    const md = formatMarkdownReport(report);

    expect(md).not.toContain('## Flagged for Manual Review');
  });
});
